import { memo, useCallback, useState } from "react";
import { FlatList, Modal, Pressable, Text, View, type ListRenderItemInfo } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { Cast } from "../lib/cast";
import type { SubtitleResult } from "../subtitles/subdl";
import { useTheme } from "../theme/ThemeContext";
import { Button } from "./Button";

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

export function SubtitlesModal({
  open,
  onClose,
  cast,
}: {
  open: boolean;
  onClose: () => void;
  cast: Cast;
}) {
  const { C, styles } = useTheme();
  const [subLang, setSubLang] = useState("en");

  // Stable renderItem so the subtitle-results FlatList windows without rebuilding rows
  // (cast.attachSub is itself stable — a useCallback in the hook).
  const renderSubResult = useCallback(
    ({ item }: ListRenderItemInfo<SubtitleResult>) => (
      <SubResultRow item={item} onAttach={cast.attachSub} />
    ),
    [cast.attachSub],
  );

  return (
    <Modal
      visible={open}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={() => {}}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Subtitles</Text>
            <Pressable onPress={onClose} hitSlop={10}>
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
  );
}
