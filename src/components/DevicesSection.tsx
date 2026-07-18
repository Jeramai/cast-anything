import { Text, View } from "react-native";
import type { Cast } from "../lib/cast";
import { useTheme } from "../theme/ThemeContext";
import { Button } from "./Button";
import { DeviceRow } from "./DeviceRow";
import { Section } from "./Section";

export function DevicesSection({ cast }: { cast: Cast }) {
  const { styles } = useTheme();
  return (
    <Section title="1 · Choose a device">
      <Button
        title={cast.isScanning ? "Scanning…" : "Scan for devices"}
        variant="primary"
        loading={cast.isScanning}
        onPress={cast.scan}
      />
      {cast.devices.length === 0 && !cast.isScanning && (
        <Text style={styles.hint}>
          {cast.scanCompleted
            ? "No devices found. Make sure the TV is on, awake, and on the same Wi-Fi as this phone — then scan again."
            : "Make sure the TV is on and on the same Wi-Fi, then scan."}
        </Text>
      )}
      <View style={{ gap: 8, marginTop: cast.devices.length ? 12 : 0 }}>
        {cast.devices.map((d) => (
          <DeviceRow
            key={d.id}
            device={d}
            selected={cast.selectedDevice?.id === d.id}
            onPress={() => cast.selectDevice(d)}
          />
        ))}
      </View>
    </Section>
  );
}
