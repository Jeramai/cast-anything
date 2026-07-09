import TcpSocket from 'react-native-tcp-socket';
import { Buffer } from 'buffer';
import { read, stat } from '@dr.pogodin/react-native-fs';
import { parseHttpHead, planLiveResponse, planResponse, type ServedFile } from './dlnaHttp';

export type { ServedFile };

/**
 * A live, unbounded stream (our HLS→MPEG-TS remux). Unlike a {@link ServedFile} it
 * has no size or seek — the server just pulls complete segments via `next()` and
 * deletes each one through `done()` once it's been sent.
 */
export interface LiveSource {
  mime: string;
  /** `contentFeatures.dlna.org` value (must carry the live flags). */
  features: string;
  /** Next complete segment path, or null once the feed has ended. */
  next: (alive: () => boolean) => Promise<string | null>;
  /** Called after a segment has been fully sent — delete it. */
  done: (path: string) => void;
  /** Stop producing (cast stopped / superseded). */
  stop: () => void;
}

/** Path the live remux is served at (any query is ignored). */
export const LIVE_PATH = '/live.ts';

/**
 * A small DLNA-aware HTTP file server for casting local media.
 *
 * The bundled lighttpd can't speak DLNA — it sends no `contentFeatures.dlna.org`
 * header and can't answer `TimeSeekRange.dlna.org`. Samsung renderers (e.g. The
 * Freestyle) therefore refuse to seek (UPnP 701 "Transition not available") and
 * reject byte-seek (710). This server fixes that: it advertises DLNA content
 * features, answers both byte `Range` and DLNA `TimeSeekRange` (mapping a time
 * target to a byte offset from the known duration + size), and streams with
 * write-callback backpressure so multi-GB files don't blow up memory.
 *
 * It also keeps an in-memory log of every request (method, path, seek headers, and
 * the response we sent) so we can see exactly how a renderer tries to seek.
 */

export const MEDIA_PORT = 51797;
const CHUNK = 256 * 1024;

let server: any = null;
let current: ServedFile | null = null;
let subtitle: ServedFile | null = null;
let subtitleUrl: string | null = null;
let live: LiveSource | null = null;

/** Path the subtitle is served at (routes here regardless of the video name). */
export const SUBTITLE_PATH = '/subtitle.srt';

export function setServedFile(f: ServedFile): void {
  current = f;
}

/** Attach (or clear) the live stream served at {@link LIVE_PATH}. */
export function setLiveSource(s: LiveSource | null): void {
  live = s;
}

/** Attach (or clear) a subtitle file + its public URL, served at SUBTITLE_PATH. */
export function setSubtitleFile(f: ServedFile | null, url: string | null): void {
  subtitle = f;
  subtitleUrl = url;
}

function sendStr(socket: any, data: string): Promise<void> {
  return new Promise((resolve) => {
    socket.write(data, undefined, () => resolve());
  });
}

/** Write the status line + headers, resolving once they've actually flushed. */
async function writeHead(socket: any, status: string, headers: Record<string, string>): Promise<void> {
  let s = `HTTP/1.1 ${status}\r\n`;
  for (const [k, v] of Object.entries(headers)) s += `${k}: ${v}\r\n`;
  await sendStr(socket, s + '\r\n');
}

/** Stream bytes [start,end] to the socket, pacing on each write's flush callback. */
async function streamBytes(
  socket: any,
  path: string,
  start: number,
  end: number,
  alive: () => boolean,
  dead: Promise<void>,
): Promise<void> {
  let pos = start;
  while (pos <= end && alive()) {
    const len = Math.min(CHUNK, end - pos + 1);
    let b64: string;
    try {
      b64 = await read(path, len, pos, 'base64');
    } catch {
      break;
    }
    const buf = Buffer.from(b64 || '', 'base64');
    if (buf.length === 0) break;
    // Await the flush so we don't read the whole file into memory faster than the
    // socket can drain it — natural backpressure. Race it against socket death so a
    // mid-stream disconnect (the renderer seeking away) can't hang the handler.
    const wrote = new Promise<void>((resolve, reject) => {
      socket.write(buf, undefined, (err?: Error) => (err ? reject(err) : resolve()));
    }).catch(() => {});
    await Promise.race([wrote, dead]);
    if (!alive()) break;
    pos += buf.length;
  }
}

