import { useRef } from "react";
import { Animated, PanResponder, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { Cast } from "../lib/cast";
import type { MediaItem } from "../media/mime";
import { useTheme } from "../theme/ThemeContext";
import { Button } from "./Button";
import { Section } from "./Section";

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

export function QueueSection({ cast }: { cast: Cast }) {
  const { styles } = useTheme();
  return (
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
  );
}
