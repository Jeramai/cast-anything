// Pure DLNA-aware HTTP request parsing + response planning — no sockets or fs, so
// it's unit-testable. mediaServer.ts wires this to real TcpSocket I/O + streaming.
//
// The seek logic lives here: a renderer asks for a byte `Range` or a DLNA
// `TimeSeekRange.dlna.org` (npt time), and we map either to a concrete byte window.

export interface ServedFile {
  /** Absolute filesystem path (no file:// scheme). */
  path: string;
  size: number;
  mime: string;
  /** Duration in seconds; enables TimeSeekRange → byte mapping (0 = unknown). */
  durationSec: number;
  /** The `contentFeatures.dlna.org` value (OP/CI/FLAGS). */
  features: string;
}

export interface HttpRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
}

/** Parse a request head (the text before the blank line) into method/path/headers. */
export function parseHttpHead(head: string): HttpRequest {
  const lines = head.split('\r\n');
  const [method = '', path = ''] = (lines[0] ?? '').split(' ');
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i].indexOf(':');
    if (idx > 0) headers[lines[i].slice(0, idx).trim().toLowerCase()] = lines[i].slice(idx + 1).trim();
  }
  return { method, path, headers };
}

/** npt time can be "84.000" or "0:01:24.000"; return seconds. */
export function nptToSeconds(v: string): number {
  if (v.includes(':')) {
    const p = v.split(':').map((x) => parseFloat(x) || 0);
    const [h, m, s] = p.length === 3 ? p : [0, p[0] ?? 0, p[1] ?? 0];
    return h * 3600 + m * 60 + s;
  }
  return parseFloat(v) || 0;
}

export const npt = (sec: number): string => Math.max(0, sec).toFixed(3);

export interface ResponsePlan {
  status: string;
  headers: Record<string, string>;
  /** Inclusive byte range to stream when hasBody is true. */
  start: number;
  end: number;
  /** True only for a GET with content (not HEAD / 404 / 416). */
  hasBody: boolean;
}

/**
 * Decide the HTTP response for a media request. `date` is injected (rather than
 * read from the clock) so this stays pure and testable. A Date header is required
 * or strict DLNA renderers reject the resource (UPnP 716).
 */
export function planResponse(req: HttpRequest, file: ServedFile | null, date: string): ResponsePlan {
  const isGetOrHead = req.method === 'GET' || req.method === 'HEAD';
  if (!file || !isGetOrHead) {
    return {
      status: '404 Not Found',
      headers: { 'Content-Length': '0', Connection: 'close' },
      start: 0,
      end: -1,
      hasBody: false,
    };
  }

  const base: Record<string, string> = {
    'Content-Type': file.mime,
    Date: date,
    'Accept-Ranges': 'bytes',
    'transferMode.dlna.org': 'Streaming',
    'contentFeatures.dlna.org': file.features,
    Server: 'CastAnything/1.0',
    Connection: 'close',
  };

  const range = req.headers['range'] || '';
  const tsr = req.headers['timeseekrange.dlna.org'] || '';
  let start = 0;
  let end = file.size - 1;
  let status = '200 OK';
  const extra: Record<string, string> = {};

  if (tsr && file.durationSec > 0 && file.size > 0) {
    // DLNA time-seek → map npt seconds to a byte offset (stream from there to EOF).
    const m = tsr.match(/npt\s*=\s*([0-9:.]+)\s*-\s*([0-9:.]*)/i);
    const startSec = m ? nptToSeconds(m[1]) : 0;
    start = Math.max(0, Math.min(file.size - 1, Math.floor((file.size * startSec) / file.durationSec)));
    status = '206 Partial Content';
    extra['Content-Range'] = `bytes ${start}-${end}/${file.size}`;
    extra['TimeSeekRange.dlna.org'] =
      `npt=${npt(startSec)}-${npt(file.durationSec)}/${npt(file.durationSec)} bytes=${start}-${end}/${file.size}`;
  } else {
    const rm = range.match(/bytes\s*=\s*(\d*)-(\d*)/i);
    if (rm && file.size > 0) {
      start = rm[1] ? parseInt(rm[1], 10) : 0;
      end = rm[2] ? Math.min(file.size - 1, parseInt(rm[2], 10)) : file.size - 1;
      if (start > end || start >= file.size) {
        return {
          status: '416 Range Not Satisfiable',
          headers: { ...base, 'Content-Range': `bytes */${file.size}`, 'Content-Length': '0' },
          start: 0,
          end: -1,
          hasBody: false,
        };
      }
      status = '206 Partial Content';
      extra['Content-Range'] = `bytes ${start}-${end}/${file.size}`;
    }
  }

  const length = Math.max(0, end - start + 1);
  return {
    status,
    headers: { ...base, ...extra, 'Content-Length': String(length) },
    start,
    end,
    hasBody: req.method === 'GET',
  };
}
