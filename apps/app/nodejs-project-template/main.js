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
// unencrypted after a key mismatch, a fresh DB after an unreadable one, no key available yet, or the
// encrypted driver being absent — never that boot failed. `waitForServer` below still runs and will
// post 'ready' once the server actually answers. Reported as status 'notice', NOT 'error': the RN host
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
const DB_ENCRYPTION_NOTICE_CODES = [
  'db_encryption_open_failed',
  'db_encryption_recovered_fresh',
  'db_encryption_no_key',
  'db_encryption_unavailable',
];

// embedded-main.ts (bundled into loam-server.js below) does the real startup work asynchronously —
// require('./loam-server.js') returns long before a config-load or server.listen() failure would
// reject, so this file's own try/catch around require() can't see it (docs/15 A8). It instead calls
// this hook, installed on `global` BEFORE requiring the bundle (same pattern as
// global.__loamOnDeviceChat below), so a failure still reaches the host screen as a real error
// instead of just the generic readiness-poll timeout. Also used directly, below, by this file's own
// DB-encryption downgrade paths (db_encryption_no_key / db_encryption_unavailable) — same single
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

/**
 * Poll the embedded server until it answers, then tell the host screen it can load the WebView.
 * The server listens asynchronously after require(), so we can't await it here — polling also
 * confirms the HTTP surface is actually serving before the WebView navigates to it.
 */
function waitForServer(attempt) {
  // Probe /api/health, NOT /api/config: config mints a session and, on a fresh node, grants the
  // first caller `firstUser` admin — a loopback probe would silently steal admin from the operator
  // (and its cookie is discarded here), disabling the kill switch and moderation. /api/health
  // creates no identity.
  const request = http.get(
    { host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 2000 },
    (response) => {
      response.resume();
      if (response.statusCode && response.statusCode < 500) {
        notify('ready', { port: PORT });
        postHostInfo();
        // Refresh addresses so the hotspot AP interface is reported once it appears (the user opens
        // "Share · Host" after boot, which is when the hotspot starts).
        setInterval(postHostInfo, 5000);
      } else {
        retry(attempt);
      }
    },
  );
  request.on('error', () => retry(attempt));
  request.on('timeout', () => {
    request.destroy();
    retry(attempt);
  });
}

/** Retry the readiness probe with a fixed backoff, giving up after ~5 minutes. */
function retry(attempt) {
  if (attempt > 600) {
    notify('error', { message: 'Server did not become ready in time.' });
    return;
  }
  setTimeout(() => waitForServer(attempt + 1), 500);
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
// steal the one-time admin grant from the operator — exactly the trap `waitForServer` above avoids
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
// The safe default is always "off" — no key, today's plaintext `better-sqlite3` driver: if RN's reply
// says `off`, the wait times out, or no key comes back for ANY reason (old RN build, screen not yet
// mounted, a thrown post()), this falls straight through to the existing behaviour. Crisis messaging
// must always work, so a slow/missing RN response can never block or crash boot over encryption.
const DB_KEY_TIMEOUT_MS = 5000;
const DB_ENCRYPTION_MODES = ['off', 'ephemeral', 'persistent', 'passphrase'];

/** Ask the RN host for the DB-encryption mode/key, waiting up to `timeoutMs`. Never rejects — any
 * failure (timeout, malformed payload, a post() throw) resolves to the safe default `{ mode: 'off' }`
 * so the caller can fall through to unencrypted boot unconditionally. */
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
      if (DB_ENCRYPTION_MODES.indexOf(mode) === -1) {
        finish({ mode: 'off' });
        return;
      }
      var key = payload && typeof payload.key === 'string' && payload.key.length > 0 ? payload.key : undefined;
      finish({ mode: mode, key: key });
    }

    var timer = setTimeout(function () {
      finish({ mode: 'off' });
    }, timeoutMs);

    // Listener registered BEFORE the request is posted — no race with RN's answer, however fast.
    rnBridge.channel.on('loam-db-key-response', onResponse);
    try {
      rnBridge.channel.post('loam-db-key-request');
    } catch (err) {
      finish({ mode: 'off' });
    }
  });
}

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

rnBridge.channel.on('loam-db-start-fresh', function (payload) {
  var requestId = payload && payload.requestId;
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
  // installs on `global` — idempotent-safe to call again. `waitForServer` (kicked off after the
  // original `require('./loam-server.js')` below) is still polling /api/health in the background and
  // will pick up the recovered server's readiness on its own; nothing else to wire up here.
  var reboot = global.__loamBootEmbeddedServer;
  if (typeof reboot === 'function') {
    try {
      reboot().catch(function (err) {
        console.error('Retry boot after start-fresh confirmation failed', err);
      });
    } catch (err) {
      console.error('Failed to invoke the retry-boot hook after start-fresh confirmation', err);
    }
  } else {
    console.error(
      'No retry-boot hook installed (unexpected — loam-server.js should have set global.__loamBootEmbeddedServer)',
    );
  }
});

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

