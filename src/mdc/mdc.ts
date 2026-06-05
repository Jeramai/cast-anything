import TcpSocket from 'react-native-tcp-socket';
import { Buffer } from 'buffer';
import {
  buildPacket,
  INPUT_URL_LAUNCHER,
  MDC_CMD,
  parseResponse,
  PLAY_VIA_URL_LAUNCHER,
  SUB_PLAY_VIA,
  SUB_URL_ADDRESS,
  type MdcResponse,
} from './mdcProtocol';

/**
 * Minimal Samsung MDC (Multiple Display Control) client over TCP port 1515. The
 * pure wire format (packet/checksum/parse) lives in ./mdcProtocol; this file
 * adds the socket I/O. Used to drive Samsung signage that doesn't accept DLNA
 * push: set the URL Launcher address and switch the input source to it.
 */

// Re-export the launcher constants used by the signage flow.
export { INPUT_URL_LAUNCHER, PLAY_VIA_URL_LAUNCHER };

const MDC_PORT = 1515;
const DEFAULT_ID = 0x00;
const RESPONSE_TIMEOUT_MS = 3000;

/** The shipped Socket type doesn't surface EventEmitter methods cleanly. */
interface SocketLike {
  on(event: 'data', cb: (data: Buffer | string) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'close', cb: () => void): void;
  write(data: Buffer | Uint8Array | string): boolean;
  destroy(): void;
  setTimeout(ms: number, cb?: () => void): void;
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

export function setInputSource(host: string, source: number): Promise<MdcResponse> {
  return sendCommand(host, MDC_CMD.INPUT_SOURCE, [source]);
}

export function setPlayVia(host: string, mode: number): Promise<MdcResponse> {
  return sendCommand(host, MDC_CMD.LAUNCHER, [SUB_PLAY_VIA, mode]);
}

export function setLauncherUrl(host: string, url: string): Promise<MdcResponse> {
  const bytes = Array.from(Buffer.from(url, 'ascii'));
  return sendCommand(host, MDC_CMD.LAUNCHER, [SUB_URL_ADDRESS, ...bytes]);
}
