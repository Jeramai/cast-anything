import { Buffer } from 'buffer';

// Pure WebSocket (RFC 6455) codec: the handshake accept-key (SHA-1), text-frame
// encoding, and client-frame parsing. No sockets here, so it's unit-testable;
// the server in ./wsServer uses it.

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ---- SHA-1 (pure JS) → 20 bytes, for the handshake accept key ----
export function sha1Bytes(bytes: number[]): number[] {
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

export function acceptKey(clientKey: string): string {
  const s = clientKey + WS_GUID;
  const bytes = [];
  for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i) & 0xff);
  return Buffer.from(sha1Bytes(bytes)).toString('base64');
}

/** Encode an unmasked server→client text frame. */
export function encodeText(str: string): Buffer {
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

export interface ParseResult {
  texts: string[];
  consumed: number;
  closed: boolean;
}

/** Parse as many complete client→server frames as possible from `buf`. */
export function parseFrames(buf: Buffer): ParseResult {
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
