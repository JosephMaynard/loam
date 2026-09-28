package expo.modules.loamhotspot

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.Inet4Address
import java.net.NetworkInterface
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

  // Every IPv4 address this device had just before the most recent startLocalOnlyHotspot call, or null
  // when no start has been attempted in this process. The hotspot's own address is whatever appears
  // AFTER the start, so `hotspotAddressCandidates` reports each address as pre-existing or new against
  // this snapshot (see that function). Android assigns the local-only hotspot a RANDOM address per start
  // (192.168/16, 172.16/12 or 10/8, never ending in .0/.1/.255 — packages/modules/Connectivity's
  // PrivateAddressCoordinator); 192.168.49.1 is reserved for Wi-Fi Direct group owners, so it must never
  // be assumed for the hotspot.
  @Volatile
  private var addressesBeforeStart: Set<String>? = null

  override fun definition() = ModuleDefinition {
    Name("LoamHotspot")

    // Fired when the SYSTEM tears the local-only hotspot down (the user enabled tethering — Android allows
    // one or the other — Wi-Fi was toggled, an OEM power policy). Without it JS kept reporting "running"
    // and showing a dead SSID/QR until the app was killed (review 2026-09-04).
    Events("onHotspotStopped")

    AsyncFunction("startHotspot") { promise: Promise ->
      startHotspot(promise)
    }

    Function("stopHotspot") {
      releaseReservation()
    }

    // Every IPv4 address the device currently holds, annotated so JS (`src/lib/hotspot-address.ts`) can
    // tell the hotspot's own interface from the phone's other networks. Never rejects: an enumeration
    // failure resolves with an empty list, which JS shows as "couldn't detect the address".
    AsyncFunction("hotspotAddressCandidates") { promise: Promise ->
      promise.resolve(hotspotAddressCandidates())
    }

    // Start/stop the foreground service that keeps the host alive while the screen is off (docs/04).
    // Best-effort: a failure is logged and leaves the app in its normal foreground-only state. Returns
    // whether the start call went through — API 31+ throws ForegroundServiceStartNotAllowedException when
    // the app is in the background, so JS re-calls this whenever the app is foregrounded (idempotent: a
    // repeat start re-posts the same notification and the wake lock is guarded).
    Function("startHostService") {
      val context = appContext.reactContext?.applicationContext
      if (context == null) {
        android.util.Log.w("LoamHotspot", "startHostService failed: no application context")
        false
      } else {
        try {
          LoamHostService.start(context)
          true
        } catch (error: Throwable) {
          android.util.Log.w("LoamHotspot", "startHostService failed", error)
          false
        }
      }
    }

    Function("stopHostService") {
      val context = appContext.reactContext?.applicationContext
      if (context == null) {
        android.util.Log.w("LoamHotspot", "stopHostService failed: no application context")
      } else {
        try {
          LoamHostService.stop(context)
        } catch (error: Throwable) {
          android.util.Log.w("LoamHotspot", "stopHostService failed", error)
        }
      }
    }

    // Kiosk mode = Android screen pinning (lock-task). Pins the app so a passer-by can't wander off
    // into other apps; without device-owner provisioning, leaving requires the system Back+Recents
    // gesture, which prompts for the device's own screen-lock PIN when one is set. Best-effort and
    // main-thread (startLockTask must run on the UI thread); a failure is logged, never thrown.
    Function("startKiosk") {
      val activity = appContext.currentActivity
      if (activity == null) {
        android.util.Log.w("LoamHotspot", "startKiosk failed: no current activity")
      } else {
        activity.runOnUiThread {
          try {
            activity.startLockTask()
          } catch (error: Throwable) {
            android.util.Log.w("LoamHotspot", "startLockTask failed", error)
          }
        }
      }
    }

    Function("stopKiosk") {
      val activity = appContext.currentActivity
      if (activity != null) {
        activity.runOnUiThread {
          try {
            activity.stopLockTask()
          } catch (error: Throwable) {
            android.util.Log.w("LoamHotspot", "stopLockTask failed", error)
          }
        }
      }
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
      // The reservation THIS callback instance started. Every startHotspot registers a fresh callback and
      // Android keeps the old ones alive until their reservation closes, so a stale callback's onStopped
      // must only ever act on its own (already-replaced) reservation — never clobber a newer start's state.
      @Volatile
      private var mine: WifiManager.LocalOnlyHotspotReservation? = null

      override fun onStarted(res: WifiManager.LocalOnlyHotspotReservation) {
        mine = res
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
        // Only the callback that owns the LIVE reservation reports a stop; a stale one (its reservation was
        // replaced by a newer start, or released by stopHotspot) is ignored. `starting` is deliberately not
        // touched here — it belongs to an in-flight start, which a stop of an OLD reservation says nothing about.
        val owned = mine ?: return
        if (reservation !== owned) {
          return
        }
        reservation = null
        try {
          sendEvent("onHotspotStopped")
        } catch (error: Throwable) {
          android.util.Log.w("LoamHotspot", "onHotspotStopped event failed", error)
        }
      }
    }

    // Snapshot the addresses that exist BEFORE the hotspot comes up: the hotspot's own address is the one
    // that is new afterwards (a phone on home Wi-Fi under STA+AP concurrency keeps its home address too).
    addressesBeforeStart = currentIpv4Addresses()

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

  /**
   * One entry per (interface, IPv4 address) the device holds right now, excluding loopback and link-local
   * (169.254/16). Each carries:
   *  - `name`         the OS interface name (`wlan0`, `swlan0`, `ap0`, `wlan1`, `rmnet_data0`…);
   *  - `address`      the dotted IPv4 address;
   *  - `prefixLength` the interface's IPv4 prefix length;
   *  - `upstream`     true when the interface is one of the phone's own networks with internet capability
   *                   (the home Wi-Fi it is a client of, mobile data, a VPN) — never a hotspot the phone
   *                   serves, which the framework registers as a local-only network at most — or when the
   *                   address is the Wi-Fi CLIENT's own (WifiManager's DHCP/connection info, an independent
   *                   second check); false when the network check ran and cleared it; null when the check
   *                   itself failed, so JS never mistakes "couldn't tell" for "cleared";
   *  - `preexisting`  whether the address already existed before the last hotspot start (null when no
   *                   start was attempted in this process).
   * JS scores these (`pickHotspotAddress`); an address that appeared with the hotspot and is not an
   * upstream network is the hotspot's. The AP interface IS visible to app-level enumeration (this and the
   * embedded Node's `os.networkInterfaces()` both go through `getifaddrs`), contrary to an older note.
   */
  private fun hotspotAddressCandidates(): List<Map<String, Any?>> {
    val upstream = upstreamInterfaceNames()
    val station = stationAddresses()
    val before = addressesBeforeStart
    val out = ArrayList<Map<String, Any?>>()
    val interfaces =
      try {
        NetworkInterface.getNetworkInterfaces()
      } catch (error: Throwable) {
        Log.w("LoamHotspot", "NetworkInterface enumeration failed", error)
        null
      } ?: return out
    for (iface in interfaces) {
      val name = iface.name ?: continue
      // `interfaceAddresses` (not `inetAddresses`) so the prefix length comes along. Some OEM kernels
      // reject the flags ioctl for certain interfaces, so no `isUp` gate — an address is a strong enough
      // sign of a live interface, and JS filters on the name.
      val addresses =
        try {
          iface.interfaceAddresses
        } catch (error: Throwable) {
          continue
        }
      for (ifAddress in addresses) {
        val inet = ifAddress.address as? Inet4Address ?: continue
        if (inet.isLoopbackAddress || inet.isLinkLocalAddress || inet.isAnyLocalAddress) continue
        val address = inet.hostAddress ?: continue
        val isUpstream: Boolean? =
          if (station.contains(address)) true else upstream?.contains(name)
        out.add(
          mapOf(
            "name" to name,
            "address" to address,
            "prefixLength" to ifAddress.networkPrefixLength.toInt(),
            "upstream" to isUpstream,
            "preexisting" to before?.contains(address),
          ),
        )
      }
    }
    return out
  }

  /** The dotted IPv4 addresses the device holds right now (same filter as `hotspotAddressCandidates`). */
  private fun currentIpv4Addresses(): Set<String> {
    val out = HashSet<String>()
    val interfaces =
      try {
        NetworkInterface.getNetworkInterfaces()
      } catch (error: Throwable) {
        return out
      } ?: return out
    for (iface in interfaces) {
      val addresses =
        try {
          iface.inetAddresses
        } catch (error: Throwable) {
          continue
        }
      for (inet in addresses) {
        if (inet !is Inet4Address || inet.isLoopbackAddress || inet.isLinkLocalAddress || inet.isAnyLocalAddress) {
          continue
        }
        inet.hostAddress?.let { out.add(it) }
      }
    }
    return out
  }

  /**
   * Interface names of the networks the phone is a CLIENT of — those ConnectivityManager reports with
   * internet capability (Wi-Fi station, cellular, VPN; capability, not validation, so a home Wi-Fi with no
   * uplink still counts). A hotspot the phone serves is never among them: local-only hotspots register no
   * network for apps, and a tethering downstream that does is a local network without the capability.
   * Needs ACCESS_NETWORK_STATE (a normal, install-time permission). Returns null when the check itself
   * failed (no context, no service, an exception), so JS can tell "cleared" from "couldn't tell"; an
   * empty set is a genuine answer (the phone is on no network at all).
   */
  private fun upstreamInterfaceNames(): Set<String>? {
    val names = HashSet<String>()
    val context = appContext.reactContext?.applicationContext ?: return null
    val connectivity =
      context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return null
    try {
      // Deprecated on API 31+ in favour of callbacks, but still the one-shot enumeration this needs.
      @Suppress("DEPRECATION")
      val networks = connectivity.allNetworks
      for (network in networks) {
        val caps = connectivity.getNetworkCapabilities(network) ?: continue
        if (!caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) continue
        val props = connectivity.getLinkProperties(network) ?: continue
        props.interfaceName?.let { names.add(it) }
      }
    } catch (error: Throwable) {
      Log.w("LoamHotspot", "Upstream network enumeration failed", error)
      return null
    }
    return names
  }

  /**
   * The Wi-Fi CLIENT's own IPv4 address(es) per WifiManager — the address the phone got from the network it
   * JOINED (home Wi-Fi), never the hotspot it serves. An independent second way to rule the station
   * interface out, for the ROMs where ConnectivityManager misreports it; both APIs are deprecated on 31+ but
   * still answer, and ACCESS_WIFI_STATE (already held for the hotspot) is all they need. Best-effort: empty
   * on any failure.
   */
  private fun stationAddresses(): Set<String> {
    val out = HashSet<String>()
    val context = appContext.reactContext?.applicationContext ?: return out
    val wifi = context.getSystemService(Context.WIFI_SERVICE) as? WifiManager ?: return out
    try {
      @Suppress("DEPRECATION")
      val fromDhcp = wifi.dhcpInfo?.ipAddress ?: 0
      @Suppress("DEPRECATION")
      val fromConnection = wifi.connectionInfo?.ipAddress ?: 0
      for (raw in intArrayOf(fromDhcp, fromConnection)) {
        if (raw != 0) out.add(littleEndianIpv4(raw))
      }
    } catch (error: Throwable) {
      Log.w("LoamHotspot", "Station address lookup failed", error)
    }
    return out
  }

  /** WifiManager hands IPv4 addresses as little-endian ints (first octet in the low byte). */
  private fun littleEndianIpv4(raw: Int): String =
    "${raw and 0xff}.${(raw shr 8) and 0xff}.${(raw shr 16) and 0xff}.${(raw ushr 24) and 0xff}"

  private fun reasonToMessage(reason: Int): String = when (reason) {
    WifiManager.LocalOnlyHotspotCallback.ERROR_NO_CHANNEL -> "no available channel"
    WifiManager.LocalOnlyHotspotCallback.ERROR_GENERIC -> "generic error"
    WifiManager.LocalOnlyHotspotCallback.ERROR_INCOMPATIBLE_MODE -> "incompatible Wi-Fi mode"
    WifiManager.LocalOnlyHotspotCallback.ERROR_TETHERING_DISALLOWED -> "tethering disallowed"
    else -> "reason code $reason"
  }
}
