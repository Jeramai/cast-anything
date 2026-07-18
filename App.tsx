import { StatusBar } from "expo-status-bar";
import {
  createContext,
  memo,
  useCallback,
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
  FlatList,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
  type ListRenderItemInfo,
  type PressableProps,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as SystemUI from "expo-system-ui";
import * as Clipboard from "expo-clipboard";
import type { DlnaDevice } from "./src/dlna";
import { useCast } from "./src/hooks/useCast";
import type { MediaItem } from "./src/media/mime";
import type { SubtitleResult } from "./src/subtitles/subdl";
import type { OutputMode } from "./src/convert/gallery";
import { CONVERT_QUALITY_LABELS } from "./src/convert/quality";
import { setScreenAwake } from "./src/background/keepAlive";
import {
  ACCENTS,
  BASES,
  composePalette,
  DEFAULT_ACCENT_KEY,
  DEFAULT_BASE_KEY,
  resolveBaseKey,
  SYSTEM_BASE_KEY,
  type ThemePalette,
} from "./src/theme/themes";
import { loadThemeChoice, saveThemeChoice } from "./src/theme/themeStore";
import { setAccentIcon } from "./src/icon/dynamicIcon";

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
  /** When set (0–1), the button becomes a progress bar that fills left→right. */
  progress?: number | null;
  /** Verb shown while `progress` is active, e.g. "Sending" → "Sending… 42%". */
  progressLabel?: string;
};

