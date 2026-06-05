import { XMLParser } from 'fast-xml-parser';
import type { DlnaDevice, SsdpHit } from './types';
import { parseUrl, resolveUrl } from './url';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Strip namespace prefixes (dlna:, etc.) so node names are predictable.
  removeNSPrefix: true,
  parseTagValue: false,
});

interface RawService {
  serviceType?: string;
  controlURL?: string;
  SCPDURL?: string;
}

/** Flatten serviceList across the root device and any embedded devices. */
function collectServices(device: any): RawService[] {
  const out: RawService[] = [];
  const list = device?.serviceList?.service;
  if (Array.isArray(list)) out.push(...list);
  else if (list) out.push(list);

  const sub = device?.deviceList?.device;
  const subs = Array.isArray(sub) ? sub : sub ? [sub] : [];
  for (const d of subs) out.push(...collectServices(d));
  return out;
}

function extractUuid(usn: string): string | null {
  const m = /uuid:([0-9a-z-]+)/i.exec(usn || '');
  return m ? m[1] : null;
}

/**
 * Fetch and parse a device description, returning a renderer we can cast to,
 * or `null` if the device is unreachable / not a media renderer.
 */
export async function fetchDevice(hit: SsdpHit): Promise<DlnaDevice | null> {
  let xml: string;
  try {
    const res = await fetch(hit.location, { method: 'GET' });
    if (!res.ok) return null;
    xml = await res.text();
  } catch {
    return null;
  }

  let doc: any;
  try {
    doc = parser.parse(xml);
  } catch {
    return null;
  }

  const root = doc?.root ?? doc;
  const device = root?.device;
  if (!device) return null;

  // Control URLs resolve against <URLBase> if present, else the description URL.
  const base: string = root?.URLBase ? String(root.URLBase) : hit.location;
  const services = collectServices(device);

  const serviceFor = (typeFragment: string): RawService | undefined =>
    services.find((s) => String(s.serviceType || '').includes(typeFragment));

  const controlUrlFor = (typeFragment: string): string | undefined => {
    const svc = serviceFor(typeFragment);
    return svc?.controlURL ? resolveUrl(base, String(svc.controlURL)) : undefined;
  };

  const avTransport = serviceFor('AVTransport');
  const avTransportControlURL = avTransport?.controlURL
    ? resolveUrl(base, String(avTransport.controlURL))
    : undefined;
  // No AVTransport => not something we can play media on.
  if (!avTransportControlURL) return null;
  const avTransportSCPDURL = avTransport?.SCPDURL
    ? resolveUrl(base, String(avTransport.SCPDURL))
    : undefined;

  const manufacturer = String(device.manufacturer || '');
  const friendlyName = String(device.friendlyName || 'Unknown device');
  const { origin } = parseUrl(hit.location);

  return {
    id: extractUuid(hit.usn) || hit.location,
    friendlyName,
    manufacturer,
    modelName: device.modelName ? String(device.modelName) : undefined,
    deviceType: String(device.deviceType || ''),
    location: hit.location,
    origin,
    address: hit.address || parseUrl(hit.location).host,
    avTransportControlURL,
    avTransportSCPDURL,
    renderingControlURL: controlUrlFor('RenderingControl'),
    isSamsung: /samsung/i.test(manufacturer) || /samsung/i.test(friendlyName),
    isSignage:
      /signage/i.test(friendlyName) ||
      /signage/i.test(String(device.modelName || '')),
  };
}
