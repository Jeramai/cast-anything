import { StatusBar } from "expo-status-bar";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ActivityIndicator,
  Animated,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
  type PressableProps,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as SystemUI from "expo-system-ui";
import type { DlnaDevice } from "./src/dlna";
import { useCast } from "./src/hooks/useCast";
import {
  ACCENTS,
  BASES,
  composePalette,
  DEFAULT_ACCENT_KEY,
  DEFAULT_BASE_KEY,
  loadThemeChoice,
  resolveBaseKey,
  saveThemeChoice,
  SYSTEM_BASE_KEY,
  type ThemePalette,
} from "./src/theme/themes";

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
function useTheme(): ThemeContextValue {
  const v = useContext(ThemeContext);
  if (!v) throw new Error("useTheme must be used within ThemeContext");
  return v;
}

function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  // Show hours once we pass an hour: 1:24:00 rather than 84:00.
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  }
  return `${m}:${String(r).padStart(2, "0")}`;
}

type BtnProps = PressableProps & {
  title?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  variant?: "primary" | "secondary" | "ghost";
  loading?: boolean;
};

function Button({ title, icon, variant = "secondary", loading, disabled, style, ...rest }: BtnProps) {
  const { C, styles } = useTheme();
  const isDisabled = disabled || loading;
  const fg = variant === "primary" ? "#fff" : C.text;
  return (
    <Pressable
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.btn,
        variant === "primary" && styles.btnPrimary,
        variant === "ghost" && styles.btnGhost,
        isDisabled && styles.btnDisabled,
        pressed && !isDisabled && styles.btnPressed,
        style as object,
      ]}
      {...rest}
    >
      {loading ? (
        <ActivityIndicator color={variant === "primary" ? "#fff" : C.text} />
      ) : (
        <View style={styles.btnContent}>
          {icon && <Ionicons name={icon} size={18} color={fg} />}
          {!!title && (
            <Text
              style={[
                styles.btnText,
                variant === "primary" && styles.btnTextPrimary,
                variant === "ghost" && styles.btnTextGhost,
              ]}
            >
              {title}
            </Text>
          )}
        </View>
      )}
    </Pressable>
  );
}

