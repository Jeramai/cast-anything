import UdpSockets from 'react-native-udp';
import { Buffer } from 'buffer';
import type { SsdpHit } from './types';

const SSDP_MULTICAST_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;

/**
 * Search targets, broad → narrow. Samsung TVs answer to MediaRenderer; we also
 * probe AVTransport and `ssdp:all` so we still find renderers that only
 * advertise the service, not the device type.
 */
const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:MediaRenderer:1',
  'urn:schemas-upnp-org:service:AVTransport:1',
  'ssdp:all',
];

function buildMSearch(searchTarget: string, mx = 2): string {
  // Lines MUST be CRLF-terminated and the message MUST end with a blank line.
  return (
    'M-SEARCH * HTTP/1.1\r\n' +
    `HOST: ${SSDP_MULTICAST_ADDR}:${SSDP_PORT}\r\n` +
    'MAN: "ssdp:discover"\r\n' +
    `MX: ${mx}\r\n` +
    `ST: ${searchTarget}\r\n` +
    '\r\n'
  );
}

/**
 * The shipped `UdpSocket` type doesn't surface its EventEmitter methods, so we
 * describe just the surface we use. `createSocket` is cast to this below.
 */
interface UdpSocketLike {
  on(
    event: 'message',
    cb: (msg: Buffer | Uint8Array, rinfo: { address: string; port: number }) => void,
  ): void;
  on(event: 'error', cb: (err: Error) => void): void;
  once(event: 'listening', cb: () => void): void;
  bind(port: number): void;
  send(
    msg: Buffer | Uint8Array | string,
    offset: number,
    length: number,
    port: number,
    address: string,
    cb?: (err?: Error) => void,
  ): void;
  setBroadcast(flag: boolean): void;
  close(): void;
}

function parseSsdpHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\r\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      out[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
  }
  return out;
}

export interface DiscoveryHandle {
  stop: () => void;
}

/**
 * Broadcast SSDP M-SEARCH requests and stream back each unique responder.
 * Fire-and-forget: call `.stop()` (or let `timeoutMs` elapse) to release the
 * UDP socket. De-dupes by USN so the same device is reported once.
 */
export function discoverSsdp(opts: {
  timeoutMs?: number;
  onHit: (hit: SsdpHit) => void;
  onError?: (err: Error) => void;
}): DiscoveryHandle {
  const { timeoutMs = 6000, onHit, onError } = opts;
  const socket = UdpSockets.createSocket({ type: 'udp4' }) as unknown as UdpSocketLike;
  const seen = new Set<string>();
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resendTimer: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    if (resendTimer) clearTimeout(resendTimer);
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  };

  socket.on('error', (err: Error) => {
    onError?.(err);
    stop();
  });

  socket.on('message', (msg: Buffer | Uint8Array, rinfo: { address: string }) => {
    const text = Buffer.isBuffer(msg)
      ? msg.toString('utf8')
      : Buffer.from(msg).toString('utf8');
    const headers = parseSsdpHeaders(text);
    const location = headers['location'];
    if (!location) return;
    const usn = headers['usn'] || location;
    if (seen.has(usn)) return;
    seen.add(usn);
    onHit({
      location,
      st: headers['st'] || headers['nt'] || '',
      usn,
      server: headers['server'],
      address: rinfo?.address || '',
    });
  });

  const sendAll = () => {
    if (closed) return;
    for (const target of SEARCH_TARGETS) {
      const data = Buffer.from(buildMSearch(target), 'utf8');
      socket.send(data, 0, data.length, SSDP_PORT, SSDP_MULTICAST_ADDR, (err?: Error) => {
        if (err) onError?.(err);
      });
    }
  };

  socket.once('listening', () => {
    try {
      socket.setBroadcast(true);
    } catch {
      /* not all platforms require/allow this */
    }
    sendAll();
    // Devices answer within MX seconds; re-probe once to catch slow responders.
    resendTimer = setTimeout(sendAll, 1500);
  });

  // Bind to a random port on all interfaces; replies arrive as unicast here.
  socket.bind(0);

  timer = setTimeout(stop, timeoutMs);
  return { stop };
}
