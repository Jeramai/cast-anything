import {
  DocumentDirectoryPath,
  readFile,
  writeFile,
} from '@dr.pogodin/react-native-fs';

/** The full color palette the UI is built from. */
export interface ThemePalette {
  bg: string;
  card: string;
  cardActive: string;
  border: string;
  accent: string;
  /** Subtle accent-tinted surface for selected items (derived from base + accent). */
  accentDim: string;
  text: string;
  textDim: string;
  danger: string;
  good: string;
  /** True for dark bases — drives the status bar style. */
  isDark: boolean;
}

// ---- Bases: the neutral surface/text colors (no accent) ----
export interface ThemeBase {
  key: string;
  name: string;
  bg: string;
  card: string;
  cardActive: string;
  border: string;
  text: string;
  textDim: string;
  isDark: boolean;
}

export const BASES: ThemeBase[] = [
  { key: 'dark', name: 'Dark', bg: '#0b0f17', card: '#151b27', cardActive: '#1d2740', border: '#222c3d', text: '#e8edf6', textDim: '#8a97ab', isDark: true },
  { key: 'amoled', name: 'AMOLED', bg: '#000000', card: '#050506', cardActive: '#101012', border: '#1c1c1f', text: '#f5f5f7', textDim: '#8a8a92', isDark: true },
  { key: 'gray', name: 'Gray', bg: '#18191c', card: '#212226', cardActive: '#2c2e33', border: '#383a40', text: '#ededf0', textDim: '#9a9ca4', isDark: true },
  { key: 'midnight', name: 'Midnight', bg: '#0a0e1a', card: '#121a2e', cardActive: '#1b2545', border: '#28345a', text: '#e6ecff', textDim: '#8893b5', isDark: true },
  { key: 'nord', name: 'Nord', bg: '#2e3440', card: '#3b4252', cardActive: '#434c5e', border: '#4c566a', text: '#eceff4', textDim: '#aab1c0', isDark: true },
  { key: 'solarized', name: 'Solarized', bg: '#002b36', card: '#073642', cardActive: '#0b4250', border: '#155e6b', text: '#eee8d5', textDim: '#93a1a1', isDark: true },
  { key: 'forest', name: 'Forest', bg: '#0c1410', card: '#14201a', cardActive: '#1d2e25', border: '#294034', text: '#e6f0e9', textDim: '#8fa896', isDark: true },
  { key: 'coffee', name: 'Coffee', bg: '#1b1410', card: '#271e17', cardActive: '#34281c', border: '#3f3020', text: '#f0e6d8', textDim: '#ab9986', isDark: true },
  { key: 'light', name: 'Light', bg: '#eef1f6', card: '#ffffff', cardActive: '#e6eaf2', border: '#d4dae6', text: '#131722', textDim: '#5a6473', isDark: false },
  { key: 'sepia', name: 'Sepia', bg: '#f3ece0', card: '#fbf6ec', cardActive: '#ece1cf', border: '#ddcdb4', text: '#2b2418', textDim: '#6b5d48', isDark: false },
];

// ---- Accents: the highlight color ----
export interface ThemeAccent {
  key: string;
  name: string;
  color: string;
}

export const ACCENTS: ThemeAccent[] = [
  { key: 'blue', name: 'Blue', color: '#4f8cff' },
  { key: 'indigo', name: 'Indigo', color: '#6366f1' },
  { key: 'violet', name: 'Violet', color: '#8b5cf6' },
  { key: 'fuchsia', name: 'Fuchsia', color: '#d946ef' },
  { key: 'pink', name: 'Pink', color: '#ec4899' },
  { key: 'rose', name: 'Rose', color: '#fb7185' },
  { key: 'red', name: 'Red', color: '#ef4444' },
  { key: 'firebrick', name: 'Firebrick', color: '#b22222' },
  { key: 'orange', name: 'Orange', color: '#fb923c' },
  { key: 'amber', name: 'Amber', color: '#fbbf24' },
  { key: 'lime', name: 'Lime', color: '#a3e635' },
  { key: 'emerald', name: 'Emerald', color: '#34d399' },
  { key: 'teal', name: 'Teal', color: '#2dd4bf' },
  { key: 'cyan', name: 'Cyan', color: '#22d3ee' },
  { key: 'sky', name: 'Sky', color: '#38bdf8' },
  { key: 'slate', name: 'Slate', color: '#9aa6b8' },
];

// Default to following the OS light/dark setting on first launch.
export const DEFAULT_BASE_KEY = 'system';
export const DEFAULT_ACCENT_KEY = 'blue';

/** Special base key: follow the OS light/dark setting. */
export const SYSTEM_BASE_KEY = 'system';

/** Resolve a (possibly "system") base key to a concrete one for the OS scheme. */
export function resolveBaseKey(baseKey: string, systemIsDark: boolean): string {
  if (baseKey === SYSTEM_BASE_KEY) return systemIsDark ? 'dark' : 'light';
  return baseKey;
}

// ---- Color mixing (for the derived accentDim) ----
function hexToRgb(h: string): [number, number, number] {
  const n = parseInt(h.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(a: string, b: string, t: number): string {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  const c = A.map((x, i) => Math.round(x + (B[i] - x) * t));
  return '#' + c.map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function composePalette(
  baseKey: string | null | undefined,
  accentKey: string | null | undefined,
): ThemePalette {
  const base = BASES.find((b) => b.key === baseKey) ?? BASES[0];
  const accent = (ACCENTS.find((a) => a.key === accentKey) ?? ACCENTS[0]).color;
  return {
    bg: base.bg,
    card: base.card,
    cardActive: base.cardActive,
    border: base.border,
    text: base.text,
    textDim: base.textDim,
    isDark: base.isDark,
    danger: '#ff5d6c',
    good: '#3ddc97',
    accent,
    // A selected-surface tint that suits the base: mostly the card color with a
    // touch of accent, so it's a dark tint on dark bases and a light one on light.
    accentDim: mix(base.card, accent, 0.22),
  };
}

// ---- Persistence ----
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
