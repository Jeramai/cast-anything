package expo.modules.castkeepalive

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat

/**
 * Foreground service that keeps the process + radios awake while casting AND
 * shows a media-style **playback notification** with transport controls (play /
 * pause / ±15s / stop) plus a lock-screen seek bar backed by a [MediaSessionCompat].
 *
 * Control taps are forwarded to JS via [CastKeepAliveModule.dispatch], which
 * drives the actual DLNA / signage commands; JS pushes playback state back here
 * (title / playing-paused / position / duration) by re-invoking `present`.
 */
class CastKeepAliveService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null
  private var wifiLock: WifiManager.WifiLock? = null
  private var session: MediaSessionCompat? = null

  // Latest playback info, so a bare command intent (no extras) can rebuild the
  // notification without losing the title/duration/etc.
  private var lastTitle = "Cast Anything"
  private var lastState = STATE_PLAYING
  private var lastPosition = 0.0
  private var lastDuration = 0.0
  private var lastControls = true
  private var lastArtPath = ""
  private var lastArt: Bitmap? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // A control button was tapped: tell JS, and optimistically reflect it.
    when (intent?.action) {
      ACTION_PLAY -> { CastKeepAliveModule.dispatch("play", null); lastState = STATE_PLAYING }
      ACTION_PAUSE -> { CastKeepAliveModule.dispatch("pause", null); lastState = STATE_PAUSED }
      ACTION_STOP_PLAYBACK -> CastKeepAliveModule.dispatch("stop", null)
      ACTION_REWIND -> CastKeepAliveModule.dispatch("seekBy", -SKIP_SECONDS)
      ACTION_FORWARD -> CastKeepAliveModule.dispatch("seekBy", SKIP_SECONDS)
      else -> {
        // present/update — carries the latest playback info as extras.
        if (intent != null && intent.hasExtra(EXTRA_TITLE)) {
          lastTitle = intent.getStringExtra(EXTRA_TITLE) ?: lastTitle
          lastState = intent.getStringExtra(EXTRA_STATE) ?: lastState
          lastPosition = intent.getDoubleExtra(EXTRA_POSITION, lastPosition)
          lastDuration = intent.getDoubleExtra(EXTRA_DURATION, lastDuration)
          lastControls = intent.getBooleanExtra(EXTRA_CONTROLS, lastControls)
          loadArtwork(intent.getStringExtra(EXTRA_ARTWORK) ?: "")
        }
      }
    }

    ensureSession()
    updateSession()
    val notification = buildNotification()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }

    acquireLocks()
    // If Android kills us under pressure, try to come back (the cast is ongoing).
    return START_STICKY
  }

  private fun acquireLocks() {
    val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
    if (wakeLock == null) {
      wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "CastAnything::ServerWakeLock")
      wakeLock?.setReferenceCounted(false)
    }
    if (wakeLock?.isHeld != true) wakeLock?.acquire()

    val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    if (wifiLock == null) {
      val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        WifiManager.WIFI_MODE_FULL_LOW_LATENCY
      } else {
        @Suppress("DEPRECATION")
        WifiManager.WIFI_MODE_FULL_HIGH_PERF
      }
      wifiLock = wm.createWifiLock(mode, "CastAnything::ServerWifiLock")
      wifiLock?.setReferenceCounted(false)
    }
    if (wifiLock?.isHeld != true) wifiLock?.acquire()
  }

  private fun releaseLocks() {
    if (wakeLock?.isHeld == true) wakeLock?.release()
    if (wifiLock?.isHeld == true) wifiLock?.release()
  }

  override fun onDestroy() {
    releaseLocks()
    session?.release()
    session = null
    super.onDestroy()
  }

  // ---- MediaSession (lock-screen / Bluetooth controls + the seek bar) ----

  private fun ensureSession() {
    if (session != null) return
    session = MediaSessionCompat(this, "CastAnything").apply {
      setCallback(object : MediaSessionCompat.Callback() {
        override fun onPlay() = CastKeepAliveModule.dispatch("play", null)
        override fun onPause() = CastKeepAliveModule.dispatch("pause", null)
        override fun onStop() = CastKeepAliveModule.dispatch("stop", null)
        override fun onFastForward() = CastKeepAliveModule.dispatch("seekBy", SKIP_SECONDS)
        override fun onRewind() = CastKeepAliveModule.dispatch("seekBy", -SKIP_SECONDS)
        override fun onSeekTo(pos: Long) = CastKeepAliveModule.dispatch("seekTo", pos / 1000.0)
      })
      isActive = true
    }
  }

  private fun updateSession() {
    val s = session ?: return
    val canSeek = lastControls && lastDuration > 0
    val durationMs = if (lastDuration > 0) (lastDuration * 1000).toLong() else -1L

    s.setMetadata(
      MediaMetadataCompat.Builder()
        .putString(MediaMetadataCompat.METADATA_KEY_TITLE, lastTitle)
        .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_TITLE, lastTitle)
        .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_SUBTITLE, "Cast Anything")
        .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, durationMs)
        .putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, lastArt)
        .putBitmap(MediaMetadataCompat.METADATA_KEY_ART, lastArt)
        .build(),
    )

    var actions = PlaybackStateCompat.ACTION_PLAY or
      PlaybackStateCompat.ACTION_PAUSE or
      PlaybackStateCompat.ACTION_PLAY_PAUSE or
      PlaybackStateCompat.ACTION_STOP
    if (canSeek) {
      actions = actions or PlaybackStateCompat.ACTION_SEEK_TO or
        PlaybackStateCompat.ACTION_FAST_FORWARD or
        PlaybackStateCompat.ACTION_REWIND
    }
    val pbState = when (lastState) {
      STATE_PLAYING -> PlaybackStateCompat.STATE_PLAYING
      STATE_PAUSED -> PlaybackStateCompat.STATE_PAUSED
      else -> PlaybackStateCompat.STATE_STOPPED
    }
    val speed = if (lastState == STATE_PLAYING) 1f else 0f
    s.setPlaybackState(
      PlaybackStateCompat.Builder()
        .setActions(actions)
        .setState(pbState, (lastPosition * 1000).toLong(), speed, SystemClock.elapsedRealtime())
        .build(),
    )
  }

  // Decode the artwork JPEG (downsampled to ~512px to keep memory sane). Cached by
  // path so re-presenting on every poll tick doesn't re-decode the same frame.
  private fun loadArtwork(path: String) {
    if (path == lastArtPath) return
    lastArtPath = path
    lastArt = null
    if (path.isEmpty()) return
    try {
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeFile(path, bounds)
      var sample = 1
      while (bounds.outWidth / sample > 512 || bounds.outHeight / sample > 512) sample *= 2
      lastArt = BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = sample })
    } catch (e: Exception) {
      lastArt = null
    }
  }

  // ---- Notification ----

  private fun buildNotification(): Notification {
    createChannel()

    val statIcon = resources.getIdentifier("ic_stat_cast", "drawable", packageName)
    val builder = NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle(lastTitle)
      .setContentText(if (lastControls) "Casting to your device" else "Showing on your device")
      .setSmallIcon(if (statIcon != 0) statIcon else applicationInfo.icon)
      .setLargeIcon(lastArt) // video frame → MediaStyle artwork / colorized background
      .setColorized(true)
      .setContentIntent(launchPendingIntent())
      .setOngoing(true)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setOnlyAlertOnce(true)

    if (lastControls) {
      val playing = lastState == STATE_PLAYING
      builder
        .addAction(action(android.R.drawable.ic_media_rew, "Rewind 15s", ACTION_REWIND, 1))
        .addAction(
          if (playing) {
            action(android.R.drawable.ic_media_pause, "Pause", ACTION_PAUSE, 2)
          } else {
            action(android.R.drawable.ic_media_play, "Play", ACTION_PLAY, 3)
          },
        )
        .addAction(action(android.R.drawable.ic_media_ff, "Forward 15s", ACTION_FORWARD, 4))
        .addAction(action(android.R.drawable.ic_menu_close_clear_cancel, "Stop", ACTION_STOP_PLAYBACK, 5))
        .setStyle(
          androidx.media.app.NotificationCompat.MediaStyle()
            .setMediaSession(session?.sessionToken)
            // Show rewind / play-pause / forward in the collapsed view.
            .setShowActionsInCompactView(0, 1, 2),
        )
    } else {
      // A photo has no timeline — just offer to take it off the screen.
      builder.addAction(
        action(android.R.drawable.ic_menu_close_clear_cancel, "Remove", ACTION_STOP_PLAYBACK, 5),
      )
    }
    return builder.build()
  }

  private fun action(icon: Int, title: String, intentAction: String, requestCode: Int): NotificationCompat.Action {
    val intent = Intent(this, CastKeepAliveService::class.java).setAction(intentAction)
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or
      (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
    val pi = PendingIntent.getService(this, requestCode, intent, flags)
    return NotificationCompat.Action(icon, title, pi)
  }

  private fun launchPendingIntent(): PendingIntent? {
    val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return null
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or
      (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
    return PendingIntent.getActivity(this, 0, launch, flags)
  }

  private fun createChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val channel = NotificationChannel(
      CHANNEL_ID,
      "Playback",
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      setShowBadge(false)
      setSound(null, null)
    }
    nm.createNotificationChannel(channel)
  }

  companion object {
    const val EXTRA_TITLE = "title"
    const val EXTRA_STATE = "state"
    const val EXTRA_POSITION = "position"
    const val EXTRA_DURATION = "duration"
    const val EXTRA_CONTROLS = "controls"
    const val EXTRA_ARTWORK = "artwork"

    const val STATE_PLAYING = "playing"
    const val STATE_PAUSED = "paused"
    const val STATE_STOPPED = "stopped"

    const val ACTION_PRESENT = "expo.modules.castkeepalive.PRESENT"
    const val ACTION_PLAY = "expo.modules.castkeepalive.PLAY"
    const val ACTION_PAUSE = "expo.modules.castkeepalive.PAUSE"
    const val ACTION_STOP_PLAYBACK = "expo.modules.castkeepalive.STOP"
    const val ACTION_REWIND = "expo.modules.castkeepalive.REWIND"
    const val ACTION_FORWARD = "expo.modules.castkeepalive.FORWARD"

    private const val SKIP_SECONDS = 15.0
    private const val CHANNEL_ID = "cast_anything_playback"
    private const val NOTIFICATION_ID = 7311
  }
}
