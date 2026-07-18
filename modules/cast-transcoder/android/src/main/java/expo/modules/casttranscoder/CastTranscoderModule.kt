package expo.modules.casttranscoder

import android.net.Uri
import com.otaliastudios.transcoder.Transcoder
import com.otaliastudios.transcoder.TranscoderListener
import com.otaliastudios.transcoder.common.TrackType
import com.otaliastudios.transcoder.resize.AtMostResizer
import com.otaliastudios.transcoder.strategy.DefaultAudioStrategy
import com.otaliastudios.transcoder.strategy.DefaultVideoStrategy
import com.otaliastudios.transcoder.time.TimeInterpolator
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.Future

/**
 * Forces each track's output timestamps to be strictly increasing. Some sources hand
 * the muxer two samples at timestamp 0, which crashes it with "Timestamps must be
 * monotonically increasing: 0, 0" (sending the transcode to the slow FFmpeg fallback).
 * The library ships a MonotonicTimeInterpolator but it's `internal`, so we roll our own:
 * per track, never emit a timestamp <= the previous one (bump by 1µs when needed).
 */
private class MonotonicInterpolator : TimeInterpolator {
  private var lastVideo = Long.MIN_VALUE
  private var lastAudio = Long.MIN_VALUE

  override fun interpolate(type: TrackType, time: Long): Long {
    return if (type == TrackType.VIDEO) {
      lastVideo = if (time <= lastVideo) lastVideo + 1 else time
      lastVideo
    } else {
      lastAudio = if (time <= lastAudio) lastAudio + 1 else time
      lastAudio
    }
  }
}

/**
 * Hardware, (near) zero-copy transcode via deepmedia/Transcoder: the MediaCodec
 * decoder renders into a Surface, the GPU scales it, and the MediaCodec encoder
 * reads from a Surface — no per-frame CPU copies. That's the ceiling-buster over
 * the FFmpeg software/MediaCodec path (which round-trips every frame through
 * system memory and caps ~1.6x). Reads the picked `content://` URI directly, so
 * there's no multi-GB pre-copy either.
 */
class CastTranscoderModule : Module() {
  private var future: Future<Void>? = null

  override fun definition() = ModuleDefinition {
    Name("CastTranscoder")

    Events("onTranscodeProgress")

    // Transcode `inputUri` (a content:// or file URI) to an H.264/AAC MP4 at
    // `outputPath`, downscaled to fit within maxWidth x maxHeight (aspect kept,
    // downscale-only). `maxFps` caps the output frame rate (0 = keep source) and
    // `bitRate` (bits/s) sets the encoder target — both come from the user's chosen
    // convert-quality preset and are the levers that make a re-encode faster.
    // Resolves with outputPath; rejects on failure/cancel.
    AsyncFunction("transcode") { inputUri: String, outputPath: String, maxHeight: Int, maxWidth: Int, maxFps: Int, bitRate: Double, promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.reject("ERR_NO_CONTEXT", "No React context available", null)
        return@AsyncFunction
      }
      try {
        val videoBuilder = DefaultVideoStrategy.Builder()
          .addResizer(AtMostResizer(maxHeight, maxWidth)) // minor, major — downscale-only
          .bitRate(bitRate.toLong())
        // frameRate() caps only (won't invent frames), so applying it to a lower-fps
        // source is harmless. 0 means "keep the source rate".
        if (maxFps > 0) videoBuilder.frameRate(maxFps)
        val video = videoBuilder.build()
        // Re-encode audio to AAC keeping the SOURCE channel count. Two dead ends we
        // avoid: forcing stereo throws "channel count not supported: 6" (the remixer
        // can't downmix >2 ch), and PassThroughTrackStrategy NPEs on this file's track
        // format. Keeping channels → a passthrough remix (N→N, always supported).
        val audio = DefaultAudioStrategy.builder()
          .channels(DefaultAudioStrategy.CHANNELS_AS_INPUT)
          .sampleRate(DefaultAudioStrategy.SAMPLE_RATE_AS_INPUT)
          .build()
        future = Transcoder.into(outputPath)
          .addDataSource(context, Uri.parse(inputUri))
          .setVideoTrackStrategy(video)
          .setAudioTrackStrategy(audio)
          // Force monotonically-increasing timestamps so sources that hand the muxer
          // two samples at ts 0 don't crash it (which would drop us to slow FFmpeg).
          .setTimeInterpolator(MonotonicInterpolator())
          .setListener(object : TranscoderListener {
            override fun onTranscodeProgress(progress: Double) {
              sendEvent("onTranscodeProgress", mapOf("progress" to progress))
            }
            override fun onTranscodeCompleted(successCode: Int) {
              future = null
              promise.resolve(outputPath)
            }
            override fun onTranscodeCanceled() {
              future = null
              promise.reject("ERR_CANCELLED", "Transcode cancelled", null)
            }
            override fun onTranscodeFailed(exception: Throwable) {
              future = null
              promise.reject("ERR_TRANSCODE", exception.message ?: "Transcode failed", exception)
            }
          })
          .transcode()
      } catch (e: Exception) {
        future = null
        promise.reject("ERR_TRANSCODE", e.message ?: "Transcode failed", e)
      }
    }

    Function("cancel") {
      future?.cancel(true)
      future = null
    }
  }
}
