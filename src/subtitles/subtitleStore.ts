import { DocumentDirectoryPath, readFile, writeFile } from '@dr.pogodin/react-native-fs';

// Persists the SUBDL API key (a single key, no login). Kept out of the pure
// ./subdl client because this pulls in the native filesystem module.

// Baked-in default key. The Settings field overrides this (saved to disk), so
// you can swap keys without a rebuild. Note: this is shipped in the APK and is
// extractable from any build — it's a free, revocable SUBDL key, so regenerate
// it in the SUBDL dashboard if it ever leaks.
const BUILTIN_KEY = 'subdl_8VVyKMa8zzo6K4yZHTIiGPgBucZyPRQwmGK39Jv5ixM';

const FILE = `${DocumentDirectoryPath}/subdl.json`;

export async function loadApiKey(): Promise<string> {
  try {
    const parsed = JSON.parse(await readFile(FILE, 'utf8'));
    if (typeof parsed?.apiKey === 'string' && parsed.apiKey) return parsed.apiKey;
  } catch {
    /* no saved key — fall through to the baked-in default */
  }
  return BUILTIN_KEY;
}

export async function saveApiKey(apiKey: string): Promise<void> {
  try {
    await writeFile(FILE, JSON.stringify({ apiKey }), 'utf8');
  } catch {
    /* best effort */
  }
}
