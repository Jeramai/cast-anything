import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { DlnaDevice } from "../dlna";
import { useTheme } from "../theme/ThemeContext";

export function DeviceRow({
  device,
  selected,
  onPress,
}: {
  device: DlnaDevice;
  selected: boolean;
  onPress: () => void;
}) {
  const { C, styles } = useTheme();
  const subtitle = [device.manufacturer, device.modelName].filter(Boolean).join(" · ");
  return (
    <Pressable onPress={onPress} style={[styles.deviceRow, selected && styles.deviceRowActive]}>
      <Ionicons
        name={device.isSignage ? "easel" : device.isSamsung ? "tv" : "desktop"}
        size={24}
        color={selected ? C.accent : C.textDim}
        style={styles.deviceIcon}
      />
      <View style={{ flex: 1 }}>
        <View style={styles.deviceNameRow}>
          <Text style={styles.deviceName} numberOfLines={1}>
            {device.friendlyName}
          </Text>
          {device.isSignage && <Text style={styles.signageTag}>SIGNAGE</Text>}
        </View>
        {!!subtitle && (
          <Text style={styles.deviceSub} numberOfLines={1}>
            {subtitle}
          </Text>
        )}
      </View>
      {selected && <Ionicons name="checkmark" size={22} color={C.accent} />}
    </Pressable>
  );
}
