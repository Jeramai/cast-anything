import TcpSocket from 'react-native-tcp-socket';
import { Buffer } from 'buffer';

/**
 * Minimal WebSocket server (RFC 6455) built on react-native-tcp-socket, so the
 * signage player page gets an event-driven channel instead of polling: the app
 * pushes media/controls instantly, and the panel streams playback status back.
 *
 * Only what we need: text frames, single-frame messages, client→server unmask,
 * server→client unmasked. Good enough for small JSON control messages.
 */

const WS_PORT = 51800;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ---- SHA-1 (pure JS) → 20 bytes, for the handshake accept key ----
function sha1Bytes(bytes: number[]): number[] {
  const rotl = (n: number, s: number) => ((n << s) | (n >>> (32 - s))) >>> 0;
  const msg = bytes.slice();
  const ml = bytes.length * 8;
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  const hi = Math.floor(ml / 0x100000000);
  const lo = ml >>> 0;
  msg.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff);
  msg.push((lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff);

  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Array(80);
  for (let i = 0; i < msg.length; i += 64) {
    for (let t = 0; t < 16; t++) {
      w[t] =
        ((msg[i + t * 4] << 24) |
          (msg[i + t * 4 + 1] << 16) |
          (msg[i + t * 4 + 2] << 8) |
          msg[i + t * 4 + 3]) >>> 0;
    }
    for (let t = 16; t < 80; t++) {
      w[t] = rotl((w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16]) >>> 0, 1);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let t = 0; t < 80; t++) {
      let f: number, k: number;
      if (t < 20) { f = ((b & c) | (~b & d)) >>> 0; k = 0x5a827999; }
      else if (t < 40) { f = (b ^ c ^ d) >>> 0; k = 0x6ed9eba1; }
      else if (t < 60) { f = ((b & c) | (b & d) | (c & d)) >>> 0; k = 0x8f1bbcdc; }
      else { f = (b ^ c ^ d) >>> 0; k = 0xca62c1d6; }
      const tmp = (rotl(a, 5) + f + e + k + w[t]) >>> 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = tmp;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  const out: number[] = [];
  for (const h of [h0, h1, h2, h3, h4]) {
    out.push((h >>> 24) & 0xff, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff);
  }
  return out;
}

function acceptKey(clientKey: string): string {
  const s = clientKey + WS_GUID;
  const bytes = [];
  for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i) & 0xff);
  return Buffer.from(sha1Bytes(bytes)).toString('base64');
}

/** Encode an unmasked server→client text frame. */
function encodeText(str: string): Buffer {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.from([0x81, 126, (len >> 8) & 0xff, len & 0xff]);
  } else {
    header = Buffer.from([0x81, 127, 0, 0, 0, 0, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff]);
  }
  return Buffer.concat([header, payload]);
}

interface ParseResult {
  texts: string[];
  consumed: number;
  closed: boolean;
}

