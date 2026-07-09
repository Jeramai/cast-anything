/** Playback state shown in the Android media notification. */
export type PlaybackState = 'playing' | 'paused' | 'stopped';

/** Snapshot pushed to the native notification / MediaSession. */
export interface PlaybackInfo {
  title: string;
  state: PlaybackState;
  /** Current position, seconds. */
  position: number;
  /** Track duration, seconds (0 / unknown hides the seek bar). */
  duration: number;
  /** False for photos — show no transport controls / seek bar. */
  controls: boolean;
  /** Local path to a frame/thumbnail JPEG, shown as the notification artwork. */
  artworkPath?: string;
  /**
   * Current device volume (0–100), or -1 if unknown/unsupported. Keeps the
   * native remote VolumeProvider — which the phone's hardware volume keys drive
   * — in sync with the TV's real level.
   */
  volume?: number;
}

/**
 * A control the user triggered from the notification / lock screen, or a volume
 * change from the phone's hardware volume keys (`volumeTo`).
 */
export type TransportAction =
  | 'play'
  | 'pause'
  | 'stop'
  | 'seekBy'
  | 'seekTo'
  | 'volumeTo';

/** Payload of the `onTransportCommand` native event. */
export interface TransportCommand {
  action: TransportAction;
  /**
   * Seconds: delta for `seekBy`, absolute target for `seekTo`. Volume 0–100 for
   * `volumeTo`. Null otherwise.
   */
  value: number | null;
}
