package expo.modules.loammeshtransport

import android.Manifest
import android.bluetooth.BluetoothManager
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.SystemClock
import android.util.Log
import java.util.concurrent.ConcurrentHashMap

/**
 * BLE discovery + wake layer for the LOAM mesh (docs/16 §5, docs/17). Advertises a tiny presence beacon
 * ([MeshConstants.SERVICE_UUID] + service data from [MeshAdvertCodec]) and scans for the same, so two
 * nearby LOAM hosts on *different* networks still find each other cheaply. BLE is discovery only — the
 * sealed blobs move over Wi-Fi Aware ([MeshWifiAwareController]); a chunked-over-GATT fallback is
 * scaffolded here for devices with no Aware hardware (marked TODO — it is slow and unverified).
 *
 * Android 12+ (API 31) split the Bluetooth permissions into `BLUETOOTH_ADVERTISE` / `BLUETOOTH_SCAN` /
 * `BLUETOOTH_CONNECT`; the runtime grant is requested from JS before start (mirroring the hotspot
 * module). A call made without the grant surfaces as a caught `SecurityException` and an error event.
 *
 * ⚠️ NATIVE-UNVERIFIED: structurally standard BLE code, but not compiled/run in CI (no radios). The
 * advertise + scan paths follow the AOSP samples closely; the GATT-server control characteristic and
 * the chunked fallback are scaffolded and explicitly incomplete.
 */
