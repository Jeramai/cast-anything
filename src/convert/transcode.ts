import { NativeModules, Platform } from 'react-native';
import { CachesDirectoryPath, mkdir, exists, unlink } from '@dr.pogodin/react-native-fs';
import {
  FFmpegKit,
  FFmpegKitConfig,
  FFprobeKit,
  ReturnCode,
} from '@wokcito/ffmpeg-kit-react-native';
import type { MediaItem } from '../media/mime';
import { sanitizeFileName } from '../server/sanitize';
import {
  assessForCast,
  buildConvertArgs,
  MAX_HEIGHT,
  MAX_WIDTH,
  type EncodeOpts,
  type MediaProbe,
} from './plan';
import {
  CONVERT_QUALITY_TUNING,
  DEFAULT_CONVERT_QUALITY,
  type ConvertQuality,
} from './quality';

/**
 * On-device media conversion for files a DLNA TV can't play. Most "unsupported"
 * files are H.264 video in a container the TV won't open (.mkv/.avi/.ts) or with
 * an audio codec it can't decode (AC-3/DTS) — so we *remux* (copy the H.264 stream
 * untouched) into an MP4 and only transcode the audio to AAC when needed. That's
 * fast and lossless on video, even for multi-GB files.
 *
 * Backed by FFmpeg via @wokcito/ffmpeg-kit-react-native. The bundled "main" build
 * has no libx264, so it can't *re-encode* video — only H.264 sources can be made
 * castable here (which covers the overwhelmingly common case).
 */

const FFMPEG_DIR = `${CachesDirectoryPath}/cast-convert`;

/** True only on a binary that actually contains the FFmpeg native module. */
export const ffmpegAvailable =
  Platform.OS === 'android' && !!NativeModules.FFmpegKitReactNativeModule;

