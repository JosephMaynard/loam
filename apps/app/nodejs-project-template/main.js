'use strict';

// nodejs-mobile launcher for the embedded LOAM server (docs/04). nodejs-mobile copies the whole
// nodejs-project into an app-writable dir and runs this CJS file on the embedded Node 18 runtime.
//
// This file is a COMMITTED TEMPLATE (apps/app/nodejs-project-template/main.js). The build copies it
// into nodejs-assets/nodejs-project/ (which is gitignored build output) alongside the esbuild
// bundle (loam-server.js), the web client (client/), and the better-sqlite3 native prebuild
// (node_modules/better-sqlite3/). See apps/app/scripts/bundle-server.mjs.

const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const rnBridge = require('rn-bridge');
// P1-2 (Sol round 5): the pure "may a key be resolved this boot?" decision, split out so it can be
// unit-tested directly (this file itself can't be — see db-key-gate.js's doc comment).
const { mayResolveDbKeyThisBoot } = require('./db-key-gate');

const PORT = 3000;
const projectDir = __dirname;
// getDataDir() → the app's writable files dir under /data/data/<pkg>/files (persists across runs).
const dataDir = path.join(rnBridge.app.datadir(), 'loam');

process.env.PORT = String(PORT);
process.env.HOST = '0.0.0.0'; // reachable from the hotspot LAN, not just loopback
process.env.LOAM_DATA_DIR = dataDir;
process.env.LOAM_CLIENT_DIST = path.join(projectDir, 'client');
// The embedded Node 18 has no node:sqlite — use the plain better-sqlite3 prebuild (docs/01, docs/04).
process.env.LOAM_DB_DRIVER = 'better-sqlite3';

/** Post a status update to the React Native host screen (best-effort; never throws). */
function notify(status, extra) {
  try {
    rnBridge.channel.post('loam-status', Object.assign({ status: status }, extra || {}));
  } catch (err) {
    console.error('Failed to post status to RN host', err);
  }
}

// Boot-notice codes (P1-4 / AF2): these all mean the server DEGRADED but kept booting — a DB opened
// unencrypted after a key mismatch, a fresh DB after an unreadable one, or the encrypted driver being
// absent — never that boot failed. The readiness probe below (`startReadinessProbe`/`probeServer`) still
// runs and will post 'ready' once the server actually answers. Reported as status 'notice', NOT 'error': the RN host
// screen must not treat these as fatal (they used to arrive as 'error' and then get silently clobbered
// the moment 'ready' followed — see index.tsx's persistent notice state, AF2/P1-4). Any OTHER code
// (e.g. `boot_failed`/`boot_unhandled_rejection` from embedded-main.ts, where the process exits and
// 'ready' can never follow) stays a real 'error'.
//
// `db_encryption_unreadable` is deliberately NOT in this list (P1-1, Sol round 3): unlike the others,
// the server did NOT keep booting for it — `openInitialStore` threw and boot failed. It used to still
// arrive here as a 'notice' (this DB open failure is non-destructive, so it *felt* like a degrade), but
// then embedded-main.ts's catch immediately followed up with a SECOND report at 'boot_failed', which
// clobbered the notice into a generic fatal error anyway — so it was never really a notice in practice,
// just a confusing double-report. It now arrives as a single 'error' with the specific code, the runtime
// stays alive (embedded-main.ts no longer exits for this one), and index.tsx shows it as a persistent
// FATAL state with the "Preserve old database & start fresh" action — see index.tsx's DB_UNREADABLE_CODE.
//
// `db_encryption_locked` is ALSO deliberately not in this list (P1-1, Sol round 4): it means a
// `persistent`/`passphrase` boot found no usable key and REFUSED to start the server at all — never a
// "degraded but booted" case like the others here, so it must arrive as a real 'error' too. index.tsx
// shows its own dedicated fatal block (boot-time passphrase-unlock / retry), keyed on this exact code.
// (`db_encryption_no_key` — the PRE-P1-1-round-4 code for "encrypted mode, no key" — used to live here
// too, back when that case silently downgraded to a plaintext boot instead of staying locked; it is no
// longer emitted by this file at all, but `index.tsx`'s defensive fallback set still recognizes it in
// case an older bundled build is ever paired with a newer one.)
const DB_ENCRYPTION_NOTICE_CODES = ['db_encryption_open_failed', 'db_encryption_recovered_fresh', 'db_encryption_unavailable'];

// embedded-main.ts (bundled into loam-server.js below) does the real startup work asynchronously —
// require('./loam-server.js') returns long before a config-load or server.listen() failure would
// reject, so this file's own try/catch around require() can't see it (docs/15 A8). It instead calls
// this hook, installed on `global` BEFORE requiring the bundle (same pattern as
// global.__loamOnDeviceChat below), so a failure still reaches the host screen as a real error
// instead of just the generic readiness-poll timeout. Also used directly, below, by this file's own
// DB-encryption downgrade paths (db_encryption_locked / db_encryption_unavailable) — same single
// choke point decides notice-vs-fatal for both callers.
global.__loamReportBootError = function (message, code) {
  const isNotice = DB_ENCRYPTION_NOTICE_CODES.indexOf(code) !== -1;
  notify(isNotice ? 'notice' : 'error', { message: message, code: code });
};

// P1-2 (Sol round 3): the server's kill switch calls this (`globalThis.__loamRequestWipeRestart`, see
// executeKillSwitch in apps/server/src/app.ts) when a `persistent`/`passphrase`-encrypted node is wiped
// — its key is FIXED (Keystore-held) and the server process has no way to mint a new one in-process, so
// it deletes the now-orphaned ciphertext and asks THIS process (over the bridge, same reasoning as every
// other RN-owned action here) to clear the Keystore key material and restart the embedded runtime. The
// RN side (index.tsx) owns `clearStoredDbKeys()` and the actual restart; installed BEFORE requiring the
// server bundle (same pattern as every other global.__loam* hook above/below) so it's always present by
// the time a kill switch could possibly fire.
global.__loamRequestWipeRestart = function () {
  try {
    rnBridge.channel.post('loam-wipe-restart');
  } catch (err) {
    console.error('Failed to post loam-wipe-restart to the RN host', err);
  }
};

// P1-1 (Sol round 5): the server's `openInitialStore` (apps/server/src/app.ts) calls this
// (`globalThis.__loamReportDbKeyMigrated`) after successfully migrating a passphrase-mode DB to the
// current key derivation — either by opening it directly under the current key (already migrated, or a
// fresh install that never needed the legacy one) or by rekeying it in place from the legacy key. Forward
// it to RN so `db-encryption.ts`'s `registerDbEncryption` can call `markPassphraseKeyMigrated()`, which
// stops future boots from offering the legacy key at all. Best-effort, same pattern as every other
// global.__loam* hook here — installed BEFORE requiring the server bundle. Never carries any key material.
global.__loamReportDbKeyMigrated = function () {
  try {
    rnBridge.channel.post('loam-db-key-migrated');
  } catch (err) {
    console.error('Failed to post loam-db-key-migrated to the RN host', err);
  }
};

// Interface NAME prefixes that belong to a VPN/tunnel/virtual adapter rather than the real hotspot/LAN
// (P2-3): an address on one of these is never reachable by a nearby device scanning the join QR, so
// picking one would silently break joining. Mirrors the exclusions in apps/server/src/net.ts's
// `resolveLanIPv4` (`tun`/`utun`/`tailscale`/`wg`/`ppp`), plus a few more that only show up on Android
// (`rmnet` — the cellular radio interfaces; `dummy`/`docker`/`veth`/`bridge` — container/virtual
// networking some ROMs or apps set up). Matched case-insensitively against the OS-reported name.
const TUNNEL_INTERFACE_PREFIXES = ['tun', 'utun', 'tailscale', 'wg', 'ppp', 'rmnet', 'dummy', 'docker', 'veth', 'bridge'];

function isTunnelInterfaceName(name) {
  const lower = name.toLowerCase();
  return TUNNEL_INTERFACE_PREFIXES.some(function (prefix) {
    return lower.startsWith(prefix);
  });
}

/**
 * The host's non-internal IPv4 addresses, excluding VPN/tunnel/virtual interfaces (P2-3) — the native
 * Share QR (`hotspotJoinUrl` in apps/app/src/app/index.tsx) picks from this FLAT list, so filtering
 * happens here rather than trusting the picker to know which addresses are real. The hotspot's AP
 * interface (192.168.49.1 on stock Android LocalOnlyHotspot, but not guaranteed) only appears once the
 * hotspot is up, so we re-post these periodically — the host UI builds the Step-2 join QR from the real
 * address rather than a guess.
 */
