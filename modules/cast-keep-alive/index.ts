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
