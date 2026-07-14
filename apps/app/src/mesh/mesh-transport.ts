// A clean `MeshTransport` abstraction over the `loam-mesh-transport` native module (opportunistic-mesh
// Phase 3 — docs/16 §5, docs/17). It hides the native surface behind a small, typed façade that:
//   - lazily uses the native module (imported through the module's index, which itself uses
//     `requireOptionalNativeModule`, so a build without radios yields a graceful no-op);
//   - owns the runtime-permission prompt (React Native `PermissionsAndroid`, mirroring `use-hotspot.ts`);
//   - exposes discover / advertise / send-blob + typed event subscription.
//
// The transport carries OPAQUE base64 bytes only — it never opens or reasons about a sealed blob. The
// pull/push courier logic (which blobs to move, and to/from the localhost relay endpoints) lives in the
// launcher (nodejs-project-template/main.js); the RN side just drives the radio (see mesh-courier.ts).
import { PermissionsAndroid, Platform } from 'react-native';
import type { Permission } from 'react-native';

import {
  MESH_TRANSPORT_PROTOCOL_VERSION,
  addMeshListener,
  getMeshCapabilities,
  getMissingMeshPermissions,
  isMeshTransportSupported,
  sendMeshBlob,
  shutdownMeshTransport,
  startMeshAdvertising,
  startMeshDiscovery,
  stopMeshAdvertising,
  stopMeshDiscovery,
} from '../../modules/loam-mesh-transport';
import type {
  MeshPeer,
  MeshTransferReceived,
  MeshTransportCapabilities,
} from '../../modules/loam-mesh-transport';

export type { MeshPeer, MeshTransferReceived, MeshTransportCapabilities };

/** The presence beacon this node advertises — the have-mail hint plus an optional group hint. */
export type MeshAdvertState = {
  haveMail: boolean;
  meshHint?: string;
};

/** Callbacks a consumer (the courier) registers with the transport. */
export type MeshTransportHandlers = {
  onPeer?: (peer: MeshPeer) => void;
  onReceived?: (transfer: MeshTransferReceived) => void;
  onError?: (error: string) => void;
};

/**
 * The single façade the courier talks to. A module-scope singleton (like the hotspot store) so the
 * radios have exactly one owner regardless of how many callers subscribe. Every method is safe to call
 * when the native module is absent — it degrades to a no-op.
 */
export class MeshTransport {
  private handlers: MeshTransportHandlers = {};
  private unsubscribers: (() => void)[] = [];
  private started = false;
  /** Shared promise for an in-flight `start()` so overlapping callers don't double-start (see `start`). */
  private startInFlight: Promise<boolean> | null = null;
  /** Lifecycle generation, bumped by `stop()`. `doStart()` captures it before the async permission
   * request and bails if it changed — so a stop() during startup can't be undone by the resuming
   * `doStart()` registering listeners + starting the radios after teardown. */
  private generation = 0;

  /** True when the native transport module is linked (Android host build). */
  get supported(): boolean {
    return isMeshTransportSupported();
  }

  /** Which physical transports this device can use. `{ ble:false, wifiAware:false }` when unsupported. */
  async capabilities(): Promise<MeshTransportCapabilities> {
    return getMeshCapabilities();
  }

  /**
   * Ensure the runtime permissions are granted. Prompts via `PermissionsAndroid` for anything missing
   * (per the native module's grant check), and resolves true only when nothing is still missing.
   */
  async ensurePermissions(): Promise<boolean> {
    if (!this.supported || Platform.OS !== 'android') {
      return false;
    }
    let missing = await getMissingMeshPermissions();
    if (missing.length === 0) {
      return true;
    }
    // Request EXACTLY what native reports missing — native owns the correct API/capability split (P1). The
    // RN side must not hardcode its own set, or it re-introduces the API 31/32 bug (requesting the
    // API-33-only NEARBY_WIFI_DEVICES and omitting the ACCESS_FINE_LOCATION Aware needs there).
    await PermissionsAndroid.requestMultiple(missing as Permission[]);
    missing = await getMissingMeshPermissions();
    return missing.length === 0;
  }