/**
 * Resolve process.env.LOAM_DB_KEY (or the plaintext driver fallback) from the RN key handoff, then
 * require + start the embedded server exactly as before. Never throws — any failure anywhere in this
 * resolution falls back to the existing plaintext better-sqlite3 driver so the host still boots.
 */
function resolveDbEncryptionAndBoot() {
  requestDbKey(DB_KEY_TIMEOUT_MS)
    .then(function (result) {
      var mode = result.mode;
      var key = result.key;

      // Threaded to the embedded server for EVERY boot (AF1/shared contract), 'off' included — so
      // anything downstream that cares about the operator's CONFIGURED mode (as opposed to whether a
      // key happened to come back) doesn't have to re-derive it from LOAM_DB_KEY's shape/value.
      process.env.LOAM_DB_ENCRYPTION_MODE = mode;

      if (mode === 'off') {
        // Safe default: today's plaintext behaviour, unchanged. Silent — 'off' is the true default,
        // not a downgrade, so it must never trigger a boot-error notice.
        process.env.LOAM_DB_DRIVER = 'better-sqlite3';
        clearEphemeralMarker();
        return;
      }

      if (mode !== 'ephemeral' && !key) {
        // An encrypted mode is selected but no key came back — e.g. passphrase mode with no
        // passphrase entered yet, or a Keystore/RNG failure on the RN side. Unlike 'off' this IS a
        // silent downgrade to plaintext unless reported (G5): the operator picked an encrypted mode
        // and would otherwise have no idea their data is going in unencrypted. NEVER logs `key`
        // (there isn't one) or any other secret material. Ephemeral mode is excluded from this branch
        // entirely (see below) — db-encryption.ts's `resolveDbKey('ephemeral')` never returns a key any
        // more by design, so it would otherwise ALWAYS hit this "no key" downgrade.
        global.__loamReportBootError(
          'Encryption mode "' + mode + '" is selected but no key is available (e.g. no passphrase ' +
            'entered yet, or a device Keystore/RNG failure) — starting UNENCRYPTED.',
          'db_encryption_no_key',
        );
        process.env.LOAM_DB_DRIVER = 'better-sqlite3';
        clearEphemeralMarker();
        return;
      }

      // The encrypted driver (better-sqlite3-multiple-ciphers) isn't shipped in every build yet — only
      // plain better-sqlite3 always is (docs/01 "Native prebuild", docs/04). Check availability BEFORE
      // trusting the key: openStore would otherwise throw deep inside server startup the first time an
      // operator picks an encrypted mode on a build that lacks the module. This actually REQUIRES the
      // module (not just require.resolve) — resolving only proves the JS entry point exists, not that
      // the native binding loads; a shipped-but-broken binding would pass a resolve-only guard and then
      // crash-loop server boot instead of failing here where it can be reported and downgraded cleanly.
      // Report the downgrade loudly (A8 boot-error bridge) instead of silently serving plaintext, or
      // bricking boot.
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
        clearEphemeralMarker();
        return;
      }

      if (mode === 'ephemeral') {
        deleteStaleEphemeralDb();
        // The LITERAL string 'ephemeral' — NOT a generated key (Sol P1-1). The embedded server
        // (apps/server/src/embedded.ts) recognizes this exact value and generates + holds its OWN
        // random RAM-only key, which `executeKillSwitch` can then ROTATE in place on a wipe. Never
        // derived from RN's `resolveDbKey('ephemeral')` any more — that no longer returns a key at all
        // for this mode (see db-encryption.ts).
        process.env.LOAM_DB_KEY = 'ephemeral';
        return;
      }

      clearEphemeralMarker();
      // openStore's encryptionKey path takes precedence over LOAM_DB_DRIVER (see db.ts) — leave the
      // driver env unset here. NEVER logged.
      process.env.LOAM_DB_KEY = key;
    })
    .catch(function () {
      // Should be unreachable (requestDbKey never rejects), but keep the fallback total.
      process.env.LOAM_DB_DRIVER = 'better-sqlite3';
    })
    .then(function () {
      try {
        require('./loam-server.js');
        waitForServer(0);
        // Start the mesh courier poll once the server is required. refreshMesh no-ops (404) until an
        // operator enables mesh, so this costs one cheap loopback GET per 30s while off.
        setInterval(refreshMesh, MESH_POLL_MS);
        setTimeout(refreshMesh, 5000);
      } catch (err) {
        console.error('Failed to start the embedded LOAM server', err);
        notify('error', { message: String((err && err.message) || err) });
      }
    });
}

notify('starting');
resolveDbEncryptionAndBoot();
