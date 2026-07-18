import TcpSocket from 'react-native-tcp-socket';
import { Buffer } from 'buffer';
import { read, stat } from '@dr.pogodin/react-native-fs';
import { parseHttpHead, planLiveResponse, planResponse, type ServedFile } from './dlnaHttp';

export type { ServedFile };

/**
 * A live, unbounded stream (our HLS→MPEG-TS remux or on-the-fly local transcode).
 * Unlike a {@link ServedFile} it has no size or seek — each HTTP connection gets its
 * own reader that pulls complete segments in order; segment deletion/retention is the
 * source's rolling-window job, never the reader's.
 */
export interface LiveSource {
  mime: string;
  /** `contentFeatures.dlna.org` value (must carry the live flags). */
  features: string;
  /**
   * Create an independent reader for one HTTP connection. Each reader walks the
   * retained segments from the very start (seg #0 carries the H.264 decoder headers)
   * to the live edge with its OWN cursor — readers never consume destructively, so
   * the renderer's short probe GET can no longer steal the header-bearing first
   * segment from the real playback GET (which left playback undecodable and stuck in
   * TRANSITIONING). Retention/deletion is the source's own rolling-window job.
   */
  createReader: () => { next: (alive: () => boolean) => Promise<string | null> };
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
// 1 MB chunks (was 256 KB). Every chunk costs two JS↔native bridge round-trips
// (disk read + socket write) plus a base64 marshal, so bigger chunks = 4× fewer of
// that fixed per-chunk overhead — the difference between "just barely keeps up" and
// "keeps the TV's buffer full". Peak memory stays tiny: at most two chunks in flight
// (see the read-ahead in streamBytes).
const CHUNK = 1024 * 1024;

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

/**
 * Write the status line + headers, resolving once they've actually flushed — or as
 * soon as the socket dies. `sendStr` resolves only from the write callback, which
 * may never fire on an already-closing socket, so we race it against `dead` (like
 * the body loop) to avoid leaking a handler that hangs forever on a reset connection.
 */
async function writeHead(
  socket: any,
  status: string,
  headers: Record<string, string>,
  dead?: Promise<void>,
): Promise<void> {
  let s = `HTTP/1.1 ${status}\r\n`;
  for (const [k, v] of Object.entries(headers)) s += `${k}: ${v}\r\n`;
  const wrote = sendStr(socket, s + '\r\n');
  await (dead ? Promise.race([wrote, dead]) : wrote);
}

/**
 * Read one chunk of [pos, pos+len) from disk and decode it to bytes. Returns null
 * on read error or EOF so callers can just stop. Kept separate so the read+decode of
 * the *next* chunk can be kicked off (and run on the bridge) while the current one is
 * still draining to the socket — see the read-ahead in streamBytes.
 */
async function readChunk(path: string, len: number, pos: number): Promise<Buffer | null> {
  try {
    const b64 = await read(path, len, pos, 'base64');
    const buf = Buffer.from(b64 || '', 'base64');
    return buf.length ? buf : null;
  } catch {
    return null;
  }
}

/**
 * Stream bytes [start,end] to the socket, pacing on each write's flush callback.
 *
 * Pipelined: while the current chunk is draining to the socket we've already kicked
 * off the disk read + base64 decode of the NEXT one, so disk I/O overlaps network
 * I/O instead of running strictly one-after-the-other. That roughly doubles sustained
 * throughput — the difference between the TV's buffer draining (→ it stalls to
 * re-buffer) and staying comfortably full. At most two chunks are ever in flight, so
 * memory stays bounded — we never read the whole file ahead of the socket.
 */
async function streamBytes(
  socket: any,
  path: string,
  start: number,
  end: number,
  alive: () => boolean,
  dead: Promise<void>,
): Promise<void> {
  let pos = start;
  // Prime the pipeline: begin reading the first chunk before the loop.
  let pending: Promise<Buffer | null> =
    pos <= end ? readChunk(path, Math.min(CHUNK, end - pos + 1), pos) : Promise.resolve(null);
  while (pos <= end && alive()) {
    const buf = await pending;
    if (!buf) break;
    pos += buf.length;
    // Kick off the next read NOW, so it runs while we await this chunk's flush below.
    pending =
      pos <= end && alive()
        ? readChunk(path, Math.min(CHUNK, end - pos + 1), pos)
        : Promise.resolve(null);
    // Await the flush so we don't read the whole file into memory faster than the
    // socket can drain it — natural backpressure. Race it against socket death so a
    // mid-stream disconnect (the renderer seeking away) can't hang the handler.
    const wrote = new Promise<void>((resolve, reject) => {
      socket.write(buf, undefined, (err?: Error) => (err ? reject(err) : resolve()));
    }).catch(() => {});
    await Promise.race([wrote, dead]);
    if (!alive()) break;
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
  // Own cursor per connection: this stream always starts at seg #0 (decoder headers)
  // regardless of what other connections (e.g. the renderer's probe) have read.
  const reader = src.createReader();
  let sent = 0;
  const t0 = Date.now();
  while (alive()) {
    const waitStart = Date.now();
    const seg = await reader.next(alive);
    if (seg == null || !alive()) break;
    const waitedMs = Date.now() - waitStart; // time spent waiting for the segment to be ready
    const size = (await stat(seg).catch(() => null))?.size ?? 0;
    const sendStart = Date.now();
    if (size > 0) await streamBytes(socket, seg, 0, size - 1, alive, dead);
    const sendMs = Date.now() - sendStart; // time spent pushing it to the TV (socket-paced)
    sent++;
    // waitedMs high → encoder is the bottleneck; sendMs high → the TV is pulling slowly
    // (its buffer is full / Wi-Fi ceiling). The real filename shows WHICH underlying
    // segment this connection got.
    console.log(
      `[live-serve] ${seg.split('/').pop()} (#${sent} on this conn) ${(size / 1024).toFixed(0)}KB wait=${waitedMs}ms send=${sendMs}ms elapsed=${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
  }
  console.log(`[live-serve] connection closed after ${sent} segments, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

async function handle(socket: any): Promise<void> {
  let buf = Buffer.alloc(0);
  let started = false;
  let alive = true;
  let resolveDead: () => void = () => {};
  const dead = new Promise<void>((r) => {
    resolveDead = r;
  });
  let liveConn = false; // only log lifecycle noise for the live stream, not every file read
  socket.on('close', () => {
    if (liveConn) console.log('[live-serve] socket closed by peer (TV)');
    alive = false;
    resolveDead();
  });
  socket.on('error', (e: Error) => {
    if (liveConn) console.log(`[live-serve] socket error: ${e?.message ?? e}`);
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
      liveConn = true;
      console.log(
        `[live-serve] ${req.method} ${req.path} — TV connected (range=${req.headers['range'] ?? 'none'}, ua=${req.headers['user-agent'] ?? '?'}, conn=${req.headers['connection'] ?? '?'})`,
      );
      const plan = planLiveResponse(req, live, new Date().toUTCString());
      await writeHead(socket, plan.status, plan.headers, dead);
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
    await writeHead(socket, plan.status, plan.headers, dead);
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
      const s = TcpSocket.createServer((socket: any) => {
        handle(socket).catch(() => {
          try {
            socket.destroy();
          } catch {}
        });
      });
      s.on('error', (e: Error) => {
        if (!settled) {
          settled = true;
          if (server === s) server = null;
          reject(e instanceof Error ? e : new Error(String(e)));
        } else if (server === s) {
          // Died AFTER startup (network drop, OS reclaim). Drop the dead handle so
          // the next cast restarts it instead of reusing a socket that no longer
          // accepts connections — otherwise the TV would fetch the URL, get nothing,
          // and report a cryptic 716 "resource not found".
          console.warn('[mediaServer] error after start; will restart on next use:', e?.message);
          server = null;
        }
      });
      // A cached handle whose native socket has closed must not be reused as if healthy.
      s.on('close', () => {
        if (server === s) server = null;
      });
      s.listen({ port: MEDIA_PORT, host: '0.0.0.0' }, () => {
        if (!settled) {
          settled = true;
          server = s;
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