function DeviceRow({
  device,
  selected,
  onPress,
}: {
  device: DlnaDevice;
  selected: boolean;
  onPress: () => void;
}) {
  const { C, styles } = useTheme();
  const subtitle = [device.manufacturer, device.modelName].filter(Boolean).join(" · ");
  return (
    <Pressable onPress={onPress} style={[styles.deviceRow, selected && styles.deviceRowActive]}>
      <Ionicons
        name={device.isSignage ? "easel" : device.isSamsung ? "tv" : "desktop"}
        size={24}
        color={selected ? C.accent : C.textDim}
        style={styles.deviceIcon}
      />
      <View style={{ flex: 1 }}>
        <View style={styles.deviceNameRow}>
          <Text style={styles.deviceName} numberOfLines={1}>
            {device.friendlyName}
          </Text>
          {device.isSignage && <Text style={styles.signageTag}>SIGNAGE</Text>}
        </View>
        {!!subtitle && (
          <Text style={styles.deviceSub} numberOfLines={1}>
            {subtitle}
          </Text>
        )}
      </View>
      {selected && <Ionicons name="checkmark" size={22} color={C.accent} />}
    </Pressable>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const { styles } = useTheme();
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

/**
 * Draggable "Now playing" card pinned to the bottom. Drag (or tap) the handle to
 * slide between a peek bar (title + play/pause) and the full controls. Built on
 * Animated + PanResponder so it needs no extra native deps.
 */
function NowPlayingSheet({
  cast,
  isImage,
  isPlaying,
  isPaused,
  progress,
}: {
  cast: ReturnType<typeof useCast>;
  isImage: boolean;
  isPlaying: boolean;
  isPaused: boolean;
  progress: number;
}) {
  const { styles } = useTheme();
  const PEEK = 96;
  const EXPANDED = isImage ? 180 : 330;
  const range = EXPANDED - PEEK; // how far it slides down to collapse

  const translateY = useRef(new Animated.Value(range)).current; // start collapsed (peek)
  const offset = useRef(range);
  const [expanded, setExpanded] = useState(false);

  // 0 = collapsed (peek), 1 = expanded. Drives the play/pause cross-fade so the
  // small corner icon and the big central button are never both visible at rest —
  // the control appears to glide between the two positions as you drag.
  const open = translateY.interpolate({
    inputRange: [0, Math.max(1, range)],
    outputRange: [1, 0],
    extrapolate: "clamp",
  });
  const peekOpacity = open.interpolate({ inputRange: [0, 0.4], outputRange: [1, 0], extrapolate: "clamp" });
  const peekScale = open.interpolate({ inputRange: [0, 0.4], outputRange: [1, 0.7], extrapolate: "clamp" });
  const bodyPlayOpacity = open.interpolate({ inputRange: [0.55, 1], outputRange: [0, 1], extrapolate: "clamp" });
  const bodyPlayShift = open.interpolate({ inputRange: [0.55, 1], outputRange: [16, 0], extrapolate: "clamp" });
  // Dim the content behind as the card rises, so the card reads as a separate
  // surface instead of blending into the same-colored cards behind it.
  const backdropOpacity = open.interpolate({ inputRange: [0, 1], outputRange: [0, 0.55], extrapolate: "clamp" });

  const snapTo = (to: number) => {
    offset.current = to;
    setExpanded(to === 0);
    Animated.spring(translateY, {
      toValue: to,
      useNativeDriver: true,
      bounciness: 2,
      speed: 14,
    }).start();
  };

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 4,
      onPanResponderMove: (_e, g) => {
        translateY.setValue(Math.min(range, Math.max(0, offset.current + g.dy)));
      },
      onPanResponderRelease: (_e, g) => {
        // A tap (negligible drag) toggles; a real drag snaps by direction/position.
        if (Math.abs(g.dy) < 6 && Math.abs(g.vy) < 0.2) {
          snapTo(offset.current > range / 2 ? 0 : range);
          return;
        }
        const next = offset.current + g.dy;
        const expand = g.vy < -0.4 || (g.vy <= 0.4 && next < range / 2);
        snapTo(expand ? 0 : range);
      },
    }),
  ).current;

  return (
    <>
      {/* Scrim — dims the content behind the card while it's raised. Tap to collapse. */}
      <Animated.View
        pointerEvents={expanded ? "auto" : "none"}
        style={[styles.sheetBackdrop, { opacity: backdropOpacity }]}
      >
        <Pressable style={styles.fill} onPress={() => snapTo(range)} />
      </Animated.View>

      <Animated.View style={[styles.sheet, { height: EXPANDED, transform: [{ translateY }] }]}>
      {/* Grab handle + peek row — always visible */}
      <View style={styles.sheetGrip} {...pan.panHandlers}>
        <View style={styles.sheetHandle} />
        <View style={styles.sheetPeek}>
          <View style={{ flex: 1 }}>
            <Text style={styles.nowTitle} numberOfLines={1}>
              {cast.nowPlaying?.name ?? "Media"}
            </Text>
            <Text style={styles.statusLabel}>
              {(isImage ? "ON SCREEN" : cast.status.replace(/_/g, " "))}
            </Text>
          </View>
          {!isImage && (
            <Animated.View
              pointerEvents={expanded ? "none" : "auto"}
              style={{ opacity: peekOpacity, transform: [{ scale: peekScale }] }}
            >
              {isPlaying ? (
                <Button icon="pause" variant="primary" onPress={cast.onPause} style={styles.peekBtn} />
              ) : (
                <Button icon="play" variant="primary" onPress={cast.onPlay} style={styles.peekBtn} />
              )}
            </Animated.View>
          )}
        </View>
      </View>

      {/* Expanded body */}
      <View style={styles.sheetBody}>
        {isImage ? (
          <Button
            icon="close"
            title="Remove from screen"
            variant="ghost"
            onPress={cast.onStop}
            style={styles.grow}
          />
        ) : (
          <>
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
            </View>
            <View style={styles.timeRow}>
              <Text style={styles.timeText}>{formatTime(cast.position)}</Text>
              <Text style={styles.timeText}>
                {cast.duration > 0 ? formatTime(cast.duration) : "--:--"}
              </Text>
            </View>

            <View style={styles.controls}>
              {cast.seekSupported && (
                <Button icon="play-back" title="15" onPress={() => cast.onSeek(Math.max(0, cast.position - 15))} />
              )}
              <Animated.View
                pointerEvents={expanded ? "auto" : "none"}
                style={[styles.grow, { opacity: bodyPlayOpacity, transform: [{ translateY: bodyPlayShift }] }]}
              >
                {isPlaying ? (
                  <Button icon="pause" title="Pause" variant="primary" onPress={cast.onPause} style={styles.fill} />
                ) : (
                  <Button icon="play" title="Play" variant="primary" onPress={cast.onPlay} style={styles.fill} />
                )}
              </Animated.View>
              {cast.seekSupported && (
                <Button icon="play-forward" title="15" onPress={() => cast.onSeek(cast.position + 15)} />
              )}
            </View>
            {!cast.seekSupported && (
              <Text style={styles.hint}>This device doesn’t support seeking.</Text>
            )}

            <View style={styles.controls}>
              <Button icon="stop" title="Stop" variant="ghost" onPress={cast.onStop} style={styles.grow} />
              <Button icon="volume-low" onPress={() => cast.onVolumeStep(-1)} />
              <View style={styles.volReadout}>
                <Text style={styles.volText}>{cast.volume ?? "–"}</Text>
              </View>
              <Button icon="volume-high" onPress={() => cast.onVolumeStep(1)} />
            </View>
            {isPaused && <Text style={styles.hint}>Paused on the device.</Text>}
          </>
        )}
      </View>
      </Animated.View>
    </>
  );
}

