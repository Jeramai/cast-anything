package expo.modules.castkeepalive

import android.content.Intent
import android.os.Build
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

  override fun definition() = ModuleDefinition {
    Name("CastKeepAlive")

    Events("onTransportCommand")

    OnCreate { instance = this@CastKeepAliveModule }
    OnDestroy { if (instance === this@CastKeepAliveModule) instance = null }

    Function("present") { title: String, state: String, position: Double, duration: Double, controls: Boolean ->
      val context = appContext.reactContext
      if (context != null) {
        val intent = Intent(context, CastKeepAliveService::class.java).apply {
          action = CastKeepAliveService.ACTION_PRESENT
          putExtra(CastKeepAliveService.EXTRA_TITLE, title)
          putExtra(CastKeepAliveService.EXTRA_STATE, state)
          putExtra(CastKeepAliveService.EXTRA_POSITION, position)
          putExtra(CastKeepAliveService.EXTRA_DURATION, duration)
          putExtra(CastKeepAliveService.EXTRA_CONTROLS, controls)
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
