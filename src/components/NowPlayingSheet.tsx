import { useEffect, useRef, useState } from "react";
import { Animated, PanResponder, Pressable, Text, View } from "react-native";
import type { Cast } from "../lib/cast";
import { formatTime } from "../lib/formatTime";
import { useTheme } from "../theme/ThemeContext";
import { Button } from "./Button";

/**
 * Draggable "Now playing" card pinned to the bottom. Drag (or tap) the handle to
 * slide between a peek bar (title + play/pause) and the full controls. Built on
 * Animated + PanResponder so it needs no extra native deps.
 */
export function NowPlayingSheet({
  cast,
  progress,
}: {
  cast: Cast;
  progress: number;
}) {
  const { styles } = useTheme();
  // Photos aren't a timeline: no play/pause, seek, scrub or volume — just the
  // option to take them off the screen. Audio/video get the full transport.
  // Based on what's actually casting (nowPlaying), not the live selection.
  const isImage = cast.nowPlaying?.kind === "image";
  const isPlaying = cast.status === "PLAYING";
  const isPaused = cast.status === "PAUSED_PLAYBACK";
  const isTransitioning = cast.status === "TRANSITIONING";
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
