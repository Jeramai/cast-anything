import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Animated,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../theme/ThemeContext";

const OPEN_MS = 300;
const CLOSE_MS = 240;
const SETTLE_MS = 180;
// Drag the grabber past this fraction of the sheet height — or fling faster than
// FLING_VELOCITY (px/ms) — to dismiss; otherwise it springs back open.
const DISMISS_FRACTION = 0.25;
const FLING_VELOCITY = 0.5;

/**
 * The app's bottom-sheet primitive — ported from Cadence's BottomSheet, but rebuilt on
 * core Animated + PanResponder (like NowPlayingSheet) so it adds no native deps, and
 * themed via useTheme() instead of NativeWind. It slides up from the bottom, dims the
 * content behind (tap the scrim to dismiss), and drag-to-dismiss lives on the grabber
 * only so the gesture never fights a ScrollView in the body. Shrink-wraps to its
 * content, capped at `heightFraction` of the screen. Hosted in a transparent Modal for
 * full-screen scrim coverage and hardware-back support. `translateY` drives the slide,
 * the drag, and the backdrop opacity together (0 = open, sheet height = closed).
 */
export function BottomSheet({
  open,
  onClose,
  heightFraction = 0.9,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** Max sheet height as a fraction of the screen; it shrink-wraps shorter content. */
  heightFraction?: number;
  children: ReactNode;
}) {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: winH } = useWindowDimensions();

  // 0 = fully open; sheetHeight = fully off-screen (resting closed). Start at a full
  // screen height so the sheet is below the screen regardless of content height.
  const translateY = useRef(new Animated.Value(winH)).current;
  const sheetHeight = useRef(winH);
  const [mounted, setMounted] = useState(open);
  // Gate the open slide until the first measurement so it starts at the sheet's true
  // edge rather than the full-screen fallback (which would read as lag).
  const [laidOut, setLaidOut] = useState(false);

  // Keep onClose fresh for the PanResponder, which is created once and would otherwise
  // capture the first render's onClose forever.
  const onCloseRef = useRef(onClose);
  // Write after commit (not during render) so render stays pure.
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // Lazy-mount on open (adjust during render, not in an effect, so it isn't flagged as
  // state-synced-in-an-effect); stays mounted until the close animation finishes.
  if (open && !mounted) setMounted(true);

  useEffect(() => {
    if (open) {
      if (!laidOut) return;
      Animated.timing(translateY, { toValue: 0, duration: OPEN_MS, useNativeDriver: true }).start();
    } else if (mounted) {
      Animated.timing(translateY, {
        toValue: sheetHeight.current,
        duration: CLOSE_MS,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
  }, [open, laidOut, mounted, translateY]);

  const panRef = useRef<ReturnType<typeof PanResponder.create> | null>(null);
  if (panRef.current === null) {
    panRef.current = PanResponder.create({
      // Claim the gesture on touch-start (not just on move) so a tap is caught and the
      // drag can't be lost to the Modal's view underneath.
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 4,
      onPanResponderMove: (_e, g) => {
        translateY.setValue(Math.max(0, g.dy));
      },
      onPanResponderRelease: (_e, g) => {
        // A tap (negligible drag) dismisses; so does a drag past the threshold or a
        // downward fling. A short drag springs back open.
        const tapped = Math.abs(g.dy) < 6 && Math.abs(g.vy) < 0.2;
        const dismiss = tapped || g.dy > sheetHeight.current * DISMISS_FRACTION || g.vy > FLING_VELOCITY;
        if (dismiss) {
          onCloseRef.current();
        } else {
          Animated.timing(translateY, { toValue: 0, duration: SETTLE_MS, useNativeDriver: true }).start();
        }
      },
    });
  }
  const pan = panRef.current;

  const backdropOpacity = translateY.interpolate({
    inputRange: [0, Math.max(1, sheetHeight.current)],
    outputRange: [0.6, 0],
    extrapolate: "clamp",
  });

  if (!mounted) return null;

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={onClose}>
      <View style={styles.root}>
        {/* Scrim — dims the content behind. Tap outside the sheet to dismiss. */}
        <Animated.View style={[styles.scrim, { opacity: backdropOpacity }]}>
          <Pressable style={styles.fill} onPress={onClose} />
        </Animated.View>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <Animated.View
            onLayout={(e) => {
              const h = e.nativeEvent.layout.height;
              sheetHeight.current = h;
              if (!laidOut) {
                translateY.setValue(h);
                setLaidOut(true);
              }
            }}
            style={[
              styles.sheet,
              {
                backgroundColor: C.card,
                maxHeight: Math.round(winH * heightFraction),
                paddingBottom: insets.bottom + 8,
                transform: [{ translateY }],
              },
            ]}
          >
            {/* The grabber is the dismiss target (tap or drag) — no close button needed.
                hitSlop widens the small pill into a comfortable grab area. */}
            <View
              style={styles.handle}
              hitSlop={{ top: 12, bottom: 16, left: 24, right: 24 }}
              {...pan.panHandlers}
            >
              <View style={[styles.grabber, { backgroundColor: C.border }]} />
            </View>
            {children}
          </Animated.View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end" },
  scrim: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "#000",
  },
  fill: { flex: 1 },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    boxShadow: "0px -4px 16px rgba(0,0,0,0.35)",
  },
  handle: { paddingTop: 10, paddingBottom: 12, alignItems: "center" },
  grabber: { alignSelf: "center", width: 40, height: 5, borderRadius: 99 },
});
