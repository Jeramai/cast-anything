/**
 * Minimal URL helpers. React Native's built-in `URL` polyfill does not reliably
 * resolve relative references against a base, so we parse with regex instead.
 */

export interface UrlParts {
  scheme: string;
  host: string;
  port: string;
  path: string;
  /** scheme://host[:port] */
  origin: string;
}

export function parseUrl(url: string): UrlParts {
  const m = /^(https?):\/\/([^/:?#]+)(?::(\d+))?([^?#]*)/i.exec(url.trim());
  if (!m) {
    return { scheme: 'http', host: '', port: '', path: '/', origin: '' };
  }
  const scheme = m[1].toLowerCase();
  const host = m[2];
  const port = m[3] || '';
  const path = m[4] || '/';
  const origin = port ? `${scheme}://${host}:${port}` : `${scheme}://${host}`;
  return { scheme, host, port, path, origin };
}

/**
 * True if `host` is an address that other devices on the LAN (e.g. a TV) cannot
 * reach back: loopback, link-local, or an Android emulator's NAT address. Used
 * to warn when local-file casting is attempted from an emulator.
 */
export function isUnreachableByLan(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '10.0.2.15' || // Android emulator (AVD) NAT address for the guest
    host === '10.0.3.15' || // Genymotion
    host.startsWith('127.') ||
    host.startsWith('169.254.') // link-local (no DHCP lease)
  );
}

/** Resolve a possibly-relative reference against a base URL. */
export function resolveUrl(base: string, ref: string): string {
  if (!ref) return base;
  if (/^https?:\/\//i.test(ref)) return ref;
  const { origin, path } = parseUrl(base);
  if (ref.startsWith('/')) return origin + ref;
  const dir = path.replace(/\/[^/]*$/, '/');
  return origin + (dir || '/') + ref;
}
