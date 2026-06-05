import ExpoModulesCore
import UIKit

/**
 * iOS can't run an indefinite background HTTP server — once the app is
 * suspended its listening sockets are closed. The best we can legitimately do is
 * request a `UIApplication` background task, which buys a short grace window
 * (typically tens of seconds) after the screen locks before the OS suspends us.
 * Combined with keep-awake (which prevents the idle auto-lock), this covers the
 * common cases; a manual lock will still end the cast once the window expires.
 *
 * There's no app-controllable media notification on iOS without an active audio
 * session (`MPRemoteCommandCenter` needs the `audio` background mode + real audio
 * playback, which this app doesn't do), so `present` just manages the background
 * task and the `onTransportCommand` event is declared but never emitted here.
 * The rich playback notification with controls is Android-only.
 */
public class CastKeepAliveModule: Module {
  private var bgTaskId: UIBackgroundTaskIdentifier = .invalid

  public func definition() -> ModuleDefinition {
    Name("CastKeepAlive")

    Events("onTransportCommand")

    // present(title, state, position, duration, controls) — params ignored on iOS.
    Function("present") { (_: String, _: String, _: Double, _: Double, _: Bool) in
      DispatchQueue.main.async {
        self.beginBackgroundTask()
      }
    }

    Function("stop") {
      DispatchQueue.main.async {
        self.endBackgroundTask()
      }
    }

    OnDestroy {
      DispatchQueue.main.async {
        self.endBackgroundTask()
      }
    }
  }

  private func beginBackgroundTask() {
    endBackgroundTask()
    bgTaskId = UIApplication.shared.beginBackgroundTask(withName: "CastAnythingServer") { [weak self] in
      // Called by the OS when our time is about to expire — clean up.
      self?.endBackgroundTask()
    }
  }

  private func endBackgroundTask() {
    if bgTaskId != .invalid {
      UIApplication.shared.endBackgroundTask(bgTaskId)
      bgTaskId = .invalid
    }
  }
}