function lanAddresses() {
  const addresses = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    if (isTunnelInterfaceName(name)) {
      continue;
    }
    for (const info of interfaces[name] || []) {
      if (info && info.family === 'IPv4' && !info.internal) {
        addresses.push(info.address);
      }
    }
  }
  return addresses;
}

/** Report the current network addresses to the host screen (for the Step-2 join QR + diagnostics). */
function postHostInfo() {
  try {
    rnBridge.channel.post('loam-hostinfo', { port: PORT, addresses: lanAddresses() });
  } catch (err) {
    console.error('Failed to post host info', err);
  }
}

// Answer on-demand requests (the Share overlay asks when it opens) and refresh on an interval so the
// hotspot AP address is picked up whenever the hotspot comes up, without the host screen polling.
rnBridge.channel.on('loam-hostinfo-request', postHostInfo);

// P2 (Sol round 4): true once 'ready' has actually been announced to the host screen — makes
// `announceReady` idempotent so it's safe to call from BOTH the direct server-side signal
// (`__loamReportBootReady`, fired the instant `server.listen()` succeeds — see embedded-main.ts) and
// this file's own `/api/health` poll, whichever gets there first, without double-posting 'ready' or
// re-arming the `postHostInfo` interval twice.
let serverReadyAnnounced = false;

/** Tell the host screen the embedded server is up, exactly once. */
function announceReady() {
  if (serverReadyAnnounced) {
    return;
  }
  serverReadyAnnounced = true;
  notify('ready', { port: PORT });
  postHostInfo();
  // Refresh addresses so the hotspot AP interface is reported once it appears (the user opens
  // "Share · Host" after boot, which is when the hotspot starts).
  setInterval(postHostInfo, 5000);
}

// P2 (Sol round 4): the DIRECT signal — embedded-main.ts calls this the instant `server.listen()`
// succeeds, independent of (and not racing) this file's own poll below. Installed on `global` BEFORE
// requiring the server bundle, same pattern as `__loamReportBootError`/`__loamRequestWipeRestart`.
// Without this, `waitForServer`/`retry`'s poll giving up after ~5 minutes (see below) meant a LATER
// successful boot — e.g. the in-process retry after a "Preserve old database & start fresh"
// confirmation, possibly minutes after the original poll gave up — never told the host screen it was
// ready: `startFreshBusy` stayed stuck true and the WebView never mounted, even though the server was
// actually healthy.
global.__loamReportBootReady = announceReady;

// P2 (Sol round 4): a "singleton" generation counter for the readiness poll below — `startReadinessProbe`
// bumps it and starts a FRESH polling chain every time it's called (once per boot attempt: the initial
// boot, and again after every in-process retry — start-fresh recovery or a db-unlock retry), while any
// OLDER chain still ticking away in the background self-cancels on its next tick instead of continuing
// to run alongside the new one. Without this, a retry that starts its own poll while an earlier one
// hasn't given up yet would leave two overlapping polling loops running concurrently.
let readinessPollGeneration = 0;

/** Start a brand-new readiness-poll chain (P2), superseding any still-running older one. */
function startReadinessProbe() {
  readinessPollGeneration += 1;
  probeServer(readinessPollGeneration, 0);
}

/**
 * Poll the embedded server until it answers, then tell the host screen it can load the WebView.
 * The server listens asynchronously after require(), so we can't await it here — polling also
 * confirms the HTTP surface is actually serving before the WebView navigates to it. `generation` ties
 * this chain to the `startReadinessProbe` call that started it (P2's singleton guard, see above) — a
 * newer call bumps `readinessPollGeneration`, and this chain quietly stops the moment it notices.
 */
function probeServer(generation, attempt) {
  if (generation !== readinessPollGeneration) {
    return; // superseded by a newer probe (a later retry) — this older chain has nothing left to do
  }
  // Probe /api/health, NOT /api/config: config mints a session and, on a fresh node, grants the
  // first caller `firstUser` admin — a loopback probe would silently steal admin from the operator
  // (and its cookie is discarded here), disabling the kill switch and moderation. /api/health
  // creates no identity.
  const request = http.get(
    { host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 2000 },
    (response) => {
      response.resume();
      if (generation !== readinessPollGeneration) {
        return;
      }
      if (response.statusCode && response.statusCode < 500) {
        announceReady();
      } else {
        retry(generation, attempt);
      }
    },
  );
  request.on('error', () => retry(generation, attempt));
  request.on('timeout', () => {
    request.destroy();
    retry(generation, attempt);
  });
}

/** Retry the readiness probe with a fixed backoff, giving up after ~5 minutes. */
function retry(generation, attempt) {
  if (generation !== readinessPollGeneration) {
    return;
  }
  if (attempt > 600) {
    // RF3: an explicit code (rather than none at all) so index.tsx can tell THIS specific give-up apart
    // from other generic errors — it's the one codeless-in-the-past case that used to silently clobber
    // an active "Preserve old database & start fresh" recovery state (db_encryption_unreadable) whenever
    // this timeout fired mid-retry. (P2: this give-up no longer matters for readiness itself — the direct
    // `__loamReportBootReady` signal above doesn't depend on this poll at all — but it's still useful
    // liveness diagnostics, and a fresh `startReadinessProbe()` call on the next retry supersedes it.)
    notify('error', { message: 'Server did not become ready in time.', code: 'boot_timeout' });
    return;
  }
  setTimeout(() => probeServer(generation, attempt + 1), 500);
}

// ---- On-device LLM bridge (optional) --------------------------------------------------------
// The embedded server has no LLM runtime of its own. When the operator enables the on-device backend
// (llm.onDevice), the server calls global.__loamOnDeviceChat; we forward the chat over the rn-bridge
// channel to the RN/native model (llama.rn, see apps/app/src/lib/on-device-llm) and stream the reply
// back. Installed BEFORE requiring the server so the hook is present when config is first read.
// Correlation ids keep concurrent DMs from crossing streams. If the RN side has no model loaded it
// answers loam-llm-error, which the server surfaces as a graceful assistant error — crisis messaging
// is never affected, and this whole block is inert unless the on-device backend is turned on.
const onDeviceChats = new Map(); // id -> { onDelta, onEnd, onError }
const onDeviceTimers = new Map(); // id -> timeout handle (bounds a wedged request)
let onDeviceChatSeq = 0;
const ON_DEVICE_TIMEOUT_MS = 5 * 60 * 1000;

/** Drop a request's callbacks + timer so a request that never ends can't leak a Map entry forever. */
function clearOnDeviceChat(id) {
  const timer = onDeviceTimers.get(id);
  if (timer) {
    clearTimeout(timer);
  }
  onDeviceTimers.delete(id);
  onDeviceChats.delete(id);
}

rnBridge.channel.on('loam-llm-delta', (payload) => {
  const chat = payload && onDeviceChats.get(payload.id);
  if (chat && typeof payload.text === 'string') {
    chat.onDelta(payload.text);
  }
});
rnBridge.channel.on('loam-llm-end', (payload) => {
  const chat = payload && onDeviceChats.get(payload.id);
  if (chat) {
    clearOnDeviceChat(payload.id);
    chat.onEnd();
  }
});
rnBridge.channel.on('loam-llm-error', (payload) => {
  const chat = payload && onDeviceChats.get(payload.id);
  if (chat) {
    clearOnDeviceChat(payload.id);
    chat.onError((payload && payload.error) || 'The on-device model failed.');
  }
});

global.__loamOnDeviceChat = function (messages, callbacks) {
  const id = String((onDeviceChatSeq += 1));
  onDeviceChats.set(id, callbacks);
  onDeviceTimers.set(
    id,
    setTimeout(function () {
      const chat = onDeviceChats.get(id);
      if (chat) {
        clearOnDeviceChat(id);
        chat.onError('The on-device model timed out.');
      }
    }, ON_DEVICE_TIMEOUT_MS),
  );
  try {
    rnBridge.channel.post('loam-llm-request', { id: id, messages: messages });
  } catch (err) {
    clearOnDeviceChat(id);
    callbacks.onError('Could not reach the on-device model: ' + String((err && err.message) || err));
  }
};