function CastScreen() {
  const { C, styles, baseKey, accentKey, setBaseKey, setAccentKey } = useTheme();
  const cast = useCast();
  const [urlInput, setUrlInput] = useState("");
  const [barWidth, setBarWidth] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const isPlaying = cast.status === "PLAYING";
  const isPaused = cast.status === "PAUSED_PLAYBACK";
  const hasPlayback = cast.status !== "IDLE" && cast.status !== "NO_MEDIA_PRESENT";
  const progress = cast.duration > 0 ? Math.min(1, cast.position / cast.duration) : 0;
  // Photos aren't a timeline: no play/pause, seek, scrub or volume — just the
  // option to take them off the screen. Audio/video get the full transport.
  // Based on what's actually casting (nowPlaying), not the live selection.
  const isImage = cast.nowPlaying?.kind === "image";

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <StatusBar style={C.isDark ? "light" : "dark"} />
      <ScrollView
        contentContainerStyle={[styles.scroll, hasPlayback && styles.scrollWithSheet]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.h1}>Cast Anything</Text>
            <Text style={styles.subtitle}>
              Stream video, music & photos to a DLNA TV on your Wi-Fi
            </Text>
          </View>
          <Pressable onPress={() => setSettingsOpen(true)} hitSlop={10} style={styles.iconBtn}>
            <Ionicons name="settings-outline" size={22} color={C.textDim} />
          </Pressable>
        </View>

        {/* ---- Devices ---- */}
        <Section title="1 · Choose a device">
          <Button
            title={cast.isScanning ? "Scanning…" : "Scan for devices"}
            variant="primary"
            loading={cast.isScanning}
            onPress={cast.scan}
          />
          {cast.devices.length === 0 && !cast.isScanning && (
            <Text style={styles.hint}>
              Make sure the TV is on and on the same Wi-Fi, then scan.
            </Text>
          )}
          <View style={{ gap: 8, marginTop: cast.devices.length ? 12 : 0 }}>
            {cast.devices.map((d) => (
              <DeviceRow
                key={d.id}
                device={d}
                selected={cast.selectedDevice?.id === d.id}
                onPress={() => cast.selectDevice(d)}
              />
            ))}
          </View>
        </Section>

        {/* ---- Media ---- */}
        <Section title="2 · Choose what to cast">
          <Button
            icon={cast.importing ? undefined : "folder-open"}
            title={cast.importing ? "Importing…" : "Pick a file"}
            loading={cast.importing}
            onPress={cast.chooseFile}
          />
          {cast.importing && (
            <Text style={styles.hint}>
              Copying the file into the app — large files can take a moment.
            </Text>
          )}
          <View style={styles.urlRow}>
            <TextInput
              value={urlInput}
              onChangeText={setUrlInput}
              placeholder="…or paste a media URL"
              placeholderTextColor={C.textDim}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              style={styles.input}
            />
            <Button
              title="Use"
              onPress={() => {
                cast.chooseUrl(urlInput);
                setUrlInput("");
              }}
            />
          </View>
          {cast.media && (
            <View style={styles.mediaCard}>
              <Ionicons
                name={
                  cast.media.kind === "audio"
                    ? "musical-notes"
                    : cast.media.kind === "image"
                      ? "image"
                      : "film"
                }
                size={20}
                color={C.accent}
              />
              <Text style={styles.mediaKind}>{cast.media.kind.toUpperCase()}</Text>
              <Text style={styles.mediaName} numberOfLines={1}>
                {cast.media.name}
              </Text>
              <Pressable onPress={cast.clearMedia} hitSlop={10}>
                <Ionicons name="close" size={18} color={C.textDim} />
              </Pressable>
            </View>
          )}
        </Section>

        {/* ---- Cast ---- */}
        <Button
          icon="play-circle"
          title={cast.selectedDevice?.isSignage ? "Send to signage" : "Cast to device"}
          variant="primary"
          loading={cast.busy}
          disabled={!cast.selectedDevice || !cast.media}
          onPress={cast.cast}
          style={{ marginTop: 4 }}
        />

        {/* ---- Signage (URL Launcher) result ---- */}
        {cast.signage && (
          <Section title="Samsung signage · URL Launcher">
            <Text style={styles.hint}>{cast.signage.message}</Text>
            <Text selectable style={styles.urlBox}>
              {cast.signage.playerUrl}
            </Text>
            <View style={styles.signageStatusRow}>
              <View style={styles.signageStatItem}>
                <Ionicons
                  name={cast.signage.urlSetViaMdc ? "checkmark-circle" : "ellipse-outline"}
                  size={14}
                  color={cast.signage.urlSetViaMdc ? C.good : C.textDim}
                />
                <Text style={styles.signageStat}>
                  {cast.signage.urlSetViaMdc ? "URL set automatically" : "set URL on panel"}
                </Text>
              </View>
              <View style={styles.signageStatItem}>
                <Ionicons
                  name={cast.signageControls.connected ? "ellipse" : "ellipse-outline"}
                  size={14}
                  color={cast.signageControls.connected ? C.good : C.textDim}
                />
                <Text style={styles.signageStat}>
                  {cast.signageControls.connected ? "panel connected" : "waiting for panel…"}
                </Text>
              </View>
            </View>

            {cast.signageControls.duration > 0 && (
              <>
                <Pressable
                  style={styles.progressTrackTappable}
                  hitSlop={{ top: 12, bottom: 12 }}
                  onLayout={(e) => setBarWidth(e.nativeEvent.layout.width)}
                  onPress={(e) => {
                    if (barWidth > 0) {
                      const frac = Math.max(0, Math.min(1, e.nativeEvent.locationX / barWidth));
                      cast.signageControls.seekTo(frac * cast.signageControls.duration);
                    }
                  }}
                >
                  <View style={styles.progressTrack}>
                    <View
                      style={[
                        styles.progressFill,
                        {
                          width: `${Math.min(
                            100,
                            (cast.signageControls.position / cast.signageControls.duration) * 100,
                          )}%`,
                        },
                      ]}
                    />
                  </View>
                </Pressable>
                <View style={styles.timeRow}>
                  <Text style={styles.timeText}>{formatTime(cast.signageControls.position)}</Text>
                  <Text style={styles.timeText}>{formatTime(cast.signageControls.duration)}</Text>
                </View>
              </>
            )}

            {/* Playback controls — pushed instantly over the WebSocket. A photo
                has no timeline to scrub, so only audio/video get the transport. */}
            {isImage ? (
              <Text style={styles.signageStat}>Showing photo on the panel.</Text>
            ) : (
              <>
                <View style={styles.controls}>
                  <Button icon="play-back" title="15" onPress={() => cast.signageControls.seek(-15)} />
                  {cast.signageControls.playing ? (
                    <Button
                      icon="pause"
                      title="Pause"
                      variant="primary"
                      onPress={cast.signageControls.pause}
                      style={styles.grow}
                    />
                  ) : (
                    <Button
                      icon="play"
                      title="Play"
                      variant="primary"
                      onPress={cast.signageControls.play}
                      style={styles.grow}
                    />
                  )}
                  <Button icon="play-forward" title="15" onPress={() => cast.signageControls.seek(15)} />
                </View>
                <Text style={styles.signageStat}>
                  Plays muted — this panel’s browser blocks audio on autoplay.
                </Text>
              </>
            )}

            <Button title="Done" variant="ghost" onPress={cast.dismissSignage} />
          </Section>
        )}

        <Text style={styles.footer}>The TV must be on the same Wi-Fi network as this phone.</Text>
      </ScrollView>

      {/* ---- Settings (theme) modal ---- */}
      <Modal
        visible={settingsOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setSettingsOpen(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setSettingsOpen(false)}>
          <Pressable style={styles.modalCard} onPress={() => {}}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Theme</Text>
              <Pressable onPress={() => setSettingsOpen(false)} hitSlop={10}>
                <Ionicons name="close" size={22} color={C.textDim} />
              </Pressable>
            </View>

            <ScrollView
              style={{ flexShrink: 1 }}
              contentContainerStyle={{ gap: 12 }}
              showsVerticalScrollIndicator={false}
            >
              <Text style={styles.themeLabel}>Background</Text>
              <View style={styles.themeRow}>
                <Pressable
                  onPress={() => setBaseKey(SYSTEM_BASE_KEY)}
                  style={[
                    styles.baseChip,
                    styles.autoChip,
                    {
                      backgroundColor: C.cardActive,
                      borderColor: baseKey === SYSTEM_BASE_KEY ? C.accent : C.border,
                    },
                  ]}
                >
                  <Ionicons name="contrast-outline" size={14} color={C.text} />
                  <Text style={[styles.baseChipText, { color: C.text }]}>Auto</Text>
                </Pressable>
                {BASES.map((b) => (
                  <Pressable
                    key={b.key}
                    onPress={() => setBaseKey(b.key)}
                    style={[
                      styles.baseChip,
                      { backgroundColor: b.card, borderColor: baseKey === b.key ? C.accent : b.border },
                    ]}
                  >
                    <Text style={[styles.baseChipText, { color: b.text }]}>{b.name}</Text>
                  </Pressable>
                ))}
              </View>

              <Text style={styles.themeLabel}>Accent</Text>
              <View style={styles.themeRow}>
                {ACCENTS.map((a) => (
                  <Pressable
                    key={a.key}
                    onPress={() => setAccentKey(a.key)}
                    style={[
                      styles.swatch,
                      { backgroundColor: a.color },
                      accentKey === a.key && { borderColor: C.text, borderWidth: 3 },
                    ]}
                  >
                    {accentKey === a.key && <Ionicons name="checkmark" size={16} color="#fff" />}
                  </Pressable>
                ))}
              </View>
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      {/* ---- Now playing (draggable bottom-sheet card) ---- */}
      {hasPlayback && (
        <NowPlayingSheet
          cast={cast}
          isImage={isImage}
          isPlaying={isPlaying}
          isPaused={isPaused}
          progress={progress}
        />
      )}

      {/* ---- Error toast ---- */}
      {cast.error && (
        <Pressable style={styles.toast} onPress={cast.dismissError}>
          <Text style={styles.toastText}>{cast.error}</Text>
          <Text style={styles.toastDismiss}>tap to dismiss</Text>
        </Pressable>
      )}
    </SafeAreaView>
  );
}

export default function App() {
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

  return (
    <ThemeContext.Provider value={{ C, styles, baseKey, accentKey, setBaseKey, setAccentKey }}>
      <SafeAreaProvider>
        <CastScreen />
      </SafeAreaProvider>
    </ThemeContext.Provider>
  );
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
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 16,
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
