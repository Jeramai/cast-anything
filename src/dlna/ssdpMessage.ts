// Pure SSDP message helpers — building the M-SEARCH request and parsing response
// headers. No sockets, so it's unit-testable; ./ssdp does the UDP I/O.

export const SSDP_MULTICAST_ADDR = '239.255.255.250';
export const SSDP_PORT = 1900;

/**
 * Search targets, broad → narrow. Samsung TVs answer to MediaRenderer; we also
 * probe AVTransport and `ssdp:all` so we still find renderers that only
 * advertise the service, not the device type.
 */
export const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:MediaRenderer:1',
  'urn:schemas-upnp-org:service:AVTransport:1',
  'ssdp:all',
];

export function buildMSearch(searchTarget: string, mx = 2): string {
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

export function parseSsdpHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\r\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      out[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
  }
  return out;
}
