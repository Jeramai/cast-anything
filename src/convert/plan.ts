// Pure conversion-planning logic — no native imports, so it's unit-testable.
// transcode.ts wires this to FFprobe/FFmpegKit + the filesystem.

export interface MediaProbe {
  /** ffprobe format string, e.g. "matroska,webm" or "mov,mp4,m4a,...". */
  container: string;
  videoCodec: string | null;
  audioCodec: string | null;
  /** Duration in seconds (0 if unknown). */
  durationSec: number;
  /** Video width/height in px (0/undefined if unknown). Used to gate re-encode. */
  width?: number;
  height?: number;
}

export interface CastAssessment {
  /** Already TV-friendly (MP4 + H.264 + AAC) — no conversion needed. */
  compatible: boolean;
  /** Whether we can produce a castable file (false if it needs an impractical re-encode). */
  canConvert: boolean;
  videoPlan: 'copy' | 'reencode' | 'none';
  audioPlan: 'copy' | 'aac' | 'none';
  /** During a re-encode, downscale to fit 1080p (source is larger, e.g. 4K). */
  downscale?: boolean;
  /** Human-readable explanation for the UI. */
  reason: string;
}

// Above this the source is downscaled to 1080p during re-encode — the Freestyle is
// a 1080p device and a phone software-encode of 4K is punishingly slow.
const MAX_HEIGHT = 1088; // 1080 + slack
const MAX_WIDTH = 1940; // 1920 + slack

/** A short human label for a resolution, used in the "can't convert" guidance. */
function resolutionLabel(width: number, height: number): string {
  if (height >= 2000 || width >= 3000) return '4K';
  if (height > 0) return `${height}p`;
  return 'high-resolution';
}

/** Decide what (if anything) to do to make a probed file castable. */
export function assessForCast(p: MediaProbe): CastAssessment {
  const isMp4 = /mp4|mov|m4a/.test(p.container);
  const videoOk = p.videoCodec === 'h264' || p.videoCodec === null;
  const audioOk = p.audioCodec === 'aac' || p.audioCodec === 'mp3' || p.audioCodec === null;

  if (isMp4 && videoOk && audioOk) {
    return {
      compatible: true,
      canConvert: true,
      // Copy whatever streams exist; 'none' is reserved for a genuinely absent
      // stream. (Hardcoding audioPlan:'none' here stripped audio from an already
      // TV-friendly MP4 — it emitted `-an`.)
      videoPlan: p.videoCodec ? 'copy' : 'none',
      audioPlan: p.audioCodec ? 'copy' : 'none',
      reason: 'Already a TV-friendly MP4.',
    };
  }

  // Non-H.264 video (HEVC/VP9/…) → re-encode to H.264 with the bundled libx264,
  // downscaling to 1080p if the source is larger (the Freestyle is 1080p). This is a
  // software encode on the phone, so it can be slow for long/4K files — but it works.
  if (p.videoCodec && p.videoCodec !== 'h264') {
    const width = p.width ?? 0;
    const height = p.height ?? 0;
    const downscale = height > MAX_HEIGHT || width > MAX_WIDTH;
    const codec = p.videoCodec.toUpperCase();
    const audioPlan: CastAssessment['audioPlan'] = audioOk ? 'copy' : 'aac';
    const steps: string[] = [];
    if (downscale) steps.push(`downscale ${resolutionLabel(width, height)} → 1080p`);
    steps.push(`re-encode ${codec} → H.264`);
    if (audioPlan === 'aac') steps.push(`${p.audioCodec} audio → AAC`);
    return {
      compatible: false,
      canConvert: true,
      videoPlan: 'reencode',
      audioPlan,
      downscale,
      reason: `Will ${steps.join(', ')}. This is a phone software-encode, so it can take a while.`,
    };
  }

  const audioPlan: CastAssessment['audioPlan'] =
    p.audioCodec === null ? 'none' : audioOk ? 'copy' : 'aac';
  const parts: string[] = [];
  if (!isMp4) parts.push(`repackage ${p.container.split(',')[0] || 'file'} → MP4`);
  if (audioPlan === 'aac') parts.push(`convert ${p.audioCodec} audio → AAC`);
  return {
    compatible: false,
    canConvert: true,
    videoPlan: 'copy',
    audioPlan,
    reason: parts.length ? `Will ${parts.join(' and ')} (video copied as-is).` : 'Will repackage as MP4.',
  };
}

