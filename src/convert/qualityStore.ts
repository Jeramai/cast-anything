import { DocumentDirectoryPath, readFile, writeFile } from '@dr.pogodin/react-native-fs';
import { DEFAULT_CONVERT_QUALITY, toConvertQuality, type ConvertQuality } from './quality';

// Persists the chosen convert speed/quality preset (see ./quality). Kept out of the
// pure ./quality module because this pulls in the native filesystem. Mirrors the
// subtitleStore pattern (single small JSON file, best-effort read/write).

const FILE = `${DocumentDirectoryPath}/convert-quality.json`;

export async function loadConvertQuality(): Promise<ConvertQuality> {
  try {
    const parsed = JSON.parse(await readFile(FILE, 'utf8'));
    return toConvertQuality(parsed?.quality);
  } catch {
    return DEFAULT_CONVERT_QUALITY;
  }
}

export async function saveConvertQuality(quality: ConvertQuality): Promise<void> {
  try {
    await writeFile(FILE, JSON.stringify({ quality }), 'utf8');
  } catch {
    /* best effort */
  }
}
