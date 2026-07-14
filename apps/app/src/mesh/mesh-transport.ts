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
 * The Android runtime permissions the transport needs. On API 31+ the Bluetooth trio + Wi-Fi nearby;
 * on older devices BLE scanning is location-gated. Requested via `PermissionsAndroid.requestMultiple`,
 * exactly like the hotspot flow.
 */
function wantedPermissions(): Permission[] {
  if (Platform.OS !== 'android') {
    return [];
  }
  const apiLevel = typeof Platform.Version === 'number' ? Platform.Version : 0;
  if (apiLevel >= 31) {
    return [
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES,
    ];
  }
  return [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
}

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
    // Prompt for the full wanted set (requestMultiple no-ops already-granted ones); then re-check.
    const toRequest = wantedPermissions();
    if (toRequest.length > 0) {
      await PermissionsAndroid.requestMultiple(toRequest);
    }
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
    this.startInFlight = this.doStart(advert).finally(() => {
      this.startInFlight = null;
    });
    return this.startInFlight;
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