// ---- Opportunistic-mesh transport courier (Phase 3 — docs/16 §5, docs/17) -------------------------
// The COURIER BRAIN. The native BLE/Wi-Fi-Aware radio lives in the RN process and is driven by
// src/mesh/mesh-courier.ts; this side decides WHAT to move, using two loopback-only server endpoints:
//   - GET  /api/mesh/outbound  → sealed blobs this node offers (full SealedMessage records)
//   - POST /api/mesh/inbound   → sealed blobs a peer just handed us (fed to the existing relay)
// Both 404 unless the operator has turned `mesh.enabled` on, so the courier discovers the mesh state
// purely by probing them — it needs no config access. Radios only spin up once mesh is enabled.
//
// Protocol (symmetric epidemic gossip, mirroring the sync layer): every node advertises + scans; on a
// peer sighting it PUSHES each of its outbound blobs to that peer (deduped per session). The receiver
// feeds them to /api/mesh/inbound, which dedups by id + tombstone and delivers-or-relays. Because both
// sides push, a blob flows A→C→B without any pull step. TTL/hop/cap bounds live server-side.
//
// This whole block is inert unless mesh is enabled AND the RN side has the native module — with the
// radios absent the RN courier is a no-op, so the posts below simply go unanswered. Never throws into
// the server boot path.
const MESH_POLL_MS = 30_000;
let meshEnabled = false;
let meshOutbound = []; // cached [{ id, base64 }] this node currently offers
const meshSentToPeer = new Map(); // peerId -> Set(blobId) already pushed this session (bounded)
const MESH_MAX_TRACKED_PEERS = 50;

/** Loopback JSON request to the embedded server's mesh bridge endpoints. Calls back (err, status, json). */
function meshRequest(method, path, body, callback) {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const request = http.request(
    {
      host: '127.0.0.1',
      port: PORT,
      path: path,
      method: method,
      timeout: 5000,
      headers: payload
        ? { 'content-type': 'application/json', 'content-length': payload.length }
        : {},
    },
    (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        let json;
        try {
          json = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
        } catch (err) {
          json = undefined;
        }
        callback(null, response.statusCode || 0, json);
      });
    },
  );
  request.on('error', (err) => callback(err, 0, undefined));
  request.on('timeout', () => {
    request.destroy();
    callback(new Error('mesh request timeout'), 0, undefined);
  });
  if (payload) {
    request.write(payload);
  }
  request.end();
}

/** Post a command to the RN mesh courier (best-effort; never throws). */
function meshPost(name, payload) {
  try {
    rnBridge.channel.post(name, payload || {});
  } catch (err) {
    // The RN side may not be listening yet (host screen not mounted); the poll re-posts, so ignore.
  }
}

/** Poll the outbound endpoint: it tells us whether mesh is on and what we're currently offering. */
function refreshMesh() {
  meshRequest('GET', '/api/mesh/outbound', undefined, (err, status, json) => {
    if (err) {
      return; // server momentarily unavailable — try again next tick
    }
    if (status === 404) {
      // Mesh is off (or not loopback, which can't happen here). Stop the radios if we'd started them.
      if (meshEnabled) {
        meshEnabled = false;
        meshOutbound = [];
        meshSentToPeer.clear();
        meshPost('loam-mesh-stop');
      }
      return;
    }
    if (status !== 200 || !json || !Array.isArray(json.messages)) {
      return;
    }
    meshEnabled = true;
    // Cache each sealed blob as the base64 of its JSON so a peer sighting can push it immediately.
    meshOutbound = json.messages.map((message) => ({
      id: String(message.id),
      base64: Buffer.from(JSON.stringify(message)).toString('base64'),
    }));
    const haveMail = meshOutbound.length > 0;
    // start is idempotent on the RN side; re-posting each poll covers the boot race where the RN
    // courier mounts after the server. advertise updates the have-mail hint.
    meshPost('loam-mesh-start', { haveMail: haveMail });
    meshPost('loam-mesh-advertise', { haveMail: haveMail });
  });
}

/** Push every outbound blob we haven't already sent to this peer this session. */
function meshPushToPeer(peerId) {
  if (!meshEnabled || !peerId || !meshOutbound.length) {
    return;
  }
  let sent = meshSentToPeer.get(peerId);
  if (!sent) {
    if (meshSentToPeer.size >= MESH_MAX_TRACKED_PEERS) {
      meshSentToPeer.clear(); // crude bound — re-pushing is harmless (receiver dedups by id)
    }
    sent = new Set();
    meshSentToPeer.set(peerId, sent);
  }
  for (const blob of meshOutbound) {
    if (sent.has(blob.id)) {
      continue;
    }
    sent.add(blob.id);
    meshPost('loam-mesh-send', { peerId: peerId, blobId: blob.id, base64: blob.base64 });
  }
}

// A peer was discovered by the radio — push what we're holding to it.
rnBridge.channel.on('loam-mesh-peer', (payload) => {
  if (payload && typeof payload.peerId === 'string') {
    meshPushToPeer(payload.peerId);
  }
});

// A push completed; on failure, forget it so a later sighting retries.
rnBridge.channel.on('loam-mesh-sent', (payload) => {
  if (payload && payload.ok === false && typeof payload.peerId === 'string' && typeof payload.blobId === 'string') {
    const sent = meshSentToPeer.get(payload.peerId);
    if (sent) {
      sent.delete(payload.blobId);
    }
  }
});

// A blob arrived over the radio — hand it to the relay (it validates + dedups + delivers/relays).
rnBridge.channel.on('loam-mesh-received', (payload) => {
  if (!payload || typeof payload.base64 !== 'string') {
    return;
  }
  let message;
  try {
    message = JSON.parse(Buffer.from(payload.base64, 'base64').toString('utf8'));
  } catch (err) {
    return; // malformed transfer — drop
  }
  meshRequest('POST', '/api/mesh/inbound', { messages: [message] }, (err, status, json) => {
    if (!err && status === 200 && json && json.accepted > 0) {
      // Accepting mail may change what we now hold to carry — refresh our outbound + have-mail hint.
      refreshMesh();
    }
  });
});

rnBridge.channel.on('loam-mesh-error', (payload) => {
  console.warn('Mesh transport error', (payload && payload.error) || payload);
});

// ---- On-device model selection (model manager UI, apps/app/src/lib/model-manager-bridge.ts) -------
// The RN model manager downloads GGUF files into its own (Expo) sandbox and, when the operator taps
// "Set active"/"Deactivate", asks THIS process to persist the chosen `llm.onDevice` block into
// config.json — the same boot-time config layer the server already reads (layered defaults ←
// config.json ← DB admin edits, see CLAUDE.md). This is done over the rn-bridge channel and
// deliberately NEVER over HTTP: any authenticated request from this process (even just
// `/api/config`) would mint a session and, on a fresh node with `firstUser` bootstrap, silently
// steal the one-time admin grant from the operator — exactly the trap the readiness probe above avoids
// by probing `/api/health` instead. nodejs-mobile can't restart in-process, so this takes effect the
// NEXT time the app (re)starts the embedded server; the RN UI is expected to say so.
//
// Every field is re-validated here (mirroring packages/schema's OnDeviceLlmConfigSchema bounds)
// before it's ever written to disk: config.json is a fail-closed boot layer (an invalid document
// makes the whole server refuse to start, see app.ts's parseConfigUpdate), so a malformed manager
// request must be rejected, never written.
const configPath = path.join(dataDir, 'config.json');

/** Read + JSON-parse config.json. Absent file → `{}` (a normal fresh boot); any other error (unlikely,
 * since a malformed file would already have kept the server from booting) propagates to the caller. */
function readConfigFile() {
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return {};
    }
    throw err;
  }
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

/** Same bounds as `OnDeviceLlmConfigSchema` in packages/schema (kept in sync by hand — this file has
 * no access to the zod schema). Returns false (never throws) on anything out of range. */
function isValidSetPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  if (typeof payload.modelPath !== 'string' || payload.modelPath.length < 1 || payload.modelPath.length > 1024) {
    return false;
  }
  if (
    payload.model !== undefined &&
    (typeof payload.model !== 'string' || payload.model.length < 1 || payload.model.length > 120)
  ) {
    return false;
  }
  if (
    payload.contextSize !== undefined &&
    (typeof payload.contextSize !== 'number' ||
      !Number.isInteger(payload.contextSize) ||
      payload.contextSize < 1 ||
      payload.contextSize > 32768)
  ) {
    return false;
  }
  return true;
}

/** Write `next` to config.json atomically (temp file + rename) so a mid-write crash can never leave a
 * half-written, unparseable file behind — that would strand the operator with a server that refuses
 * to boot and no in-app way to fix it. */
function writeConfigFile(next) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmpPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmpPath, configPath);
}

