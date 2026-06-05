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
  // DLNA.ORG_OP is two bits: <time-seek><byte-seek>.
  //   video/audio → OP=11 (BOTH time- and byte-seek). We must advertise
  //     time-seek (the first 1): the UPnP `Seek` action uses Unit=REL_TIME, and
  //     Samsung renderers honor exactly what we claim — with OP=01 (byte only)
  //     they reject every REL_TIME seek with UPnP 701 "Transition not available".
  //     With OP=11 they accept it and perform a byte-range GET at the computed
  //     offset, which our Range-capable server handles.
  //   image → OP=00 (no seek). Advertising a photo with the streaming/seek flags
  //     makes Samsung reject the item with UPnP 402 (Invalid Args).
  const dlnaFlags =
    opts.kind === 'image'
      ? 'DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=00f00000000000000000000000000000'
      : 'DLNA.ORG_OP=11;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000';
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
async function setAVTransportURI(
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

/**
 * Seek to an absolute position. `unit` defaults to the standard `REL_TIME`, but
 * Samsung renderers reject that with 701 and require their proprietary
 * `X_DLNA_SeekTime` instead (both take an "H:MM:SS" target). See {@link SEEK_UNITS}.
 */
export async function seek(
  device: DlnaDevice,
  seconds: number,
  unit: string = 'REL_TIME',
): Promise<void> {
  await soapAction(requireAvTransport(device), AV_TRANSPORT, 'Seek', {
    InstanceID: '0',
    Unit: unit,
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

/** Read the current Master volume (0–100). Returns null if unsupported. */
export async function getVolume(device: DlnaDevice): Promise<number | null> {
  if (!device.renderingControlURL) return null;
  const doc = await soapAction(
    device.renderingControlURL,
    RENDERING_CONTROL,
    'GetVolume',
    { InstanceID: '0', Channel: 'Master' },
  );
  const raw = doc?.Envelope?.Body?.GetVolumeResponse?.CurrentVolume;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
}

/**
 * Seek to an absolute BYTE offset using Samsung's `X_DLNA_SeekByte` mode. Some
 * Samsung renderers reject every time-based seek (701) but accept byte seeks —
 * the offset is derived from the file size and the elapsed-time fraction.
 */
export async function seekBytes(
  device: DlnaDevice,
  byteOffset: number,
): Promise<void> {
  await soapAction(requireAvTransport(device), AV_TRANSPORT, 'Seek', {
    InstanceID: '0',
    Unit: 'X_DLNA_SeekByte',
    Target: String(Math.max(0, Math.floor(byteOffset))),
  });
}

/**
 * Which transport actions the renderer will accept *right now* (comma-separated,
 * e.g. "Play,Pause,Seek,Stop"). Useful to tell whether a device actually permits
 * Seek in its current state, vs. just declaring it in its service description.
 */
export async function getCurrentTransportActions(
  device: DlnaDevice,
): Promise<string> {
  const doc = await soapAction(
    requireAvTransport(device),
    AV_TRANSPORT,
    'GetCurrentTransportActions',
    { InstanceID: '0' },
  );
  const r = doc?.Envelope?.Body?.GetCurrentTransportActionsResponse ?? {};
  return String(r.Actions || '');
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
async function inspectDevice(device: DlnaDevice): Promise<void> {
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
    try {
      await play(device);
    } catch (err) {
      // Samsung (e.g. The Freestyle) auto-plays on SetAVTransportURI, so an
      // explicit Play comes back 701 "Transition not available" (it's already
      // playing). That's success, not a failure — the caller's polling confirms.
      if (err instanceof Error && /\b701\b/.test(err.message)) {
        console.warn('[DLNA] Play returned 701 (already auto-playing) — continuing');
      } else {
        throw err;
      }
    }
  } catch (err) {
    // Log what the device actually supports to aid diagnosis, then rethrow.
    inspectDevice(device).catch(() => {});
    throw err;
  }
}
