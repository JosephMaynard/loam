package expo.modules.loamhotspot

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log

/**
 * A foreground service that keeps the LOAM host reachable while the screen is off or the app is
 * backgrounded (docs/04). Android suspends an ordinary app's process (and its embedded server +
 * hotspot) when the screen locks; a foreground service — with its required persistent notification —
 * plus a partial wake lock keeps the CPU and the process alive so joiners stay connected.
 *
 * Started/stopped from [LoamHotspotModule]. Everything here is best-effort: a failure is logged and
 * degrades to the app's normal foreground-only behaviour rather than crashing.
 */
class LoamHostService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null
  // Renews the bounded wake lock at roughly half its own timeout, for as long as this service is
  // alive — see `acquireWakeLock`/`scheduleWakeLockRenewal`. Cancelled in `releaseWakeLock` so it can
  // never outlive the service (or double up across restarts of the same instance).
  private val wakeLockHandler = Handler(Looper.getMainLooper())
  private val renewWakeLockRunnable = Runnable { renewWakeLock() }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent == null) {
      // A spurious/redelivered start with no real command (e.g. the system resurrecting the service
      // after the process was killed) — there's no RN/Node process behind it, so don't hold a
      // notification + wake lock for a server that isn't there.
      releaseWakeLock()
      stopSelf()
      return START_NOT_STICKY
    }
    try {
      startForegroundNotification(NotificationLabels.fromIntent(intent))
      acquireWakeLock()
    } catch (error: Throwable) {
      Log.w(TAG, "Failed to enter the foreground host state", error)
      stopSelf()
    }
    // START_NOT_STICKY: the embedded Node server lives in the RN process, not this service. If
    // Android kills the process under memory pressure, the service must not be independently
    // resurrected into a "hosting" state with no server behind it — the app restarts it (via
    // `start()`) once the process (and Node) is actually back up.
    return START_NOT_STICKY
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    // The user swiped the app away — stop hosting rather than keep the notification + wake lock
    // alive for a process that's going away.
    releaseWakeLock()
    stopSelf()
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    releaseWakeLock()
    super.onDestroy()
  }

  /**
   * The notification's text. JS passes it in the app's language on every start (`startHostService(labels)`,
   * read from the intent extras); a start without labels falls back to English. Blank values fall back too.
   */
  private data class NotificationLabels(
    val channelName: String,
    val channelDescription: String,
    val title: String,
    val text: String,
  ) {
    companion object {
      val DEFAULT =
        NotificationLabels(
          channelName = "LOAM host",
          channelDescription = "Keeps LOAM reachable while the screen is off.",
          title = "LOAM is hosting",
          text = "Others can join while this stays on. Tap to open.",
        )

      fun fromIntent(intent: Intent): NotificationLabels =
        NotificationLabels(
          channelName = intent.getStringExtra(EXTRA_CHANNEL_NAME)?.takeIf { it.isNotBlank() } ?: DEFAULT.channelName,
          channelDescription =
            intent.getStringExtra(EXTRA_CHANNEL_DESCRIPTION)?.takeIf { it.isNotBlank() } ?: DEFAULT.channelDescription,
          title = intent.getStringExtra(EXTRA_TITLE)?.takeIf { it.isNotBlank() } ?: DEFAULT.title,
          text = intent.getStringExtra(EXTRA_TEXT)?.takeIf { it.isNotBlank() } ?: DEFAULT.text,
        )
    }
  }

  private fun startForegroundNotification(labels: NotificationLabels) {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      // Re-creating an existing channel updates its name and description (Android keeps the user's own
      // importance/sound choices), so a language change reaches the system settings on the next start.
      val channel =
        NotificationChannel(CHANNEL_ID, labels.channelName, NotificationManager.IMPORTANCE_LOW).apply {
          description = labels.channelDescription
          setShowBadge(false)
        }
      manager.createNotificationChannel(channel)
    }

    val launch = packageManager.getLaunchIntentForPackage(packageName)
    val contentIntent =
      if (launch != null) {
        PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE)
      } else {
        null
      }

    val builder =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Notification.Builder(this, CHANNEL_ID)
      } else {
        @Suppress("DEPRECATION") Notification.Builder(this)
      }
    builder
      .setContentTitle(labels.title)
      .setContentText(labels.text)
      // A monochrome 24dp vector of this module's own (res/drawable). The launcher icon is a full-colour
      // adaptive icon, which the status bar would draw as an alpha blob; the app's generated
      // `ic_launcher_monochrome` lives in the app module, out of this library's R, and is laid out for the
      // adaptive-icon safe zone rather than a status-bar glyph.
      .setSmallIcon(R.drawable.loam_host_notification)
      .setOngoing(true)
    if (contentIntent != null) {
      builder.setContentIntent(contentIntent)
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(
        NOTIFICATION_ID,
        builder.build(),
        ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
      )
    } else {
      startForeground(NOTIFICATION_ID, builder.build())
    }
  }

  private fun acquireWakeLock() {
    // Only acquire when nothing is currently held — avoids stacking a duplicate acquisition on a
    // repeated `onStartCommand` (e.g. the system redelivering a start while already hosting). This is
    // NOT how the 12h window gets reset — see `renewWakeLock` below for that: routing the renewal through
    // this "guard on isHeld, else acquire" would make the periodic tick a no-op, since the lock is still
    // genuinely held at the halfway point (it hasn't expired yet).
    if (wakeLock?.isHeld == true) {
      return
    }
    val power = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock =
      power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "loam:host").apply {
        setReferenceCounted(false)
        // Bounded: a timeout backstop means a leaked lock can't drain the battery forever. Renewed
        // periodically below (at half the timeout) for as long as the service stays alive, so a
        // long-running kiosk/wall-mount host doesn't silently lose it at the 12h mark; this is a
        // ceiling per acquisition, not an expected session length.
        acquire(WAKE_LOCK_TIMEOUT_MS)
      }
    scheduleWakeLockRenewal()
  }

  /** The renewal tick (fires at half the wake lock's own timeout, for as long as the service stays
   * alive): explicitly RELEASE the current lock and ACQUIRE a fresh one, resetting the 12h window.
   * This is deliberately NOT just `acquireWakeLock()` — that guards on `isHeld` and no-ops when the lock
   * is still held, which it always IS at this halfway-point tick (it hasn't expired yet); every renewal
   * would be a no-op, and the original acquisition would run out at the full 12h mark with nothing
   * having replaced it. */
  private fun renewWakeLock() {
    wakeLock?.let { lock -> if (lock.isHeld) lock.release() }
    wakeLock = null
    acquireWakeLock()
  }

  /** (Re)schedule the next renewal at half the wake lock's own timeout, replacing any pending one so
   * repeated `acquireWakeLock()` calls (e.g. from `onStartCommand`) can never stack up duplicates. */
  private fun scheduleWakeLockRenewal() {
    wakeLockHandler.removeCallbacks(renewWakeLockRunnable)
    wakeLockHandler.postDelayed(renewWakeLockRunnable, WAKE_LOCK_TIMEOUT_MS / 2)
  }

  private fun releaseWakeLock() {
    wakeLockHandler.removeCallbacks(renewWakeLockRunnable)
    wakeLock?.let { lock ->
      if (lock.isHeld) {
        lock.release()
      }
    }
    wakeLock = null
  }

  companion object {
    private const val TAG = "LoamHostService"
    private const val CHANNEL_ID = "loam-host"
    private const val NOTIFICATION_ID = 4201
    // Backstop for the partial wake lock: bounds a leak to this long instead of forever. Active
    // hosting re-acquires it on the next start, so 12h comfortably outlasts any real gap between starts.
    private const val WAKE_LOCK_TIMEOUT_MS = 12 * 60 * 60 * 1000L
    // Intent extras carrying the notification text from JS (see `NotificationLabels`).
    private const val EXTRA_CHANNEL_NAME = "loam.channelName"
    private const val EXTRA_CHANNEL_DESCRIPTION = "loam.channelDescription"
    private const val EXTRA_TITLE = "loam.title"
    private const val EXTRA_TEXT = "loam.text"

    /**
     * Start the foreground host service (best-effort; safe to call repeatedly). `labels` is the
     * notification text in the app's language (`channelName`, `channelDescription`, `title`, `text`;
     * only string values are used); null or a missing entry means the English default.
     */
    fun start(context: Context, labels: Map<String, Any?>? = null) {
      val intent = Intent(context, LoamHostService::class.java)
      (labels?.get("channelName") as? String)?.let { intent.putExtra(EXTRA_CHANNEL_NAME, it) }
      (labels?.get("channelDescription") as? String)?.let { intent.putExtra(EXTRA_CHANNEL_DESCRIPTION, it) }
      (labels?.get("title") as? String)?.let { intent.putExtra(EXTRA_TITLE, it) }
      (labels?.get("text") as? String)?.let { intent.putExtra(EXTRA_TEXT, it) }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }

    /** Stop the foreground host service. */
    fun stop(context: Context) {
      context.stopService(Intent(context, LoamHostService::class.java))
    }
  }
}
