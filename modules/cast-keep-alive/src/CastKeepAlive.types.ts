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
}

/** A control the user triggered from the notification / lock screen. */
export type TransportAction = 'play' | 'pause' | 'stop' | 'seekBy' | 'seekTo';

/** Payload of the `onTransportCommand` native event. */
export interface TransportCommand {
  action: TransportAction;
  /** Seconds: delta for `seekBy`, absolute target for `seekTo`; else null. */
  value: number | null;
}
