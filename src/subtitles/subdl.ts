import { Buffer } from 'buffer';
import { unzipSync } from 'fflate';

// SUBDL subtitle client (https://subdl.com). Single free API key, no login —
// search returns zip URLs; we download + unzip the .srt. Pure (fetch + fflate), so
// it's unit-testable with a mocked fetch.

const API = 'https://api.subdl.com/api/v1';
const DL = 'https://dl.subdl.com';

export interface SubtitleResult {
  /** Zip path on dl.subdl.com, e.g. "/subtitle/205288-612109.zip". */
  url: string;
  /** Language code, e.g. "EN". */
  language: string;
  /** Release/title label for the picker. */
  release: string;
}

export async function searchSubtitles(
  apiKey: string,
  query: string,
  language: string,
): Promise<SubtitleResult[]> {
  if (!apiKey) throw new Error('Add your SUBDL API key in Settings first.');
  const url =
    `${API}/subtitles?api_key=${encodeURIComponent(apiKey)}` +
    `&film_name=${encodeURIComponent(query)}` +
    `&languages=${encodeURIComponent(language.toUpperCase())}&subs_per_page=30`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Subtitle search failed (HTTP ${res.status}).`);
  const json = await res.json();
  if (json?.status === false) throw new Error(json?.error || 'No subtitles found.');
  const subs: any[] = Array.isArray(json?.subtitles) ? json.subtitles : [];
  return subs
    .filter((s) => s?.url)
    .map((s) => ({
      url: s.url,
      language: String(s.language || s.lang || '?'),
      release: s.release_name || s.name || 'subtitle',
    }));
}

/** Download the result's zip and return the .srt text it contains. */
export async function downloadSubtitle(zipPath: string): Promise<string> {
  const full = zipPath.startsWith('http') ? zipPath : `${DL}${zipPath}`;
  const res = await fetch(full);
  if (!res.ok) throw new Error(`Subtitle download failed (HTTP ${res.status}).`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const files = unzipSync(bytes);
  const name = Object.keys(files).find((n) => /\.(srt|vtt)$/i.test(n));
  if (!name) throw new Error('No subtitle (.srt) found in the downloaded archive.');
  return Buffer.from(files[name]).toString('utf8');
}