function Button({ title, icon, variant = "secondary", loading, progress, progressLabel, disabled, style, ...rest }: BtnProps) {
  const { C, styles } = useTheme();
  const showProgress = progress != null;
  const isDisabled = disabled || loading || showProgress;
  const fg = variant === "primary" ? "#fff" : C.text;
  const pct = showProgress ? Math.round(progress * 100) : 0;
  return (
    <Pressable
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.btn,
        variant === "primary" && styles.btnPrimary,
        variant === "ghost" && styles.btnGhost,
        isDisabled && !showProgress && styles.btnDisabled,
        pressed && !isDisabled && styles.btnPressed,
        showProgress && { overflow: "hidden" },
        style as object,
      ]}
      {...rest}
    >
      {showProgress ? (
        <>
          <View style={[styles.btnProgressFill, { width: `${pct}%` }]} />
          <View style={styles.btnContent}>
            <ActivityIndicator size="small" color={fg} />
            <Text style={[styles.btnText, styles.btnTextPrimary]}>{progressLabel ?? "Sending"}… {pct}%</Text>
          </View>
        </>
      ) : loading ? (
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
  isTransitioning,
  progress,
}: {
  cast: ReturnType<typeof useCast>;
  isImage: boolean;
  isPlaying: boolean;
  isPaused: boolean;
  isTransitioning: boolean;
  progress: number;
}) {
  const { styles } = useTheme();
  const PEEK = 96;
  // A multi-item queue adds a Prev/Shuffle/Repeat/Next row, so the card needs more
  // height when expanded.
  const hasQueue = !isImage && cast.queue.length > 1;
  const EXPANDED = isImage ? 180 : hasQueue ? 400 : 330;
  const range = EXPANDED - PEEK; // how far it slides down to collapse
  // The card's height (hence `range`) changes at runtime: a photo, or growing the
  // queue past one item, resizes the expanded card. The PanResponder below is created
  // once and would otherwise capture the FIRST render's `range` forever — clamping and
  // snap thresholds would use a stale height. Mirror `range` into a ref the handlers
  // read live.
  const rangeRef = useRef(range);
  // Write after commit (not during render) so render stays pure; the handlers read it live.
  useEffect(() => {
    rangeRef.current = range;
  });

  // Lazy-init so the Animated.Value isn't reconstructed on every render.
  const translateYRef = useRef<Animated.Value | null>(null);
  if (translateYRef.current === null) translateYRef.current = new Animated.Value(range);
  const translateY = translateYRef.current; // start collapsed (peek)
  const offset = useRef(range);
  const [expanded, setExpanded] = useState(false);

  // When `range` changes while the card rests collapsed, re-pin it to the new bottom
  // so it doesn't hang mid-slide (old range) or over-collapse. The expanded rest
  // position is 0 regardless of range, so only the collapsed case needs re-syncing.
  useEffect(() => {
    if (!expanded) {
      offset.current = range;
      translateY.setValue(range);
    }
  }, [range, expanded, translateY]);

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

  // snapTo is redefined each render (fresh `range`), but the PanResponder captures the
  // FIRST one, so route its calls through a ref that tracks the latest.
  const snapToRef = useRef(snapTo);
  // Write after commit (not during render) so render stays pure; the handlers read it live.
  useEffect(() => {
    snapToRef.current = snapTo;
  });

  const barWidthRef = useRef(0);
  const panRef = useRef<ReturnType<typeof PanResponder.create> | null>(null);
  if (panRef.current === null) {
    panRef.current = PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 4,
      onPanResponderMove: (_e, g) => {
        const r = rangeRef.current;
        translateY.setValue(Math.min(r, Math.max(0, offset.current + g.dy)));
      },
      onPanResponderRelease: (_e, g) => {
        const r = rangeRef.current;
        // A tap (negligible drag) toggles; a real drag snaps by direction/position.
        if (Math.abs(g.dy) < 6 && Math.abs(g.vy) < 0.2) {
          snapToRef.current(offset.current > r / 2 ? 0 : r);
          return;
        }
        const next = offset.current + g.dy;
        const expand = g.vy < -0.4 || (g.vy <= 0.4 && next < r / 2);
        snapToRef.current(expand ? 0 : r);
      },
    });
  }
  const pan = panRef.current;

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
              {isImage
                ? "ON SCREEN"
                : cast.isLive
                  ? `${cast.status.replace(/_/g, " ")} · STREAMING`
                  : cast.status.replace(/_/g, " ")}
            </Text>
          </View>
          {!isImage && (
            <Animated.View
              pointerEvents={expanded ? "none" : "auto"}
              style={{ opacity: peekOpacity, transform: [{ scale: peekScale }] }}
            >
              {isTransitioning ? (
                <Button loading variant="primary" style={styles.peekBtn} />
              ) : isPlaying ? (
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
            <Pressable
              style={styles.progressTrackTappable}
              onLayout={(e) => {
                barWidthRef.current = e.nativeEvent.layout.width;
              }}
              onPress={(e) => {
                if (cast.seekSupported && cast.duration > 0 && barWidthRef.current > 0) {
                  const frac = Math.max(0, Math.min(1, e.nativeEvent.locationX / barWidthRef.current));
                  cast.onSeek(frac * cast.duration);
                }
              }}
            >
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
              </View>
            </Pressable>
            <View style={styles.timeRow}>
              <Text style={styles.timeText}>{formatTime(cast.position)}</Text>
              <Text style={styles.timeText}>
                {(() => {
                  const total = cast.duration > 0 ? cast.duration : cast.knownDurationSec;
                  return total > 0 ? formatTime(total) : "--:--";
                })()}
              </Text>
            </View>

            {hasQueue && (
              <View style={styles.controls}>
                <Button icon="play-skip-back" onPress={cast.previous} style={styles.grow} />
                <Button
                  icon="shuffle"
                  variant={cast.shuffle ? "primary" : "secondary"}
                  onPress={cast.toggleShuffle}
                  style={styles.grow}
                />
                <Button
                  icon="repeat"
                  title={cast.repeatMode === "one" ? "1" : cast.repeatMode === "all" ? "∞" : undefined}
                  variant={cast.repeatMode !== "off" ? "primary" : "secondary"}
                  onPress={cast.cycleRepeat}
                  style={styles.grow}
                />
                <Button icon="play-skip-forward" onPress={cast.next} style={styles.grow} />
              </View>
            )}

            <View style={styles.controls}>
              {cast.seekSupported && (
                <Button icon="play-back" title="15" onPress={() => cast.onSeek(Math.max(0, cast.position - 15))} />
              )}
              <Animated.View
                pointerEvents={expanded ? "auto" : "none"}
                style={[styles.grow, { opacity: bodyPlayOpacity, transform: [{ translateY: bodyPlayShift }] }]}
              >
                {isTransitioning ? (
                  <Button loading title="Loading" variant="primary" style={styles.fill} />
                ) : isPlaying ? (
                  <Button icon="pause" title="Pause" variant="primary" onPress={cast.onPause} style={styles.fill} />
                ) : (
                  <Button icon="play" title="Play" variant="primary" onPress={cast.onPlay} style={styles.fill} />
                )}
              </Animated.View>
              {cast.seekSupported && (
                <Button icon="play-forward" title="15" onPress={() => cast.onSeek(cast.position + 15)} />
              )}
            </View>
            <View style={styles.controls}>
              <Button icon="stop" title="Stop" variant="ghost" onPress={cast.onStop} style={styles.grow} />
              <Button icon="volume-low" onPress={() => cast.onVolumeStep(-1)} />
              <View style={styles.volReadout}>
                <Text style={styles.volText}>{cast.volume ?? "–"}</Text>
              </View>
              <Button icon="volume-high" onPress={() => cast.onVolumeStep(1)} />
            </View>
            {/* Hints below all the controls */}
            {cast.isLive ? (
              <Text style={styles.hint}>
                Streaming live as it transcodes — seeking isn’t available. Use “Convert”
                for a seekable saved copy.
              </Text>
            ) : (
              !cast.seekSupported && (
                <Text style={styles.hint}>This device doesn’t support seeking.</Text>
              )
            )}
            {isPaused && <Text style={styles.hint}>Paused on the device.</Text>}
          </>
        )}
      </View>
      </Animated.View>
    </>
  );
}

