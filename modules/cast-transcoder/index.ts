import { Platform } from 'react-native';
import CastTranscoder from './src/CastTranscoderModule';

/** True if the native zero-copy transcoder is in this build (Android only). */
export const nativeTranscoderAvailable = Platform.OS === 'android' && !!CastTranscoder;

export interface NativeTranscodeOptions {
  /** Source content:// or file URI. */
  inputUri: string;
  /** Destination file path (no scheme). */
  outputPath: string;
  /** Max output dimensions (aspect kept, downscale-only). Defaults to 1080p. */
  maxHeight?: number;
  maxWidth?: number;
  /** Cap the output frame rate (0 = keep source). From the convert-quality preset. */
  maxFps?: number;
  /** Encoder target bitrate in bits/s. From the convert-quality preset. Default 8 Mbps. */
  bitRate?: number;
  onProgress?: (fraction: number) => void;
}

/**
 * Hardware transcode to a ≤1080p H.264/AAC MP4 using MediaCodec surfaces (fast,
 * near zero-copy). Resolves with the output path. Throws `{ cancelled: true }` if
 * cancelled, or an Error on failure — callers can fall back to FFmpeg.
 */
export async function transcodeToH264(opts: NativeTranscodeOptions): Promise<string> {
  if (!CastTranscoder) throw new Error('Native transcoder not available');
  const sub = opts.onProgress
    ? CastTranscoder.addListener('onTranscodeProgress', (e) => opts.onProgress?.(e.progress))
    : null;
  try {
    return await CastTranscoder.transcode(
      opts.inputUri,
      opts.outputPath,
      opts.maxHeight ?? 1080,
      opts.maxWidth ?? 1920,
      opts.maxFps ?? 0,
      opts.bitRate ?? 8_000_000,
    );
  } catch (e) {
    if ((e as { code?: string })?.code === 'ERR_CANCELLED') {
      throw Object.assign(new Error('Transcode cancelled'), { cancelled: true });
    }
    throw e;
  } finally {
    sub?.remove();
  }
}

/** Cancel an in-progress native transcode. Safe anytime. */
export function cancelNativeTranscode(): void {
  try {
    CastTranscoder?.cancel();
  } catch {
    /* no-op */
  }
}
