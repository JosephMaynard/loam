# 17 — Mesh transport (Phase 3): testing procedure + stub/risk register

> **Status: SCAFFOLDED, native-unverified.** This documents the Phase-3 opportunistic transport built
> in `feat/mesh-transport-phase3` — the code that carries the already-built sealed-sender blobs
> (docs/16 Phases 0–2) between nearby Android hosts over BLE + Wi-Fi Aware, with no AP and no internet.
> The TypeScript/JS compiles and the server bridge is desktop-tested; **the Kotlin has not been
> compiled or run against radios** (CI has none, and an emulator has no BLE/Wi-Fi-Aware). This file is
> the exact procedure a human with two phones runs to verify it, and the honest list of what is stubbed.

## What was built

| Layer | File(s) | Verified? |
|---|---|---|
| BLE advertise/scan + GATT service, Wi-Fi Aware publish/subscribe + data-path socket | `apps/app/modules/loam-mesh-transport/android/**/*.kt` | **No — native-unverified** |
| Expo module JS interface + wrapper | `apps/app/modules/loam-mesh-transport/{index.ts,src/*.ts}` | TS typechecks |
| `MeshTransport` abstraction (perms, discover, send/receive, events) | `apps/app/src/mesh/mesh-transport.ts` | TS typechecks |
| RN ↔ launcher courier bridge | `apps/app/src/mesh/mesh-courier.ts` | TS typechecks |
| Launcher courier brain (poll outbound, push/pull, feed relay) | `apps/app/nodejs-project-template/main.js` | Not runtime-tested (needs device) |
| Loopback bridge endpoints | `apps/server/src/app.ts` (`GET /api/mesh/outbound`, `POST /api/mesh/inbound`) | **Yes — desktop tests** |
| Permissions + optional features | `apps/app/plugins/with-loam-host.js` | Applied at prebuild (not device-verified) |

**Nothing here touches `@loam/crypto` or public-data sync.** The transport carries opaque bytes; every
crypto/relay rule stays server-side in the existing sealed relay (docs/16 §2–3).

## Architecture recap (how a message actually moves)

```text
 Phone A (sender host)                         Phone B (recipient host)
 ┌──────────────────────────┐                 ┌──────────────────────────┐
 │ Node server (relay)       │   BLE beacon    │ Node server (relay)       │
 │  GET  /api/mesh/outbound ─┼──►  discover ◄──┼─ GET  /api/mesh/outbound  │
 │  POST /api/mesh/inbound ◄─┼─ Wi-Fi Aware ──►┼─ POST /api/mesh/inbound   │
 │        ▲   │              │  data-path blob │              │   ▲        │
 │        │ rn-bridge        │                 │        rn-bridge │        │
 │  main.js courier brain    │                 │  main.js courier brain    │
 │        │   ▲              │                 │              ▲   │        │
 │  mesh-courier.ts (RN)     │                 │     mesh-courier.ts (RN)  │
 │        │   ▲              │                 │              ▲   │        │
 │  loam-mesh-transport (Kotlin BLE + Wi-Fi Aware)  ...same on B...        │
 └──────────────────────────┘                 └──────────────────────────┘
```

1. Both hosts **advertise** a tiny BLE beacon under a fixed LOAM service UUID (a version byte, a
   have-mail flag, an optional short group hint) and **scan** for the same.
2. On a sighting the RN courier posts `loam-mesh-peer` to `main.js`. The launcher (the "courier brain")
   `GET`s its own `/api/mesh/outbound` (loopback) — the live sealed blobs it holds — and posts each back
   as `loam-mesh-send`. The native layer moves the bytes over a **Wi-Fi Aware data path** (a TCP socket
   on the NAN link; BLE throughput is too low for the tens-of-KB blobs).
3. The receiver's native layer emits `onTransferReceived`; the RN courier posts `loam-mesh-received`;
   the launcher `POST`s it to `/api/mesh/inbound`, which runs the **existing** `acceptSealedFromPeer`
   (TTL/hop/tombstone/dedup/cap → deliver-if-ours-else-relay). Delivery decrypts into an ordinary DM.
4. Gossip is **symmetric**: both sides advertise + scan + push, so a blob flows A→C→B without any pull.
   Convergence bounds (TTL, hop, per-node cap) are entirely server-side and unchanged.

