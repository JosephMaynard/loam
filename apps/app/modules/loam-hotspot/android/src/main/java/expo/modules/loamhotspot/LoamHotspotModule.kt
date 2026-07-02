package expo.modules.loamhotspot

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.atomic.AtomicBoolean

/** Coded exception surfaced to JS as `ERR_HOTSPOT` (inferred from the class name). */
private class HotspotException(message: String, cause: Throwable? = null) :
  CodedException(message, cause)

/**
 * Drives Android's `WifiManager.LocalOnlyHotspot` for the LOAM host (docs/04): starts a local-only
 * (no-internet) hotspot and reports back the system-generated SSID + passphrase, which the JS side
 * renders as the "Step 1" WiFi-join QR. Exactly one local-only hotspot may exist per device, so the
 * active reservation is held here and reused across `startHotspot` calls.
 *
 * Requires `ACCESS_FINE_LOCATION` (LocalOnlyHotspot is location-gated) plus `CHANGE_WIFI_STATE` /
 * `ACCESS_WIFI_STATE` (and `NEARBY_WIFI_DEVICES` on API 33+). Runtime permission is requested from
 * JS before `startHotspot`; a missing grant surfaces here as a `SecurityException`.
 */
class LoamHotspotModule : Module() {
  // Touched from both the JS/module thread (start/stopHotspot) and the main-thread hotspot callback;
  // @Volatile gives the cross-thread visibility those reads/writes need.
  @Volatile
  private var reservation: WifiManager.LocalOnlyHotspotReservation? = null

  // Set while a start is in progress so two overlapping startHotspot calls can't both reach
  // startLocalOnlyHotspot (the reservation @Volatile read alone gives visibility, not atomicity).
  private val starting = AtomicBoolean(false)

  override fun definition() = ModuleDefinition {
    Name("LoamHotspot")

    AsyncFunction("startHotspot") { promise: Promise ->
      startHotspot(promise)
    }

    Function("stopHotspot") {
      releaseReservation()
    }

    // The runtime is one hotspot per process; make sure we don't leak the reservation when the
    // module is torn down (app backgrounded/reloaded).
    OnDestroy {
      releaseReservation()
    }
  }

  private fun startHotspot(promise: Promise) {
    // Already running: return the current credentials rather than starting a second hotspot.
    reservation?.let { existing ->
      val creds = readCredentials(existing)
      if (creds != null) {
        promise.resolve(creds)
      } else {
        promise.reject(HotspotException("The hotspot is running but its credentials are unavailable."))
      }
      return
    }

    // Serialize concurrent starts: only the caller that flips this from false→true proceeds; a
    // second overlapping call is rejected instead of also invoking startLocalOnlyHotspot.
    if (!starting.compareAndSet(false, true)) {
      return promise.reject(HotspotException("A hotspot start is already in progress."))
    }

    val context: Context = appContext.reactContext ?: run {
      starting.set(false)
      return promise.reject(HotspotException("The Android context is unavailable."))
    }

    val wifiManager =
      context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager ?: run {
        starting.set(false)
        return promise.reject(HotspotException("WifiManager is unavailable on this device."))
      }

    // The callback fires asynchronously on the main thread after this method returns; guard so the
    // promise settles exactly once even if start throws and a late callback also arrives.
    val settled = AtomicBoolean(false)

    val callback = object : WifiManager.LocalOnlyHotspotCallback() {
      override fun onStarted(res: WifiManager.LocalOnlyHotspotReservation) {
        reservation = res
        starting.set(false)
        if (!settled.compareAndSet(false, true)) {
          return
        }
        val creds = readCredentials(res)
        if (creds != null) {
          promise.resolve(creds)
        } else {
          promise.reject(HotspotException("The hotspot started but reported no SSID/password."))
        }
      }

      override fun onFailed(reason: Int) {
        starting.set(false)
        if (!settled.compareAndSet(false, true)) {
          return
        }
        promise.reject(HotspotException("Couldn't start the hotspot on this device (${reasonToMessage(reason)})."))
      }

      override fun onStopped() {
        reservation = null
      }
    }

    try {
      wifiManager.startLocalOnlyHotspot(callback, Handler(Looper.getMainLooper()))
    } catch (e: SecurityException) {
      starting.set(false)
      if (settled.compareAndSet(false, true)) {
        promise.reject(HotspotException("Location permission is required to start the hotspot.", e))
      }
    } catch (e: Throwable) {
      starting.set(false)
      if (settled.compareAndSet(false, true)) {
        promise.reject(HotspotException("Couldn't start the hotspot: ${e.message ?: e.javaClass.simpleName}", e))
      }
    }
  }

  /**
   * Reads the generated SSID + passphrase from a reservation. Uses `SoftApConfiguration` on API 30+
   * (`getSsid()`/`getPassphrase()`) and falls back to the deprecated `WifiConfiguration` on older
   * devices. Returns null if either value is missing.
   */
  private fun readCredentials(res: WifiManager.LocalOnlyHotspotReservation): Map<String, Any?>? {
    val ssid: String?
    val password: String?
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      val config = res.softApConfiguration
      @Suppress("DEPRECATION") // getSsid() is deprecated on API 33+ but still returns the SSID
      val name = config.ssid
      ssid = name
      password = config.passphrase
    } else {
      // Pre-30 WifiConfiguration returns the SSID/key wrapped in double quotes for ASCII values, so
      // strip them — an un-stripped value would put literal quotes into the WiFi-join QR.
      @Suppress("DEPRECATION")
      val config = res.wifiConfiguration
      @Suppress("DEPRECATION")
      ssid = unquote(config?.SSID)
      @Suppress("DEPRECATION")
      password = unquote(config?.preSharedKey)
    }
    if (ssid.isNullOrEmpty() || password.isNullOrEmpty()) {
      return null
    }
    return mapOf("ssid" to ssid, "password" to password)
  }

  /** Strip a single pair of surrounding double quotes, as pre-30 `WifiConfiguration` adds. */
  private fun unquote(value: String?): String? =
    if (value != null && value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
      value.substring(1, value.length - 1)
    } else {
      value
    }

  private fun releaseReservation() {
    reservation?.close()
    reservation = null
  }

  private fun reasonToMessage(reason: Int): String = when (reason) {
    WifiManager.LocalOnlyHotspotCallback.ERROR_NO_CHANNEL -> "no available channel"
    WifiManager.LocalOnlyHotspotCallback.ERROR_GENERIC -> "generic error"
    WifiManager.LocalOnlyHotspotCallback.ERROR_INCOMPATIBLE_MODE -> "incompatible Wi-Fi mode"
    WifiManager.LocalOnlyHotspotCallback.ERROR_TETHERING_DISALLOWED -> "tethering disallowed"
    else -> "reason code $reason"
  }
}
