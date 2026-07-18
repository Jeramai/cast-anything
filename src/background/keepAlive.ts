import {
  addTransportCommandListener,
  backgroundSleep,
  presentPlayback,
  requestIgnoreBatteryOptimizations,
  stopPlayback,
  type PlaybackInfo,
  type TransportAction,
} from '../../modules/cast-keep-alive';

export { addTransportCommandListener, backgroundSleep };
export type { PlaybackInfo, TransportAction };

// Prompt for the battery-optimization exemption at most once per session — the
// native side no-ops if already granted, but we don't want to re-open the system
// dialog on every cast if the user dismissed it.
let exemptionAsked = false;
/**
 * Ensure the app can keep serving in the background (screen off). Without the
 * battery-optimization exemption, Doze defers our network after ~30 min and the
 * TV loses the stream. Best-effort + no-ops if already exempt or on iOS.
 */
export function ensureBackgroundExemption(): void {
  if (exemptionAsked) return;
  exemptionAsked = true;
  try {
    requestIgnoreBatteryOptimizations();
  } catch {
    /* native module absent — nothing to do */
  }
}

/**
 * Keep the phone serving while a cast is in progress, and show a playback
 * notification with controls.
 *
 *  - `expo-keep-awake` stops the screen auto-locking while you're set up.
 *  - the native foreground service (Android) shows a media notification with
 *    transport controls + a seek bar and keeps the process + radios alive once
 *    the screen goes off. iOS gets a time-limited background task (no controls).
 *
 * Both require the native module to be in the build — they no-op on a binary
 * that predates them, so the app keeps working until it's rebuilt.
 */
const TAG = 'cast-active';

type KeepAwake = {
  activateKeepAwakeAsync: (tag?: string) => Promise<void>;
  deactivateKeepAwake: (tag?: string) => Promise<void>;
};

// `expo-keep-awake` requires its native module at import time, which throws on a
// binary that predates it. Load it lazily so that never crashes the JS bundle —
// it simply stays null until the app is rebuilt with the module.
let keepAwake: KeepAwake | null | undefined;
function getKeepAwake(): KeepAwake | null {
  if (keepAwake === undefined) {
    try {
      keepAwake = require('expo-keep-awake') as KeepAwake;
    } catch {
      keepAwake = null;
    }
  }
  return keepAwake;
}

// Independent tag for "keep the screen on while the app is open" — separate from
// the cast-active tag, so the screen stays awake whenever either is in effect.
const SCREEN_TAG = 'app-awake';

/** Keep the screen from auto-locking while the app is foregrounded (or release it). */
export async function setScreenAwake(on: boolean): Promise<void> {
  const ka = getKeepAwake();
  if (!ka) return;
  try {
    if (on) await ka.activateKeepAwakeAsync(SCREEN_TAG);
    else await ka.deactivateKeepAwake(SCREEN_TAG);
  } catch {
    /* keep-awake not in this binary yet — no-op until rebuilt */
  }
}

let active = false;

/** Start or update the keep-alive + playback notification for an active cast. */
export async function presentKeepAlive(info: PlaybackInfo): Promise<void> {
  presentPlayback(info);
  if (!active) {
    active = true;
    try {
      await getKeepAwake()?.activateKeepAwakeAsync(TAG);
    } catch {
      /* keep-awake not in this binary yet — foreground service still covers it */
    }
  }
}

/** Tear down the keep-alive + playback notification. */
export async function stopKeepAlive(): Promise<void> {
  stopPlayback();
  if (!active) return;
  active = false;
  try {
    await getKeepAwake()?.deactivateKeepAwake(TAG);
  } catch {
    /* ignore */
  }
}