// A queue row you can tap to play, or swipe left/right to remove. Uses the same
// PanResponder + Animated approach as the now-playing sheet (no gesture-handler dep).
// The horizontal-only responder (dx must dominate dy) leaves vertical scrolling to
// the surrounding ScrollView.
const SWIPE_REMOVE_PX = 120;

// A stable, unique React key per queue item. Queue items are distinct object
// instances (two adds of the same file are still separate objects), and their
// references survive queue add/remove (spread/filter preserve them), so a WeakMap
// hands each a key that stays put when a sibling is removed. An index- or uri-based
// key makes a surviving duplicate reuse a just-swiped-away QueueRow — it inherits
// that row's translateX≈600 and renders off-screen.
let queueKeySeq = 0;
const queueKeys = new WeakMap<MediaItem, string>();
function queueKey(item: MediaItem): string {
  let k = queueKeys.get(item);
  if (!k) {
    k = `q${queueKeySeq++}`;
    queueKeys.set(item, k);
  }
  return k;
}

function QueueRow({
  item,
  active,
  disabled,
  onPlay,
  onRemove,
}: {
  item: MediaItem;
  active: boolean;
  /** True when this TV can't play the file even by transcoding — greyed + not tappable. */
  disabled: boolean;
  onPlay: () => void;
  onRemove: () => void;
}) {
  const { C, styles } = useTheme();
  const translateXRef = useRef<Animated.Value | null>(null);
  if (translateXRef.current === null) translateXRef.current = new Animated.Value(0);
  const translateX = translateXRef.current;
  const panRef = useRef<ReturnType<typeof PanResponder.create> | null>(null);
  if (panRef.current === null) {
    panRef.current = PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > Math.abs(g.dy) && Math.abs(g.dx) > 8,
      onPanResponderMove: (_e, g) => translateX.setValue(g.dx),
      onPanResponderRelease: (_e, g) => {
        if (Math.abs(g.dx) > SWIPE_REMOVE_PX) {
          Animated.timing(translateX, {
            toValue: g.dx > 0 ? 600 : -600,
            duration: 160,
            useNativeDriver: true,
          }).start(() => onRemove());
        } else {
          Animated.spring(translateX, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
        }
      },
    });
  }
  return (
    <Animated.View style={{ transform: [{ translateX }] }} {...panRef.current.panHandlers}>
      <Pressable
        onPress={disabled ? undefined : onPlay}
        disabled={disabled}
        style={[styles.queueRow, active && styles.queueRowActive, disabled && styles.queueRowDisabled]}
      >
        <Ionicons
          name={
            disabled
              ? "alert-circle"
              : active
                ? "play"
                : item.kind === "audio"
                  ? "musical-notes"
                  : item.kind === "image"
                    ? "image"
                    : "film"
          }
          size={16}
          color={disabled ? C.textDim : active ? C.accent : C.textDim}
        />
        <View style={styles.grow}>
          <Text style={styles.queueName} numberOfLines={1}>
            {item.name}
          </Text>
          {disabled && <Text style={styles.queueNote}>Can’t play on this TV — swipe to remove</Text>}
        </View>
        <Pressable onPress={onRemove} hitSlop={10}>
          <Ionicons name="close" size={16} color={C.textDim} />
        </Pressable>
      </Pressable>
    </Animated.View>
  );
}

