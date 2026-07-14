package expo.modules.loammeshtransport

import android.os.ParcelUuid
import java.util.UUID

/**
 * Fixed identifiers + tunables for the LOAM opportunistic-mesh transport (docs/16 §5, docs/17).
 *
 * The two radios play different roles:
 *  - **BLE** is the low-power *discovery + wake* layer: a host advertises a tiny presence beacon under
 *    [SERVICE_UUID] and everyone scans for it. BLE throughput is far too low for the tens-of-KB sealed
 *    blobs, so it is used to find peers, exchange a manifest hint, and (only as a fallback when Wi-Fi
 *    Aware is unavailable) chunk bytes over [DATA_CHARACTERISTIC_UUID].
 *  - **Wi-Fi Aware (NAN)** is the *bulk transfer* layer: once BLE says a peer is near, a Wi-Fi Aware
 *    data path (a plain TCP socket over the NAN link, no AP/internet) moves the sealed blob.
 *
 * NONE of these values are secret. The service UUID and Wi-Fi Aware service name only say "this is a
 * LOAM mesh node"; who a message is for stays inside the sealed relay's routing tags (docs/16 §2).
 */
internal object MeshConstants {
  /** GATT service every LOAM host advertises + serves. "6c6f616d" is ASCII "loam". */
  val SERVICE_UUID: UUID = UUID.fromString("6c6f616d-6d65-7368-0001-000000000001")
  val SERVICE_PARCEL_UUID = ParcelUuid(SERVICE_UUID)

  /**
   * Control characteristic: a peer reads it to fetch our presence/manifest hint, or writes a small
   * handshake to negotiate a Wi-Fi Aware data path. Kept tiny (fits one MTU).
   */
  val CONTROL_CHARACTERISTIC_UUID: UUID = UUID.fromString("6c6f616d-6d65-7368-0001-000000000002")

  /**
   * Data characteristic: the BLE-ONLY fallback transfer path (chunked writes) used when a device has
   * no Wi-Fi Aware hardware. Slow (a ~90 KB blob is hundreds of ~500-byte writes) — see the TODO in
   * [MeshBleController]. Preferred path is always Wi-Fi Aware.
   */
  val DATA_CHARACTERISTIC_UUID: UUID = UUID.fromString("6c6f616d-6d65-7368-0001-000000000003")

  /** Wi-Fi Aware publish/subscribe service name — the NAN equivalent of the BLE service UUID. */
  const val WIFI_AWARE_SERVICE_NAME = "loam-mesh-v1"

  /** Transport wire-format version, mirrored in [MeshAdvertCodec] and the JS `MeshAdvert.version`. */
  const val PROTOCOL_VERSION = 1

  /** First byte of every BLE service-data blob, so a stray advertiser under our UUID is rejected. */
  const val ADVERT_MAGIC = 0x4C // 'L'

  /** Advert flag bit: this node currently holds sealed mail worth pulling. */
  const val ADVERT_FLAG_HAVE_MAIL = 0x01

  /** Cap on a single transferred blob: the sealed schema caps a blob at ~87 480 base64 chars; the JSON
   * envelope around it is small, so 128 KiB is comfortable headroom and bounds a hostile peer. */
  const val MAX_BLOB_BYTES = 128 * 1024

  /** Wi-Fi Aware data-path + socket transfer timeout. */
  const val TRANSFER_TIMEOUT_MS = 30_000L

  /** Hard cap on concurrent inbound Wi-Fi Aware transfers. The responder `ServerSocket` accepts on local
   * interfaces, so this bounds how many receive threads a connection flood can create before the
   * server-side sealed-message validation runs (docs/17 — a small number: real mesh peers are few). */
  const val MAX_CONCURRENT_TRANSFERS = 4

  /** How long a discovered peer stays "fresh" before we re-emit it on a new sighting. */
  const val PEER_DEBOUNCE_MS = 15_000L

  /** Bound on the opaque-token → device-address maps (BLE + Wi-Fi Aware), so a churn of rotating
   * addresses can't grow them without limit. Real meshes have a handful of nearby peers. */
  const val MAX_TRACKED_PEERS = 256

  /** Consecutive Wi-Fi Aware discovery config-failures before we assume the parent attach session died and
   * reattach from scratch — the pre-API-33 fallback for the missing `onAwareSessionTerminated` (docs/17). */
  const val MAX_DISCOVERY_FAILURES = 3
}
