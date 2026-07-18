import CastKeepAlive from './src/CastKeepAliveModule';
import type {
  PlaybackInfo,
  TransportAction,
  TransportCommand,
} from './src/CastKeepAlive.types';

export * from './src/CastKeepAlive.types';

/**
 * Start (or update) the playback notification + keep the app alive while
 * casting. Safe to call repeatedly — the native side starts the foreground
 * service on the first call and just updates the notification after that.
 */
export function presentPlayback(info: PlaybackInfo): void {
  try {
    CastKeepAlive?.present(
      info.title,
      info.state,
      info.position,
      info.duration,
      info.controls,
      info.artworkPath ?? '',
      info.volume ?? -1,
    );
  } catch {
    /* native module absent or threw */
  }
}

/** Remove the playback notification / end the background task. Safe anytime. */
export function stopPlayback(): void {
  try {
    CastKeepAlive?.stop();
  } catch {
    /* no-op */
  }
}

/**
 * Delay that KEEPS RUNNING with the screen off. React Native's setTimeout /
 * setInterval are driven by the UI Choreographer and freeze whenever the activity
 * pauses (power button / pocket) — which silently stops any JS loop, including the
 * ones feeding the TV. This resolves from a native timer thread instead (promise
 * resolutions still dispatch to JS while paused). Falls back to setTimeout when the
 * native module isn't in the binary (old build / web), where the freeze caveat
 * then applies.
 */
export function backgroundSleep(ms: number): Promise<void> {
  try {
    if (CastKeepAlive && typeof CastKeepAlive.sleep === 'function') {
      return CastKeepAlive.sleep(ms);
    }
  } catch {
    /* fall through to the JS timer */
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ask the OS to exempt the app from battery optimization (Android) so the media
 * server keeps serving with the screen off. Returns true if already exempt.
 */
export function requestIgnoreBatteryOptimizations(): boolean {
  try {
    return CastKeepAlive?.requestIgnoreBatteryOptimizations() ?? true;
  } catch {
    return true; // module absent / iOS — don't nag
  }
}

/**
 * Subscribe to transport commands the user triggers from the notification / lock
 * screen. Returns an unsubscribe handle (no-op if the native module is absent).
 */
export function addTransportCommandListener(
  listener: (action: TransportAction, value: number | null) => void,
): { remove: () => void } {
  if (!CastKeepAlive) return { remove: () => {} };
  return CastKeepAlive.addListener('onTransportCommand', (e: TransportCommand) =>
    listener(e.action, e.value),
  );
}