internal class MeshBleController(
  private val context: Context,
  private val listener: Listener,
) {
  interface Listener {
    fun onPeerDiscovered(peerId: String, haveMail: Boolean, meshHint: String, rssi: Int)
    fun onError(message: String)
  }

  private val bluetoothManager: BluetoothManager? =
    context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
  private var advertiser: BluetoothLeAdvertiser? = null
  private var scanner: BluetoothLeScanner? = null
  private var advertiseCallback: AdvertiseCallback? = null
  private var scanCallback: ScanCallback? = null

  // BLE device address → last time we emitted it, so a chatty advertiser doesn't spam onPeerDiscovered.
  private val lastSeen = ConcurrentHashMap<String, Long>()

  // Opaque session-local token → BLE MAC address. The token is what crosses to JS / the Node launcher —
  // the MAC (privacy-sensitive, even though modern Android rotates it) never leaves this class (P1-3),
  // mirroring the Wi-Fi Aware PeerHandle mapping. Bounded LRU so rotating addresses can't grow it.
  private val blePeers = object : LinkedHashMap<String, String>(16, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>): Boolean =
      size > MeshConstants.MAX_TRACKED_PEERS
  }
  private val blePeersLock = Any()
  private var blePeerSeq = 0L

  /** Resolve (or mint) the opaque token for a device address; the token is the only handle JS ever sees. */
  private fun tokenForAddress(address: String): String = synchronized(blePeersLock) {
    for ((token, existing) in blePeers) {
      if (existing == address) return token
    }
    val token = "ble-${blePeerSeq++}"
    blePeers[token] = address
    token
  }

  /** True when this device has BLE AND the adapter can advertise (peripheral role) — required to be
   * discoverable. Some older/cheaper phones are central-only. */
  fun isSupported(): Boolean {
    if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) {
      return false
    }
    val adapter = bluetoothManager?.adapter ?: return false
    return adapter.isEnabled && adapter.isMultipleAdvertisementSupported
  }

  private fun hasPermission(permission: String): Boolean =
    context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

  /** Runtime permissions this controller needs on the running API level. */
  fun missingPermissions(): List<String> {
    val needed = mutableListOf<String>()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      if (!hasPermission(Manifest.permission.BLUETOOTH_ADVERTISE)) needed += Manifest.permission.BLUETOOTH_ADVERTISE
      if (!hasPermission(Manifest.permission.BLUETOOTH_SCAN)) needed += Manifest.permission.BLUETOOTH_SCAN
      if (!hasPermission(Manifest.permission.BLUETOOTH_CONNECT)) needed += Manifest.permission.BLUETOOTH_CONNECT
    } else {
      // Pre-12, BLE scanning is location-gated.
      if (!hasPermission(Manifest.permission.ACCESS_FINE_LOCATION)) needed += Manifest.permission.ACCESS_FINE_LOCATION
    }
    return needed
  }

  fun startAdvertising(advert: MeshAdvert) {
    val adapter = bluetoothManager?.adapter ?: return listener.onError("No Bluetooth adapter")
    val leAdvertiser = adapter.bluetoothLeAdvertiser
      ?: return listener.onError("This device can't BLE-advertise (central-only)")
    // Stop any advertisement already running (with its old callback) before starting a new one, so a
    // repeated start can't leave the previous advertiser live or orphan its callback.
    stopAdvertising()
    advertiser = leAdvertiser

    val settings = AdvertiseSettings.Builder()
      // Low-power, duty-cycled discovery — battery is a first-class concern (docs/16 §5).
      .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_POWER)
      .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_LOW)
      .setConnectable(true) // connectable so a peer can reach the GATT control service / fallback
      .build()

    val data = AdvertiseData.Builder()
      .addServiceUuid(MeshConstants.SERVICE_PARCEL_UUID)
      .addServiceData(MeshConstants.SERVICE_PARCEL_UUID, MeshAdvertCodec.encode(advert))
      .setIncludeDeviceName(false) // never leak the device name
      .build()

    val callback = object : AdvertiseCallback() {
      override fun onStartFailure(errorCode: Int) {
        listener.onError("BLE advertise failed (code $errorCode)")
      }
    }
    advertiseCallback = callback
    try {
      leAdvertiser.startAdvertising(settings, data, callback)
    } catch (error: SecurityException) {
      listener.onError("Missing BLUETOOTH_ADVERTISE permission")
    } catch (error: Throwable) {
      listener.onError("BLE advertise error: ${error.message}")
    }
  }

  fun stopAdvertising() {
    try {
      advertiseCallback?.let { advertiser?.stopAdvertising(it) }
    } catch (error: Throwable) {
      Log.w(TAG, "stopAdvertising failed", error)
    } finally {
      advertiseCallback = null
    }
  }

  fun startDiscovery() {
    val adapter = bluetoothManager?.adapter ?: return listener.onError("No Bluetooth adapter")
    val leScanner = adapter.bluetoothLeScanner ?: return listener.onError("No BLE scanner")
    scanner = leScanner

    val filter = ScanFilter.Builder()
      .setServiceUuid(MeshConstants.SERVICE_PARCEL_UUID)
      .build()
    val settings = ScanSettings.Builder()
      // Low-power scan; the courier bursts to a higher duty cycle only when it needs to move mail.
      .setScanMode(ScanSettings.SCAN_MODE_LOW_POWER)
      .build()

    val callback = object : ScanCallback() {
      override fun onScanResult(callbackType: Int, result: ScanResult) {
        handleScanResult(result)
      }

      override fun onBatchScanResults(results: MutableList<ScanResult>) {
        results.forEach { handleScanResult(it) }
      }

      override fun onScanFailed(errorCode: Int) {
        listener.onError("BLE scan failed (code $errorCode)")
      }
    }
    scanCallback = callback
    try {
      leScanner.startScan(listOf(filter), settings, callback)
    } catch (error: SecurityException) {
      listener.onError("Missing BLUETOOTH_SCAN permission")
    } catch (error: Throwable) {
      listener.onError("BLE scan error: ${error.message}")
    }
  }

  fun stopDiscovery() {
    try {
      scanCallback?.let { scanner?.stopScan(it) }
    } catch (error: Throwable) {
      Log.w(TAG, "stopDiscovery failed", error)
    } finally {
      scanCallback = null
    }
  }

  private fun handleScanResult(result: ScanResult) {
    val record = result.scanRecord ?: return
    val serviceData = record.getServiceData(MeshConstants.SERVICE_PARCEL_UUID)
    val advert = MeshAdvertCodec.decode(serviceData) ?: return
    if (advert.version != MeshConstants.PROTOCOL_VERSION) {
      return // a differently-versioned mesh — ignore rather than mis-parse
    }

    // Reading the device address can throw SecurityException if BLUETOOTH_CONNECT was revoked mid-scan;
    // bail out cleanly (before any debounce / peerId / listener callback) rather than crash the scan.
    val address = try {
      result.device?.address ?: return
    } catch (error: SecurityException) {
      return
    }
    val now = SystemClock.elapsedRealtime()
    val previous = lastSeen[address]
    if (previous != null && now - previous < MeshConstants.PEER_DEBOUNCE_MS) {
      return // debounce repeated sightings
    }
    lastSeen[address] = now

    // The JS peerId is an OPAQUE session-local token, never the MAC — the courier round-trips the token
    // back to `sendBlob`, and only this class maps it to the device address (P1-3).
    val peerId = tokenForAddress(address)
    listener.onPeerDiscovered(peerId, advert.haveMail, advert.meshHintHex(), result.rssi)
  }

  /**
   * BLE-ONLY fallback transfer (chunked GATT writes) for devices without Wi-Fi Aware.
   *
   * TODO (native, real-device work — docs/17): implement the actual transfer:
   *  1. `adapter.getRemoteDevice(address).connectGatt(...)` to the peer discovered above.
   *  2. Discover [MeshConstants.DATA_CHARACTERISTIC_UUID], negotiate the largest MTU (`requestMtu`).
   *  3. Write the framed blob ([MeshFraming]) in (MTU-3)-byte chunks with write-response, waiting for
   *     each `onCharacteristicWrite` before the next (BLE has no stream backpressure).
   *  4. On the responder, host a `BluetoothGattServer` with that characteristic and reassemble.
   * This is deliberately left unimplemented: it is slow (a ~90 KB blob is hundreds of round-trips),
   * only matters on Aware-less hardware, and can't be verified without two radios. Wi-Fi Aware is the
   * real path; this throws so the courier surfaces "no bulk transport" rather than silently dropping.
   */
  @Suppress("UNUSED_PARAMETER")
  fun sendBlobFallback(peerId: String, bytes: ByteArray) {
    throw UnsupportedOperationException(
      "BLE-only chunked transfer is not yet implemented; this device needs Wi-Fi Aware for mesh mail.",
    )
  }

  fun stop() {
    stopAdvertising()
    stopDiscovery()
    lastSeen.clear()
  }

  companion object {
    private const val TAG = "MeshBle"
  }
}
