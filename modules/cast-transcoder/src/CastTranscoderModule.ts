import { NativeModule, requireOptionalNativeModule } from 'expo';

type CastTranscoderEvents = {
  /** Progress 0..1 while transcoding. */
  onTranscodeProgress: (event: { progress: number }) => void;
};

declare class CastTranscoderModule extends NativeModule<CastTranscoderEvents> {
  /**
   * Transcode `inputUri` (content:// or file) to an H.264/AAC MP4 at `outputPath`,
   * downscaled to fit within maxWidth x maxHeight (aspect kept, downscale-only).
   * `maxFps` caps the output frame rate (0 = keep source) and `bitRate` (bits/s) is
   * the encoder target — the two convert-quality speed levers. Resolves with
   * outputPath; rejects (ERR_CANCELLED / ERR_TRANSCODE) otherwise.
   */
  transcode(
    inputUri: string,
    outputPath: string,
    maxHeight: number,
    maxWidth: number,
    maxFps: number,
    bitRate: number,
  ): Promise<string>;
  /** Cancel an in-progress transcode. */
  cancel(): void;
}

// Optional: null when the native module isn't in the running binary (older build),
// so importing this never crashes — callers fall back to FFmpeg.
export default requireOptionalNativeModule<CastTranscoderModule>('CastTranscoder');
