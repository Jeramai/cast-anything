import {
  DocumentDirectoryPath,
  readFile,
  writeFile,
} from '@dr.pogodin/react-native-fs';

// Persistence for the theme choice. Kept apart from ./themes (which is pure and
// unit-tested) because this pulls in the native filesystem module.

const FILE = `${DocumentDirectoryPath}/theme.json`;

export interface ThemeChoice {
  base: string;
  accent: string;
}

export async function loadThemeChoice(): Promise<Partial<ThemeChoice>> {
  try {
    const parsed = JSON.parse(await readFile(FILE, 'utf8'));
    return {
      base: typeof parsed?.base === 'string' ? parsed.base : undefined,
      accent: typeof parsed?.accent === 'string' ? parsed.accent : undefined,
    };
  } catch {
    return {};
  }
}

export async function saveThemeChoice(choice: ThemeChoice): Promise<void> {
  try {
    await writeFile(FILE, JSON.stringify(choice), 'utf8');
  } catch {
    /* best effort */
  }
}
