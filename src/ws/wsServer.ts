import TcpSocket from 'react-native-tcp-socket';
import { Buffer } from 'buffer';
import { acceptKey, encodeText, parseFrames } from './wsCodec';

/**
 * Minimal WebSocket server (RFC 6455) built on react-native-tcp-socket, so the
 * signage player page gets an event-driven channel instead of polling: the app
 * pushes media/controls instantly, and the panel streams playback status back.
 *
 * Only what we need: text frames, single-frame messages, client→server unmask,
 * server→client unmasked. Good enough for small JSON control messages. The
 * pure RFC 6455 codec (accept key / framing) lives in ./wsCodec.
 */

const WS_PORT = 51800;

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

export function getWsPort(): number {
  return WS_PORT;
}
