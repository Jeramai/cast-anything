// Pure convert-quality presets — no native imports, so it's unit-testable.
// transcode.ts maps the chosen preset onto the native transcoder (frame-rate +
// bitrate) and the FFmpeg fallback (buildConvertArgs tuning).
//
// The re-encode already runs on hardware (MediaCodec decode → GPU scale → encode),
// so the remaining speed levers are the two that shrink the encoder's workload:
//   • frame rate — capping 60fps/HFR sources to 30 nearly halves the frames to encode
//   • bitrate    — fewer output bytes to produce (and a smaller file that streams faster)
// The user picks the trade in the Convert dialog; the choice is persisted.

/** How to trade quality for conversion speed. */
export type ConvertQuality = 'best' | 'balanced' | 'fastest';

export interface QualityTuning {
  /** Cap the output frame rate (drop frames above this). 0 = keep the source fps. */
  maxFps: number;
  /** Target video bitrate in megabits/s for the hardware encoder. */
  bitRateMbps: number;
  /** Max output height (aspect kept, downscale-only). */
  maxHeight: number;
  /** Max output width (aspect kept, downscale-only). */
  maxWidth: number;
}

/**
 * The three presets. The Freestyle (and most cast targets) top out at 1080p, so
 * that's the quality ceiling. Resolution is by far the biggest encode-speed lever —
 * halving the pixel count roughly halves the work on either path — so `fastest`
 * drops to 720p (fine upscaled on a 1080p screen), on top of the 30fps cap and a
 * lower bitrate. `best` keeps source fps + full bitrate at 1080p; `balanced` caps
 * fps but keeps 1080p + bitrate.
 */
export const CONVERT_QUALITY_TUNING: Record<ConvertQuality, QualityTuning> = {
  best: { maxFps: 0, bitRateMbps: 8, maxHeight: 1080, maxWidth: 1920 },
  balanced: { maxFps: 30, bitRateMbps: 8, maxHeight: 1080, maxWidth: 1920 },
  fastest: { maxFps: 30, bitRateMbps: 6, maxHeight: 720, maxWidth: 1280 },
};

/** Default when the user hasn't chosen one — favor speed (their stated preference). */
export const DEFAULT_CONVERT_QUALITY: ConvertQuality = 'fastest';

/** Short human labels for the picker, in display order (slowest→fastest). */
export const CONVERT_QUALITY_LABELS: { key: ConvertQuality; label: string; hint: string }[] = [
  { key: 'best', label: 'Best · 1080p', hint: '1080p, source frame rate, full bitrate. Slowest.' },
  { key: 'balanced', label: 'Balanced · 1080p', hint: '1080p, caps to 30fps (halves work on 60fps videos).' },
  { key: 'fastest', label: 'Fastest · 720p', hint: '720p + 30fps + lower bitrate. Much quicker, smaller file.' },
];

/** Coerce an arbitrary stored/incoming value to a valid quality, else the default. */
export function toConvertQuality(value: unknown): ConvertQuality {
  return value === 'best' || value === 'balanced' || value === 'fastest'
    ? value
    : DEFAULT_CONVERT_QUALITY;
}
