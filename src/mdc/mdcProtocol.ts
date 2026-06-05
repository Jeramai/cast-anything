import { Buffer } from 'buffer';

/**
 * Pure Samsung MDC (Multiple Display Control) wire format — packet building,
 * checksum, and response parsing. No sockets, so it's unit-testable; ./mdc does
 * the TCP I/O on port 1515.
 *
 * Packet:  [0xAA][cmd][id][dataLen][...data][checksum]
 *   checksum = (cmd + id + dataLen + Σdata) & 0xFF   (header 0xAA excluded)
 * Response: [0xAA][0xFF][id][len][ack][rcmd][...data][checksum]
 *   ack 0x41 'A' = ACK, 0x4E 'N' = NAK
 */

export const MDC_CMD = {
  STATUS: 0x00,
  POWER: 0x11,
  INPUT_SOURCE: 0x14,
  LAUNCHER: 0xc7,
} as const;

export const SUB_PLAY_VIA = 0x81;
export const SUB_URL_ADDRESS = 0x82;

/** Input-source value for URL Launcher (used with MDC_CMD.INPUT_SOURCE). */
export const INPUT_URL_LAUNCHER = 0x63;
/** "Play via" mode value for URL Launcher (sub 0x81). */
export const PLAY_VIA_URL_LAUNCHER = 0x01;

export interface MdcResponse {
  ok: boolean; // true when ACK
  ack: 'A' | 'N' | '?';
  rcmd: number;
  /** Payload bytes after ack + responded-command. */
  data: Uint8Array;
  raw: Uint8Array;
}

export function buildPacket(cmd: number, id: number, data: number[]): Buffer {
  const len = data.length;
  const checksum = (cmd + id + len + data.reduce((a, b) => a + b, 0)) & 0xff;
  return Buffer.from([0xaa, cmd, id, len, ...data, checksum]);
}

export function parseResponse(buf: Buffer): MdcResponse {
  const u = Uint8Array.from(buf);
  if (u[0] !== 0xaa || u[1] !== 0xff) {
    return { ok: false, ack: '?', rcmd: 0, data: new Uint8Array(), raw: u };
  }
  const len = u[3];
  const ack = u[4] === 0x41 ? 'A' : u[4] === 0x4e ? 'N' : '?';
  const rcmd = u[5];
  // len counts ack(1) + rcmd(1) + data; payload runs from index 6 to (4 + len).
  const data = u.slice(6, 4 + len);
  return { ok: ack === 'A', ack, rcmd, data, raw: u };
}

/** Decode the URL string from a getLauncherUrl() response (after the subcmd). */
export function decodeLauncherUrl(res: MdcResponse): string {
  // data = [0x82, ...urlBytes]
  const bytes = res.data[0] === SUB_URL_ADDRESS ? res.data.slice(1) : res.data;
  return Buffer.from(bytes).toString('ascii').replace(/\0+$/, '').trim();
}
