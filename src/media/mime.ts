import type { MediaKind } from '../dlna/types';

// Pure MIME/kind inference + the MediaItem shape — no native imports, so it's
// unit-testable. The system file picker lives in ./media (which imports it).

export interface MediaItem {
  /** Local file:// uri (picked file) or a remote http(s) URL. */
  uri: string;
  name: string;
  mime: string;
  kind: MediaKind;
  size?: number;
  /** True when `uri` is a local file that must be served over HTTP. */
  isLocal: boolean;
  /**
   * True for a live stream (HLS `.m3u8`): infinite, non-seekable, and the
   * renderer needs live DLNA flags instead of VOD seek flags. See
   * {@link isHlsMime} and the `live` branch of avtransport's contentFeatures.
   */
  live?: boolean;
}

/** Apple HLS playlist MIME — the canonical one Samsung/DLNA renderers expect. */
export const HLS_MIME = 'application/vnd.apple.mpegurl';

const EXT_TO_MIME: Record<string, string> = {
  // video
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  webm: 'video/webm',
  ts: 'video/mp2t',
  m3u8: HLS_MIME,
  // audio
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  // image
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  heic: 'image/heic',
};

/** Lowercased file extension from a name or URL (sans query/hash). */
export function extensionOf(nameOrUrl: string): string {
  const clean = nameOrUrl.split(/[?#]/)[0];
  const dot = clean.lastIndexOf('.');
  return dot >= 0 ? clean.slice(dot + 1).toLowerCase() : '';
}

export function kindFromMime(mime: string): MediaKind {
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('image/')) return 'image';
  return 'video';
}

/** True for an HLS playlist MIME (`application/vnd.apple.mpegurl`, `x-mpegURL`). */
export function isHlsMime(mime: string): boolean {
  return /mpegurl/i.test(mime);
}

/** Best-effort MIME from an explicit value or a filename/URL extension. */
export function guessMime(nameOrUrl: string, explicit?: string | null): string {
  if (explicit && explicit !== 'application/octet-stream') return explicit;
  const ext = extensionOf(nameOrUrl);
  return EXT_TO_MIME[ext] || 'video/mp4';
}

/** Build a MediaItem for a remote URL the user typed in. */
export function mediaFromUrl(url: string): MediaItem {
  const trimmed = url.trim();
  const name = decodeURIComponent(trimmed.split(/[?#]/)[0].split('/').pop() || 'Stream');
  const mime = guessMime(trimmed);
  // HLS is detected by the .m3u8 extension OR the playlist token appearing
  // anywhere in the URL (many stream links carry no extension at all).
  const live = isHlsMime(mime) || /\bm3u8\b/i.test(trimmed);
  return {
    uri: trimmed,
    name,
    mime: live ? HLS_MIME : mime,
    kind: kindFromMime(mime),
    isLocal: false,
    live,
  };
}
