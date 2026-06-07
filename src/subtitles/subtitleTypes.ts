// Pure helpers for restricting subtitle file selection. Kept free of native
// imports so it can be unit-tested.

/** Subtitle file extensions we accept (SubRip / WebVTT / SubStation / MicroDVD). */
export const SUBTITLE_EXTENSIONS = ['srt', 'vtt', 'ass', 'ssa', 'sub'] as const;

/**
 * MIME types handed to the document picker to narrow it toward subtitles.
 * Android registers `.srt` inconsistently (often `text/plain`, sometimes no
 * MIME at all), so we include the broad text types to keep real subtitle files
 * selectable and rely on `isSubtitleFile()` to reject anything else afterwards.
 */
export const SUBTITLE_MIME_TYPES = [
  'application/x-subrip',
  'application/x-subtitle',
  'text/vtt',
  'text/plain',
  'application/octet-stream',
];

/** True when a filename has a recognised subtitle extension. */
export function isSubtitleFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase();
  return !!ext && (SUBTITLE_EXTENSIONS as readonly string[]).includes(ext);
}
