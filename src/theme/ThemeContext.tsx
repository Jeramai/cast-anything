import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { StyleSheet, useColorScheme } from "react-native";
import * as SystemUI from "expo-system-ui";
import {
  composePalette,
  DEFAULT_ACCENT_KEY,
  DEFAULT_BASE_KEY,
  resolveBaseKey,
  type ThemePalette,
} from "./themes";
import { loadThemeChoice, saveThemeChoice } from "./themeStore";

// ---- Theme context: the active palette + themed stylesheet ----
interface ThemeContextValue {
  C: ThemePalette;
  styles: ReturnType<typeof makeStyles>;
  baseKey: string;
  accentKey: string;
  setBaseKey: (k: string) => void;
  setAccentKey: (k: string) => void;
}
const ThemeContext = createContext<ThemeContextValue | null>(null);
export function useTheme(): ThemeContextValue {
  const v = useContext(ThemeContext);
  if (!v) throw new Error("useTheme must be used within ThemeContext");
  return v;
}

/**
 * Holds the active theme choice (base + accent), derives the palette and themed
 * stylesheet from it, persists changes, and keeps the native root background in
 * sync. Provides all of that to the tree via ThemeContext.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [baseKey, setBaseKey] = useState(DEFAULT_BASE_KEY);
  const [accentKey, setAccentKey] = useState(DEFAULT_ACCENT_KEY);
  const loaded = useRef(false);

  // Load the saved choice once on startup.
  useEffect(() => {
    loadThemeChoice().then((c) => {
      if (c.base) setBaseKey(c.base);
      if (c.accent) setAccentKey(c.accent);
      loaded.current = true;
    });
  }, []);

  // Persist on change (but not before the initial load, so we don't clobber it).
  useEffect(() => {
    if (loaded.current) saveThemeChoice({ base: baseKey, accent: accentKey });
  }, [baseKey, accentKey]);

  // "Auto" base follows the OS light/dark setting (null treated as dark).
  const scheme = useColorScheme();
  const effectiveBaseKey = resolveBaseKey(baseKey, scheme !== "light");
  const C = useMemo(
    () => composePalette(effectiveBaseKey, accentKey),
    [effectiveBaseKey, accentKey],
  );
  const styles = useMemo(() => makeStyles(C), [C]);

  // Keep the native root background in sync so there's no flash of the wrong color.
  useEffect(() => {
    SystemUI.setBackgroundColorAsync(C.bg).catch(() => {});
  }, [C.bg]);

  // Memoize so context consumers don't re-render on unrelated parent renders
  // (setBaseKey/setAccentKey are stable useState setters).
  const themeValue = useMemo(
    () => ({ C, styles, baseKey, accentKey, setBaseKey, setAccentKey }),
    [C, styles, baseKey, accentKey],
  );

  return <ThemeContext.Provider value={themeValue}>{children}</ThemeContext.Provider>;
}

function makeStyles(C: ThemePalette) {
  return StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  scroll: { padding: 8, paddingTop: 8, paddingBottom: 60, gap: 18 },
  scrollWithSheet: { paddingBottom: 130 }, // clear the peeking now-playing sheet
  h1: { color: C.text, fontSize: 30, fontWeight: "800", letterSpacing: -0.5 },
  subtitle: { color: C.textDim, fontSize: 14, marginTop: 2 },
  section: {
    backgroundColor: C.card,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: C.border,
    gap: 10,
  },
  sectionTitle: {
    color: C.textDim,
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  hint: { color: C.textDim, fontSize: 13, lineHeight: 18 },
  // Buttons
  btn: {
    backgroundColor: C.cardActive,
    paddingVertical: 13,
    paddingHorizontal: 16,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 48,
  },
  btnPrimary: { backgroundColor: C.accent },
  btnGhost: { backgroundColor: "transparent", borderWidth: 1, borderColor: C.textDim },
  btnDisabled: { opacity: 0.4 },
  btnPressed: { opacity: 0.75 },
  btnContent: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 },
  btnText: { color: C.text, fontSize: 15, fontWeight: "600" },
  btnTextPrimary: { color: "#fff" },
  btnTextGhost: { color: C.text },
  grow: { flex: 1 },
  fill: { width: "100%" },
  // Devices
  deviceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: 12,
    backgroundColor: C.cardActive,
    borderWidth: 1,
    borderColor: "transparent",
  },
  deviceRowActive: { borderColor: C.accent, backgroundColor: C.accentDim },
  deviceIcon: { fontSize: 24 },
  deviceNameRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  deviceName: { color: C.text, fontSize: 16, fontWeight: "600", flexShrink: 1 },
  signageTag: {
    color: "#fff",
    backgroundColor: C.accent,
    fontSize: 9,
    fontWeight: "800",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 5,
    overflow: "hidden",
  },
  deviceSub: { color: C.textDim, fontSize: 13, marginTop: 2 },
  check: { color: C.accent, fontSize: 20, fontWeight: "800" },
  // Media
  urlRow: { flexDirection: "row", gap: 8, alignItems: "center" },
  input: {
    flex: 1,
    backgroundColor: C.cardActive,
    color: C.text,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    borderWidth: 1,
    borderColor: C.border,
  },
  mediaCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    // Subtle tint sets the selected item apart — no border.
    backgroundColor: C.accentDim,
    borderRadius: 12,
    padding: 12,
  },
  mediaKind: {
    // Fixed dark text — the green tag background is the same in every theme.
    color: "#0b1a12",
    backgroundColor: C.good,
    fontSize: 10,
    fontWeight: "800",
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
    overflow: "hidden",
  },
  mediaName: { color: C.text, fontSize: 14, flex: 1 },
  clearX: { color: C.textDim, fontSize: 16, fontWeight: "700" },
  pickRow: { flexDirection: "row", gap: 10 },
  queueRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 9,
    paddingHorizontal: 10,
    borderRadius: 10,
    backgroundColor: C.card,
    marginBottom: 6,
  },
  queueRowActive: { backgroundColor: C.accentDim },
  queueRowDisabled: { opacity: 0.45 },
  queueName: { color: C.text, fontSize: 13 },
  queueNote: { color: C.textDim, fontSize: 11, marginTop: 2 },
  queueActions: { flexDirection: "row", gap: 8, marginTop: 4 },
  subActiveRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: C.accentDim,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 4,
  },
  subActiveText: { color: C.text, fontSize: 13, flex: 1 },
  subResults: { maxHeight: 260, marginTop: 10 },
  subResultRow: {
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.border,
  },
  subResultTitle: { color: C.text, fontSize: 14 },
  subResultMeta: { color: C.textDim, fontSize: 12, marginTop: 2 },
  outChip: {
    paddingHorizontal: 11,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
  },
  outChipOn: { backgroundColor: C.accentDim, borderColor: C.accent },
  outChipText: { color: C.textDim, fontSize: 12, fontWeight: "600" },
  outChipTextOn: { color: C.text },
  // Translucent fill overlaid on the (accent) primary button to show send progress.
  btnProgressFill: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: "rgba(255,255,255,0.28)",
  },
  // Now playing
  nowTitle: { color: C.text, fontSize: 17, fontWeight: "700" },
  statusLabel: { color: C.accent, fontSize: 12, fontWeight: "700", letterSpacing: 1 },
  progressTrackTappable: { paddingVertical: 6, marginTop: 2 },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: C.cardActive,
    overflow: "hidden",
    marginTop: 6,
  },
  progressFill: { height: 6, backgroundColor: C.accent, borderRadius: 3 },
  timeRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 4 },
  timeText: { color: C.textDim, fontSize: 12, fontVariant: ["tabular-nums"] },
  controls: { flexDirection: "row", gap: 8, marginTop: 8 },
  // Draggable now-playing sheet
  sheetBackdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "#000",
  },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: C.card,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    // No top border — the scrim + shadow separate it from the content behind.
    // boxShadow works on both platforms on RN's new architecture.
    boxShadow: "0px -4px 12px rgba(0,0,0,0.35)",
  },
  sheetGrip: { paddingTop: 8, paddingHorizontal: 16 },
  sheetHandle: {
    width: 40,
    height: 5,
    borderRadius: 3,
    backgroundColor: C.border,
    alignSelf: "center",
    marginBottom: 10,
  },
  sheetPeek: { flexDirection: "row", alignItems: "center", gap: 12, paddingBottom: 10 },
  peekBtn: { minWidth: 60 },
  sheetBody: { paddingHorizontal: 16, paddingBottom: 16, gap: 6 },
  volReadout: {
    minWidth: 44,
    paddingHorizontal: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  volText: { color: C.text, fontSize: 15, fontWeight: "700", fontVariant: ["tabular-nums"] },
  // Signage
  urlBox: {
    color: C.text,
    backgroundColor: C.cardActive,
    borderRadius: 10,
    padding: 12,
    fontSize: 13,
    fontFamily: "Courier",
    borderWidth: 1,
    borderColor: C.border,
  },
  signageStatusRow: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  signageStatItem: { flexDirection: "row", alignItems: "center", gap: 5 },
  signageStat: { color: C.textDim, fontSize: 12 },
  warn: {
    color: C.danger,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
    backgroundColor: "#2a1418",
    borderRadius: 10,
    padding: 10,
  },
  footer: { color: C.textDim, fontSize: 12, lineHeight: 18, textAlign: "center", marginTop: 4 },
  // Toast
  toast: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 24,
    backgroundColor: C.danger,
    borderRadius: 12,
    padding: 14,
  },
  toastText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  toastDismiss: { color: "#ffd9dd", fontSize: 11, marginTop: 4 },
  // Header + settings
  header: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    marginTop: 2,
  },
  modalKav: { flex: 1 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  modalCard: {
    width: "100%",
    maxWidth: 440,
    maxHeight: "85%",
    backgroundColor: C.card,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: C.border,
    padding: 18,
    gap: 12,
  },
  modalHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  modalTitle: { color: C.text, fontSize: 18, fontWeight: "800" },
  // Theme picker
  themeLabel: { color: C.textDim, fontSize: 12, fontWeight: "600", marginTop: 2 },
  themeRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" },
  baseChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
  },
  baseChipText: { fontSize: 13, fontWeight: "600" },
  autoChip: { flexDirection: "row", alignItems: "center", gap: 6 },
  swatch: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    borderColor: "transparent",
  },
  });
}
