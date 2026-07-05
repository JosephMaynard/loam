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
import android.os.IBinder
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

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    try {
      startForegroundNotification()
      acquireWakeLock()
    } catch (error: Throwable) {
      Log.w(TAG, "Failed to enter the foreground host state", error)
      stopSelf()
    }
    // START_STICKY: if Android kills us under memory pressure, restart the service when it can.
    return START_STICKY
  }

  override fun onDestroy() {
    releaseWakeLock()
    super.onDestroy()
  }

  private fun startForegroundNotification() {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel =
        NotificationChannel(CHANNEL_ID, "LOAM host", NotificationManager.IMPORTANCE_LOW).apply {
          description = "Keeps LOAM reachable while the screen is off."
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
      .setContentTitle("LOAM is hosting")
      .setContentText("Others can join while this stays on. Tap to open.")
      .setSmallIcon(applicationInfo.icon)
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
    if (wakeLock != null) {
      return
    }
    val power = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock =
      power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "loam:host").apply {
        setReferenceCounted(false)
        acquire()
      }
  }

  private fun releaseWakeLock() {
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

    /** Start the foreground host service (best-effort; safe to call repeatedly). */
    fun start(context: Context) {
      val intent = Intent(context, LoamHostService::class.java)
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
