import { XMLParser } from 'fast-xml-parser';
import type {
  DlnaDevice,
  MediaKind,
  PositionInfo,
  TransportInfo,
} from './types';

const AV_TRANSPORT = 'urn:schemas-upnp-org:service:AVTransport:1';
const RENDERING_CONTROL = 'urn:schemas-upnp-org:service:RenderingControl:1';

const responseParser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
});

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (c) =>
    c === '<'
      ? '&lt;'
      : c === '>'
        ? '&gt;'
        : c === '&'
          ? '&amp;'
          : c === "'"
            ? '&apos;'
            : '&quot;',
  );
}

/** seconds → "H:MM:SS" as required by the UPnP REL_TIME format. */
export function secondsToHms(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/** "H:MM:SS(.fff)" → seconds. Returns 0 for unknown / "NOT_IMPLEMENTED". */
export function hmsToSeconds(hms: string): number {
  if (!hms || /not_implemented/i.test(hms)) return 0;
  const parts = hms.split(':').map((p) => parseFloat(p));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  while (parts.length < 3) parts.unshift(0);
  const [h, m, s] = parts;
  return Math.floor(h * 3600 + m * 60 + s);
}

function upnpClassFor(kind: MediaKind): string {
  switch (kind) {
    case 'video':
      return 'object.item.videoItem';
    case 'audio':
      return 'object.item.audioItem.musicTrack';
    case 'image':
      return 'object.item.imageItem.photo';
  }
}

/**
 * Build DIDL-Lite metadata for the item. Samsung TVs are picky: without valid
 * metadata (title + upnp:class + a `res` with a sensible protocolInfo) they may
 * refuse to start playback or show no title.
 */
export function buildDidlMetadata(opts: {
  url: string;
  title: string;
  kind: MediaKind;
  mime: string;
}): string {
  // Images aren't seekable streams, so they need different DLNA operation/flag
  // values than audio/video. Advertising a photo with the streaming/seek flags
  // (OP=01) makes Samsung reject the item with UPnP 402 (Invalid Args).
  //   video/audio → OP=01 (byte-seek) + streaming-transfer flags
  //   image       → OP=00 (no seek)  + interactive/background-transfer flags
  const dlnaFlags =
    opts.kind === 'image'
      ? 'DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=00f00000000000000000000000000000'
      : 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000';
  const protocolInfo = `http-get:*:${opts.mime}:${dlnaFlags}`;
  return (
    '<DIDL-Lite ' +
    'xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" ' +
    'xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/">' +
    '<item id="0" parentID="-1" restricted="1">' +
    `<dc:title>${escapeXml(opts.title)}</dc:title>` +
    `<upnp:class>${upnpClassFor(opts.kind)}</upnp:class>` +
    `<res protocolInfo="${protocolInfo}">${escapeXml(opts.url)}</res>` +
    '</item>' +
    '</DIDL-Lite>'
  );
}

async function soapAction(
  controlURL: string,
  serviceType: string,
  action: string,
  args: Record<string, string>,
): Promise<any> {
  const body =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    '<s:Body>' +
    `<u:${action} xmlns:u="${serviceType}">` +
    Object.entries(args)
      .map(([k, v]) => `<${k}>${v}</${k}>`)
      .join('') +
    `</u:${action}>` +
    '</s:Body>' +
    '</s:Envelope>';

  const res = await fetch(controlURL, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      SOAPAction: `"${serviceType}#${action}"`,
    },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    const code = /<errorCode>\s*(\d+)\s*<\/errorCode>/i.exec(text)?.[1];
    const desc = /<errorDescription>([^<]*)<\/errorDescription>/i.exec(text)?.[1];
    // Log the full exchange so it's inspectable in the dev console / Metro logs.
    console.warn(
      `[DLNA] ${action} → HTTP ${res.status}` +
        (code ? ` UPnP ${code}` : '') +
        `\n  control: ${controlURL}` +
        `\n  request: ${body}` +
        `\n  response: ${text.slice(0, 600)}`,
    );
    const parts = [
      code ? `UPnP ${code}` : null,
      desc || (code ? UPNP_ERRORS[code] : null),
    ].filter(Boolean);
    throw new Error(
      `${action} failed (HTTP ${res.status}${parts.length ? `, ${parts.join(' — ')}` : ''})`,
    );
  }
  return responseParser.parse(text);
}

/** Common AVTransport fault codes → plain-language hints. */
const UPNP_ERRORS: Record<string, string> = {
  '402': 'Invalid args (the TV did not accept the request/metadata)',
  '501': 'Action failed',
  '701': 'Transition not available (try Stop first)',
  '714': 'Unsupported media format / MIME type',
  '715': 'Resource is protected',
  '716': "Resource not found — the TV could not reach the media URL",
  '718': 'Invalid InstanceID',
};

function requireAvTransport(device: DlnaDevice): string {
  if (!device.avTransportControlURL) {
    throw new Error(`${device.friendlyName} has no AVTransport service.`);
  }
  return device.avTransportControlURL;
}

/** Load a media URL onto the renderer (does not start playback by itself). */
export async function setAVTransportURI(
  device: DlnaDevice,
  url: string,
  metadata: string,
): Promise<void> {
  await soapAction(requireAvTransport(device), AV_TRANSPORT, 'SetAVTransportURI', {
    InstanceID: '0',
    CurrentURI: escapeXml(url),
    CurrentURIMetaData: escapeXml(metadata),
  });
}

