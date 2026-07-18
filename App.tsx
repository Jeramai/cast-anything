import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import {
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useCast } from "./src/hooks/useCast";
import { setScreenAwake } from "./src/background/keepAlive";
import { ThemeProvider, useTheme } from "./src/theme/ThemeContext";
import { Button } from "./src/components/Button";
import { DevicesSection } from "./src/components/DevicesSection";
import { MediaSection } from "./src/components/MediaSection";
import { QueueSection } from "./src/components/QueueSection";
import { StreamViaUrlSection } from "./src/components/StreamViaUrlSection";
import { SignageSection } from "./src/components/SignageSection";
import { SettingsModal } from "./src/components/SettingsModal";
import { ConvertModal } from "./src/components/ConvertModal";
import { SubtitlesModal } from "./src/components/SubtitlesModal";
import { NowPlayingSheet } from "./src/components/NowPlayingSheet";

function CastScreen() {
  const { C, styles } = useTheme();
  const cast = useCast();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const [subsOpen, setSubsOpen] = useState(false);

  const hasPlayback = cast.status !== "IDLE" && cast.status !== "NO_MEDIA_PRESENT";
  // Prefer the transport's reported duration, but fall back to the probed length so a
  // live transcode (which advertises no timeline → duration 0) still shows real
  // progress and an end time.
  const totalSec = cast.duration > 0 ? cast.duration : cast.knownDurationSec;
  const progress = totalSec > 0 ? Math.min(1, cast.position / totalSec) : 0;

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
        <DevicesSection cast={cast} />

        {/* ---- Media ---- */}
        <MediaSection
          cast={cast}
          onOpenConvert={() => setConvertOpen(true)}
          onOpenSubtitles={() => setSubsOpen(true)}
        />

        {/* ---- Queue ---- */}
        {cast.queue.length > 0 && <QueueSection cast={cast} />}

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
        {(cast.canStreamViaUrl || cast.streamUrl) && <StreamViaUrlSection cast={cast} />}

        {/* ---- Signage (URL Launcher) result ---- */}
        {cast.signage && <SignageSection cast={cast} />}

        <Text style={styles.footer}>The TV must be on the same Wi-Fi network as this phone.</Text>
      </ScrollView>

      {/* ---- Settings (theme) modal ---- */}
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} cast={cast} />

      {/* ---- Convert dialog ---- */}
      <ConvertModal open={convertOpen} onClose={() => setConvertOpen(false)} cast={cast} />

      {/* ---- Subtitles dialog ---- */}
      <SubtitlesModal open={subsOpen} onClose={() => setSubsOpen(false)} cast={cast} />

      {/* ---- Now playing (draggable bottom-sheet card) ---- */}
      {hasPlayback && <NowPlayingSheet cast={cast} progress={progress} />}

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

  return (
    <ThemeProvider>
      <SafeAreaProvider>
        <CastScreen />
      </SafeAreaProvider>
    </ThemeProvider>
  );
}
