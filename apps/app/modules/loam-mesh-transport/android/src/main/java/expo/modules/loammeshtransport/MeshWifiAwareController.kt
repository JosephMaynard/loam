package expo.modules.loammeshtransport

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.aware.AttachCallback
import android.net.wifi.aware.DiscoverySession
import android.net.wifi.aware.DiscoverySessionCallback
import android.net.wifi.aware.PeerHandle
import android.net.wifi.aware.PublishConfig
import android.net.wifi.aware.SubscribeConfig
import android.net.wifi.aware.WifiAwareManager
import android.net.wifi.aware.WifiAwareNetworkInfo
import android.net.wifi.aware.WifiAwareNetworkSpecifier
import android.net.wifi.aware.WifiAwareSession
import android.os.Build
import android.util.Log
import androidx.annotation.RequiresApi
import java.io.IOException
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * Wi-Fi Aware (NAN) bulk transfer for the LOAM mesh (docs/16 §5, docs/17). Wi-Fi Aware forms a direct,
 * infrastructure-less link between nearby devices (no AP, no internet), which is exactly LOAM's model,
 * and unlike BLE it can move the tens-of-KB sealed blobs quickly.
 *
 * Lifecycle: [attach] to the Aware subsystem → [publish] a service so peers can find us AND [subscribe]
 * so we find them. On a match we hold the peer's [PeerHandle]. To send, the *initiator* requests a Wi-Fi
 * Aware network (a [WifiAwareNetworkSpecifier] data path) and opens a TCP socket to the peer's
 * [ServerSocket]; the *responder* accepts and reads the framed blob (see [MeshFraming]).
 *
 * ⚠️ NATIVE-UNVERIFIED. This mirrors the AOSP Wi-Fi Aware sample + docs, but has not been compiled or
 * run against a real device (Wi-Fi Aware needs hardware CI can't provide — docs/17). Areas most likely
 * to need adjustment on a real phone: the exact data-path handshake ordering (publisher vs subscriber
 * initiating), the port-exchange over the message channel, and per-OEM Aware quirks. Guarded on
 * [WifiAwareManager.isAvailable] and `FEATURE_WIFI_AWARE`; when absent the module falls back to BLE.
 */
// Gated on API 29 (Q): WifiAwareManager itself is API 26, but the data-path primitives this uses
// (WifiAwareNetworkSpecifier) are API 29+. Pre-29 devices fall back to BLE.
@RequiresApi(Build.VERSION_CODES.Q)
internal class MeshWifiAwareController(
  private val context: Context,
  private val listener: Listener,
) {
  interface Listener {
    /** A peer matched our subscription; `peerId` is the opaque handle the JS layer sends blobs to. */
    fun onPeerMatched(peerId: String, haveMail: Boolean, meshHint: String)
    /** A full framed blob arrived over an accepted data path. */
    fun onBlobReceived(peerId: String, bytes: ByteArray)
    fun onError(message: String)
  }

  private val executor = Executors.newCachedThreadPool()
  private var awareManager: WifiAwareManager? = null
  private var session: WifiAwareSession? = null
  private var publishSession: DiscoverySession? = null
  private var subscribeSession: DiscoverySession? = null
  private var serverSocket: ServerSocket? = null
  private var listenPort: Int = 0

  // Opaque peerId → the live PeerHandle we can open a data path to. peerId is a session-local string so
  // the JS bridge never touches a PeerHandle (not serialisable) or a MAC (privacy).
  private val peers = ConcurrentHashMap<String, PeerHandle>()
  private var peerSeq = 0L

  fun isSupported(): Boolean {
    val manager = context.getSystemService(Context.WIFI_AWARE_SERVICE) as? WifiAwareManager ?: return false
    return manager.isAvailable
  }

  /** Attach, start the responder socket, then publish + subscribe. Best-effort; errors surface via the
   * listener and leave the module in a BLE-only state. */
  fun start(advert: MeshAdvert) {
    val manager = context.getSystemService(Context.WIFI_AWARE_SERVICE) as? WifiAwareManager
    if (manager == null || !manager.isAvailable) {
      listener.onError("Wi-Fi Aware is unavailable on this device")
      return
    }
    awareManager = manager
    try {
      manager.attach(object : AttachCallback() {
        override fun onAttached(newSession: WifiAwareSession) {
          session = newSession
          startResponderSocket()
          publish(newSession, advert)
          subscribe(newSession)
        }

        override fun onAttachFailed() {
          listener.onError("Wi-Fi Aware attach failed")
        }
      }, null)
    } catch (error: SecurityException) {
      listener.onError("Missing NEARBY_WIFI_DEVICES permission for Wi-Fi Aware")
    } catch (error: Throwable) {
      listener.onError("Wi-Fi Aware start failed: ${error.message}")
    }
  }

  /** Update the advertised have-mail flag by re-publishing (Aware has no in-place advert update). */
  fun updateAdvert(advert: MeshAdvert) {
    val active = session ?: return
    publishSession?.close()
    publish(active, advert)
  }

  private fun publish(session: WifiAwareSession, advert: MeshAdvert) {
    val config = PublishConfig.Builder()
      .setServiceName(MeshConstants.WIFI_AWARE_SERVICE_NAME)
      .setServiceSpecificInfo(MeshAdvertCodec.encode(advert))
      .build()
    session.publish(config, object : DiscoverySessionCallback() {
      override fun onPublishStarted(discoverySession: android.net.wifi.aware.PublishDiscoverySession) {
        publishSession = discoverySession
      }

      override fun onMessageReceived(peerHandle: PeerHandle, message: ByteArray) {
        // The initiator sends us its listening details / a nudge; we simply keep the handle so the
        // data-path accept can match it. Port exchange happens on the network-request path below.
        rememberPeer(peerHandle, MeshAdvertCodec.decode(message))
      }
    }, null)
  }

  private fun subscribe(session: WifiAwareSession) {
    val config = SubscribeConfig.Builder()
      .setServiceName(MeshConstants.WIFI_AWARE_SERVICE_NAME)
      .build()
    session.subscribe(config, object : DiscoverySessionCallback() {
      override fun onSubscribeStarted(discoverySession: android.net.wifi.aware.SubscribeDiscoverySession) {
        subscribeSession = discoverySession
      }

      override fun onServiceDiscovered(
        peerHandle: PeerHandle,
        serviceSpecificInfo: ByteArray?,
        matchFilter: MutableList<ByteArray>?,
      ) {
        val advert = MeshAdvertCodec.decode(serviceSpecificInfo)
        val peerId = rememberPeer(peerHandle, advert)
        listener.onPeerMatched(
          peerId,
          advert?.haveMail ?: false,
          advert?.meshHintHex() ?: "",
        )
      }
    }, null)
  }

  private fun rememberPeer(handle: PeerHandle, advert: MeshAdvert?): String {
    // Reuse an existing id for the same handle where possible so repeated sightings don't leak entries.
    for ((id, existing) in peers) {
      if (existing == handle) {
        return id
      }
    }
    val id = "aware-${peerSeq++}"
    peers[id] = handle
    return id
  }

  /**
   * Responder side: a plain TCP server on a Wi-Fi Aware network. The initiator connects and writes one
   * framed blob; we read it and hand it up. Each accepted connection is one blob then close.
   */
  private fun startResponderSocket() {
    try {
      val socket = ServerSocket(0)
      serverSocket = socket
      listenPort = socket.localPort
      executor.execute {
        while (!socket.isClosed) {
          try {
            val client = socket.accept()
            executor.execute { receiveOne(client) }
          } catch (error: IOException) {
            break // socket closed on shutdown
          }
        }
      }
    } catch (error: IOException) {
      listener.onError("Could not open the Wi-Fi Aware responder socket: ${error.message}")
    }
  }

  private fun receiveOne(client: Socket) {
    try {
      client.soTimeout = MeshConstants.TRANSFER_TIMEOUT_MS.toInt()
      val bytes = client.getInputStream().use { MeshFraming.readBlob(it) }
      // We don't have a reliable peerId for an inbound socket (the data path is anonymous at the TCP
      // layer); report a synthetic id — the courier only needs the bytes, and dedup is by blob id
      // server-side. TODO: thread the discovery peerId through via a first-frame handshake if per-peer
      // accounting is ever needed.
      listener.onBlobReceived("aware-inbound", bytes)
    } catch (error: Throwable) {
      Log.w(TAG, "Wi-Fi Aware receive failed", error)
    } finally {
      try {
        client.close()
      } catch (_: IOException) {
      }
    }
  }

  /**
   * Initiator side: request a Wi-Fi Aware data path to `peerId`, then open a socket to the peer's
   * responder and write the framed blob. Blocks (on the caller's background thread) until the transfer
   * completes or times out. Returns normally on success, throws on failure.
   *
   * ⚠️ The peer's listen port must be learned out-of-band; here we assume a convention (the responder's
   * [WifiAwareNetworkInfo] exposes an IPv6 peer address, and both sides use a fixed derived port). A
   * real implementation exchanges the port over the discovery message channel first — left as a clearly
   * marked step because it can't be verified without two radios (docs/17).
   */
  fun sendBlob(peerId: String, bytes: ByteArray) {
    val manager = awareManager ?: throw IOException("Wi-Fi Aware not attached")
    val publisher = publishSession ?: subscribeSession ?: throw IOException("No Aware discovery session")
    val handle = peers[peerId] ?: throw IOException("Unknown peer $peerId")

    val specifier: WifiAwareNetworkSpecifier =
      WifiAwareNetworkSpecifier.Builder(publisher, handle).build()
    val request = NetworkRequest.Builder()
      .addTransportType(NetworkCapabilities.TRANSPORT_WIFI_AWARE)
      .setNetworkSpecifier(specifier)
      .build()
    val connectivity = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

    val done = java.util.concurrent.CountDownLatch(1)
    var failure: Throwable? = null

    val callback = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        executor.execute {
          try {
            writeOverNetwork(network, connectivity, bytes)
          } catch (error: Throwable) {
            failure = error
          } finally {
            done.countDown()
          }
        }
      }

      override fun onUnavailable() {
        failure = IOException("Wi-Fi Aware data path unavailable")
        done.countDown()
      }
    }

    connectivity.requestNetwork(request, callback, MeshConstants.TRANSFER_TIMEOUT_MS.toInt())
    try {
      if (!done.await(MeshConstants.TRANSFER_TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)) {
        throw IOException("Wi-Fi Aware transfer timed out")
      }
      failure?.let { throw it }
    } finally {
      try {
        connectivity.unregisterNetworkCallback(callback)
      } catch (_: IllegalArgumentException) {
      }
    }
  }

  private fun writeOverNetwork(network: Network, connectivity: ConnectivityManager, bytes: ByteArray) {
    val caps = connectivity.getNetworkCapabilities(network)
    val info = caps?.transportInfo as? WifiAwareNetworkInfo
      ?: throw IOException("No Wi-Fi Aware peer address on the data path")
    val peerAddress = info.peerIpv6Addr ?: throw IOException("No peer IPv6 address")
    // See the doc-comment caveat: the port must really be exchanged over the discovery channel. We use
    // the responder's advertised port convention here.
    val port = if (info.port != 0) info.port else listenPort
    val socket = network.socketFactory.createSocket()
    try {
      socket.connect(InetSocketAddress(peerAddress, port), MeshConstants.TRANSFER_TIMEOUT_MS.toInt())
      MeshFraming.writeBlob(socket.getOutputStream(), bytes)
    } finally {
      socket.close()
    }
  }

  fun stop() {
    try {
      publishSession?.close()
      subscribeSession?.close()
      serverSocket?.close()
      session?.close()
    } catch (error: Throwable) {
      Log.w(TAG, "Wi-Fi Aware stop failed", error)
    } finally {
      publishSession = null
      subscribeSession = null
      serverSocket = null
      session = null
      peers.clear()
    }
  }

  companion object {
    private const val TAG = "MeshWifiAware"
  }
}