rnBridge.channel.on('loam-model-set-active', (payload) => {
  const requestId = payload && payload.requestId;
  const reply = (ok, error) => {
    try {
      rnBridge.channel.post('loam-model-set-active-result', { requestId: requestId, ok: ok, error: error });
    } catch (err) {
      // RN side isn't listening (screen unmounted mid-request) — nothing more to do.
    }
  };

  try {
    const current = readConfigFile();
    let onDevice;

    if (payload && payload.action === 'clear') {
      onDevice = Object.assign({}, current.llm && current.llm.onDevice, { enabled: false });
    } else if (payload && payload.action === 'set') {
      if (!isValidSetPayload(payload)) {
        reply(false, 'Invalid model configuration (path/model/contextSize out of range).');
        return;
      }
      onDevice = Object.assign({}, current.llm && current.llm.onDevice, {
        enabled: true,
        modelPath: payload.modelPath,
      });
      if (typeof payload.model === 'string' && payload.model) {
        onDevice.model = payload.model;
      }
      if (typeof payload.contextSize === 'number') {
        onDevice.contextSize = payload.contextSize;
      }
    } else {
      reply(false, 'Unknown action.');
      return;
    }

    const next = Object.assign({}, current, { llm: Object.assign({}, current.llm, { onDevice: onDevice }) });
    writeConfigFile(next);
    reply(true);
  } catch (err) {
    reply(false, String((err && err.message) || err));
  }
});

// ---- On-device DB-encryption key handoff (PR B — docs/01, docs/21) --------------------------------
// The embedded server encrypts its SQLite DB at rest when handed a key via LOAM_DB_KEY (see
// apps/server/src/embedded.ts / db.ts). On the Android host the key/mode choice lives in RN, backed by
// the device Keystore via expo-secure-store (apps/app/src/lib/db-encryption.ts) — this process has no
// access to that store, so it REQUESTS the key over the nodejs-mobile bridge and WAITS for RN's answer
// before requiring the server. We request and RN answers (never the reverse), the same request/response
// idiom `loam-model-set-active` uses above — so there's no race against listener-registration order at
// boot (main.js doesn't need RN to have posted before it started listening).
//
// `'off'` is the safe default ONLY when RN's reply genuinely says so — but a timeout, a malformed/
// unrecognized payload, a thrown post(), or RN's own reported read failure (`{mode:'error'}`, from a
// SecureStore/Keystore glitch — see db-encryption.ts's `DB_ENCRYPTION_MODE_READ_ERROR`) must NOT be
// treated the same way any more (P1-3, Sol round 5): those tell us nothing about the operator's actual
// choice, and silently falling through to plaintext would downgrade an encrypted node on a merely
// transient hiccup. Those cases resolve to the `'locked-error'` sentinel mode instead — the caller
// (`resolveDbEncryptionAndBoot` below) reports `db_encryption_locked` and refuses to start the server
// AT ALL, exactly like the existing "persistent/passphrase with no usable key" case, rather than the old
// silent plaintext fallback. Genuine `{mode:'off'}` (RN successfully read an unset/off selection) is
// still a normal, silent boot — crisis messaging still always works for the actual default case.
const DB_KEY_TIMEOUT_MS = 5000;
const DB_ENCRYPTION_MODES = ['off', 'ephemeral', 'persistent', 'passphrase'];
// RN's own sentinel for "I successfully asked, but the read itself failed" (db-encryption.ts's
// `DB_ENCRYPTION_MODE_READ_ERROR`) — not a real encryption mode, so deliberately excluded from
// `DB_ENCRYPTION_MODES` above.
const DB_MODE_READ_ERROR = 'error';
// This file's own sentinel (never sent over the bridge) for "do not resolve a real mode/key this call —
// treat exactly like db_encryption_locked" — covers RN's read-error reply, a timeout, a malformed/
// unrecognized payload, and a thrown post().
const DB_KEY_LOCKED_ERROR = 'locked-error';

/** Ask the RN host for the DB-encryption mode/key, waiting up to `timeoutMs`. Never rejects — any
 * FAILURE (timeout, malformed/unrecognized payload, a post() throw, or RN's own reported read error)
 * resolves to `{ mode: 'locked-error' }` (P1-3, Sol round 5) so the caller locks rather than silently
 * falls back to plaintext. Only a genuinely successful `{mode:'off'}` reply resolves to `'off'`. */
function requestDbKey(timeoutMs) {
  return new Promise(function (resolve) {
    var settled = false;

    function finish(result) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      rnBridge.channel.removeListener('loam-db-key-response', onResponse);
      resolve(result);
    }

    function onResponse(payload) {
      var mode = payload && payload.mode;
      if (mode === DB_MODE_READ_ERROR) {
        // RN successfully answered, but told us ITS read of the stored mode failed — not the same as
        // "off selected". Lock rather than guess.
        finish({ mode: DB_KEY_LOCKED_ERROR });
        return;
      }
      if (DB_ENCRYPTION_MODES.indexOf(mode) === -1) {
        // Malformed/missing/unrecognized payload (old RN build, corrupt post) — must not be assumed
        // 'off' either; lock instead.
        finish({ mode: DB_KEY_LOCKED_ERROR });
        return;
      }
      var key = payload && typeof payload.key === 'string' && payload.key.length > 0 ? payload.key : undefined;
      var legacyKey =
        payload && typeof payload.legacyKey === 'string' && payload.legacyKey.length > 0 ? payload.legacyKey : undefined;
      finish({ mode: mode, key: key, legacyKey: legacyKey });
    }

    var timer = setTimeout(function () {
      // A timeout means RN never answered at all (screen not mounted yet, a hung Keystore call) — a
      // transient condition, not evidence the operator wants plaintext. Lock; the operator (or a later
      // `loam-db-unlock` retry once RN is up) can try again.
      finish({ mode: DB_KEY_LOCKED_ERROR });
    }, timeoutMs);

    // Listener registered BEFORE the request is posted — no race with RN's answer, however fast.
    rnBridge.channel.on('loam-db-key-response', onResponse);
    try {
      rnBridge.channel.post('loam-db-key-request');
    } catch (err) {
      finish({ mode: DB_KEY_LOCKED_ERROR });
    }
  });
}

// RF-c (adversarial review, round 5): a plaintext "last-known DB-encryption mode" hint. Records ONLY the
// mode NAME (never key/passphrase material — those never touch disk here at all) whenever a mode is
// SUCCESSFULLY resolved from the RN handoff. Its one job is to make a LATER boot's `requestDbKey` FAILURE
// (`locked-error` — a 5s timeout before the RN screen has even mounted, a transient Keystore hiccup, a
// malformed reply) recoverable in the RIGHT direction: `off`/absent means this node has no secret to
// protect, so a transient failure must NOT block boot — crisis-messaging availability wins, boot
// plaintext. `persistent`/`passphrase`/`ephemeral` means the node genuinely has (had) a secret-based mode,
// so a transient failure must LOCK rather than silently downgrade to plaintext (the P1-3 confidentiality
// guarantee). It is NOT key material and NOT secret — it's the same mode string already sent in the clear
// over the bridge and threaded through LOAM_DB_ENCRYPTION_MODE.
var DB_MODE_HINT_PATH = path.join(dataDir, '.loam-db-mode-hint');

/** Persist the last-known mode NAME. Refuses to write anything that isn't a known mode string, so no
 *  key-shaped value can ever land here even by a caller mistake. Returns true only on a genuine write
 *  success (P1-b, Sol round 6): the `loam-db-set-mode-hint` handler below reports that back so the RN
 *  picker can warn when a transactional hint write failed. Existing callers ignore the return.
 *
 *  P1-1 (Sol round 7): the write is ATOMIC — write to a temp file then rename over the target — so an
 *  interrupted/partial write can never leave a TRUNCATED hint on disk (which `readDbModeHint` would treat
 *  as a `status:'error'` and LOCK on). rename(2) is atomic on the same filesystem. */
function writeDbModeHint(mode) {
  if (DB_ENCRYPTION_MODES.indexOf(mode) === -1) {
    return false;
  }
  var tmpPath = DB_MODE_HINT_PATH + '.tmp';
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(tmpPath, mode, 'utf8');
    fs.renameSync(tmpPath, DB_MODE_HINT_PATH);
    return true;
  } catch (err) {
    // best-effort — a missing hint only makes a future transient failure err toward locking when a secret
    // mode was previously recorded; an unwritten hint on a fresh/off node just keeps booting plaintext.
    try {
      fs.unlinkSync(tmpPath);
    } catch (cleanupErr) {
      // ENOENT is the common case (writeFileSync itself failed) — nothing to clean up.
    }
    return false;
  }
}

