// Pure conversion-planning logic — no native imports, so it's unit-testable.
// transcode.ts wires this to FFprobe/FFmpegKit + the filesystem.

export interface MediaProbe {
  /** ffprobe format string, e.g. "matroska,webm" or "mov,mp4,m4a,...". */
  container: string;
  videoCodec: string | null;
  audioCodec: string | null;
  /** Duration in seconds (0 if unknown). */
  durationSec: number;
}

export interface CastAssessment {
  /** Already TV-friendly (MP4 + H.264 + AAC) — no conversion needed. */
  compatible: boolean;
  /** Whether we can produce a castable file (false if it needs video re-encoding). */
  canConvert: boolean;
  videoPlan: 'copy' | 'reencode' | 'none';
  audioPlan: 'copy' | 'aac' | 'none';
  /** Human-readable explanation for the UI. */
  reason: string;
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

  // We can only copy the video stream (no x264 in this build).
  if (p.videoCodec && p.videoCodec !== 'h264') {
    return {
      compatible: false,
      canConvert: false,
      videoPlan: 'reencode',
      audioPlan: audioOk ? 'copy' : 'aac',
      reason: `Video is ${p.videoCodec}, which would need re-encoding (not supported by this build). Only H.264 files can be converted here.`,
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
 * Build the FFmpeg argument list for a conversion. Video is always copied (this
 * build can't re-encode); audio is copied, transcoded to AAC, or dropped — `-an`
 * only when there is genuinely no audio stream.
 */
export function buildConvertArgs(input: string, outPath: string, plan: CastAssessment): string[] {
  const args = ['-y', '-i', input, '-c:v', 'copy'];
  if (plan.audioPlan === 'aac') args.push('-c:a', 'aac', '-b:a', '192k');
  else if (plan.audioPlan === 'none') args.push('-an');
  else args.push('-c:a', 'copy');
  args.push('-movflags', '+faststart', outPath);
  return args;
}