/** Parse as many complete client→server frames as possible from `buf`. */
function parseFrames(buf: Buffer): ParseResult {
  const texts: string[] = [];
  let offset = 0;
  let closed = false;
  while (offset + 2 <= buf.length) {
    const b0 = buf[offset];
    const b1 = buf[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = offset + 2;
    if (len === 126) {
      if (buf.length < p + 2) break;
      len = (buf[p] << 8) | buf[p + 1];
      p += 2;
    } else if (len === 127) {
      if (buf.length < p + 8) break;
      // Support up to 32-bit lengths (low 4 bytes); our messages are tiny.
      len = (buf[p + 4] * 0x1000000) + (buf[p + 5] << 16) + (buf[p + 6] << 8) + buf[p + 7];
      p += 8;
    }
    let mask: number[] | null = null;
    if (masked) {
      if (buf.length < p + 4) break;
      mask = [buf[p], buf[p + 1], buf[p + 2], buf[p + 3]];
      p += 4;
    }
    if (buf.length < p + len) break;
    const payload = Buffer.from(buf.slice(p, p + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    p += len;
    offset = p;
    if (opcode === 0x8) { closed = true; break; } // close
    if (opcode === 0x1) texts.push(payload.toString('utf8')); // text (ignore ping/pong/binary)
  }
  return { texts, consumed: offset, closed };
}

interface WsClient {
  socket: any;
  buf: Buffer;
  open: boolean;
}

let server: any = null;
let clients: WsClient[] = [];
let currentMedia: object | null = null;
let startPromise: Promise<number> | null = null;
let onStatus: ((msg: any) => void) | null = null;
let onClientsChange: ((count: number) => void) | null = null;

function notifyClients() {
  onClientsChange?.(clients.filter((c) => c.open).length);
}

function sendTo(client: WsClient, obj: object) {
  try {
    client.socket.write(encodeText(JSON.stringify(obj)));
  } catch {
    /* dead socket */
  }
}

function handleConnection(socket: any) {
  const client: WsClient = { socket, buf: Buffer.alloc(0), open: false };
  clients.push(client);

  const cleanup = () => {
    clients = clients.filter((c) => c !== client);
    notifyClients();
  };

  socket.on('data', (d: Buffer | string) => {
    const chunk = typeof d === 'string' ? Buffer.from(d, 'binary') : Buffer.from(d);
    client.buf = Buffer.concat([client.buf, chunk]);

    if (!client.open) {
      const text = client.buf.toString('latin1');
      const end = text.indexOf('\r\n\r\n');
      if (end === -1) return; // wait for full headers
      const keyMatch = /sec-websocket-key:\s*(.+)\r\n/i.exec(text);
      if (!keyMatch) {
        try { socket.destroy(); } catch {}
        return;
      }
      const accept = acceptKey(keyMatch[1].trim());
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      client.open = true;
      client.buf = client.buf.slice(end + 4); // remaining bytes are WS frames
      notifyClients();
      if (currentMedia) sendTo(client, { type: 'media', ...currentMedia });
    }

    if (client.open && client.buf.length) {
      const { texts, consumed, closed } = parseFrames(client.buf);
      if (consumed) client.buf = client.buf.slice(consumed);
      for (const t of texts) {
        try {
          onStatus?.(JSON.parse(t));
        } catch {
          /* ignore non-JSON */
        }
      }
      if (closed) {
        try { socket.destroy(); } catch {}
        cleanup();
      }
    }
  });

  socket.on('close', cleanup);
  socket.on('error', cleanup);
}

export function startWsServer(handlers: {
  onStatus?: (msg: any) => void;
  onClientsChange?: (count: number) => void;
}): Promise<number> {
  onStatus = handlers.onStatus || null;
  onClientsChange = handlers.onClientsChange || null;
  if (server) return Promise.resolve(WS_PORT);
  if (startPromise) return startPromise;

  startPromise = new Promise<number>((resolve, reject) => {
    let settled = false;
    try {
      server = TcpSocket.createServer((socket: any) => handleConnection(socket));
      server.on('error', (e: Error) => {
        // Usually the port is held by a server orphaned across a JS reload.
        console.warn('[ws] server error:', e?.message);
        if (!settled) {
          settled = true;
          server = null; // don't leave a dead handle; allow a later retry
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
      server.listen({ port: WS_PORT, host: '0.0.0.0' }, () => {
        if (!settled) {
          settled = true;
          resolve(WS_PORT);
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

/** Set/replace the media the player should show; pushed to all clients. */
export function wsSetMedia(media: {
  url: string;
  kind: string;
  title: string;
  v: string;
}) {
  currentMedia = media;
  for (const c of clients) if (c.open) sendTo(c, { type: 'media', ...media });
}

/** Push a control command to the player(s). */
export function wsSendControl(action: string, value?: number) {
  for (const c of clients) if (c.open) sendTo(c, { type: 'control', action, value: value ?? null });
}

export function wsClientCount(): number {
  return clients.filter((c) => c.open).length;
}

export function getWsPort(): number {
  return WS_PORT;
}