export async function play(device: DlnaDevice): Promise<void> {
  await soapAction(requireAvTransport(device), AV_TRANSPORT, 'Play', {
    InstanceID: '0',
    Speed: '1',
  });
}

export async function pause(device: DlnaDevice): Promise<void> {
  await soapAction(requireAvTransport(device), AV_TRANSPORT, 'Pause', {
    InstanceID: '0',
  });
}

export async function stop(device: DlnaDevice): Promise<void> {
  await soapAction(requireAvTransport(device), AV_TRANSPORT, 'Stop', {
    InstanceID: '0',
  });
}

export async function seek(device: DlnaDevice, seconds: number): Promise<void> {
  await soapAction(requireAvTransport(device), AV_TRANSPORT, 'Seek', {
    InstanceID: '0',
    Unit: 'REL_TIME',
    Target: secondsToHms(seconds),
  });
}

export async function getTransportInfo(
  device: DlnaDevice,
): Promise<TransportInfo> {
  const doc = await soapAction(
    requireAvTransport(device),
    AV_TRANSPORT,
    'GetTransportInfo',
    { InstanceID: '0' },
  );
  const r = doc?.Envelope?.Body?.GetTransportInfoResponse ?? {};
  return {
    state: String(r.CurrentTransportState || 'NO_MEDIA_PRESENT'),
    status: String(r.CurrentTransportStatus || ''),
  };
}

export async function getPositionInfo(
  device: DlnaDevice,
): Promise<PositionInfo> {
  const doc = await soapAction(
    requireAvTransport(device),
    AV_TRANSPORT,
    'GetPositionInfo',
    { InstanceID: '0' },
  );
  const r = doc?.Envelope?.Body?.GetPositionInfoResponse ?? {};
  return {
    duration: hmsToSeconds(String(r.TrackDuration || '')),
    position: hmsToSeconds(String(r.RelTime || '')),
    trackURI: String(r.TrackURI || ''),
  };
}

/** Set volume 0–100 via RenderingControl, if the device advertises it. */
export async function setVolume(
  device: DlnaDevice,
  volume: number,
): Promise<void> {
  if (!device.renderingControlURL) return;
  const clamped = Math.max(0, Math.min(100, Math.round(volume)));
  await soapAction(
    device.renderingControlURL,
    RENDERING_CONTROL,
    'SetVolume',
    {
      InstanceID: '0',
      Channel: 'Master',
      DesiredVolume: String(clamped),
    },
  );
}

/**
 * Dev diagnostic: log what the device's AVTransport service actually supports.
 * Useful when a cast is rejected — e.g. signage panels that advertise the
 * service but don't implement generic DLNA "play to" push.
 */
export async function inspectDevice(device: DlnaDevice): Promise<void> {
  console.log('[DLNA] inspecting', device.friendlyName, {
    deviceType: device.deviceType,
    control: device.avTransportControlURL,
    scpd: device.avTransportSCPDURL,
  });

  // 1) Does a simple read action work? If this succeeds but SetAVTransportURI
  //    fails, the service is alive but rejects pushing media to it.
  try {
    const info = await getTransportInfo(device);
    console.log('[DLNA] GetTransportInfo OK:', info);
  } catch (e) {
    console.warn(
      '[DLNA] GetTransportInfo failed:',
      e instanceof Error ? e.message : e,
    );
  }

  // 2) Which actions does the AVTransport service declare?
  if (device.avTransportSCPDURL) {
    try {
      const res = await fetch(device.avTransportSCPDURL);
      const xml = await res.text();
      const actions = Array.from(
        xml.matchAll(/<action>\s*<name>\s*([^<]+?)\s*<\/name>/gi),
      ).map((m) => m[1]);
      console.log(
        `[DLNA] AVTransport declares ${actions.length} actions:`,
        actions.join(', ') || '(none parsed)',
      );
      console.log('[DLNA] supports SetAVTransportURI:', actions.includes('SetAVTransportURI'));
    } catch (e) {
      console.warn('[DLNA] SCPD fetch failed:', e instanceof Error ? e.message : e);
    }
  }
}

/** Convenience: load metadata + URL, then start playback. */
export async function castMedia(
  device: DlnaDevice,
  opts: { url: string; title: string; kind: MediaKind; mime: string },
): Promise<void> {
  const metadata = buildDidlMetadata(opts);
  try {
    try {
      await setAVTransportURI(device, opts.url, metadata);
    } catch (err) {
      // Some renderers (notably Samsung signage) reject our DIDL metadata with
      // UPnP 402 (Invalid Args). Retry once with empty metadata so the renderer
      // infers it from the resource itself.
      if (err instanceof Error && /\b402\b/.test(err.message)) {
        console.warn('[DLNA] retrying SetAVTransportURI with empty metadata');
        await setAVTransportURI(device, opts.url, '');
      } else {
        throw err;
      }
    }
    await play(device);
  } catch (err) {
    // Log what the device actually supports to aid diagnosis, then rethrow.
    inspectDevice(device).catch(() => {});
    throw err;
  }
}
