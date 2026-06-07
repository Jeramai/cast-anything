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
import { assessForCast, buildConvertArgs, type MediaProbe } from './plan';

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
async function ffmpegInput(uri: string): Promise<string> {
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
  return {
    container: info.getFormat() ?? '',
    videoCodec: video ? video.getCodec() : null,
    audioCodec: audio ? audio.getCodec() : null,
    durationSec: Number.isFinite(dur) ? dur : 0,
  };
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

/** Cancel an in-progress conversion, if any. */
export async function cancelConvert(): Promise<void> {
  if (activeSessionId != null) await FFmpegKit.cancel(activeSessionId);
}

export interface ConvertOptions {
  /** Progress 0..1 (best-effort; based on processed time vs. duration). */
  onProgress?: (fraction: number) => void;
}

/**
 * Convert a picked local file into a castable MP4 and return a new MediaItem
 * pointing at it. Throws if the file needs video re-encoding (unsupported) or
 * the conversion fails; rejects with `{ cancelled: true }` if cancelled.
 */
export async function convertForCast(item: MediaItem, opts: ConvertOptions = {}): Promise<MediaItem> {
  if (!ffmpegAvailable) throw new Error('Conversion needs a rebuilt app (FFmpeg not in this binary).');

  const probe = await probeMedia(item.uri);
  const plan = assessForCast(probe);
  if (!plan.canConvert) throw new Error(plan.reason);

  if (!(await exists(FFMPEG_DIR))) await mkdir(FFMPEG_DIR);
  const base = sanitizeFileName(item.name).replace(/\.[^.]+$/, '') || 'converted';
  const outPath = `${FFMPEG_DIR}/${base}.mp4`;
  if (await exists(outPath)) await unlink(outPath);

  const input = await ffmpegInput(item.uri);
  const args = buildConvertArgs(input, outPath, plan);

  const total = probe.durationSec * 1000; // statistics report processed time in ms

  return new Promise<MediaItem>((resolve, reject) => {
    FFmpegKit.executeWithArgumentsAsync(
      args,
      async (session) => {
        activeSessionId = null;
        const rc = await session.getReturnCode();
        if (ReturnCode.isSuccess(rc)) {
          resolve({
            uri: `file://${outPath}`,
            name: `${base}.mp4`,
            mime: 'video/mp4',
            kind: 'video',
            isLocal: true,
          });
        } else if (ReturnCode.isCancel(rc)) {
          reject(Object.assign(new Error('Conversion cancelled'), { cancelled: true }));
        } else {
          reject(new Error(`Conversion failed (code ${rc?.getValue?.() ?? '?'})`));
        }
      },
      undefined,
      (stats) => {
        if (total > 0 && opts.onProgress) {
          opts.onProgress(Math.max(0, Math.min(1, stats.getTime() / total)));
        }
      },
    ).then((session) => {
      activeSessionId = session.getSessionId();
    });
  });
}
