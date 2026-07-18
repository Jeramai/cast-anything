import { useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { Cast } from "../lib/cast";
import type { OutputMode } from "../convert/gallery";
import { CONVERT_QUALITY_LABELS } from "../convert/quality";
import { formatTime } from "../lib/formatTime";
import { useTheme } from "../theme/ThemeContext";
import { Button } from "./Button";

export function ConvertModal({
  open,
  onClose,
  cast,
}: {
  open: boolean;
  onClose: () => void;
  cast: Cast;
}) {
  const { C, styles } = useTheme();
  // Where a conversion's output goes: cache only, or also saved to the gallery.
  const [outMode, setOutMode] = useState<OutputMode>("cache");
  return (
    <Modal
      visible={open}
      transparent
      animationType="fade"
      onRequestClose={() => !cast.converting && onClose()}
    >
      <Pressable
        style={styles.modalBackdrop}
        onPress={() => !cast.converting && onClose()}
      >
        <Pressable style={styles.modalCard} onPress={() => {}}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Convert for TV</Text>
            <Pressable
              onPress={onClose}
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
                onClose();
              }}
              style={{ marginTop: 14 }}
            />
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
