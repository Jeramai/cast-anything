import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { Cast } from "../lib/cast";
import { useTheme } from "../theme/ThemeContext";
import { Button } from "./Button";
import { Section } from "./Section";

export function MediaSection({
  cast,
  onOpenConvert,
  onOpenSubtitles,
}: {
  cast: Cast;
  onOpenConvert: () => void;
  onOpenSubtitles: () => void;
}) {
  const { C, styles } = useTheme();
  const [urlInput, setUrlInput] = useState("");
  return (
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
                onPress={onOpenConvert}
                style={styles.grow}
              />
            )}
            {cast.media.kind === "video" && (
              <Button
                icon="chatbox-ellipses"
                title={cast.subtitle ? cast.subtitle.language.toUpperCase() : "Subs"}
                variant={cast.subtitle ? "primary" : "secondary"}
                onPress={onOpenSubtitles}
                style={styles.grow}
              />
            )}
            <Button icon="add" title="Queue" onPress={cast.enqueue} style={styles.grow} />
          </View>
        </>
      )}
    </Section>
  );
}
