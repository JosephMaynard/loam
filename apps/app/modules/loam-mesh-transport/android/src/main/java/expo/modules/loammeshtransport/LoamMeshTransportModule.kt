package expo.modules.loammeshtransport

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Base64
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.util.concurrent.Executors

/** Coded exception surfaced to JS as `ERR_MESH_TRANSPORT` (inferred from the class name). */
private class MeshTransportException(message: String, cause: Throwable? = null) :
  CodedException(message, cause)

/** The advert record marshalled from the JS `MeshAdvert`. */
internal class AdvertRecord : Record {
  @Field var version: Int = MeshConstants.PROTOCOL_VERSION
  @Field var haveMail: Boolean = false
  @Field var meshHint: String = ""

  fun toAdvert(): MeshAdvert =
    MeshAdvert(version, haveMail, MeshAdvertCodec.hintFromString(meshHint))
}

/**
 * Expo module bridging JS ↔ the LOAM opportunistic-mesh transport (Phase 3 — docs/16 §5, docs/17). It
 * owns a [MeshBleController] (low-power discovery/wake) and, when the hardware supports it, a
 * [MeshWifiAwareController] (bulk sealed-blob transfer), wiring their callbacks to JS events and
 * routing outbound `sendBlob` to the right radio.
 *
 * This layer carries OPAQUE BYTES only — it never opens/verifies a sealed blob. All crypto/relay rules
 * stay in the embedded Node server (the sealed relay, docs/16 §2-3); the courier that decides *what* to
 * push/pull lives in the launcher (nodejs-project-template/main.js) + the RN glue
 * (src/mesh/mesh-courier.ts). Mirrors the `loam-hotspot` module's structure + best-effort discipline.
 *
 * ⚠️ NATIVE-UNVERIFIED: compiled/run only on a real device (BLE + Wi-Fi Aware need radios CI lacks —
 * docs/17). The Expo definition + delegation are standard; the radio internals are the risk surface.
 */
class LoamMeshTransportModule : Module() {
  private val executor = Executors.newSingleThreadExecutor()

  @Volatile private var ble: MeshBleController? = null
  @Volatile private var aware: MeshWifiAwareController? = null

  override fun definition() = ModuleDefinition {
    Name("LoamMeshTransport")

    Events(
      "onPeerDiscovered",
      "onTransferReceived",
      "onTransferComplete",
      "onTransferFailed",
      "onTransportError",
    )

    AsyncFunction("getCapabilities") { promise: Promise ->
      val context = safeContext() ?: return@AsyncFunction promise.resolve(caps(false, false))
      val bleOk = ensureBle(context).isSupported()
      val awareOk =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
          context.packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI_AWARE) &&
          ensureAware(context)?.isSupported() == true
      promise.resolve(caps(bleOk, awareOk))
    }

    AsyncFunction("getMissingPermissions") { promise: Promise ->
      val context = safeContext()
      if (context == null) {
        promise.resolve(emptyList<String>())
        return@AsyncFunction
      }
      promise.resolve(missingPermissions(context))
    }

    Function("startAdvertising") { advert: AdvertRecord ->
      val context = safeContext() ?: return@Function
      val parsed = advert.toAdvert()
      ensureBle(context).startAdvertising(parsed)
      ensureAware(context)?.let { if (it.isSupported()) it.start(parsed) }
    }

    Function("stopAdvertising") {
      ble?.stopAdvertising()
      // Aware advertise + discover share one session; stopping it here would also stop discovery, so we
      // only tear Aware down on shutdown(). Advertising is cheap once attached.
    }

    Function("startDiscovery") {
      val context = safeContext() ?: return@Function
      ensureBle(context).startDiscovery()
    }

    Function("stopDiscovery") {
      ble?.stopDiscovery()
    }

    AsyncFunction("sendBlob") { peerId: String, base64: String, promise: Promise ->
      executor.execute { sendBlob(peerId, base64, promise) }
    }

    Function("shutdown") {
      teardown()
    }

