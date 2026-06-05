import TcpSocket from 'react-native-tcp-socket';
import { Buffer } from 'buffer';

/**
 * Minimal Samsung MDC (Multiple Display Control) client over TCP port 1515.
 *
 * Packet:  [0xAA][cmd][id][dataLen][...data][checksum]
 *   checksum = (cmd + id + dataLen + Σdata) & 0xFF   (header 0xAA excluded)
 * Response: [0xAA][0xFF][id][len][ack][rcmd][...data][checksum]
 *   ack 0x41 'A' = ACK, 0x4E 'N' = NAK
 *
 * Used to drive Samsung signage that doesn't accept DLNA push: set the URL
 * Launcher address and switch the input source to it.
 */

const MDC_PORT = 1515;
const DEFAULT_ID = 0x00;
const RESPONSE_TIMEOUT_MS = 3000;

export const MDC_CMD = {
  STATUS: 0x00,
  POWER: 0x11,
  INPUT_SOURCE: 0x14,
  LAUNCHER: 0xc7,
} as const;

const SUB_PLAY_VIA = 0x81;
const SUB_URL_ADDRESS = 0x82;

/** Input-source value for URL Launcher (used with MDC_CMD.INPUT_SOURCE). */
export const INPUT_URL_LAUNCHER = 0x63;
/** "Play via" mode value for URL Launcher (sub 0x81). */
export const PLAY_VIA_URL_LAUNCHER = 0x01;

/** The shipped Socket type doesn't surface EventEmitter methods cleanly. */
interface SocketLike {
  on(event: 'data', cb: (data: Buffer | string) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'close', cb: () => void): void;
  write(data: Buffer | Uint8Array | string): boolean;
  destroy(): void;
  setTimeout(ms: number, cb?: () => void): void;
}

export interface MdcResponse {
  ok: boolean; // true when ACK
  ack: 'A' | 'N' | '?';
  rcmd: number;
  /** Payload bytes after ack + responded-command. */
  data: Uint8Array;
  raw: Uint8Array;
}

function buildPacket(cmd: number, id: number, data: number[]): Buffer {
  const len = data.length;
  const checksum = (cmd + id + len + data.reduce((a, b) => a + b, 0)) & 0xff;
  return Buffer.from([0xaa, cmd, id, len, ...data, checksum]);
}

function parseResponse(buf: Buffer): MdcResponse {
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

/** Open a short-lived connection, send one command, resolve its response. */
function sendCommand(
  host: string,
  cmd: number,
  data: number[] = [],
  id = DEFAULT_ID,
): Promise<MdcResponse> {
  return new Promise((resolve, reject) => {
    const packet = buildPacket(cmd, id, data);
    let settled = false;
    const socket = TcpSocket.createConnection(
      { host, port: MDC_PORT },
      () => {
        socket.write(packet);
      },
    ) as unknown as SocketLike;

    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      action();
    };

    socket.setTimeout(RESPONSE_TIMEOUT_MS, () =>
      finish(() => reject(new Error(`MDC timeout (${host}:${MDC_PORT})`))),
    );
    socket.on('data', (d) => {
      const buf = typeof d === 'string' ? Buffer.from(d, 'binary') : Buffer.from(d);
      finish(() => resolve(parseResponse(buf)));
    });
    socket.on('error', (e) =>
      finish(() => reject(e instanceof Error ? e : new Error(String(e)))),
    );
  });
}

export function getStatus(host: string): Promise<MdcResponse> {
  return sendCommand(host, MDC_CMD.STATUS);
}

/** True if the host answers MDC at all (used to detect controllable panels). */
export async function isMdcReachable(host: string): Promise<boolean> {
  try {
    return (await getStatus(host)).ok;
  } catch {
    return false;
  }
}

export function getInputSource(host: string): Promise<MdcResponse> {
  return sendCommand(host, MDC_CMD.INPUT_SOURCE);
}

export function setInputSource(host: string, source: number): Promise<MdcResponse> {
  return sendCommand(host, MDC_CMD.INPUT_SOURCE, [source]);
}

export function getPlayVia(host: string): Promise<MdcResponse> {
  return sendCommand(host, MDC_CMD.LAUNCHER, [SUB_PLAY_VIA]);
}

export function setPlayVia(host: string, mode: number): Promise<MdcResponse> {
  return sendCommand(host, MDC_CMD.LAUNCHER, [SUB_PLAY_VIA, mode]);
}

export function getLauncherUrl(host: string): Promise<MdcResponse> {
  return sendCommand(host, MDC_CMD.LAUNCHER, [SUB_URL_ADDRESS]);
}

/** Decode the URL string from a getLauncherUrl() response (after the subcmd). */
export function decodeLauncherUrl(res: MdcResponse): string {
  // data = [0x82, ...urlBytes]
  const bytes = res.data[0] === SUB_URL_ADDRESS ? res.data.slice(1) : res.data;
  return Buffer.from(bytes).toString('ascii').replace(/\0+$/, '').trim();
}

export function setLauncherUrl(host: string, url: string): Promise<MdcResponse> {
  const bytes = Array.from(Buffer.from(url, 'ascii'));
  return sendCommand(host, MDC_CMD.LAUNCHER, [SUB_URL_ADDRESS, ...bytes]);
}

export interface SignageCapabilities {
  reachable: boolean;
  /** URL Launcher controllable over MDC (0xC7 ACKs). */
  urlLauncherSupported: boolean;
  /** Current launcher URL, if readable. */
  currentLauncherUrl?: string;
}

/** Probe what a Samsung panel supports so the app can choose a cast strategy. */
export async function probeSignage(host: string): Promise<SignageCapabilities> {
  const reachable = await isMdcReachable(host);
  if (!reachable) return { reachable: false, urlLauncherSupported: false };
  try {
    const urlRes = await getLauncherUrl(host);
    return {
      reachable: true,
      urlLauncherSupported: urlRes.ok,
      currentLauncherUrl: urlRes.ok ? decodeLauncherUrl(urlRes) : undefined,
    };
  } catch {
    return { reachable: true, urlLauncherSupported: false };
  }
}