/** Resolve a picked uri to something FFmpeg can read (SAF token for content://). */
export async function ffmpegInput(uri: string): Promise<string> {
  if (uri.startsWith('content://')) return FFmpegKitConfig.getSafParameterForRead(uri);
  return uri.replace(/^file:\/\//, '');
}

/** Probe a picked file for its container + video/audio codecs. */
export async function probeMedia(uri: string): Promise<MediaProbe> {
  const input = await ffmpegInput(uri);
  const session = await FFprobeKit.getMediaInformation(input);
  const info = session.getMediaInformation();
  if (!info) throw new Error('Could not read media info');
  const streams = info.getStreams() ?? [];
  const video = streams.find((s) => s.getType() === 'video');
  const audio = streams.find((s) => s.getType() === 'audio');
  const dur = parseFloat(String(info.getDuration() ?? '0'));
  const width = video ? Number(video.getWidth()) : NaN;
  const height = video ? Number(video.getHeight()) : NaN;
  const fps = video ? parseFrameRate(video.getAverageFrameRate?.()) : 0;
  return {
    container: info.getFormat() ?? '',
    videoCodec: video ? video.getCodec() : null,
    audioCodec: audio ? audio.getCodec() : null,
    durationSec: Number.isFinite(dur) ? dur : 0,
    // Resolution gates the re-encode path (4K is declined) — best-effort.
    width: Number.isFinite(width) && width > 0 ? width : undefined,
    height: Number.isFinite(height) && height > 0 ? height : undefined,
    fps: fps > 0 ? fps : undefined,
  };
}

/** ffprobe reports frame rate as a rational string ("24000/1001", "30/1"); to a number. */
function parseFrameRate(rate?: string | null): number {
  if (!rate) return 0;
  const [num, den] = rate.split('/').map((n) => parseFloat(n));
  if (!Number.isFinite(num)) return 0;
  if (den === undefined) return num;
  if (!Number.isFinite(den) || den === 0) return 0;
  return num / den;
}

/**
 * Extract a single video frame at ~`atSec` to a JPEG and return its path (for the
 * notification artwork). No -vf scale (this build has no libavfilter) — a full-res
 * frame; the native side downsamples it. Returns null if FFmpeg is absent or fails.
 */
let thumbSeq = 0;
let lastThumb: string | null = null;

export async function extractThumbnail(uri: string, atSec: number): Promise<string | null> {
  if (!ffmpegAvailable) return null;
  try {
    if (!(await exists(FFMPEG_DIR))) await mkdir(FFMPEG_DIR);
    // Unique name each call — the native side caches artwork by path, so reusing
    // one name would make it skip re-decoding the new frame.
    const out = `${FFMPEG_DIR}/thumb-${thumbSeq++}.jpg`;
    const input = await ffmpegInput(uri);
    const args = ['-y', '-ss', String(Math.max(0, Math.floor(atSec))), '-i', input, '-frames:v', '1', '-an', out];
    const result = await new Promise<string | null>((resolve) => {
      FFmpegKit.executeWithArgumentsAsync(args, async (session) => {
        const rc = await session.getReturnCode();
        resolve(ReturnCode.isSuccess(rc) && (await exists(out)) ? out : null);
      }).catch(() => resolve(null));
    });
    if (result) {
      if (lastThumb) await unlink(lastThumb).catch(() => {});
      lastThumb = result;
    }
    return result;
  } catch {
    return null;
  }
}

let activeSessionId: number | null = null;

/** Cancel an in-progress conversion, if any. All conversion runs through FFmpeg now;
 *  the native MediaCodec transcoder (modules/cast-transcoder) is parked (see the
 *  encode-path note in convertForCast) and never started, so there's nothing else to
 *  cancel. */
export async function cancelConvert(): Promise<void> {
  if (activeSessionId != null) await FFmpegKit.cancel(activeSessionId);
}

export interface ConvertOptions {
  /** Progress 0..1 (best-effort; based on processed time vs. duration). */
  onProgress?: (fraction: number) => void;
  /** Speed/quality trade (resolution + frame-rate cap + bitrate) for the re-encode.
   *  Also decides the target a larger source is downscaled to. Defaults to the app
   *  default (favoring speed). */
  quality?: ConvertQuality;
}

/**
 * Convert a picked local file into a castable MP4 and return a new MediaItem
 * pointing at it. Throws if the file needs video re-encoding (unsupported) or
 * the conversion fails; rejects with `{ cancelled: true }` if cancelled.
 */
export async function convertForCast(item: MediaItem, opts: ConvertOptions = {}): Promise<MediaItem> {
  if (!ffmpegAvailable) throw new Error('Conversion needs a rebuilt app (FFmpeg not in this binary).');

  const probe = await probeMedia(item.uri);
  // The user's speed/quality trade → concrete resolution, frame-rate cap, and bitrate.
  const preset = CONVERT_QUALITY_TUNING[opts.quality ?? DEFAULT_CONVERT_QUALITY];
  let plan = assessForCast(probe);
  if (!plan.canConvert) throw new Error(plan.reason);
  // A source the TV itself can't display (>1080p) must be re-encoded even if it's
  // already H.264 (a copy can't downscale) — this folds in the old "1080p" button.
  const overTvCeiling = (probe.height ?? 0) > MAX_HEIGHT || (probe.width ?? 0) > MAX_WIDTH;
  if (overTvCeiling && plan.videoPlan !== 'reencode') {
    plan = { ...plan, videoPlan: 'reencode', downscale: true, compatible: false };
  }
  // The preset's box (e.g. Fastest = 720p) only shapes output when we're re-encoding
  // ANYWAY. It must never force a re-encode by itself: a castable H.264 source within
  // the TV ceiling keeps its fast lossless remux — otherwise the DEFAULT "fastest"
  // preset would turn the most common case (1080p H.264 in an .mkv) from a
  // seconds-long remux into a minutes-long lossy 720p re-encode.
  const needScale =
    plan.videoPlan === 'reencode' &&
    ((probe.height ?? 0) > preset.maxHeight || (probe.width ?? 0) > preset.maxWidth);

  if (!(await exists(FFMPEG_DIR))) await mkdir(FFMPEG_DIR);
  const base = sanitizeFileName(item.name).replace(/\.[^.]+$/, '') || 'converted';
  const outPath = `${FFMPEG_DIR}/${base}.mp4`;
  if (await exists(outPath)) await unlink(outPath);

  const input = await ffmpegInput(item.uri);
  const total = probe.durationSec * 1000; // statistics report processed time in ms
  // Source-aware fps cap: only cap when the source is actually faster than the target,
  // else 0 (keep source). FFmpeg's -r would otherwise DUPLICATE frames up to the target
  // on a 24fps source — adding work, not removing it.
  const effFps = probe.fps && probe.fps > preset.maxFps && preset.maxFps > 0 ? preset.maxFps : 0;
  const scaleTo = needScale ? { w: preset.maxWidth, h: preset.maxHeight } : undefined;
  const tuning = { maxFps: effFps, bitRateMbps: preset.bitRateMbps, scaleTo };
  console.log('[convert] plan', {
    quality: opts.quality ?? DEFAULT_CONVERT_QUALITY,
    videoPlan: plan.videoPlan,
    durationSec: Math.round(probe.durationSec),
    src: { w: probe.width, h: probe.height, fps: probe.fps, codec: probe.videoCodec },
    target: { maxH: preset.maxHeight, maxW: preset.maxWidth, fps: effFps || 'source', bitrateMbps: preset.bitRateMbps },
    scale: scaleTo ?? 'none',
  });
  const result: MediaItem = {
    uri: `file://${outPath}`,
    name: `${base}.mp4`,
    mime: 'video/mp4',
    kind: 'video',
    isLocal: true,
  };

  // Re-encode on the FFmpeg hardware path. (We used to prefer the native zero-copy
  // MediaCodec transcoder, but on some devices — e.g. Pixel 9 / Tensor — SELinux
  // denies the dma-buf access it needs, so it silently drops to a per-frame CPU copy
  // and crawls at well under 1x realtime. FFmpeg's MediaCodec path is slower in theory
  // but reliably ~2.5x here, so it's the one we use. The native module is still in the
  // tree — see git history / modules/cast-transcoder — to revisit on unaffected devices.)
  //
  // The stock FFmpeg build has the MediaCodec hardware encoder but no software libx264,
  // so we only try the hardware pipelines:
  //   1. HW decode + HW encode   — fastest (both on the video silicon)
  //   2. SW decode + HW encode   — some HW decoders reject a codec/10-bit profile
  // A remux (video copy) has no encoder/decoder to vary, so it's a single attempt.
  const attempts: EncodeOpts[] =
    plan.videoPlan === 'reencode'
      ? [
          { hwDecode: true, hwEncode: true },
          { hwDecode: false, hwEncode: true },
        ]
      : [{}];

  for (let i = 0; i < attempts.length; i++) {
    if (await exists(outPath)) await unlink(outPath);
    if (i > 0) opts.onProgress?.(0);
    const status = await runFfmpeg(
      buildConvertArgs(input, outPath, plan, attempts[i], tuning),
      total,
      opts.onProgress,
    );
    if (status === 'ok') return result;
    if (status === 'cancelled') {
      throw Object.assign(new Error('Conversion cancelled'), { cancelled: true });
    }
    if (i < attempts.length - 1) {
      console.warn(`[convert] encode attempt ${i + 1} failed (${JSON.stringify(attempts[i])}); trying next`);
    }
  }
  throw new Error('Conversion failed');
}

type FfmpegStatus = 'ok' | 'cancelled' | 'failed';

/** Run one FFmpeg session; resolves with its outcome (never rejects). */
function runFfmpeg(
  args: string[],
  totalMs: number,
  onProgress?: (fraction: number) => void,
): Promise<FfmpegStatus> {
  return new Promise<FfmpegStatus>((resolve) => {
    // `settled` guards the session-id assignment below: a very fast/failed convert can
    // fire the completion callback (which clears activeSessionId) *before* the
    // executeWithArgumentsAsync promise resolves, which would otherwise leave a stale
    // id that a later cancelConvert() would target.
    let settled = false;
    FFmpegKit.executeWithArgumentsAsync(
      args,
      async (session) => {
        activeSessionId = null;
        settled = true;
        const rc = await session.getReturnCode();
        resolve(ReturnCode.isSuccess(rc) ? 'ok' : ReturnCode.isCancel(rc) ? 'cancelled' : 'failed');
      },
      undefined,
      (stats) => {
        if (totalMs > 0 && onProgress) onProgress(Math.max(0, Math.min(1, stats.getTime() / totalMs)));
      },
    ).then((session) => {
      if (!settled) activeSessionId = session.getSessionId();
    });
  });
}