/**
 * Read the last-known mode NAME as a TRI-STATE result (P1-1, Sol round 7) — MIRROR of
 * `DbModeHintResult` / the reader contract in apps/app/src/lib/db-encryption.ts (this CJS file can't
 * import the TS module, so keep the two in sync by hand):
 *   - `{ status: 'present', mode }` → the file held a recognized mode NAME.
 *   - `{ status: 'absent' }`        → a CONFIRMED ENOENT (the file genuinely does not exist).
 *   - `{ status: 'error' }`         → the read threw for any OTHER reason, OR the contents were
 *     malformed/truncated/unrecognized. Deliberately NOT collapsed to `absent`: an unreadable/corrupt
 *     hint tells us nothing, and treating it as absent would let an ephemeral node (no DB at boot) with a
 *     hint read error boot PLAINTEXT (`absent + no DB → plaintext`), a confidentiality downgrade.
 */
function readDbModeHint() {
  var raw;
  try {
    raw = fs.readFileSync(DB_MODE_HINT_PATH, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { status: 'absent' };
    }
    // Any other read failure (permissions, I/O, corruption) is NOT a confirmed absence — lock, don't guess.
    return { status: 'error' };
  }
  var trimmed = String(raw).trim();
  if (DB_ENCRYPTION_MODES.indexOf(trimmed) === -1) {
    // Malformed/truncated/unrecognized contents — treat as an error, never as a confirmed absence.
    return { status: 'error' };
  }
  return { status: 'present', mode: trimmed };
}

// P1-b (Sol round 6): whether an on-disk DB file exists — the fail-closed input to the locked-error
// plaintext decision below. `existsSync` throwing (unexpected) errs on the SAFE side: assume a DB may be
// present, so a locked-error with an absent hint LOCKS rather than downgrades.
function dbFileExists() {
  try {
    return fs.existsSync(path.join(dataDir, 'loam.db'));
  } catch (err) {
    return true;
  }
}

// P1-b (Sol round 6): write the mode-NAME hint TRANSACTIONALLY with a mode SELECTION, on request from the
// RN picker (db-encryption.ts's `setDbModeHint`), rather than only when a mode is successfully RESOLVED
// at boot. Without this, an off→encrypted selection left the stale `off` hint (or, on a fresh encrypted
// upgrade, NO hint) until the next successful encrypted boot — so a `requestDbKey` timeout in between
// would trust the stale/absent hint and boot plaintext. Only the mode NAME is ever written here; the
// payload never carries (and this file never persists) key/passphrase material.
rnBridge.channel.on('loam-db-set-mode-hint', function (payload) {
  var requestId = payload && payload.requestId;
  var mode = payload && payload.mode;
  var ok = false;
  var error;
  try {
    if (DB_ENCRYPTION_MODES.indexOf(mode) === -1) {
      error = 'Unknown or missing mode.';
    } else if (writeDbModeHint(mode)) {
      ok = true;
    } else {
      error = 'Could not persist the mode hint.';
    }
  } catch (err) {
    error = String((err && err.message) || err);
  }
  try {
    rnBridge.channel.post('loam-db-set-mode-hint-result', { requestId: requestId, ok: ok, error: error });
  } catch (postErr) {
    // RN side isn't listening — nothing more to do.
  }
});

// A marker file recording that the LAST boot ran in ephemeral mode (G4). `deleteStaleEphemeralDb`
// below always deletes the DB when mode is 'ephemeral' — that's ephemeral's whole design, wipe-on-
// restart — but the marker lets it tell that EXPECTED case apart from an operator having just switched
// INTO ephemeral from a mode with real data (persistent/passphrase/off), where the same deletion is
// actually a silent, unrecoverable data loss the RN picker's confirmation dialog (G4) is meant to have
// already warned about. Purely informational — best-effort, and never blocks or changes boot behavior.
var EPHEMERAL_MARKER_PATH = path.join(dataDir, '.loam-db-ephemeral');

function hasEphemeralMarker() {
  try {
    return fs.existsSync(EPHEMERAL_MARKER_PATH);
  } catch (err) {
    return false;
  }
}

function writeEphemeralMarker() {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(EPHEMERAL_MARKER_PATH, String(Date.now()), 'utf8');
  } catch (err) {
    // best-effort
  }
}

function clearEphemeralMarker() {
  try {
    fs.unlinkSync(EPHEMERAL_MARKER_PATH);
  } catch (err) {
    // best-effort — ENOENT is the expected/common case
  }
}

// ---- "Preserve old database & start fresh" operator confirmation (design#1 / AF8, P1-2) ------------
// When boot fails with `db_encryption_unreadable` (an existing encrypted DB the current key can't
// open), the RN error screen offers an explicit "Preserve old database & start fresh" action rather
// than the server silently doing that itself. This marker is the confirmation: the RN UI asks THIS
// process (over the bridge — same reason as the DB-key handoff above, this process owns `dataDir`) to
// write it, then tells the operator to restart the app; the server consumes-and-deletes it on the next
// boot as proof a human actually chose this, not an automatic behaviour.
var START_FRESH_MARKER_PATH = path.join(dataDir, '.loam-db-start-fresh');

// RF2: true while a reboot THIS listener triggered is still running. `bootEmbeddedServer` itself is
// now re-entrant-safe (embedded-main.ts ignores/joins a concurrent call rather than racing a second
// `listen()`), but debouncing here too means a double-tap of the button doesn't even re-write the
// marker or post a second `loam-db-start-fresh-result` — belt-and-suspenders against the exact bug a
// re-entrant in-process reboot caused: two overlapping boots racing `EADDRINUSE` into `process.exit(1)`
// and killing the recovered server.
var startFreshRebootInFlight = false;

rnBridge.channel.on('loam-db-start-fresh', function (payload) {
  var requestId = payload && payload.requestId;

  if (startFreshRebootInFlight) {
    try {
      rnBridge.channel.post('loam-db-start-fresh-result', {
        requestId: requestId,
        ok: false,
        error: 'A start-fresh recovery is already in progress.',
      });
    } catch (postErr) {
      // RN side isn't listening — nothing more to do.
    }
    return;
  }

  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(START_FRESH_MARKER_PATH, String(Date.now()), 'utf8');
    rnBridge.channel.post('loam-db-start-fresh-result', { requestId: requestId, ok: true });
  } catch (err) {
    try {
      rnBridge.channel.post('loam-db-start-fresh-result', {
        requestId: requestId,
        ok: false,
        error: String((err && err.message) || err),
      });
    } catch (postErr) {
      // RN side isn't listening — nothing more to do.
    }
    return;
  }

  // P1-1 (Sol round 3): re-attempt boot right here, in the SAME still-alive process. The marker is now
  // on disk, so this time `openInitialStore` (apps/server/src/app.ts) will see it, consume it, and
  // recover instead of throwing again. This only works because embedded-main.ts no longer
  // `process.exit()`s on a `db_encryption_unreadable` failure — the runtime (and this very listener)
  // stays alive specifically so it can receive this event and drive the retry; before that fix, the
  // process backing this listener was already dead by the time the operator could ever tap the button.
  // `global.__loamBootEmbeddedServer` is the hook loam-server.js (embedded-main.ts's bundle entry)
  // installs on `global` — idempotent-safe to call again.
  var reboot = global.__loamBootEmbeddedServer;
  if (typeof reboot === 'function') {
    // Cleared once the retry's OUTCOME (resolve or reject) is actually observed — NOT synchronously
    // after this call — so a duplicate message that arrives while the retry is still mid-flight hits
    // the debounce above instead of triggering a second overlapping boot (RF2).
    startFreshRebootInFlight = true;
    try {
      reboot()
        .then(function () {
          startFreshRebootInFlight = false;
          // P2 (Sol round 4): start a FRESH readiness-probe chain for this retry — the original poll
          // (from the very first boot attempt) may already have given up (~5 minutes) long before the
          // operator got around to confirming "Preserve old database & start fresh", and it never
          // restarts itself. Without this, a successful recovery here would never tell the host screen
          // it's ready (embedded-main.ts's direct `__loamReportBootReady` signal covers the SAME case
          // from the server side too — this is belt-and-suspenders on the client-poll side).
          startReadinessProbe();
        })
        .catch(function (err) {
          startFreshRebootInFlight = false;
          console.error('Retry boot after start-fresh confirmation failed', err);
        });
    } catch (err) {
      startFreshRebootInFlight = false;
      console.error('Failed to invoke the retry-boot hook after start-fresh confirmation', err);
    }
  } else {
    console.error(
      'No retry-boot hook installed (unexpected — loam-server.js should have set global.__loamBootEmbeddedServer)',
    );
  }
});

