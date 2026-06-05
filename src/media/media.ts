import * as DocumentPicker from 'expo-document-picker';
import type { MediaKind } from '../dlna/types';

export interface MediaItem {
  /** Local file:// uri (picked file) or a remote http(s) URL. */
  uri: string;
  name: string;
  mime: string;
  kind: MediaKind;
  size?: number;
  /** True when `uri` is a local file that must be served over HTTP. */
  isLocal: boolean;
}

const EXT_TO_MIME: Record<string, string> = {
  // video
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  webm: 'video/webm',
  ts: 'video/mp2t',
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

function extensionOf(nameOrUrl: string): string {
  const clean = nameOrUrl.split(/[?#]/)[0];
  const dot = clean.lastIndexOf('.');
  return dot >= 0 ? clean.slice(dot + 1).toLowerCase() : '';
}

export function kindFromMime(mime: string): MediaKind {
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('image/')) return 'image';
  return 'video';
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
  return {
    uri: trimmed,
    name,
    mime,
    kind: kindFromMime(mime),
    isLocal: false,
  };
}

/** Open the system file picker filtered to media types. */
export async function pickMedia(): Promise<MediaItem | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: ['video/*', 'audio/*', 'image/*'],
    copyToCacheDirectory: true,
    multiple: false,
  });

  if (result.canceled || !result.assets?.length) return null;

  const asset = result.assets[0];
  const mime = guessMime(asset.name, asset.mimeType);
  return {
    uri: asset.uri,
    name: asset.name,
    mime,
    kind: kindFromMime(mime),
    size: asset.size ?? undefined,
    isLocal: true,
  };
}
