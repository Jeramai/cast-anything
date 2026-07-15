import UdpSockets from 'react-native-udp';
import { Buffer } from 'buffer';
import type { SsdpHit } from './types';
import {
  buildMSearch,
  parseSsdpHeaders,
  SEARCH_TARGETS,
  SSDP_MULTICAST_ADDR,
  SSDP_PORT,
} from './ssdpMessage';

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
  // Once the socket is bound, errors are non-fatal (a failed multicast send on one
  // interface, setBroadcast being unsupported, or the socket closing at timeout).
  // Only a *pre-listening* error means the socket is unusable.
  let listening = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resendTimer: ReturnType<typeof setInterval> | undefined;

  const stop = () => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    if (resendTimer) clearInterval(resendTimer);
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  };

  socket.on('error', (err: Error) => {
    if (!listening) {
      // Bind failed / socket unusable → surface it and give up.
      onError?.(err);
      stop();
    } else {
      // Benign post-bind error. Do NOT abort discovery or surface a toast: a send
      // failure on one interface, or the socket closing at timeout, must not hide
      // the devices that DID answer — nor show a scary error when none did.
      console.warn('[ssdp] socket error (ignored, discovery continues):', err);
    }
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
    listening = true;
    try {
      // Not required for multicast SSDP; best-effort and its async failure is now
      // non-fatal (see the 'error' handler above).
      socket.setBroadcast(true);
    } catch {
      /* not all platforms require/allow this */
    }
    sendAll();
    // Multicast is unreliable and slow devices answer late, so re-probe repeatedly
    // across the window rather than once — this markedly reduces "found nothing on
    // the first scan" flakiness. Cleared by stop() at timeoutMs.
    resendTimer = setInterval(sendAll, 1200);
  });

  // Bind to a random port on all interfaces; replies arrive as unicast here.
  socket.bind(0);

  timer = setTimeout(stop, timeoutMs);
  return { stop };
}