**Gating.** The launcher only spins the radios up once it sees a `200` from `/api/mesh/outbound`, which
only happens when an operator has turned **`mesh.enabled`** on — via `PATCH /api/admin/config` (or by
editing `config.json` before boot), and, in a build that ships it, the admin UI **Mesh panel** is a
convenience wrapper over the same PATCH. With mesh off the endpoint `404`s and the courier stays idle (one cheap loopback
GET per 30 s). The endpoints are **loopback-only** (`request.ip` must be `127.0.0.1`/`::1`; `trustProxy`
is off, so this is unspoofable) — a joiner on the hotspot LAN cannot drain or inject the sealed queue;
that path stays the token-guarded `/api/sync/*`.

## Device requirements

- **Two (ideally three) physical Android phones.** No emulator — neither BLE peripheral mode nor
  Wi-Fi Aware exists on the emulator.
- **Wi-Fi Aware hardware** for the bulk path: check `adb shell pm list features | grep wifi.aware`.
  Common on Pixel 3+/recent flagships; **absent on many mid-range/older devices**. There is **no working
  fallback yet** — the BLE-only chunked path is unimplemented (stubs only), so a phone without Wi-Fi Aware
  **cannot run the primary Phase-3 test at all**. You need at least **two Wi-Fi-Aware-capable phones**.
- **BLE advertise (peripheral) support** on both — most phones have it, some cheap/old ones are
  central-only (`BluetoothAdapter.isMultipleAdvertisementSupported()`).
- Android **12+ (API 31+)** recommended so the `BLUETOOTH_ADVERTISE/SCAN/CONNECT` runtime-permission
  path is exercised (the code also handles pre-31 location-gated scanning).
- Build the release/dev APK per docs/04 (`pnpm --filter app apk` after `pnpm --filter app bundle:server`
  + `fetch:native`). The `loam-mesh-transport` module is auto-linked by Expo modules; no extra step.
- **Bluetooth + Wi-Fi both ON**, location ON (pre-31), phones within ~10 m, screens on/foregrounded
  (Phase 3 is foreground-only; background duty-cycling is Phase 4).

## Procedure

### 0. Pre-flight (per phone)
1. Install the APK, open LOAM, let the embedded host reach "ready".
2. Grant the mesh permissions when prompted (or Settings → Apps → LOAM → Permissions → Nearby devices).
3. As the node admin, enable mesh: `PATCH /api/admin/config` with `{ "mesh": { "enabled": true } }` (and
   `"relay": true` on the middle node for the 3-phone relay test) — or, in a build that ships it, the
   admin UI **Mesh panel** does the same. Optionally set a shared `sync.token` so only your phones pair —
   not required for the transport itself.
4. `adb logcat -s NODEJS-MOBILE MeshBle MeshWifiAware LoamMeshTransport` to watch both layers.

### 1. Two-phone direct delivery (the Phase-3 acceptance gate)
1. On **A**, add **B** as a mesh contact: B shows its identity card QR (mesh contacts UI), A scans it.
2. On **A**, send a sealed message to B (`/api/mesh/messages`). B is not on A's LAN, so it queues.
3. Bring the phones near each other, both foregrounded. **Observe, no further user action:**
   - logcat on both: BLE `onPeerDiscovered` (a `ble-…`/`aware-…` peerId), then a Wi-Fi Aware match +
     data-path request, then a transfer.
   - `main.js` on A logs the outbound push; on B, `/api/mesh/inbound` accepts 1.
   - **B's chat shows the DM from the `mesh.<hash>` sender with the plaintext.**
4. **Pass** = the message arrives with no action beyond being in range.

### 2. Three-phone carry (A→C→B), the DTN point
1. A and B never meet; **C** meets each in turn. All three mesh-enabled, C `relay = true`.
2. A sends to B (as above). Bring **A near C** → C's `/api/mesh/inbound` accepts 1; confirm C **cannot**
   read it (C's chat has no plaintext; `nodeC.store` holds a `sealed` row that doesn't contain the body).
3. Separate A and C; bring **C near B** → C re-offers the blob (still on its `outbound`), B decrypts and
   delivers. **Pass** = B gets the plaintext; C never did.

### 3. Negative / bounds checks
- **Mesh off:** turn `mesh.enabled` off on B → its `/api/mesh/outbound` `404`s and the radios stop
  (logcat: `loam-mesh-stop`); a blob pushed to it is dropped.
