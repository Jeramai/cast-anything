import { NativeModule, requireOptionalNativeModule } from 'expo';

import type { TransportCommand } from './CastKeepAlive.types';

type CastKeepAliveEvents = {
  /** Fired when a control is used from the notification / lock screen. */
  onTransportCommand: (event: TransportCommand) => void;
};

declare class CastKeepAliveModule extends NativeModule<CastKeepAliveEvents> {
  /**
   * Start (or update) the foreground service + playback notification.
   *  - Android: media-style notification with transport controls + a seek bar,
   *    backed by a MediaSession; also holds the wake / Wi-Fi locks.
   *  - iOS: begins a time-limited background task (no media notification).
   */
  present(
    title: string,
    state: string,
    position: number,
    duration: number,
    controls: boolean,
    artworkPath: string,
    volume: number,
  ): void;
  /** Tear down the foreground service / end the background task. */
  stop(): void;
  /**
   * Ask the OS to exempt the app from battery optimization (Android), so the media
   * server keeps serving with the screen off. Returns true if already exempt (no
   * dialog); otherwise opens the system prompt and returns false. No-op on iOS.
   */
  requestIgnoreBatteryOptimizations(): boolean;
}

// `requireOptionalNativeModule` returns null when the native module isn't in the
// running binary (e.g. before a rebuild that includes it), so importing this
// never crashes an older build — callers just no-op until the app is rebuilt.
export default requireOptionalNativeModule<CastKeepAliveModule>('CastKeepAlive');
