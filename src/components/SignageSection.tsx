import { useRef } from "react";
import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { Cast } from "../lib/cast";
import { formatTime } from "../lib/formatTime";
import { useTheme } from "../theme/ThemeContext";
import { Button } from "./Button";
import { Section } from "./Section";

export function SignageSection({ cast }: { cast: Cast }) {
  const { C, styles } = useTheme();
  // Only read inside the tap handler (never rendered) → a ref avoids a re-render on layout.
  const barWidthRef = useRef(0);
  // Photos aren't a timeline: no play/pause, seek, scrub or volume. Based on what's
  // actually casting (nowPlaying), not the live selection.
  const isImage = cast.nowPlaying?.kind === "image";
  if (!cast.signage) return null;
  return (
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
  );
}
