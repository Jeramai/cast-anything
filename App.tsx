import { StatusBar } from "expo-status-bar";
import { useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type PressableProps,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import type { DlnaDevice } from "./src/dlna";
import { useCast } from "./src/hooks/useCast";

const C = {
  bg: "#0b0f17",
  card: "#151b27",
  cardActive: "#1d2740",
  border: "#222c3d",
  accent: "#4f8cff",
  accentDim: "#2a3f63",
  text: "#e8edf6",
  textDim: "#8a97ab",
  danger: "#ff5d6c",
  good: "#3ddc97",
};

function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

type BtnProps = PressableProps & {
  title: string;
  variant?: "primary" | "secondary" | "ghost";
  loading?: boolean;
};

function Button({ title, variant = "secondary", loading, disabled, style, ...rest }: BtnProps) {
  const isDisabled = disabled || loading;
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
  const subtitle = [device.manufacturer, device.modelName].filter(Boolean).join(" · ");
  return (
    <Pressable onPress={onPress} style={[styles.deviceRow, selected && styles.deviceRowActive]}>
      <Text style={styles.deviceIcon}>
        {device.isSignage ? "🪧" : device.isSamsung ? "📺" : "🖥️"}
      </Text>
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
      {selected && <Text style={styles.check}>✓</Text>}
    </Pressable>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function CastScreen() {
  const cast = useCast();
  const [urlInput, setUrlInput] = useState("");
  const [barWidth, setBarWidth] = useState(0);

  const isPlaying = cast.status === "PLAYING";
  const isPaused = cast.status === "PAUSED_PLAYBACK";
  const hasPlayback = cast.status !== "IDLE" && cast.status !== "NO_MEDIA_PRESENT";
  const progress = cast.duration > 0 ? Math.min(1, cast.position / cast.duration) : 0;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Text style={styles.h1}>Cast Anything</Text>
        <Text style={styles.subtitle}>Stream video, music & photos to a DLNA TV on your Wi-Fi</Text>

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
          <Button title="📁  Pick a file" onPress={cast.chooseFile} />
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
              <Text style={styles.mediaKind}>{cast.media.kind.toUpperCase()}</Text>
              <Text style={styles.mediaName} numberOfLines={1}>
                {cast.media.name}
              </Text>
              <Pressable onPress={cast.clearMedia} hitSlop={10}>
                <Text style={styles.clearX}>✕</Text>
              </Pressable>
            </View>
          )}
        </Section>

        {/* ---- Cast ---- */}
        <Button
          title={cast.selectedDevice?.isSignage ? "Send to signage ▶" : "Cast to device ▶"}
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
              <Text style={styles.signageStat}>
                {cast.signage.urlSetViaMdc ? "✓ URL set automatically" : "• set URL on panel"}
              </Text>
              <Text style={styles.signageStat}>
                {cast.signageControls.connected ? "● panel connected" : "○ waiting for panel…"}
              </Text>
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

            {/* playback controls — pushed instantly over the WebSocket */}
            <View style={styles.controls}>
              <Button title="⏪ 15" onPress={() => cast.signageControls.seek(-15)} />
              {cast.signageControls.playing ? (
                <Button
                  title="⏸ Pause"
                  variant="primary"
                  onPress={cast.signageControls.pause}
                  style={styles.grow}
                />
              ) : (
                <Button
                  title="▶ Play"
                  variant="primary"
                  onPress={cast.signageControls.play}
                  style={styles.grow}
                />
              )}
              <Button title="15 ⏩" onPress={() => cast.signageControls.seek(15)} />
            </View>
            <Text style={styles.signageStat}>
              Plays muted — this panel’s browser blocks audio on autoplay.
            </Text>

            <Button title="Done" variant="ghost" onPress={cast.dismissSignage} />
          </Section>
        )}

        {/* ---- Now playing ---- */}
        {hasPlayback && (
          <Section title="Now playing">
            <Text style={styles.nowTitle} numberOfLines={1}>
              {cast.media?.name ?? "Media"}
            </Text>
            <Text style={styles.statusLabel}>{cast.status.replace(/_/g, " ")}</Text>

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
              <Button title="⏪ 15" onPress={() => cast.onSeek(Math.max(0, cast.position - 15))} />
              {isPlaying ? (
                <Button
                  title="⏸ Pause"
                  variant="primary"
                  onPress={cast.onPause}
                  style={styles.grow}
                />
              ) : (
                <Button
                  title="▶ Play"
                  variant="primary"
                  onPress={cast.onPlay}
                  style={styles.grow}
                />
              )}
              <Button title="15 ⏩" onPress={() => cast.onSeek(cast.position + 15)} />
            </View>

            <View style={styles.controls}>
              <Button title="⏹ Stop" variant="ghost" onPress={cast.onStop} style={styles.grow} />
              <Button title="🔉 −" onPress={() => cast.onVolume(20)} />
              <Button title="🔊 +" onPress={() => cast.onVolume(60)} />
            </View>
            {isPaused && <Text style={styles.hint}>Paused on the device.</Text>}
          </Section>
        )}

        <Text style={styles.footer}>The TV must be on the same Wi-Fi network as this phone.</Text>
      </ScrollView>

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
  return (
    <SafeAreaProvider>
      <CastScreen />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  scroll: { padding: 8, paddingTop: 24, paddingBottom: 60, gap: 18 },
  h1: { color: C.text, fontSize: 30, fontWeight: "800", letterSpacing: -0.5 },
  subtitle: { color: C.textDim, fontSize: 14, marginTop: -10 },
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
  btnGhost: { backgroundColor: "transparent", borderWidth: 1, borderColor: C.border },
  btnDisabled: { opacity: 0.4 },
  btnPressed: { opacity: 0.75 },
  btnText: { color: C.text, fontSize: 15, fontWeight: "600" },
  btnTextPrimary: { color: "#fff" },
  btnTextGhost: { color: C.textDim },
  grow: { flex: 1 },
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
    color: C.bg,
    backgroundColor: C.textDim,
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
    backgroundColor: C.cardActive,
    borderRadius: 12,
    padding: 12,
  },
  mediaKind: {
    color: C.bg,
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
});