// A single SUBDL search result row. memo + a stable `onAttach` let the FlatList skip
// re-rendering rows whose data hasn't changed as it windows the list.
const SubResultRow = memo(function SubResultRow({
  item,
  onAttach,
}: {
  item: SubtitleResult;
  onAttach: (r: SubtitleResult) => void;
}) {
  const { styles } = useTheme();
  const onPress = useCallback(() => onAttach(item), [onAttach, item]);
  return (
    <Pressable style={styles.subResultRow} onPress={onPress}>
      <Text style={styles.subResultTitle} numberOfLines={1}>
        {item.release}
      </Text>
      <Text style={styles.subResultMeta}>{item.language.toUpperCase()}</Text>
    </Pressable>
  );
});
const subResultKey = (r: SubtitleResult) => r.url;

function CastScreen() {
  const { C, styles, baseKey, accentKey, setBaseKey, setAccentKey } = useTheme();
  const cast = useCast();
  const [urlInput, setUrlInput] = useState("");
  // Only read inside the tap handler (never rendered) → a ref avoids a re-render on layout.
  const barWidthRef = useRef(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const [subsOpen, setSubsOpen] = useState(false);
  const [subLang, setSubLang] = useState("en");
  // Where a conversion's output goes: cache only, or also saved to the gallery.
  const [outMode, setOutMode] = useState<OutputMode>("cache");

  // Repaint the launcher icon to match the accent — but only when the Theme sheet
  // closes, so rapidly previewing accents doesn't swap on every tap. We snapshot the
  // accent on open and diff on close. accentLatest tracks the live accent so the
  // close-diff sees the final choice without re-running mid-preview. No-ops gracefully
  // if the native module is absent (older dev build) — the icon updates next rebuild.
  const accentLatest = useRef(accentKey);
  // Write after commit (not during render) so render stays pure. Declared before the
  // open/close effect below, so on close the ref already holds the final accent.
  useEffect(() => {
    accentLatest.current = accentKey;
  });
  const accentAtOpen = useRef(accentKey);
  useEffect(() => {
    if (settingsOpen) accentAtOpen.current = accentLatest.current;
    else if (accentLatest.current !== accentAtOpen.current)
      setAccentIcon(accentLatest.current);
  }, [settingsOpen]);

  const isPlaying = cast.status === "PLAYING";
  const isPaused = cast.status === "PAUSED_PLAYBACK";
  const isTransitioning = cast.status === "TRANSITIONING";
  const hasPlayback = cast.status !== "IDLE" && cast.status !== "NO_MEDIA_PRESENT";
  // Prefer the transport's reported duration, but fall back to the probed length so a
  // live transcode (which advertises no timeline → duration 0) still shows real
  // progress and an end time.
  const totalSec = cast.duration > 0 ? cast.duration : cast.knownDurationSec;
  const progress = totalSec > 0 ? Math.min(1, cast.position / totalSec) : 0;
  // Photos aren't a timeline: no play/pause, seek, scrub or volume — just the
  // option to take them off the screen. Audio/video get the full transport.
  // Based on what's actually casting (nowPlaying), not the live selection.
  const isImage = cast.nowPlaying?.kind === "image";

  // Stable renderItem so the subtitle-results FlatList windows without rebuilding rows
  // (cast.attachSub is itself stable — a useCallback in the hook).
  const renderSubResult = useCallback(
    ({ item }: ListRenderItemInfo<SubtitleResult>) => (
      <SubResultRow item={item} onAttach={cast.attachSub} />
    ),
    [cast.attachSub],
  );

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
              {cast.scanCompleted
                ? "No devices found. Make sure the TV is on, awake, and on the same Wi-Fi as this phone — then scan again."
                : "Make sure the TV is on and on the same Wi-Fi, then scan."}
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
          {/* Add files (one → the selection below; several → straight to the queue),
              or a whole folder → the queue. Or paste a URL. */}
          <View style={styles.pickRow}>
            <Button
              icon={cast.importing ? undefined : "albums"}
              title={cast.importing ? "Importing…" : "Add files"}
              loading={cast.importing}
              onPress={cast.addMedia}
              style={styles.grow}
            />
            <Button
              icon="folder"
              title="Add folder"
              disabled={cast.importing}
              onPress={cast.addFolder}
              style={styles.grow}
            />
          </View>
          <View style={styles.urlRow}>
            <TextInput
              value={urlInput}
              onChangeText={setUrlInput}
              placeholder="…or paste a media URL or .m3u8 stream"
              placeholderTextColor={C.textDim}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              style={styles.input}
            />
            <Button
              title="Use"
              disabled={!urlInput.trim()}
              onPress={() => {
                cast.chooseUrl(urlInput);
                setUrlInput("");
              }}
            />
          </View>

          {/* The single selected file, with only the actions that apply to it. */}
          {cast.media && (
            <>
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
              <View style={styles.pickRow}>
                {cast.canConvert && cast.media.isLocal && cast.media.kind !== "image" && (
                  <Button
                    icon="sync"
                    title="Convert"
                    onPress={() => setConvertOpen(true)}
                    style={styles.grow}
                  />
                )}
                {cast.media.kind === "video" && (
                  <Button
                    icon="chatbox-ellipses"
                    title={cast.subtitle ? cast.subtitle.language.toUpperCase() : "Subs"}
                    variant={cast.subtitle ? "primary" : "secondary"}
                    onPress={() => setSubsOpen(true)}
                    style={styles.grow}
                  />
                )}
                <Button icon="add" title="Queue" onPress={cast.enqueue} style={styles.grow} />
              </View>
            </>
          )}
        </Section>

        {/* ---- Queue ---- */}
        {cast.queue.length > 0 && (
          <Section title="Queue">
            {cast.queue.map((it, i) => (
              <QueueRow
                key={queueKey(it)}
                item={it}
                active={i === cast.queueIndex}
                disabled={cast.unplayable.has(it.uri)}
                onPlay={() => cast.playQueueAt(i)}
                onRemove={() => cast.removeFromQueue(i)}
              />
            ))}
            <Text style={styles.hint}>Tap to play · swipe a row to remove.</Text>
            <View style={styles.queueActions}>
              <Button
                icon="shuffle"
                title="Shuffle"
                variant={cast.shuffle ? "primary" : "secondary"}
                onPress={cast.toggleShuffle}
                style={styles.grow}
              />
              <Button
                icon="repeat"
                title={
                  cast.repeatMode === "one" ? "One" : cast.repeatMode === "all" ? "All" : "Repeat"
                }
                variant={cast.repeatMode !== "off" ? "primary" : "secondary"}
                onPress={cast.cycleRepeat}
                style={styles.grow}
              />
              <Button icon="trash" variant="ghost" onPress={cast.clearQueue} />
            </View>
          </Section>
        )}

        {/* ---- Cast ---- */}
        {/* While a big local file copies into the server dir, the button itself
            fills as a progress bar (cast.castProgress); otherwise it spins.
            Hidden once the "can't cast — stream it instead" fallback is up: for
            this file + TV a normal cast would just fail again, and leaving it
            would spin in lock-step with the Stream-via-URL button. Picking a
            different file/device or converting brings it back. */}
        {!(cast.canStreamViaUrl || cast.streamUrl) && (
          <Button
            icon="play-circle"
            title={
              cast.selectedDevice?.isSignage
                ? "Send to signage"
                : cast.queue.length > 0
                  ? `Play queue (${cast.queue.length})`
                  : "Cast to device"
            }
            variant="primary"
            loading={cast.busy}
            progress={cast.castProgress}
            disabled={!cast.selectedDevice || (!cast.media && cast.queue.length === 0)}
            onPress={cast.cast}
            style={{ marginTop: 4 }}
          />
        )}

        {/* ---- Stream-via-URL fallback (a file the TV can't DLNA-cast) ---- */}
        {(cast.canStreamViaUrl || cast.streamUrl) && (
          <Section title="Stream via URL">
            {cast.streamUrl ? (
              <>
                <Text style={styles.hint}>
                  Serving from your phone. This TV can’t play the file itself — open
                  this URL in a player like VLC on a computer or another device on
                  this Wi-Fi:
                </Text>
                <Text selectable style={styles.urlBox}>
                  {cast.streamUrl}
                </Text>
                <Button
                  icon="copy-outline"
                  title="Copy URL"
                  onPress={() => {
                    if (cast.streamUrl) Clipboard.setStringAsync(cast.streamUrl);
                  }}
                  style={{ marginTop: 8 }}
                />
              </>
            ) : (
              <>
                <Text style={styles.hint}>
                  This TV can’t play this file, even by transcoding. Use “Convert” above
                  for a seekable saved copy, or serve it to another player (like VLC) over
                  the network:
                </Text>
                <Button
                  icon="link-outline"
                  title="Stream via URL"
                  loading={cast.busy}
                  progress={cast.castProgress}
                  progressLabel="Serving"
                  onPress={cast.streamViaUrl}
                  style={{ marginTop: 8 }}
                />
              </>
            )}
          </Section>
        )}

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
                  onLayout={(e) => {
                    barWidthRef.current = e.nativeEvent.layout.width;
                  }}
                  onPress={(e) => {
                    if (barWidthRef.current > 0) {
                      const frac = Math.max(0, Math.min(1, e.nativeEvent.locationX / barWidthRef.current));
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
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={styles.modalKav}
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

              <Text style={styles.themeLabel}>SUBDL API key</Text>
              <TextInput
                value={cast.subdlKey}
                onChangeText={cast.setSubdlKey}
                placeholder="Paste your SUBDL API key"
                placeholderTextColor={C.textDim}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
              />
              <Text style={styles.hint}>
                Free key from subdl.com (no login needed). Enables online subtitle search.
              </Text>
            </ScrollView>
          </Pressable>
        </Pressable>
        </KeyboardAvoidingView>
      </Modal>

      {/* ---- Convert dialog ---- */}
      <Modal
        visible={convertOpen}
        transparent
        animationType="fade"
        onRequestClose={() => !cast.converting && setConvertOpen(false)}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => !cast.converting && setConvertOpen(false)}
        >
          <Pressable style={styles.modalCard} onPress={() => {}}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Convert for TV</Text>
              <Pressable
                onPress={() => setConvertOpen(false)}
                hitSlop={10}
                disabled={cast.converting}
              >
                <Ionicons name="close" size={22} color={cast.converting ? C.border : C.textDim} />
              </Pressable>
            </View>

            {cast.media && (
              <Text style={styles.hint} numberOfLines={2}>
                {cast.media.name}
              </Text>
            )}

            <Text style={styles.themeLabel}>Speed</Text>
            <View style={styles.themeRow}>
              {CONVERT_QUALITY_LABELS.map((q) => (
                <Pressable
                  key={q.key}
                  onPress={() => cast.setConvertQuality(q.key)}
                  disabled={cast.converting}
                  style={[styles.outChip, cast.convertQuality === q.key && styles.outChipOn]}
                >
                  <Text
                    style={[
                      styles.outChipText,
                      cast.convertQuality === q.key && styles.outChipTextOn,
                    ]}
                  >
                    {q.label}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.hint}>
              {CONVERT_QUALITY_LABELS.find((q) => q.key === cast.convertQuality)?.hint}
            </Text>

            <Text style={styles.themeLabel}>Save</Text>
            <View style={styles.themeRow}>
              {(["cache", "overwrite", "new"] as const).map((m) => (
                <Pressable
                  key={m}
                  onPress={() => setOutMode(m)}
                  disabled={cast.converting}
                  style={[styles.outChip, outMode === m && styles.outChipOn]}
                >
                  <Text style={[styles.outChipText, outMode === m && styles.outChipTextOn]}>
                    {m === "cache" ? "Cache only" : m === "overwrite" ? "Overwrite" : "New file"}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.hint}>
              {outMode === "cache"
                ? "Kept in the app only, just for this cast."
                : outMode === "overwrite"
                  ? "Saved to your gallery, replacing an earlier copy of the same file."
                  : "Saved to your gallery as a new file each time."}
            </Text>

            {cast.converting ? (
              <>
                <Button
                  variant="primary"
                  progress={cast.convertProgress}
                  progressLabel={
                    cast.convertEtaSec != null
                      ? `Converting · ${formatTime(cast.convertEtaSec)} left`
                      : "Converting…"
                  }
                  style={{ marginTop: 14 }}
                />
                <Button
                  icon="close"
                  title="Cancel"
                  variant="ghost"
                  onPress={cast.cancelConversion}
                  style={{ marginTop: 8 }}
                />
              </>
            ) : (
              <Button
                icon="sync"
                title="Convert"
                variant="primary"
                onPress={async () => {
                  await cast.convertSelected(outMode);
                  setConvertOpen(false);
                }}
                style={{ marginTop: 14 }}
              />
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* ---- Subtitles dialog ---- */}
      <Modal
        visible={subsOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setSubsOpen(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setSubsOpen(false)}>
          <Pressable style={styles.modalCard} onPress={() => {}}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Subtitles</Text>
              <Pressable onPress={() => setSubsOpen(false)} hitSlop={10}>
                <Ionicons name="close" size={22} color={C.textDim} />
              </Pressable>
            </View>

            {cast.subtitle && (
              <View style={styles.subActiveRow}>
                <Ionicons name="checkmark-circle" size={16} color={C.good} />
                <Text style={styles.subActiveText} numberOfLines={1}>
                  {cast.subtitle.language.toUpperCase()} · {cast.subtitle.release}
                </Text>
                <Pressable onPress={cast.clearSubtitle} hitSlop={8}>
                  <Ionicons name="close" size={16} color={C.textDim} />
                </Pressable>
              </View>
            )}

            {/* Manual file — always available, no account needed. */}
            <Button
              icon="document-attach"
              title="Pick a subtitle file (.srt)"
              variant="secondary"
              disabled={cast.searchingSubs}
              onPress={cast.pickSubtitle}
            />

            {/* Online search via SUBDL (needs the free API key from Settings). */}
            {cast.subdlKey ? (
              <>
                <Text style={styles.themeLabel}>Search online</Text>
                <View style={styles.themeRow}>
                  {["en", "es", "fr", "de", "nl", "it", "pt"].map((l) => (
                    <Pressable
                      key={l}
                      onPress={() => setSubLang(l)}
                      style={[styles.outChip, subLang === l && styles.outChipOn]}
                    >
                      <Text style={[styles.outChipText, subLang === l && styles.outChipTextOn]}>
                        {l.toUpperCase()}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <Button
                  icon="search"
                  title="Search SUBDL"
                  variant="primary"
                  loading={cast.searchingSubs}
                  onPress={() => cast.searchSubs(subLang)}
                />
                <FlatList
                  style={styles.subResults}
                  showsVerticalScrollIndicator={false}
                  data={cast.subResults}
                  keyExtractor={subResultKey}
                  renderItem={renderSubResult}
                />
              </>
            ) : (
              <Text style={styles.hint}>
                Add a SUBDL API key in Settings to search online, or pick a file above.
              </Text>
            )}
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
          isTransitioning={isTransitioning}
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

  // Keep the screen on the whole time the app is in the foreground (releases when
  // backgrounded). Casting already does this; this also covers setup + conversion.
  useEffect(() => {
    setScreenAwake(true);
    return () => {
      setScreenAwake(false);
    };
  }, []);

  // Android 13+ suppresses the foreground-service playback notification (and with
  // it the lock-screen / hardware-key transport controls) unless POST_NOTIFICATIONS
  // is granted at runtime. Ask once on startup; harmless/no-op on older Android + iOS.
  useEffect(() => {
    if (Platform.OS !== "android" || Platform.Version < 33) return;
    const perm = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
    if (!perm) return;
    PermissionsAndroid.check(perm).then((granted) => {
      if (!granted) PermissionsAndroid.request(perm).catch(() => {});
    }).catch(() => {});
  }, []);

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

  return (
    <ThemeContext.Provider value={themeValue}>
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
