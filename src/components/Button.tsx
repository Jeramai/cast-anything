import { ActivityIndicator, Pressable, Text, View, type PressableProps } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../theme/ThemeContext";

type BtnProps = PressableProps & {
  title?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  variant?: "primary" | "secondary" | "ghost";
  loading?: boolean;
  /** When set (0–1), the button becomes a progress bar that fills left→right. */
  progress?: number | null;
  /** Verb shown while `progress` is active, e.g. "Sending" → "Sending… 42%". */
  progressLabel?: string;
};

export function Button({ title, icon, variant = "secondary", loading, progress, progressLabel, disabled, style, ...rest }: BtnProps) {
  const { C, styles } = useTheme();
  const showProgress = progress != null;
  const isDisabled = disabled || loading || showProgress;
  const fg = variant === "primary" ? "#fff" : C.text;
  const pct = showProgress ? Math.round(progress * 100) : 0;
  return (
    <Pressable
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.btn,
        variant === "primary" && styles.btnPrimary,
        variant === "ghost" && styles.btnGhost,
        isDisabled && !showProgress && styles.btnDisabled,
        pressed && !isDisabled && styles.btnPressed,
        showProgress && { overflow: "hidden" },
        style as object,
      ]}
      {...rest}
    >
      {showProgress ? (
        <>
          <View style={[styles.btnProgressFill, { width: `${pct}%` }]} />
          <View style={styles.btnContent}>
            <ActivityIndicator size="small" color={fg} />
            <Text style={[styles.btnText, styles.btnTextPrimary]}>{progressLabel ?? "Sending"}… {pct}%</Text>
          </View>
        </>
      ) : loading ? (
        <ActivityIndicator color={variant === "primary" ? "#fff" : C.text} />
      ) : (
        <View style={styles.btnContent}>
          {icon && <Ionicons name={icon} size={18} color={fg} />}
          {!!title && (
            <Text
              style={[
                styles.btnText,
                variant === "primary" && styles.btnTextPrimary,
                variant === "ghost" && styles.btnTextGhost,
              ]}
            >
              {title}
            </Text>
          )}
        </View>
      )}
    </Pressable>
  );
}
