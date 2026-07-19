import { useEffect, useRef } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { Cast } from "../lib/cast";
import { useTheme } from "../theme/ThemeContext";
import { ACCENTS, BASES, SYSTEM_BASE_KEY } from "../theme/themes";
import { setAccentIcon } from "../icon/dynamicIcon";
import { Button } from "./Button";
import { BottomSheet } from "./BottomSheet";

// Support page. Opens in the browser — deliberately unlocks nothing in the app, so
// this stays an external "tip / priority on requests" link and not a Play-Billing
// digital purchase.
const KOFI_URL = "https://ko-fi.com/jeramai";

function openKofi() {
  Linking.openURL(KOFI_URL).catch(() => {});
}

export function SettingsModal({
  open,
  onClose,
  cast,
}: {
  open: boolean;
  onClose: () => void;
  cast: Cast;
}) {
  const { C, styles, baseKey, accentKey, setBaseKey, setAccentKey } = useTheme();

  // Repaint the launcher icon to match the accent — but only when the sheet closes,
  // so rapidly previewing accents doesn't swap on every tap. We snapshot the accent
  // on open and diff on close. accentLatest tracks the live accent so the close-diff
  // sees the final choice without re-running mid-preview. No-ops gracefully if the
  // native module is absent (older dev build) — the icon updates next rebuild.
  const accentLatest = useRef(accentKey);
  // Write after commit (not during render) so render stays pure. Declared before the
  // open/close effect below, so on close the ref already holds the final accent.
  useEffect(() => {
    accentLatest.current = accentKey;
  });
  const accentAtOpen = useRef(accentKey);
  useEffect(() => {
    if (open) accentAtOpen.current = accentLatest.current;
    else if (accentLatest.current !== accentAtOpen.current)
      setAccentIcon(accentLatest.current);
  }, [open]);

  return (
    <BottomSheet open={open} onClose={onClose} heightFraction={0.85}>
      <Text style={[styles.modalTitle, local.title]}>Settings</Text>
      <ScrollView
        style={local.scroll}
        contentContainerStyle={local.body}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={local.group}>
          <Text style={styles.sectionTitle}>Appearance</Text>
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
        </View>

        <View style={[local.divider, { backgroundColor: C.border }]} />

        <View style={local.group}>
          <Text style={styles.sectionTitle}>Subtitles</Text>
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
        </View>

        <View style={[local.divider, { backgroundColor: C.border }]} />

        <View style={local.group}>
          <Text style={styles.sectionTitle}>Support</Text>
          <Button title="Support on Ko-fi" icon="cafe" onPress={openKofi} />
          <Text style={styles.hint}>
            Chip in to support development and get your feature requests bumped up the
            list. Opens Ko-fi in your browser — nothing is unlocked in the app.
          </Text>
        </View>
      </ScrollView>
    </BottomSheet>
  );
}

const local = StyleSheet.create({
  title: { paddingHorizontal: 16, paddingBottom: 12 },
  scroll: { flexShrink: 1 },
  body: { paddingHorizontal: 16, paddingBottom: 8, gap: 22 },
  group: { gap: 10 },
  divider: { height: StyleSheet.hairlineWidth },
});
