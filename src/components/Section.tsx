import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { useTheme } from "../theme/ThemeContext";

export function Section({ title, children }: { title: string; children: ReactNode }) {
  const { styles } = useTheme();
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}
