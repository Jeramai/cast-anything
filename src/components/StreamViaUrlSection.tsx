import { Text } from "react-native";
import * as Clipboard from "expo-clipboard";
import type { Cast } from "../lib/cast";
import { useTheme } from "../theme/ThemeContext";
import { Button } from "./Button";
import { Section } from "./Section";

export function StreamViaUrlSection({ cast }: { cast: Cast }) {
  const { styles } = useTheme();
  return (
    <Section title="Stream via URL">
      {cast.streamUrl ? (
        <>
          <Text style={styles.hint}>
            Serving from your phone. This TV can’t play the file itself — open
            this URL in a player like VLC on a computer or another device on
            this Wi-Fi:
          </Text>
          <Text selectable style={styles.urlBox}>
            {cast.streamUrl}
          </Text>
          <Button
            icon="copy-outline"
            title="Copy URL"
            onPress={() => {
              if (cast.streamUrl) Clipboard.setStringAsync(cast.streamUrl);
            }}
            style={{ marginTop: 8 }}
          />
        </>
      ) : (
        <>
          <Text style={styles.hint}>
            This TV can’t play this file, even by transcoding. Use “Convert” above
            for a seekable saved copy, or serve it to another player (like VLC) over
            the network:
          </Text>
          <Button
            icon="link-outline"
            title="Stream via URL"
            loading={cast.busy}
            progress={cast.castProgress}
            progressLabel="Serving"
            onPress={cast.streamViaUrl}
            style={{ marginTop: 8 }}
          />
        </>
      )}
    </Section>
  );
}