// ---- `db_encryption_locked` unlock retry (P1-1, Sol round 4) -----------------------------------------
// Mirrors the "Preserve old database & start fresh" listener above, but for the OTHER recoverable boot
// state: `persistent`/`passphrase` mode found no usable key and `resolveDbEncryptionAndBoot` returned
// without ever requiring the server bundle at all (see its 'locked' outcome) — so there is no running
// server/listener to "reboot" here, just the whole key-resolution pipeline to re-run from scratch. RN
// (index.tsx) posts this after the operator has done something that might now produce a key: for
// passphrase mode, having just called `setStoredPassphrase`; for persistent mode, as a plain manual
// retry (e.g. after a transient Keystore hiccup).
//
// P1-2 (Sol round 5): this MUST go through `bootWithWipeResume()`, never call
// `resolveDbEncryptionAndBoot()` directly — a direct call here bypassed the wipe-pending marker check
// entirely, so a Retry/Unlock tap could resolve a key (and boot) while an earlier wipe's Keystore
// key-clear was still unconfirmed, opening the fresh post-wipe database under the very secret the wipe
// was meant to destroy. `bootWithWipeResume` re-checks the marker on every call (see its doc comment) and
// is the single choke point every boot/unlock entry point in this file routes through.
var dbUnlockRetryInFlight = false;

rnBridge.channel.on('loam-db-unlock', function (payload) {
  var requestId = payload && payload.requestId;

  if (dbUnlockRetryInFlight) {
    try {
      rnBridge.channel.post('loam-db-unlock-result', {
        requestId: requestId,
        ok: false,
        error: 'An unlock retry is already in progress.',
      });
    } catch (postErr) {
      // RN side isn't listening — nothing more to do.
    }
    return;
  }

  // Ack immediately that the retry was KICKED OFF — its real outcome (ready / still locked / any other
  // boot error) arrives the normal way, via `loam-status`, exactly like the start-fresh flow above.
  dbUnlockRetryInFlight = true;
  try {
    rnBridge.channel.post('loam-db-unlock-result', { requestId: requestId, ok: true });
  } catch (postErr) {
    // RN side isn't listening for the ack — still proceed with the retry itself below; the operator
    // will see the outcome via the next `loam-status` regardless.
  }

  bootWithWipeResume().then(
    function () {
      dbUnlockRetryInFlight = false;
    },
    function (err) {
      dbUnlockRetryInFlight = false;
      console.error('db-unlock retry failed unexpectedly', err);
    },
  );
});

// ---- Wipe-restart handoff: durable resume (P1-2b, Sol round 4) ---------------------------------------
// The server-side kill switch (executeKillSwitchBody, apps/server/src/app.ts) writes this marker BEFORE
// signaling `loam-wipe-restart` for a `persistent`/`passphrase`-encrypted node — see `wipePendingMarkerPath`
// there. If the app is suspended/backgrounded/killed before RN can VERIFY the Keystore key material is
// actually cleared (or the clear itself fails), the marker survives on disk and this boot gets another
// chance: re-post the SAME `loam-wipe-restart` event index.tsx's listener already handles (it doesn't
// distinguish "live signal from the kill switch" from "resume repost from this boot") — it clears the
// key, verifies, and on success posts `loam-wipe-complete` right back to the listener below, which is
// the ONLY thing allowed to delete this marker.
var WIPE_PENDING_MARKER_PATH = path.join(dataDir, '.loam-wipe-pending');

function hasWipePendingMarker() {
  try {
    return fs.existsSync(WIPE_PENDING_MARKER_PATH);
  } catch (err) {
    return false;
  }
}

// P1-c (Sol round 6): delete the wipe-pending marker AND VERIFY it's actually gone, returning real
// success/failure. The old version swallowed unlink failures, so `proceed()` (below) would boot and mint
// a BRAND-NEW device secret while the marker silently lingered — and the NEXT boot's wipe-resume would
// then re-clear THAT fresh secret, leaving the new database unreadable. A verified return lets `proceed()`
// refuse to mint a new secret unless the marker is provably gone. ENOENT (already absent) counts as
// success; any other unlink error, or the file still being present/unverifiable afterward, is a failure.
function clearWipePendingMarker() {
  try {
    fs.unlinkSync(WIPE_PENDING_MARKER_PATH);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return true; // already gone — nothing pending
    }
    return false; // a real delete failure — the marker may still be on disk
  }
  try {
    return fs.existsSync(WIPE_PENDING_MARKER_PATH) === false;
  } catch (err) {
    return false; // couldn't verify removal — must not be reported as a clean success
  }
}

// P1-2(b): the ONLY place this marker is ever deleted — never on a bare signal, never speculatively. This
// standalone handler covers the LIVE / no-active-resume path (a kill-switch wipe while the server is
// already running); the resume path's `proceed()` does its own verified clear-and-decide (P1-c). A failure
// here is not fatal on the live path: the marker simply persists, and the NEXT boot's wipe-resume re-drives
// the clear and retries the delete.
rnBridge.channel.on('loam-wipe-complete', function () {
  clearWipePendingMarker();
});

// NOTE (Sol round-4 finding #1): the wipe-restart re-post is intentionally NOT fired here as a bare,
// unsequenced signal. On a resumed-wipe boot the device secret MUST be cleared BEFORE any DB key is
// resolved for this boot — otherwise resolveDbKey races the clear on the same SecureStore item and can
// encrypt the fresh DB under the very secret we're destroying (or brick it). The re-post + the
// wait-for-clear-before-boot are handled together in `bootWithWipeResume()` at the bottom of this file.
var WIPE_RESUME_TIMEOUT_MS = 20000;

/** Best-effort delete of a previous encrypted DB's files. Only called for 'ephemeral' mode, where a
 * fresh random key is generated every launch, so a DB encrypted under a PREVIOUS launch's key can never
 * be opened again — leaving the stale files behind would just make openStore fail on a confusing
 * "file is not a database" error instead of starting clean. ENOENT (nothing to delete on a fresh
 * install, or when the DB was never encrypted) and any other error are both swallowed: failing to
 * delete a stale file must never block boot. Logs (never blocks on) the "this deletion wasn't expected"
 * case per the marker comment above, then marks THIS boot as ephemeral for the next one. */
function deleteStaleEphemeralDb() {
  if (!hasEphemeralMarker()) {
    console.warn(
      'Booting in ephemeral DB-encryption mode, but the previous boot was not marked ephemeral — ' +
        'this deletion may be destroying data from a different (non-ephemeral) mode.',
    );
  }
  ['loam.db', 'loam.db-wal', 'loam.db-shm'].forEach(function (name) {
    try {
      fs.unlinkSync(path.join(dataDir, name));
    } catch (err) {
      // best-effort — ENOENT is the expected/common case
    }
  });
  writeEphemeralMarker();
}

// P2 (Sol round 4): the mesh-courier poll must only ever be armed ONCE per process — `resolveDbEncryptionAndBoot`
// can now run more than once (a `db_encryption_locked` unlock retry, see `loam-db-unlock` below), and a
// second `setInterval(refreshMesh, ...)` would stack a redundant concurrent poll rather than replacing
// the first.
let meshPollArmed = false;

/**
 * Resolve process.env.LOAM_DB_KEY from the RN key handoff, then require + start the embedded server —
 * OR, for `persistent`/`passphrase` with no usable key, stay LOCKED and do neither (P1-1, Sol round 4:
 * these two modes must never fall back to a plaintext boot). Returns a promise resolving once this
 * attempt is fully settled (server required + readiness probe started, OR left locked) so callers —
 * the initial boot at the bottom of this file, and the `loam-db-unlock` retry listener below — can tell
 * when it's safe to retry again. Never rejects.
 */
