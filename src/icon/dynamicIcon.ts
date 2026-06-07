import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * Theme-matched launcher icon. One opaque icon per accent is bundled by the
 * @howincodes/expo-dynamic-app-icon config plugin (see app.json); at runtime we
 * switch to the variant whose name matches the chosen accent key.
 *
 * The library's own entry calls requireNativeModule() at import, which throws on
 * a binary built before the plugin was added. We bind via requireOptionalNativeModule
 * instead, so an un-rebuilt dev build simply gets a null module and theme switching
 * keeps working — it just won't repaint the launcher icon until the next rebuild.
 */
interface DynamicIconModule {
  setAppIcon(name: string | null, isInBackground?: boolean): Promise<string | false>;
  getAppIcon(): Promise<string>;
}

const Native = requireOptionalNativeModule<DynamicIconModule>('ExpoDynamicAppIcon');

/**
 * Switch the launcher icon to the variant matching `accentKey`.
 *
 * The isInBackground flag means very different things per platform, so we set it
 * per platform:
 * - iOS  → true: change silently, no system "you changed the icon" alert.
 * - Android → false: apply on the very next onPause with no delay. (true would add
 *   a 5s delay that gets cancelled if you return to the app first, which makes the
 *   swap feel random. The library uses DONT_KILL_APP, so an immediate apply is safe.)
 *
 * Resolves false (and never throws) when the module is absent or the swap fails.
 */
export async function setAccentIcon(accentKey: string): Promise<boolean> {
  if (!Native) return false;
  try {
    const res = await Native.setAppIcon(accentKey, Platform.OS === 'ios');
    return res !== false;
  } catch (e) {
    console.warn('[icon] setAppIcon failed:', (e as Error)?.message);
    return false;
  }
}
