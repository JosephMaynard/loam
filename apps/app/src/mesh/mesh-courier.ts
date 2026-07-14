// RN-side glue for the opportunistic-mesh transport (Phase 3 — docs/16 §5, docs/17). It is the mirror
// image of `on-device-llm.ts`: a bridge between the native BLE/Wi-Fi-Aware radio (which only the RN
// process can drive) and the embedded Node server (which holds the sealed relay + the localhost
// `/api/mesh/{outbound,inbound}` endpoints). The two processes talk over the nodejs-mobile channel.
//
// Split of responsibilities (deliberate — keeps crypto/relay decisions server-side):
//   - The **launcher** (nodejs-project-template/main.js) is the COURIER BRAIN: on a peer sighting it
//     pulls this node's outbound sealed blobs and pushes them; on a received blob it POSTs it to the
//     relay. It sends this module commands and receives its events over the channel.
//   - This module is the RADIO DRIVER: it forwards native transport events up to the launcher and
//     executes the launcher's start/stop/advertise/send commands against `meshTransport`.
//
// Everything is inert unless the launcher enables the mesh (which it only does when the operator has
// turned `mesh.enabled` on — the launcher discovers that via the localhost endpoints, see main.js). On
// a device without the native module, `meshTransport` is a no-op, so registering this is harmless.
import { meshTransport } from './mesh-transport';
import type { MeshPeer, MeshTransferReceived } from './mesh-transport';

/** Node → RN: start the radios advertising this have-mail state. */
type StartCommand = { haveMail?: unknown; meshHint?: unknown };
/** Node → RN: update the advertised have-mail hint. */
type AdvertiseCommand = { haveMail?: unknown; meshHint?: unknown };
/** Node → RN: push one base64 sealed blob to a discovered peer. `blobId` echoes back on completion. */
type SendCommand = { peerId?: unknown; blobId?: unknown; base64?: unknown };

/** The subset of the nodejs-mobile bridge channel this module uses (kept loose, like the LLM bridge). */
interface BridgeChannel {
  addListener(name: string, handler: (payload: unknown) => void): void;
  removeListener(name: string, handler: (payload: unknown) => void): void;
  post(name: string, payload: unknown): void;
}

function asBool(value: unknown): boolean {
  return value === true;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Wire the mesh courier bridge onto the nodejs-mobile channel. Returns a cleanup that stops the radios
 * and removes every listener. Safe on any platform: if the native transport is absent every call is a
 * no-op, and if the launcher never enables the mesh no radios are touched.
 */
export function registerMeshCourier(channel: BridgeChannel): () => void {
  // Forward native transport events up to the launcher (the courier brain).
  meshTransport.setHandlers({
    onPeer: (peer: MeshPeer) => {
      channel.post('loam-mesh-peer', {
        peerId: peer.peerId,
        haveMail: peer.haveMail,
        meshHint: peer.meshHint,
      });
    },
    onReceived: (transfer: MeshTransferReceived) => {
      channel.post('loam-mesh-received', { peerId: transfer.peerId, base64: transfer.base64 });
    },
    onError: (error: string) => {
      channel.post('loam-mesh-error', { error });
    },
  });

  const onStart = (payload: unknown): void => {
    const command = (payload ?? {}) as StartCommand;
    void meshTransport
      .start({ haveMail: asBool(command.haveMail), meshHint: asString(command.meshHint) })
      .then((ok) => channel.post('loam-mesh-started', { ok }))
      .catch((error: unknown) => {
        channel.post('loam-mesh-error', { error: error instanceof Error ? error.message : String(error) });
      });
  };

  const onStop = (): void => {
    meshTransport.stop();
  };

  const onAdvertise = (payload: unknown): void => {
    const command = (payload ?? {}) as AdvertiseCommand;
    meshTransport.setAdvert({ haveMail: asBool(command.haveMail), meshHint: asString(command.meshHint) });
  };

  const onSend = (payload: unknown): void => {
    const command = (payload ?? {}) as SendCommand;
    const peerId = asString(command.peerId);
    const base64 = asString(command.base64);
    const blobId = asString(command.blobId);
    if (!peerId || !base64) {
      // Still ack (ok: false) so the launcher's pending send resolves instead of hanging forever.
      channel.post('loam-mesh-sent', { peerId, blobId, ok: false });
      return;
    }
    void meshTransport.sendBlob(peerId, base64).then((ok) => {
      channel.post('loam-mesh-sent', { peerId, blobId, ok });
    });
  };

  channel.addListener('loam-mesh-start', onStart);
  channel.addListener('loam-mesh-stop', onStop);
  channel.addListener('loam-mesh-advertise', onAdvertise);
  channel.addListener('loam-mesh-send', onSend);

  return () => {
    channel.removeListener('loam-mesh-start', onStart);
    channel.removeListener('loam-mesh-stop', onStop);
    channel.removeListener('loam-mesh-advertise', onAdvertise);
    channel.removeListener('loam-mesh-send', onSend);
    meshTransport.stop();
  };
}