function resolveDbEncryptionAndBoot() {
  return requestDbKey(DB_KEY_TIMEOUT_MS)
    .then(function (result) {
      var mode = result.mode;
      var key = result.key;
      var legacyKey = result.legacyKey;

      if (mode === DB_KEY_LOCKED_ERROR) {
        // P1-3 (Sol round 5): RN couldn't tell us its actual mode selection at all — a Keystore/
        // SecureStore read failure, a timeout, or a malformed/unrecognized response. This is NOT the
        // same signal as an operator genuinely choosing 'off'. RF-c (adversarial review, round 5): but
        // whether it should BLOCK boot depends on whether this node has a secret to protect. `off` is the
        // default for most hosts, and a 5s requestDbKey timeout (the RN screen not mounted yet) must not
        // lock a node that has no secret — that would hurt crisis-messaging availability for the common
        // case. Consult the last successfully-resolved mode hint:
        var hint = readDbModeHint();
        var dbExists = dbFileExists();
        // P1-1 (Sol round 7, was P1-b round 6): MIRROR of `mayBootPlaintextOnLockedError(hint, dbExists)`
        // in apps/app/src/lib/db-encryption.ts (harness-tested there; this CJS file can't import the TS
        // module, so the two copies are kept in sync by hand). `hint` is now the TRI-STATE result of
        // `readDbModeHint` above. Authorize a plaintext boot ONLY when:
        //   - present AND mode 'off' → last-known mode was explicitly plaintext → safe; OR
        //   - CONFIRMED-absent (ENOENT) AND no DB file → a genuinely fresh, never-configured node.
        // Everything else LOCKS, never plaintext:
        //   - status 'error' (read failure OR malformed/truncated/unrecognized) → LOCK regardless of the
        //     DB, closing the ephemeral "no DB + hint read error → plaintext" hole (round 7 hole 1);
        //   - absent WITH a DB present → LOCK (a DB exists but no mode recorded — don't downgrade it);
        //   - a present ENCRYPTED-mode hint → LOCK even with NO DB (RF6-c): ephemeral wipes its DB every
        //     boot, and a freshly-selected persistent/passphrase mode has no DB yet, but the operator
        //     explicitly chose an encrypted mode, so a transient error must not write an UNENCRYPTED
        //     loam.db. Only present-'off' or the true "confirmed-absent AND no DB" case boots plaintext.
        var mayBootPlaintext =
          (hint.status === 'present' && hint.mode === 'off') || (hint.status === 'absent' && dbExists === false);
        if (mayBootPlaintext) {
          // No secret to protect: the last-known mode was plaintext 'off', or there's no database file at
          // all AND no mode was ever recorded. A transient key-request failure must NOT lock such a node —
          // boot plaintext, exactly like a genuine 'off' reply. The hint is left untouched — this FAILED
          // resolution is not authoritative enough to write one (only a real reply from RN is).
          console.warn(
            'Could not determine the on-device encryption mode this boot; last-known mode ' +
              (hint.status === 'present' ? "'" + hint.mode + "'" : hint.status) +
              ', DB file ' +
              (dbExists ? 'present' : 'absent') +
              ' — booting plaintext (no secret to protect). Availability over a transient lock (RF-c/P1-1).',
          );
          process.env.LOAM_DB_ENCRYPTION_MODE = 'off';
          process.env.LOAM_DB_DRIVER = 'better-sqlite3';
          delete process.env.LOAM_DB_KEY_MIGRATE_FROM;
          clearEphemeralMarker();
          return 'proceed';
        }
        // A DB file exists and the hint is absent/unreadable or a secret-based mode (persistent/
        // passphrase/ephemeral) — do NOT silently downgrade to plaintext on a transient failure. Stay
        // locked, exactly like the "no usable key" case below — `index.tsx` shows the same Retry recovery
        // (`loam-db-unlock`), which re-runs this function once the app is responsive.
        global.__loamReportBootError(
          'Could not determine the on-device encryption mode this boot (a device security-store read ' +
            'failed, the request timed out, or the response was malformed) — refusing to start ' +
            'unencrypted. Retry once the app is responsive.',
          'db_encryption_locked',
        );
        clearEphemeralMarker();
        return 'locked';
      }

      // Threaded to the embedded server for EVERY boot (AF1/shared contract), 'off' included — so
      // anything downstream that cares about the operator's CONFIGURED mode (as opposed to whether a
      // key happened to come back) doesn't have to re-derive it from LOAM_DB_KEY's shape/value.
      process.env.LOAM_DB_ENCRYPTION_MODE = mode;

      if (mode === 'off') {
        // Safe default: today's plaintext behaviour, unchanged. Silent — 'off' is the true default,
        // not a downgrade, so it must never trigger a boot-error notice.
        process.env.LOAM_DB_DRIVER = 'better-sqlite3';
        delete process.env.LOAM_DB_KEY_MIGRATE_FROM;
        clearEphemeralMarker();
        writeDbModeHint('off'); // RF-c: a later transient key-request failure may boot plaintext.
        return 'proceed';
      }

      if (mode !== 'ephemeral' && !key) {
        // P1-1 (Sol round 4): persistent/passphrase with no usable key — e.g. passphrase mode with no
        // passphrase entered yet, or a Keystore/RNG failure on the RN side — must NEVER fall back to a
        // plaintext boot (that used to happen here, silently discarding the operator's chosen
        // protection the moment a key wasn't ready). Stay LOCKED instead: report the distinct
        // `db_encryption_locked` code (a fatal-until-unlocked state, not a "degraded but booted"
        // notice) and do not proceed to require the server bundle at all — see the caller below, which
        // checks this return value before doing so. `index.tsx` shows a boot-time "enter passphrase to
        // unlock" prompt (passphrase mode) or a plain Retry (persistent mode), both of which post
        // `loam-db-unlock` to re-run this whole function. NEVER logs `key` (there isn't one) or any
        // other secret material. Ephemeral mode is excluded from this branch entirely (see below) —
        // db-encryption.ts's `resolveDbKey('ephemeral')` never returns a key any more by design, so it
        // would otherwise ALWAYS hit this branch.
        global.__loamReportBootError(
          'Encryption mode "' + mode + '" is selected but no key is available yet (no passphrase ' +
            'entered, or a device Keystore/RNG failure) — refusing to start unencrypted.' +
            (mode === 'passphrase' ? ' Enter the passphrase to unlock.' : ' Retry, or open Encryption settings.'),
          'db_encryption_locked',
        );
        clearEphemeralMarker();
        // RF-c: record the operator's REAL secret-based selection even though no key is available yet, so
        // a later transient key-request failure LOCKS (not plaintext-boots) this node. Not key material.
        writeDbModeHint(mode);
        return 'locked';
      }

      // The encrypted driver (better-sqlite3-multiple-ciphers) isn't shipped in every build yet — only
      // plain better-sqlite3 always is (docs/01 "Native prebuild", docs/04). Check availability BEFORE
      // trusting the key: openStore would otherwise throw deep inside server startup the first time an
      // operator picks an encrypted mode on a build that lacks the module. This actually REQUIRES the
      // module (not just require.resolve) — resolving only proves the JS entry point exists, not that
      // the native binding loads; a shipped-but-broken binding would pass a resolve-only guard and then
      // crash-loop server boot instead of failing here where it can be reported and downgraded cleanly.
      // Report the downgrade loudly (A8 boot-error bridge) instead of silently serving plaintext, or
      // bricking boot. This is the ONE case where an encrypted mode still boots plaintext (see
      // CLAUDE.md/docs/15) — the native module being absent is a build seam, not a missing key, and is
      // deliberately distinct from the `db_encryption_locked` case above.
      var encryptedDriverAvailable = false;
      try {
        require('better-sqlite3-multiple-ciphers');
        encryptedDriverAvailable = true;
      } catch (err) {
        encryptedDriverAvailable = false;
      }

      if (!encryptedDriverAvailable) {
        global.__loamReportBootError(
          "Encrypted storage needs the SQLCipher native module, which isn't in this build yet — starting UNENCRYPTED.",
          'db_encryption_unavailable',
        );
        process.env.LOAM_DB_DRIVER = 'better-sqlite3';
        // P1-3 (Sol round 3): also downgrade the DECLARED mode to 'off', not just the driver. Leaving
        // LOAM_DB_ENCRYPTION_MODE at 'ephemeral' here used to make embedded.ts's resolveEphemeralDbKey
        // (which used to also check the mode, not just the LOAM_DB_KEY literal) generate an ephemeral
        // key and set `ephemeralDbKey`, so the server tried to require the very
        // better-sqlite3-multiple-ciphers module this branch just proved was MISSING — crash-looping
        // boot instead of degrading. Posture reporting must match reality too: this boot really is
        // unencrypted, for every mode, not just 'ephemeral'.
        process.env.LOAM_DB_ENCRYPTION_MODE = 'off';
        delete process.env.LOAM_DB_KEY_MIGRATE_FROM;
        clearEphemeralMarker();
        // RF-c: this build can only ever run plaintext (no SQLCipher module), and this boot IS plaintext,
        // so record 'off' — a later transient failure should stay available, not lock. Self-corrects to
        // the real mode on the first successful encrypted boot once the module ships.
        writeDbModeHint('off');
        return 'proceed';
      }

      if (mode === 'ephemeral') {
        deleteStaleEphemeralDb();
        // The LITERAL string 'ephemeral' — NOT a generated key (Sol P1-1). The embedded server
        // (apps/server/src/embedded.ts) recognizes this exact value and generates + holds its OWN
        // random RAM-only key, which `executeKillSwitch` can then ROTATE in place on a wipe. Never
        // derived from RN's `resolveDbKey('ephemeral')` any more — that no longer returns a key at all
        // for this mode (see db-encryption.ts).
        process.env.LOAM_DB_KEY = 'ephemeral';
        delete process.env.LOAM_DB_KEY_MIGRATE_FROM;
        writeDbModeHint('ephemeral'); // RF-c: secret-based mode → a later transient failure LOCKS.
        return 'proceed';
      }

      clearEphemeralMarker();
      // openStore's encryptionKey path takes precedence over LOAM_DB_DRIVER (see db.ts) — leave the
      // driver env unset here. NEVER logged.
      process.env.LOAM_DB_KEY = key;
      // P1-1 (Sol round 5): a pre-round-4 passphrase key derivation, offered ONLY when RN hasn't
      // recorded a confirmed migration yet (db-encryption.ts's `resolveDbKey('passphrase')`). Threaded
      // to the server as LOAM_DB_KEY_MIGRATE_FROM so `openInitialStore` can fall back to it and rekey in
      // place — see embedded.ts. Never logged.
      if (legacyKey) {
        process.env.LOAM_DB_KEY_MIGRATE_FROM = legacyKey;
      } else {
        delete process.env.LOAM_DB_KEY_MIGRATE_FROM;
      }
      // RF-c: a real persistent/passphrase key resolved — record the secret-based mode so a later
      // transient key-request failure LOCKS rather than downgrading to plaintext. Only the mode NAME is
      // written; `key`/`legacyKey` never touch this file (or any file) here.
      writeDbModeHint(mode);
      return 'proceed';
    })
    .catch(function () {
      // Should be unreachable (requestDbKey never rejects), but keep the fallback total. 'off'-style
      // plaintext, not 'locked' — an unexpected internal failure here is not the same signal as an
      // operator's encrypted mode genuinely having no key.
      process.env.LOAM_DB_DRIVER = 'better-sqlite3';
      delete process.env.LOAM_DB_KEY_MIGRATE_FROM;
      return 'proceed';
    })
    .then(function (outcome) {
      if (outcome === 'locked') {
        // Stay locked (P1-1): do NOT require the server bundle — no plaintext fallback for
        // persistent/passphrase — and do NOT start the readiness probe, since there is no server to
        // probe. `global.__loamReportBootError` above already told the host screen; the
        // `loam-db-unlock` listener re-invokes this whole function once the operator retries.
        return;
      }
      try {
        require('./loam-server.js');
        // P2 (Sol round 4): a FRESH readiness-probe chain for every attempt that gets this far —
        // including a retry after a `db_encryption_locked` unlock, mirroring the same fix applied to
        // the `loam-db-start-fresh` retry below. Superseded automatically if this isn't the latest call
        // (see `startReadinessProbe`'s doc comment).
        startReadinessProbe();
        // Start the mesh courier poll once the server is required. refreshMesh no-ops (404) until an
        // operator enables mesh, so this costs one cheap loopback GET per 30s while off. Armed at most
        // once per process — see `meshPollArmed`'s doc comment.
        if (!meshPollArmed) {
          meshPollArmed = true;
          setInterval(refreshMesh, MESH_POLL_MS);
          setTimeout(refreshMesh, 5000);
        }
      } catch (err) {
        console.error('Failed to start the embedded LOAM server', err);
        notify('error', { message: String((err && err.message) || err) });
      }
    });
}

