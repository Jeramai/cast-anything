package expo.modules.casttranscoder

import android.net.Uri
import com.otaliastudios.transcoder.Transcoder
import com.otaliastudios.transcoder.TranscoderListener
import com.otaliastudios.transcoder.resize.AtMostResizer
import com.otaliastudios.transcoder.strategy.DefaultAudioStrategy
import com.otaliastudios.transcoder.strategy.DefaultVideoStrategy
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.Future

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
    // downscale-only). Resolves with outputPath; rejects on failure/cancel.
    AsyncFunction("transcode") { inputUri: String, outputPath: String, maxHeight: Int, maxWidth: Int, promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.reject("ERR_NO_CONTEXT", "No React context available", null)
        return@AsyncFunction
      }
      try {
        val video = DefaultVideoStrategy.Builder()
          .addResizer(AtMostResizer(maxHeight, maxWidth)) // minor, major — downscale-only
          .bitRate(8_000_000L)
          .build()
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
