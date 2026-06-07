import TcpSocket from 'react-native-tcp-socket';
import { Buffer } from 'buffer';
import { read } from '@dr.pogodin/react-native-fs';
import { parseHttpHead, planResponse, type ServedFile } from './dlnaHttp';

export type { ServedFile };

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

export function setServedFile(f: ServedFile): void {
  current = f;
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
    const f = current;
    const plan = planResponse(req, f, new Date().toUTCString());
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
