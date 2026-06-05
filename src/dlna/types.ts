/** Media categories we know how to advertise to a DLNA renderer. */
export type MediaKind = 'video' | 'audio' | 'image';

/** A raw SSDP discovery hit, before we fetch the device description. */
export interface SsdpHit {
  /** URL of the device description XML (the SSDP `LOCATION` header). */
  location: string;
  /** Search target / notification type the device answered with. */
  st: string;
  /** Unique Service Name — contains the device uuid. */
  usn: string;
  /** `SERVER` header, e.g. "Linux/4.1 UPnP/1.0 ...". */
  server?: string;
  /** IP address the datagram came from (from `rinfo`). */
  address: string;
}

/** A fully-resolved DLNA media renderer we can cast to. */
export interface DlnaDevice {
  /** Stable id (device uuid from USN, falls back to location). */
  id: string;
  friendlyName: string;
  manufacturer: string;
  modelName?: string;
  deviceType: string;
  /** Device description URL. */
  location: string;
  /** scheme://host[:port] of the device. */
  origin: string;
  /** LAN IP of the device. */
  address: string;
  /** Absolute AVTransport control URL (required to play media). */
  avTransportControlURL?: string;
  /** Absolute AVTransport service-description (SCPD) URL, for diagnostics. */
  avTransportSCPDURL?: string;
  /** Absolute RenderingControl control URL (for volume), if advertised. */
  renderingControlURL?: string;
  /** True when the manufacturer string looks like a Samsung TV. */
  isSamsung: boolean;
  /** True when the device looks like a Samsung signage panel (uses MDC, not DLNA push). */
  isSignage: boolean;
}

export type TransportState =
  | 'STOPPED'
  | 'PLAYING'
  | 'PAUSED_PLAYBACK'
  | 'TRANSITIONING'
  | 'NO_MEDIA_PRESENT'
  | string;

export interface TransportInfo {
  state: TransportState;
  status: string;
}

export interface PositionInfo {
  /** Track duration, seconds (0 if unknown). */
  duration: number;
  /** Current relative playback position, seconds. */
  position: number;
  /** URI currently loaded on the renderer. */
  trackURI: string;
}