    OnDestroy {
      teardown()
    }
  }

  // ---- Wiring -----------------------------------------------------------------------------------

  private fun safeContext(): Context? = appContext.reactContext?.applicationContext

  private fun ensureBle(context: Context): MeshBleController {
    ble?.let { return it }
    val controller = MeshBleController(
      context,
      object : MeshBleController.Listener {
        override fun onPeerDiscovered(peerId: String, haveMail: Boolean, meshHint: String, rssi: Int) {
          sendEvent(
            "onPeerDiscovered",
            mapOf("peerId" to peerId, "haveMail" to haveMail, "meshHint" to meshHint, "rssi" to rssi),
          )
        }

        override fun onError(message: String) {
          sendEvent("onTransportError", mapOf("error" to message))
        }
      },
    )
    ble = controller
    return controller
  }

  private fun ensureAware(context: Context): MeshWifiAwareController? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return null
    }
    if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI_AWARE)) {
      return null // fall back to BLE-only (with the documented chunked-transfer TODO)
    }
    aware?.let { return it }
    val controller = MeshWifiAwareController(
      context,
      object : MeshWifiAwareController.Listener {
        override fun onPeerMatched(peerId: String, haveMail: Boolean, meshHint: String) {
          sendEvent(
            "onPeerDiscovered",
            mapOf("peerId" to peerId, "haveMail" to haveMail, "meshHint" to meshHint, "rssi" to null),
          )
        }

        override fun onBlobReceived(peerId: String, bytes: ByteArray) {
          sendEvent(
            "onTransferReceived",
            mapOf("peerId" to peerId, "base64" to Base64.encodeToString(bytes, Base64.NO_WRAP)),
          )
        }

        override fun onError(message: String) {
          sendEvent("onTransportError", mapOf("error" to message))
        }
      },
    )
    aware = controller
    return controller
  }

  /** Route an outbound blob to Wi-Fi Aware (preferred) or the BLE fallback, by peerId namespace. */
  private fun sendBlob(peerId: String, base64: String, promise: Promise) {
    try {
      val bytes = Base64.decode(base64, Base64.NO_WRAP)
      when {
        peerId.startsWith("aware-") -> {
          val controller = aware ?: throw MeshTransportException("Wi-Fi Aware is not active")
          controller.sendBlob(peerId, bytes)
        }
        peerId.startsWith("ble-") -> {
          // No Aware link to this peer — fall back to the (currently unimplemented) chunked BLE path.
          val controller = ble ?: throw MeshTransportException("BLE is not active")
          controller.sendBlobFallback(peerId, bytes)
        }
        else -> throw MeshTransportException("Unknown peer id: $peerId")
      }
      promise.resolve(null)
      sendEvent("onTransferComplete", mapOf("peerId" to peerId))
    } catch (error: Throwable) {
      promise.reject(MeshTransportException(error.message ?: "Mesh transfer failed", error))
      sendEvent("onTransferFailed", mapOf("peerId" to peerId, "error" to (error.message ?: "failed")))
    }
  }

  private fun teardown() {
    try {
      ble?.stop()
      aware?.stop()
    } finally {
      ble = null
      aware = null
    }
  }

  private fun hasPermission(context: Context, permission: String): Boolean =
    context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

  private fun missingPermissions(context: Context): List<String> {
    val needed = mutableListOf<String>()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      for (p in listOf(
        Manifest.permission.BLUETOOTH_ADVERTISE,
        Manifest.permission.BLUETOOTH_SCAN,
        Manifest.permission.BLUETOOTH_CONNECT,
        Manifest.permission.NEARBY_WIFI_DEVICES,
      )) {
        if (!hasPermission(context, p)) needed += p
      }
    } else {
      if (!hasPermission(context, Manifest.permission.ACCESS_FINE_LOCATION)) {
        needed += Manifest.permission.ACCESS_FINE_LOCATION
      }
    }
    return needed
  }

  private fun caps(ble: Boolean, wifiAware: Boolean): Map<String, Any> =
    mapOf("ble" to ble, "wifiAware" to wifiAware)
}