- **Loopback guard:** from another device on the LAN, `curl http://<B-ip>:3000/api/mesh/outbound` →
  `404` (only B's own launcher, over 127.0.0.1, may read it).
- **Idempotence:** re-enter range repeatedly → B never shows a duplicate DM (dedup by id + tombstone).
- **Battery sanity:** leave both advertising/scanning 30 min foregrounded, note drain — informs Phase 4.

## Stubs, TODOs, and risks (be honest)

1. **All Kotlin is native-unverified.** It follows the AOSP BLE + Wi-Fi Aware samples but has never been
   compiled by Gradle or run on a radio. Expect the first real build to surface API/import fixes.
2. **Wi-Fi Aware data-path handshake + port exchange is the likeliest thing to need rework.**
   `MeshWifiAwareController.sendBlob`/`writeOverNetwork` assume the responder's listen port is learned
   from `WifiAwareNetworkInfo.port` or a fixed convention; a correct implementation must exchange the
   port over the Aware discovery **message channel** first (send a message on match, read it in
   `onMessageReceived`, then request the network). The initiator-vs-responder role and the
   `WifiAwareNetworkSpecifier` builder args (with/without PMK/passphrase) may also need adjustment per
   OEM. Inbound sockets currently report a synthetic `aware-inbound` peerId (no back-link to the
   discovery handle) — fine for gossip (dedup is server-side) but blocks per-peer accounting.
3. **BLE-only chunked fallback is NOT implemented** — `MeshBleController.sendBlobFallback` throws. On a
   phone without Wi-Fi Aware there is currently **no bulk transport**. Finishing it means: connect GATT
   to the discovered device, negotiate MTU, write the framed blob (`MeshFraming`) in (MTU-3)-byte chunks
   with write-response backpressure, and host a `BluetoothGattServer` on the responder to reassemble.
   Slow (~hundreds of round-trips for a 90 KB blob) — Wi-Fi Aware is the real path; this is the
   compatibility floor.
4. **BLE advertisement size.** The presence beacon uses legacy advertising service-data (~20 usable
   bytes) so old scanners can see it. The group hint is capped at 8 bytes; anything bigger would force
   extended advertising (BT5), which not all peers can scan. Fine for "is this a LOAM node + have-mail",
   not for carrying anything addressable (by design — routing tags stay in the sealed relay).
5. **No duty-cycling / background (Phase 4).** Radios run while foregrounded only. Continuous
   advertise+scan+Aware is battery-hungry — this is exactly where Briar stalled (docs/16 §5/§6). Phase 4
   is `PendingIntent`-based BLE discovery, burst-scan/back-off, Doze-aware scheduling, and bringing
   Wi-Fi up only on a confirmed nearby peer.
6. **Permission prompt UX.** The OS prompt is issued from JS (`PermissionsAndroid`, `mesh-transport.ts`)
   mirroring the hotspot flow; the native module only *checks* grants. There is no in-app rationale
   screen yet — a denied grant just leaves the mesh idle (logged).
7. **Peer namespace split.** BLE sightings yield `ble-<addr>` peerIds and Wi-Fi Aware matches yield
   `aware-<n>`; `sendBlob` routes by prefix. The same physical phone can appear under both. Harmless
   (server dedups) but a real build may want to correlate them to avoid double-pushing.
8. **Duplicate-push bound is crude.** The launcher tracks a per-peer sent-set and clears it wholesale at
   50 peers; a busy room may re-push a blob occasionally (idempotent on receipt). Fine for a scaffold.
9. **Open-relay caution (docs/16 §6.6).** Carrying strangers' sealed mail is a higher-trust operation
   than public gossip; consider requiring a `sync.token` before a node relays over the transport. Not
   enforced by the transport layer today (the relay cap + TTL/hop are the only bounds).

## Where to pick up

Get the module **compiling** first (`pnpm --filter app typecheck` already passes for the JS/TS; a real
`expo prebuild` + Gradle build is the next gate for the Kotlin). Then run Procedure §1 on two Aware-
capable phones and fix the Wi-Fi Aware data-path handshake against real logs. Only claim Phase 3 "done"
once §1 and §2 pass on hardware (docs/16 guardrail 5). Finish the BLE fallback (§stub 3) before
targeting Aware-less devices. Then Phase 4 (battery/background).
