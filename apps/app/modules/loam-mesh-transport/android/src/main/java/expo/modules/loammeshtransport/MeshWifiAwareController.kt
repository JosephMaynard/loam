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
import android.net.wifi.aware.PublishDiscoverySession
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
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

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

  // ONE lock serializes the whole lifecycle — `start`, the async `onAttached` (generation check AND the
  // session/socket/publish/subscribe setup, atomically), `updateAdvert`, and `stop`'s teardown — so
  // `stop()` can't interleave between `onAttached`'s guard check and its resource publication and resurrect
  // a session/socket/executor after teardown (P1). The generation is the secondary guard inside the lock.
  private val lifecycleLock = Any()
  @Volatile private var generation = 0
  @Volatile private var starting = false
  // "A publish() is in flight but onPublishStarted hasn't returned the handle yet." Without this, an
  // advert refresh in that window sees `publishSession == null` and publishes AGAIN, orphaning sessions.
  private var publishing = false
  private var pendingAdvert: MeshAdvert? = null
  // Same for subscribe: without it a config-fail / termination would leave discovery permanently dead
  // (nothing re-subscribes) — the recurring start() re-subscribes when both are clear (P1).
  private var subscribing = false

  private val executor = Executors.newCachedThreadPool()
  // Hard cap on concurrent inbound transfers. `ServerSocket` accepts on local interfaces, so without this
  // a flood of connections would each spawn a receive thread (unbounded) before any server-side sealed
  // validation runs (P1-5). Excess connections are closed immediately — before a thread is dispatched.
  private val activeReceives = java.util.concurrent.atomic.AtomicInteger(0)
  private var awareManager: WifiAwareManager? = null
  private var session: WifiAwareSession? = null
  private var publishSession: PublishDiscoverySession? = null
  private var subscribeSession: DiscoverySession? = null
  private var serverSocket: ServerSocket? = null
  private var listenPort: Int = 0

  // Opaque peerId → the live PeerHandle we can open a data path to. peerId is a session-local string so
  // the JS bridge never touches a PeerHandle (not serialisable) or a MAC (privacy). Bounded LRU so a churn
  // of transient matches can't grow it until transport shutdown (P2); guarded by `peersLock`.
  private val peers = object : LinkedHashMap<String, PeerHandle>(16, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, PeerHandle>): Boolean =
      size > MeshConstants.MAX_TRACKED_PEERS
  }
  private val peersLock = Any()
  private var peerSeq = 0L

  fun isSupported(): Boolean {
    val manager = context.getSystemService(Context.WIFI_AWARE_SERVICE) as? WifiAwareManager ?: return false
    return manager.isAvailable
  }

  /** Attach, start the responder socket, then publish + subscribe. Best-effort; errors surface via the
   * listener and leave the module in a BLE-only state. */
  fun start(advert: MeshAdvert) = synchronized(lifecycleLock) {
    // Already attached → refresh the advert (P1-2; a re-attach every 30s would leak
    // sessions/sockets/threads) AND re-subscribe if discovery died, so a failed/terminated subscribe
    // self-heals on the recurring tick instead of leaving this node permanently unable to discover peers (P1).
    val active = session
    if (active != null) {
      updateAdvert(advert)
      ensureSubscribed(active)
      return
    }
    if (starting) {
      return // an attach is already in flight; don't start a second
    }
    val manager = context.getSystemService(Context.WIFI_AWARE_SERVICE) as? WifiAwareManager
    if (manager == null || !manager.isAvailable) {
      listener.onError("Wi-Fi Aware is unavailable on this device")
      return
    }
    awareManager = manager
    val gen = generation
    starting = true
    try {
      manager.attach(object : AttachCallback() {
        override fun onAttached(newSession: WifiAwareSession) {
          // Hold the SAME lifecycle lock across the generation check AND the whole resource setup, so a
          // stop() can't slip in between (advancing the generation + shutting the executor down) and leave
          // this callback publishing a session/socket onto a torn-down controller (P1). stop() either ran
          // before us (generation advanced → discard) or waits behind us (tears our resources back down).
          synchronized(lifecycleLock) {
            if (gen != generation) {
              try {
                newSession.close()
              } catch (_: Throwable) {
              }
              return
            }
            session = newSession
            starting = false
            startResponderSocket()
            publish(newSession, advert)
            subscribe(newSession)
          }
        }

        override fun onAttachFailed() {
          synchronized(lifecycleLock) {
            starting = false
            if (gen == generation) {
              listener.onError("Wi-Fi Aware attach failed")
            }
          }
        }
      }, null)
    } catch (error: SecurityException) {
      starting = false
      listener.onError("Missing NEARBY_WIFI_DEVICES permission for Wi-Fi Aware")
    } catch (error: Throwable) {
      starting = false
      listener.onError("Wi-Fi Aware start failed: ${error.message}")
    }
  }

  /** Update the advertised have-mail flag. Prefer updating the ACTIVE publish IN PLACE
   * (`PublishDiscoverySession.updatePublish`, API 26+) — closing and asynchronously re-publishing lets two
   * overlapping refreshes each create a session where only the last `onPublishStarted` handle is tracked,
   * leaking the others (P1). Only publish afresh if there is no live publish yet. */
  fun updateAdvert(advert: MeshAdvert): Unit = synchronized(lifecycleLock) {
    val existing = publishSession
    if (existing != null) {
      existing.updatePublish(buildPublishConfig(advert)) // update the ACTIVE publish in place (API 26+)
      return
    }
    if (publishing) {
      // A first publish() is in flight but onPublishStarted hasn't returned the handle yet — do NOT
      // publish again (that would orphan sessions, P1). Stash the latest advert; onPublishStarted applies
      // it in place once the handle arrives.
      pendingAdvert = advert
      return
    }
    val active = session ?: return
    publish(active, advert)
  }

  private fun buildPublishConfig(advert: MeshAdvert): PublishConfig =
    PublishConfig.Builder()
      .setServiceName(MeshConstants.WIFI_AWARE_SERVICE_NAME)
      .setServiceSpecificInfo(MeshAdvertCodec.encode(advert))
      .build()

  private fun publish(session: WifiAwareSession, advert: MeshAdvert) {
    publishing = true
    // Bind this publish attempt to the current lifecycle generation, so its async callbacks (which may
    // arrive after a stop()/re-start) can tell whether they're still current (P1).
    val gen = generation
    session.publish(buildPublishConfig(advert), object : DiscoverySessionCallback() {
      override fun onPublishStarted(discoverySession: android.net.wifi.aware.PublishDiscoverySession) {
        synchronized(lifecycleLock) {
          // A stop() (or superseding start) landed while this publish was in flight — this success is STALE:
          // close the discovery session instead of repopulating publishSession onto a torn-down controller.
          if (gen != generation) {
            try {
              discoverySession.close()
            } catch (_: Throwable) {
            }
            return
          }
          publishing = false
          publishSession = discoverySession
          // Apply any advert refresh that arrived while this first publish was in flight (P1).
          pendingAdvert?.let { discoverySession.updatePublish(buildPublishConfig(it)) }
          pendingAdvert = null
        }
      }

      override fun onSessionConfigFailed() {
        synchronized(lifecycleLock) {
          // The initial publish FAILED. Clear `publishing` so a later updateAdvert can retry, instead of
          // wedging forever (every refresh only overwriting pendingAdvert, never re-publishing) (P1). Also
          // drop the stashed pendingAdvert: it's now stale, and a fresh retry publishes the CURRENT advert —
          // otherwise a later success could apply this old value and briefly revert the payload (P2).
          if (gen == generation) {
            publishing = false
            pendingAdvert = null
            listener.onError("Wi-Fi Aware publish failed")
          }
        }
      }

      override fun onSessionTerminated() {
        synchronized(lifecycleLock) {
          // The publish session ended on its own — drop the stale handle + pending advert + clear
          // `publishing` so the next updateAdvert re-publishes the current advert rather than calling
          // updatePublish on a dead session or replaying a stale pending value (P1/P2).
          if (gen == generation) {
            publishSession = null
            publishing = false
            pendingAdvert = null
          }
        }
      }

      override fun onMessageReceived(peerHandle: PeerHandle, message: ByteArray) {
        // The initiator sends us its listening details / a nudge; we simply keep the handle so the
        // data-path accept can match it. Port exchange happens on the network-request path below.
        rememberPeer(peerHandle, MeshAdvertCodec.decode(message))
      }
    }, null)
  }

  /** Re-subscribe if discovery isn't live — called from the recurring start() so a failed/terminated
   * subscribe self-heals on the next 30s tick (P1). Caller holds the lifecycle lock. */
  private fun ensureSubscribed(session: WifiAwareSession) {
    if (subscribeSession == null && !subscribing) {
      subscribe(session)
    }
  }

  private fun subscribe(session: WifiAwareSession) {
    subscribing = true
    val gen = generation
    val config = SubscribeConfig.Builder()
      .setServiceName(MeshConstants.WIFI_AWARE_SERVICE_NAME)
      .build()
    session.subscribe(config, object : DiscoverySessionCallback() {
      override fun onSubscribeStarted(discoverySession: android.net.wifi.aware.SubscribeDiscoverySession) {
        synchronized(lifecycleLock) {
          // Stale success after a stop()/re-start — close it rather than repopulate onto a torn-down node.
          if (gen != generation) {
            try {
              discoverySession.close()
            } catch (_: Throwable) {
            }
            return
          }
          subscribing = false
          subscribeSession = discoverySession
        }
      }

      override fun onSessionConfigFailed() {
        synchronized(lifecycleLock) {
          // Discovery couldn't start. Clear `subscribing` so the recurring start()'s ensureSubscribed
          // re-subscribes — otherwise this node would never discover peers (P1).
          if (gen == generation) {
            subscribing = false
            listener.onError("Wi-Fi Aware subscribe failed")
          }
        }
      }

      override fun onSessionTerminated() {
        synchronized(lifecycleLock) {
          // The subscribe session ended — drop the dead handle so the next start() re-subscribes (P1).
          if (gen == generation) {
            subscribeSession = null
            subscribing = false
          }
        }
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
    synchronized(peersLock) {
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
  }

  /**
   * Responder side: a plain TCP server on a Wi-Fi Aware network. The initiator connects and writes one
   * framed blob; we read it and hand it up. Each accepted connection is one blob then close.
   */
  private fun startResponderSocket() {
    try {
      // NOTE (P1-5, partial): `ServerSocket(0)` binds all local interfaces, so on a device also running the
      // hotspot a LAN client that found the port could connect here. Binding to the Aware interface alone
      // needs the responder restructured around the per-peer Aware `Network` lifecycle (tied to the
      // still-unverified port-exchange scaffold — see `sendBlob`'s doc caveat), so it's a device-iteration
      // follow-up. The admission cap below + the per-connection deadline in `receiveOne` bound the DoS
      // impact meanwhile (≤ MAX_CONCURRENT_TRANSFERS slots, each ≤ TRANSFER_TIMEOUT_MS), and every accepted
      // blob is still validated server-side (sealed relay) before anything is delivered.
      val socket = ServerSocket(0)
      serverSocket = socket
      listenPort = socket.localPort
      executor.execute {
        while (!socket.isClosed) {
          try {
            val client = socket.accept()
            // Hard admission cap: close excess connections immediately (before dispatching a thread) so a
            // flood can't spawn unbounded receive threads ahead of server-side validation (P1-5).
            if (activeReceives.get() >= MeshConstants.MAX_CONCURRENT_TRANSFERS) {
              try {
                client.close()
              } catch (_: IOException) {
              }
            } else {
              activeReceives.incrementAndGet()
              try {
                executor.execute { receiveOne(client) }
              } catch (rejected: RejectedExecutionException) {
                // stop() shut the executor down between accept and dispatch — undo the reservation and
                // close the client rather than leak an ever-open connection + a stuck counter (P1).
                activeReceives.decrementAndGet()
                try {
                  client.close()
                } catch (_: IOException) {
                }
              }
            }
          } catch (error: IOException) {
            // An IOException on a CLOSED socket is our own shutdown (`stop()` closed it) — exit quietly.
            // On an OPEN socket it's a real accept failure that must not be silently swallowed as shutdown.
            if (!socket.isClosed) {
              listener.onError("Wi-Fi Aware responder accept failed: ${error.message}")
            }
            break
          }
        }
      }
    } catch (error: IOException) {
      listener.onError("Could not open the Wi-Fi Aware responder socket: ${error.message}")
    }
  }

  private fun receiveOne(client: Socket) {
    // Absolute deadline: `soTimeout` only bounds a single blocked read, so a peer trickling one byte per
    // sub-timeout window could hold the connection indefinitely. A watchdog closes the socket after the
    // whole-transfer budget regardless, capping how long any one slot is held (P1-5).
    val watchdog = executor.let {
      Thread {
        try {
          Thread.sleep(MeshConstants.TRANSFER_TIMEOUT_MS)
          if (!client.isClosed) client.close()
        } catch (_: Throwable) {
        }
      }.apply { isDaemon = true; start() }
    }
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
      watchdog.interrupt()
      activeReceives.decrementAndGet()
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
    val handle = synchronized(peersLock) { peers[peerId] } ?: throw IOException("Unknown peer $peerId")

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
        try {
          executor.execute {
            try {
              writeOverNetwork(network, connectivity, bytes)
            } catch (error: Throwable) {
              failure = error
            } finally {
              done.countDown()
            }
          }
        } catch (rejected: RejectedExecutionException) {
          // stop() shut the executor down while the data path was coming up — fail fast instead of letting
          // the latch below block until the full transfer timeout (P1).
          failure = IOException("Wi-Fi Aware transport stopped")
          done.countDown()
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

  fun stop(): Unit = synchronized(lifecycleLock) {
    // Under the SAME lock as onAttached's setup, so teardown is atomic vs a concurrent attach callback: a
    // late onAttached either already advanced past its guard (and set up under this lock, so we tear its
    // resources down here) or hasn't run yet (it sees the bumped generation and discards its session) (P1).
    generation++
    starting = false
    publishing = false
    subscribing = false
    pendingAdvert = null
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
      synchronized(peersLock) { peers.clear() }
      // Shut the cached-thread-pool down so repeated start/stop cycles can't leave accept/receive worker
      // threads running or idle. The controller is discarded after stop() (a fresh one is created on the
      // next start), so a dead executor is never reused.
      executor.shutdown()
    }
  }

  companion object {
    private const val TAG = "MeshWifiAware"
  }
}