/**
 * Stream a live source as one continuous body: pull complete segments in order,
 * send each, then delete it. Ends when the source is exhausted (next → null) or
 * the renderer disconnects (alive() → false).
 */
async function streamLive(
  socket: any,
  src: LiveSource,
  alive: () => boolean,
  dead: Promise<void>,
): Promise<void> {
  while (alive()) {
    const seg = await src.next(alive);
    if (seg == null || !alive()) break;
    const size = (await stat(seg).catch(() => null))?.size ?? 0;
    if (size > 0) await streamBytes(socket, seg, 0, size - 1, alive, dead);
    src.done(seg);
  }
}

async function handle(socket: any): Promise<void> {
  let buf = Buffer.alloc(0);
  let started = false;
  let alive = true;
  let resolveDead: () => void = () => {};
  const dead = new Promise<void>((r) => {
    resolveDead = r;
  });
  socket.on('close', () => {
    alive = false;
    resolveDead();
  });
  socket.on('error', () => {
    alive = false;
    resolveDead();
  });
  socket.on('data', async (d: Buffer | string) => {
    if (started) return; // one request per (Connection: close) socket
    buf = Buffer.concat([buf, typeof d === 'string' ? Buffer.from(d, 'latin1') : Buffer.from(d)]);
    const headEnd = buf.indexOf('\r\n\r\n');
    if (headEnd === -1) return;
    started = true;

    const req = parseHttpHead(buf.slice(0, headEnd).toString('latin1'));

    // Live stream (HLS→MPEG-TS remux): no size, no seek — stream until it ends.
    if (req.path.split('?')[0] === LIVE_PATH) {
      const plan = planLiveResponse(req, live, new Date().toUTCString());
      await writeHead(socket, plan.status, plan.headers);
      if (plan.hasBody && live) await streamLive(socket, live, () => alive, dead);
      socket.end();
      return;
    }

    const wantsSub = req.path.split('?')[0] === SUBTITLE_PATH;
    const f = wantsSub ? subtitle : current;
    const plan = planResponse(req, f, new Date().toUTCString());
    // Point Samsung renderers at the sidecar subtitle via the legacy HTTP header
    // (the DIDL sec:CaptionInfoEx is the primary path; this is a belt-and-braces).
    if (!wantsSub && subtitleUrl && plan.hasBody !== undefined && plan.status !== '404 Not Found') {
      plan.headers['CaptionInfo.sec'] = subtitleUrl;
    }
    await writeHead(socket, plan.status, plan.headers);
    if (plan.hasBody && f) await streamBytes(socket, f.path, plan.start, plan.end, () => alive, dead);
    socket.end();
  });
}

let startPromise: Promise<number> | null = null;

/** Start the media server (idempotent). Binds all interfaces on MEDIA_PORT. */
export function startMediaServer(): Promise<number> {
  if (server) return Promise.resolve(MEDIA_PORT);
  if (startPromise) return startPromise;
  startPromise = new Promise<number>((resolve, reject) => {
    let settled = false;
    try {
      server = TcpSocket.createServer((socket: any) => {
        handle(socket).catch(() => {
          try {
            socket.destroy();
          } catch {}
        });
      });
      server.on('error', (e: Error) => {
        if (!settled) {
          settled = true;
          server = null;
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
      server.listen({ port: MEDIA_PORT, host: '0.0.0.0' }, () => {
        if (!settled) {
          settled = true;
          resolve(MEDIA_PORT);
        }
      });
    } catch (e) {
      server = null;
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  }).finally(() => {
    startPromise = null;
  });
  return startPromise;
}
