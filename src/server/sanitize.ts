/** Keep filenames URL/filesystem-safe while preserving the extension. */
export function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');
  return cleaned.replace(/^_+|_+$/g, '') || `media-${Date.now()}`;
}