/**
 * Plan for the explicit "1080p" action: guarantee a ≤1080p H.264 MP4. Re-encodes
 * (downscaling if the source is larger) unless the file is already H.264 within
 * 1080p, in which case the normal plan (a fast remux) is enough.
 */
export function plan1080p(p: MediaProbe): CastAssessment {
  const over1080 = (p.height ?? 0) > MAX_HEIGHT || (p.width ?? 0) > MAX_WIDTH;
  const isH264 = p.videoCodec === 'h264' || p.videoCodec === null;
  if (isH264 && !over1080) return assessForCast(p);
  const audioOk = p.audioCodec === 'aac' || p.audioCodec === 'mp3' || p.audioCodec === null;
  return {
    compatible: false,
    canConvert: true,
    videoPlan: 'reencode',
    audioPlan: p.audioCodec === null ? 'none' : audioOk ? 'copy' : 'aac',
    downscale: over1080,
    reason: `Convert to 1080p H.264${over1080 ? ` (from ${resolutionLabel(p.width ?? 0, p.height ?? 0)})` : ''}.`,
  };
}

/**
 * Build the FFmpeg argument list for a conversion. Video is copied when already H.264
 * (fast, lossless remux) or re-encoded to H.264 otherwise, with a downscale-to-1080p
 * filter when the source is larger. `hw` selects the Android MediaCodec hardware
 * encoder (`h264_mediacodec`, many× faster than software) vs software `libx264`
 * (the fallback). Audio is copied, transcoded to AAC, or dropped.
 */
export interface EncodeOpts {
  /** HW-decode the source via Android MediaCodec (`-hwaccel mediacodec`). This is the
   *  big win for 4K HEVC — software HEVC decode, not the encode, is the bottleneck. */
  hwDecode?: boolean;
  /** HW-encode with `h264_mediacodec` (vs software `libx264`). */
  hwEncode?: boolean;
}

export function buildConvertArgs(
  input: string,
  outPath: string,
  plan: CastAssessment,
  enc: EncodeOpts = {},
): string[] {
  const reencode = plan.videoPlan === 'reencode';
  const args = ['-y'];
  // `-hwaccel` must precede `-i`. Only meaningful when we re-encode (a remux doesn't
  // decode frames). ffmpeg copies the HW-decoded frames back to system memory so the
  // scale/format filter still works.
  if (reencode && enc.hwDecode) args.push('-hwaccel', 'mediacodec');
  args.push('-i', input);
  if (reencode) {
    // Fit within 1920x1080, preserve aspect, keep dimensions even (H.264 requires it).
    // (Default scaler: measured no throughput gain from fast_bilinear — the ceiling is
    // the hardware decode↔encode frame copy, not the scale — so keep the better quality.)
    const vf: string[] = [];
    if (plan.downscale) {
      vf.push('scale=w=1920:h=1080:force_original_aspect_ratio=decrease:force_divisible_by=2');
    }
    if (enc.hwEncode) {
      // Hardware encoder: format=nv12 downconverts 10-bit HDR → 8-bit and gives the
      // encoder the pixel format it expects. HW encoders are bitrate-based (no CRF).
      vf.push('format=nv12');
      args.push('-c:v', 'h264_mediacodec', '-b:v', '8M');
    } else {
      // Software x264 fallback — slow but works on any device.
      vf.push('format=yuv420p');
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23');
    }
    args.push('-vf', vf.join(','));
  } else {
    args.push('-c:v', 'copy');
  }
  if (plan.audioPlan === 'aac') args.push('-c:a', 'aac', '-b:a', '192k');
  else if (plan.audioPlan === 'none') args.push('-an');
  else args.push('-c:a', 'copy');
  args.push('-movflags', '+faststart', outPath);
  return args;
}
