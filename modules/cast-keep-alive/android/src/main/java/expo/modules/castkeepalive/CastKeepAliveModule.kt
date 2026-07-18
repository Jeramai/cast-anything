package expo.modules.castkeepalive

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.PowerManager
import android.provider.Settings
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Bridges the JS playback state ↔ the [CastKeepAliveService] media notification.
 *
 *  - `present(...)` starts/updates the foreground service + playback notification.
 *  - `stop()` tears it down.
 *  - Control taps from the notification / lock screen are pushed to JS as
 *    `onTransportCommand` events; JS turns them into DLNA / signage commands.
 */
class CastKeepAliveModule : Module() {
  private var started = false
  // Background-safe timer thread. React Native's own JS timers (setTimeout /
  // setInterval) are driven by the UI Choreographer and PAUSE whenever the
  // activity pauses (screen off) — even with the service's partial wakelock held.
  // Promises resolved from native, however, keep dispatching to the JS thread,
  // so `sleep` gives JS a delay that keeps ticking with the screen off. A plain
  // HandlerThread is lifecycle-independent; the wakelock keeps its clock honest.
  private var timerHandler: Handler? = null

  private fun timers(): Handler {
    timerHandler?.let { return it }
    val thread = HandlerThread("CastKeepAliveTimers")
    thread.start()
    return Handler(thread.looper).also { timerHandler = it }
  }

  override fun definition() = ModuleDefinition {
    Name("CastKeepAlive")

    Events("onTransportCommand")

    OnCreate { instance = this@CastKeepAliveModule }
    OnDestroy {
      if (instance === this@CastKeepAliveModule) instance = null
      timerHandler?.looper?.quitSafely()
      timerHandler = null
    }

    // Resolve after `ms` — a setTimeout replacement that KEEPS RUNNING with the
    // screen off (see timerHandler above). Playback-critical waits (live-segment
    // polling, DLNA status polls) must use this instead of JS timers.
    AsyncFunction("sleep") { ms: Double, promise: Promise ->
      timers().postDelayed({ promise.resolve(null) }, ms.toLong().coerceAtLeast(0))
    }

    Function("present") { title: String, state: String, position: Double, duration: Double, controls: Boolean, artworkPath: String, volume: Double ->
      val context = appContext.reactContext
      if (context != null) {
        val intent = Intent(context, CastKeepAliveService::class.java).apply {
          action = CastKeepAliveService.ACTION_PRESENT
          putExtra(CastKeepAliveService.EXTRA_TITLE, title)
          putExtra(CastKeepAliveService.EXTRA_STATE, state)
          putExtra(CastKeepAliveService.EXTRA_POSITION, position)
          putExtra(CastKeepAliveService.EXTRA_DURATION, duration)
          putExtra(CastKeepAliveService.EXTRA_CONTROLS, controls)
          putExtra(CastKeepAliveService.EXTRA_ARTWORK, artworkPath)
          putExtra(CastKeepAliveService.EXTRA_VOLUME, volume.toInt())
        }
        // First call (while the app is foreground) promotes to a foreground
        // service; later updates just deliver onStartCommand to the running one.
        if (!started && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          context.startForegroundService(intent)
        } else {
          context.startService(intent)
        }
        started = true
      }
    }

    Function("stop") {
      val context = appContext.reactContext
      if (context != null) {
        context.stopService(Intent(context, CastKeepAliveService::class.java))
      }
      started = false
    }

    // Ask the OS to exempt us from battery optimization so the media server keeps
    // serving with the screen off. Without this, Doze defers our network after
    // ~30 min and the TV loses the stream. Returns true if already exempt (no
    // dialog shown); otherwise opens the system prompt and returns false.
    Function("requestIgnoreBatteryOptimizations") {
      val context = appContext.reactContext ?: return@Function false
      val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
      val already = pm.isIgnoringBatteryOptimizations(context.packageName)
      if (!already) {
        val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
          .setData(Uri.parse("package:${context.packageName}"))
        val activity = appContext.activityProvider?.currentActivity
        if (activity != null) {
          activity.startActivity(intent)
        } else {
          context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
      }
      already
    }
  }

  private fun emit(action: String, value: Double?) {
    sendEvent("onTransportCommand", mapOf("action" to action, "value" to value))
  }

  companion object {
    private var instance: CastKeepAliveModule? = null

    /** Called by the service when a control is used; forwarded to JS. */
    fun dispatch(action: String, value: Double?) {
      instance?.emit(action, value)
    }
  }
}