notify('starting');

// Sol round-4 finding #1 / P1-2 (Sol round 5): on a boot where a wipe handoff was interrupted (the
// `.loam-wipe-pending` marker survived), let the RN host clear the device secret BEFORE resolving a DB
// key for this boot. Re-post the clear, wait for `loam-wipe-complete` (the marker-delete handler above
// confirms the key is verifiably gone), and only THEN resolve the key + boot — resolveDbKey will mint a
// NEW device secret since the old one is gone. On timeout we do NOT boot under the un-cleared key:
// surface a locked state and keep the listener, so a late completion still boots and reopening the app
// retries (the marker persists).
//
// P1-2 (Sol round 5): this is now the ONE SINGLE CHOKE POINT allowed to call
// `resolveDbEncryptionAndBoot()` — EVERY boot/unlock entry point (the initial boot at the bottom of this
// file, AND the `loam-db-unlock` retry listener above) MUST go through this function, gated by
// `mayResolveDbKeyThisBoot` (db-key-gate.js). Before this fix, `loam-db-unlock`'s handler called
// `resolveDbEncryptionAndBoot()` directly — bypassing the marker check entirely — so a Retry/Unlock tap
// after a `db_encryption_locked` report (which can also fire while a wipe-resume is still pending) could
// resolve a key and boot a fresh database under the OLD secret the wipe was meant to destroy.
//
// Always returns a Promise that resolves once THIS call's outcome is settled (key resolved & boot
// attempted, OR still locked pending the resume) — never rejects. A wait-for-resume in progress is a
// SINGLETON (`wipeResumeWait`): a second caller (e.g. `loam-db-unlock` firing while the initial boot's
// own resume wait is still pending) joins the SAME wait rather than registering a second overlapping
// `loam-wipe-complete` listener/timer.
var wipeResumeWait;
// RF-d (adversarial review, round 5): a single-flight guard for the NO-marker fast path below. The
// resume path is already a singleton via `wipeResumeWait`, but the direct `return
// resolveDbEncryptionAndBoot()` had no guard — two concurrent callers (the initial boot at the bottom of
// this file and a `loam-db-unlock` retry firing in the same tick) could each start an overlapping boot
// of the embedded server. Cleared once the in-flight boot settles (`resolveDbEncryptionAndBoot` never
// rejects), so a genuine SEQUENTIAL retry after a settled attempt still runs.
var bootInFlight;

function bootWithWipeResume() {
  if (wipeResumeWait) {
    return wipeResumeWait;
  }

  if (bootInFlight) {
    return bootInFlight;
  }

  if (mayResolveDbKeyThisBoot(hasWipePendingMarker())) {
    bootInFlight = resolveDbEncryptionAndBoot().finally(function () {
      bootInFlight = undefined;
    });
    return bootInFlight;
  }

  wipeResumeWait = new Promise(function (resolve) {
    var proceeded = false;
    var timer;
    function proceed() {
      if (proceeded) {
        return;
      }
      proceeded = true;
      clearTimeout(timer);
      rnBridge.channel.removeListener('loam-wipe-complete', proceed);
      // P1-c (Sol round 6): RN only posts `loam-wipe-complete` after `clearStoredDbKeys` VERIFIED the
      // device secret is gone — but we must ALSO confirm OUR OWN wipe-pending marker is actually deleted
      // before booting. If the marker delete failed, booting now would mint a fresh device secret while
      // the marker lingers, and the NEXT boot's wipe-resume would clear THAT fresh secret and brick the
      // new DB. So on a marker-cleanup failure, do NOT resolve a key / mint a secret: leave the marker in
      // place and surface a distinct "reopen to finish" state. Reopening re-drives the resume — RN
      // re-clears the already-gone key idempotently (destroying no fresh secret, because we never minted
      // one) and the marker delete is retried — so recovery completes without data loss.
      if (clearWipePendingMarker() !== true) {
        notify('error', {
          message:
            'The security reset cleared the encryption key, but a cleanup step is still pending — reopen ' +
            'the app to finish it. The database was not reopened.',
          code: 'db_encryption_locked',
        });
        resolve('locked');
        return;
      }
      resolve(resolveDbEncryptionAndBoot());
    }

    timer = setTimeout(function () {
      if (proceeded) {
        return;
      }
      proceeded = true;
      rnBridge.channel.removeListener('loam-wipe-complete', proceed);
      // The clear didn't complete in time — do NOT boot under the un-destroyed key. The marker persists,
      // so reopening the app re-attempts; a later `loam-wipe-complete` (if it eventually arrives after
      // this timeout) is picked up by the NEXT call to this function, since `wipeResumeWait` is cleared
      // in the `finally` below.
      notify('error', {
        message:
          'A security reset is still finishing on this device — reopen the app to complete it. The database was not reopened.',
        code: 'db_encryption_locked',
      });
      resolve('locked');
    }, WIPE_RESUME_TIMEOUT_MS);

    // `proceed` also runs once the marker-delete handler above has cleared the marker on the SAME event.
    rnBridge.channel.on('loam-wipe-complete', proceed);
    try {
      rnBridge.channel.post('loam-wipe-restart');
    } catch (err) {
      proceeded = true;
      clearTimeout(timer);
      rnBridge.channel.removeListener('loam-wipe-complete', proceed);
      console.error('Failed to post loam-wipe-restart for a resumed wipe handoff', err);
      notify('error', {
        message: 'A security reset could not be completed on this device — reopen the app to retry.',
        code: 'db_encryption_locked',
      });
      resolve('locked');
    }
  }).finally(function () {
    wipeResumeWait = undefined;
  });

  return wipeResumeWait;
}

bootWithWipeResume();