  /** Register (replace) the courier's event handlers. */
  setHandlers(handlers: MeshTransportHandlers): void {
    this.handlers = handlers;
  }

  /**
   * Start advertising + discovery. Requests permissions first; if they're denied, stays stopped and
   * reports an error through `onError`. Idempotent — a second call while running is a no-op. Returns
   * true when the radios were actually started.
   *
   * Serialized: `start()` awaits permissions, so two overlapping calls could otherwise both pass the
   * `started` check and each register listeners + start the radios twice. Concurrent callers share the
   * one in-flight startup promise instead.
   */
  async start(advert: MeshAdvertState): Promise<boolean> {
    if (this.started) {
      return true;
    }
    if (this.startInFlight) {
      return this.startInFlight;
    }
    const attempt = this.doStart(advert);
    this.startInFlight = attempt;
    // Clear the field only if it STILL points at this attempt: a stop() (which nulls it) + a newer start()
    // may have replaced it while this one was pending, and this attempt's finally must not erase the newer
    // one (which would let a third caller start concurrently and double-register) (P1).
    void attempt.finally(() => {
      if (this.startInFlight === attempt) {
        this.startInFlight = null;
      }
    });
    return attempt;
  }

  private async doStart(advert: MeshAdvertState): Promise<boolean> {
    if (this.started) {
      return true;
    }
    if (!this.supported) {
      return false;
    }
    const gen = this.generation;
    const granted = await this.ensurePermissions();
    // A stop() (or another start()) happened while the permission dialog was up — abandon this startup
    // rather than register listeners + start the radios after teardown (P1-4).
    if (gen !== this.generation) {
      return false;
    }
    if (!granted) {
      this.handlers.onError?.('Mesh permissions were not granted.');
      return false;
    }

    this.unsubscribers.push(
      addMeshListener('onPeerDiscovered', (peer) => this.handlers.onPeer?.(peer)),
      addMeshListener('onTransferReceived', (transfer) => this.handlers.onReceived?.(transfer)),
      addMeshListener('onTransportError', ({ error }) => this.handlers.onError?.(error)),
    );

    startMeshAdvertising({
      version: MESH_TRANSPORT_PROTOCOL_VERSION,
      haveMail: advert.haveMail,
      meshHint: advert.meshHint ?? '',
    });
    startMeshDiscovery();
    this.started = true;
    return true;
  }

  /** Update the advertised have-mail hint without restarting discovery. */
  setAdvert(advert: MeshAdvertState): void {
    if (!this.started) {
      return;
    }
    startMeshAdvertising({
      version: MESH_TRANSPORT_PROTOCOL_VERSION,
      haveMail: advert.haveMail,
      meshHint: advert.meshHint ?? '',
    });
  }

  /** Send one base64 sealed blob to a discovered peer. Resolves on transport ack; never throws here
   * (failures are reported to the caller as a boolean + the `onTransferFailed` native event). */
  async sendBlob(peerId: string, base64: string): Promise<boolean> {
    if (!this.started) {
      return false;
    }
    try {
      await sendMeshBlob(peerId, base64);
      return true;
    } catch {
      return false;
    }
  }

  /** Stop the radios and drop event subscriptions. Idempotent. */
  stop(): void {
    // Bump the generation so any in-flight `doStart()` (awaiting permissions) abandons instead of
    // resuming into a started state after this teardown (P1-4).
    this.generation += 1;
    this.startInFlight = null;
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
    stopMeshDiscovery();
    stopMeshAdvertising();
    shutdownMeshTransport();
    this.started = false;
  }
}

/** The process-wide transport singleton — the radios have exactly one owner. */
export const meshTransport = new MeshTransport();
