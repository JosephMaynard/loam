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
const crypto = require('crypto');
const rnBridge = require('rn-bridge');
// The pure "may a key be resolved this boot?" decision, split out so it can be
// unit-tested directly (this file itself can't be — see db-key-gate.js's doc comment).
const { mayResolveDbKeyThisBoot } = require('./db-key-gate');
// The pure three-outcome durable install of the start-fresh marker, split out for the same
// reason (unit-testable with an injected `fs` — see start-fresh-marker.js's doc comment). Distinguishes
// a durable install from a provably-absent write and from an INDETERMINATE post-rename commit, which a
// bare boolean "durable write" result conflates with "nothing was written".
const { installStartFreshMarker } = require('./start-fresh-marker');
// The three-outcome durable config.json write (durable / failed / indeterminate),
// split out for the same unit-testability reason (injected `fs` — see config-write.js's doc comment).
const { durableWriteConfig } = require('./config-write');
const { applyNewNetwork, setupUnfinished } = require('./new-network');
// The `loam-emergency-reset-result` answer, split out so it is testable (see reset-reply.js).
const { resetReply } = require('./reset-reply');
// The pure per-attempt boot-env decision (clear-all-then-set-branch), split out so the
// "every attempt is a FRESH boot configuration — no stale LOAM_DB_KEY leaks across in-process retries" rule
// is unit-testable (see boot-config.js's doc comment).
const { DB_KEY_LOCKED_ERROR, computeDbBootEnv, applyBootEnvTo } = require('./boot-config');

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
// Per-boot HOST TOKEN: proves a caller is THIS host process. The server (a) forces the
// `hostDevice` admin bootstrap while it is set — admin is granted only to whoever presents it via
// `POST /api/admin/claim`, never to "the first session" (the server listens on 0.0.0.0 from boot, but the
// operator's own WebView only reaches it after the readiness probe + bootstrap fetch + client load, so
// under `firstUser` any LAN peer polling `/api/config` could take admin on every fresh-DB boot — every boot
// in ephemeral mode); and (b) requires it on the loopback mesh bridge and the other launcher-only
// `/api/host/*` routes, since on Android loopback is reachable by every installed app. Minted fresh each boot; handed ONLY to the RN host screen (which
// injects it into its own WebView) and attached to this file's own bridge requests. Never logged.
const hostToken = crypto.randomBytes(32).toString('base64url');
process.env.LOAM_HOST_TOKEN = hostToken;

/** Post a status update to the React Native host screen (best-effort; never throws). */
function notify(status, extra) {
  try {
    rnBridge.channel.post('loam-status', Object.assign({ status: status }, extra || {}));
  } catch (err) {
    console.error('Failed to post status to RN host', err);
  }
}

// Boot-notice codes: these mean the server DEGRADED but kept booting (`db_encryption_recovered_fresh`: a
// fresh DB after an unreadable one), never that boot failed. `db_encryption_open_failed` is no longer
// emitted by the server (an encrypted mode whose keyed open fails now locks instead of serving plaintext)
// and stays listed only so it can never be mistaken for a fatal error. The readiness probe below
// (`startReadinessProbe`/`probeServer`) still runs and will post 'ready' once the server actually answers.
// Reported as status 'notice', NOT 'error': the RN host screen must not treat these as fatal, and a notice
// must survive the 'ready' that follows it (see index.tsx's persistent notice state). Any OTHER code
// (e.g. `boot_failed`/`boot_unhandled_rejection` from embedded-main.ts, where the process exits and
// 'ready' can never follow) stays a real 'error'.
//
// `db_encryption_unreadable` is deliberately NOT in this list: the server did NOT keep booting for it —
// `openInitialStore` threw and boot failed. It arrives as a single 'error' with the specific code, the
// runtime stays alive (embedded-main.ts does not exit for this one), and index.tsx shows it as a persistent
// FATAL state with the "Preserve old database & start fresh" action — see index.tsx's DB_UNREADABLE_CODE.
//
// `db_encryption_locked` is ALSO deliberately not in this list: it means a boot found no usable key (or
// could not determine the mode) and REFUSED to start the server at all — never a "degraded but booted"
// case, so it must arrive as a real 'error' too. index.tsx shows its own dedicated fatal block (boot-time
// passphrase-unlock / retry), keyed on this exact code.
//
// `db_encryption_driver_missing` is likewise a real 'error': the SQLCipher driver failed to load under an
// encrypted selection, and the launcher LOCKS instead of booting plaintext.
const DB_ENCRYPTION_NOTICE_CODES = ['db_encryption_open_failed', 'db_encryption_recovered_fresh'];

// embedded-main.ts (bundled into loam-server.js below) does the real startup work asynchronously —
// require('./loam-server.js') returns long before a config-load or server.listen() failure would
// reject, so this file's own try/catch around require() can't see it. It instead calls
// this hook, installed on `global` BEFORE requiring the bundle (same pattern as
// global.__loamOnDeviceChat below), so a failure still reaches the host screen as a real error
// instead of just the generic readiness-poll timeout. Also used directly, below, by this file's own
// DB-encryption lock paths (db_encryption_locked / db_encryption_driver_missing) — same single
// choke point decides notice-vs-fatal for both callers.
global.__loamReportBootError = function (message, code) {
  const isNotice = DB_ENCRYPTION_NOTICE_CODES.indexOf(code) !== -1;
  notify(isNotice ? 'notice' : 'error', { message: message, code: code });
};

// The server's kill switch calls this (`globalThis.__loamRequestWipeRestart`, see
// executeKillSwitchBody in apps/server/src/kill-switch.ts) when a `persistent`/`passphrase`-encrypted node is wiped
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

// The server's `openInitialStore` (apps/server/src/store-lifecycle.ts) calls this
// (`globalThis.__loamReportDbKeyMigrated`) after successfully migrating a passphrase-mode DB to the
// current key derivation — either by opening it directly under the current key (already migrated, or a
// fresh install that never needed the legacy one) or by rekeying it in place from the legacy key. Forward
// it to RN so `db-encryption.ts`'s `registerDbEncryption` can call `markPassphraseKeyMigrated()`, which
// stops future boots from offering the legacy key at all. Best-effort, same pattern as every other
// global.__loam* hook here — installed BEFORE requiring the server bundle. Never carries any key material.
global.__loamReportDbKeyMigrated = function (requestId) {
  try {
    // Carry the id of the key-handoff attempt whose DB open the server just confirmed, so RN promotes the EXACT candidate that attempt used — not a different, overlapping attempt's
    // unverified guess. The server passes the IMMUTABLE per-boot id it captured at buildApp time (from
    // `LOAM_DB_KEY_REQUEST_ID`), NEVER a mutable launcher global. Missing/undefined (a non-passphrase boot)
    // makes the RN side a no-op.
    var id = typeof requestId === 'string' && requestId.length > 0 ? requestId : null;
    rnBridge.channel.post('loam-db-key-migrated', { requestId: id });
  } catch (err) {
    console.error('Failed to post loam-db-key-migrated to the RN host', err);
  }
};

// Interface NAME prefixes that belong to a VPN/tunnel/virtual adapter rather than the real hotspot/LAN:
// an address on one of these is never reachable by a nearby device scanning the join QR, so
// picking one would silently break joining. Mirrors the exclusions in apps/server/src/net.ts's
// `resolveLanIPv4` (`tun`/`utun`/`tailscale`/`wg`/`ppp`), plus a few more that only show up on Android
// (`rmnet` — the cellular radio interfaces; `dummy`/`docker`/`veth` — container/virtual networking some
// ROMs or apps set up). `bridge*` is deliberately kept: some ROMs bridge the hotspot onto `bridge0`
// (docs/25 HW1), and the hotspot-address picker needs to see it. Matched case-insensitively.
const TUNNEL_INTERFACE_PREFIXES = ['tun', 'utun', 'tailscale', 'wg', 'ppp', 'ipsec', 'rmnet', 'dummy', 'docker', 'veth'];

function isTunnelInterfaceName(name) {
  const lower = name.toLowerCase();
  return TUNNEL_INTERFACE_PREFIXES.some(function (prefix) {
    return lower.startsWith(prefix);
  });
}

/**
 * The host's non-internal IPv4 addresses with their interface names, excluding VPN/tunnel/virtual
 * interfaces. The native Share QR (`joinUrl` in apps/app/src/lib/join-url.ts) uses the flat
 * address list for the shared-WiFi / Pi case, so filtering happens here rather than trusting the picker
 * to know which addresses are real. When the LocalOnlyHotspot is running, the QR targets the hotspot's
 * OWN address — Android assigns it at random per start (there is no fixed gateway; 192.168.49.1 is
 * Wi-Fi Direct's) — which the native module discovers (`hotspotAddressCandidates`); this list, with names,
 * is the host screen's second source for that and for its diagnostics line. Re-posted periodically so
 * the shared-WiFi Step-2 QR reflects the real address rather than a guess.
 */
function lanInterfaces() {
  const entries = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    if (isTunnelInterfaceName(name)) {
      continue;
    }
    for (const info of interfaces[name] || []) {
      if (info && info.family === 'IPv4' && !info.internal) {
        // `cidr` is "10.80.217.150/24"; the prefix lets the host screen match a joiner's address to the
        // interface that serves it.
        const prefix = typeof info.cidr === 'string' ? Number(info.cidr.split('/')[1]) : NaN;
        entries.push(
          Number.isInteger(prefix) ? { name: name, address: info.address, prefixLength: prefix } : { name: name, address: info.address },
        );
      }
    }
  }
  return entries;
}

/** Report the current network addresses to the host screen (for the Step-2 join QR + diagnostics).
 * `addresses` is the flat list older host screens read; `interfaces` pairs each with its interface;
 * `clients` is who is connected to the server from OFF this phone (`GET /api/host/clients`, launcher-only)
 * — the share screen's "N phones connected" and its proof of which interface the hotspot is on. `null`
 * when the server couldn't be asked this tick (not yet listening): the screen keeps its last answer.
 * `invite` is the code the join QR carries on an approval-only node (`GET /api/host/invite`). */
function postHostInfo() {
  // Runs from a timer and a bridge listener: nothing here may throw, or the whole embedded runtime goes
  // down with it. An enumeration failure (os.networkInterfaces() can throw on an odd ROM) just reports no
  // addresses this tick — native discovery on the RN side still has its own enumeration.
  let interfaces = [];
  try {
    interfaces = lanInterfaces();
  } catch (err) {
    console.error('Failed to enumerate network interfaces', err);
  }
  const info = {
    port: PORT,
    addresses: interfaces.map(function (entry) {
      return entry.address;
    }),
    interfaces: interfaces,
    clients: null,
    // The invite code for the join QR (`GET /api/host/invite`): a string on an approval-only node, null
    // when there is none (an open node, or the server didn't answer this tick).
    invite: null,
  };
  const post = function () {
    try {
      rnBridge.channel.post('loam-hostinfo', info);
    } catch (postErr) {
      console.error('Failed to post host info', postErr);
    }
  };
  try {
    meshRequest('GET', '/api/host/clients', undefined, function (err, status, json) {
      if (!err && status === 200 && json && Array.isArray(json.clients)) {
        info.clients = json.clients;
      }
      try {
        meshRequest('GET', '/api/host/invite', undefined, function (inviteErr, inviteStatus, inviteJson) {
          if (!inviteErr && inviteStatus === 200 && inviteJson && typeof inviteJson.code === 'string') {
            info.invite = inviteJson.code;
          }
          post();
        });
      } catch (inviteErr) {
        post();
      }
    });
  } catch (err) {
    console.error('Failed to ask the server who is connected', err);
    post();
  }
}

// Answer on-demand requests (the Share overlay asks when it opens) and refresh on an interval so the
// hotspot AP address is picked up whenever the hotspot comes up, without the host screen polling.
rnBridge.channel.on('loam-hostinfo-request', postHostInfo);

// True once 'ready' has actually been announced to the host screen — makes
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
  // `hostToken` rides the in-process bridge to the RN host screen, which injects it into its OWN WebView
  // so the operator's client claims admin under the `hostDevice` bootstrap (see the token's comment).
  notify('ready', { port: PORT, hostToken: hostToken });
  postHostInfo();
  // Refresh addresses so the hotspot AP interface is reported once it appears (the user opens
  // "Share · Host" after boot, which is when the hotspot starts).
  setInterval(postHostInfo, 5000);
}

// The DIRECT signal — embedded-main.ts calls this the instant `server.listen()`
// succeeds, independent of (and not racing) this file's own poll below. Installed on `global` BEFORE
// requiring the server bundle, same pattern as `__loamReportBootError`/`__loamRequestWipeRestart`.
// The poll (`probeServer`/`retry`) gives up after ~5 minutes, so without this a LATER successful boot —
// e.g. the in-process retry after a "Preserve old database & start fresh" confirmation, possibly minutes
// after the original poll gave up — would never tell the host screen it was ready, and the WebView would
// never mount even though the server was healthy.
global.__loamReportBootReady = announceReady;

// A "singleton" generation counter for the readiness poll below — `startReadinessProbe`
// bumps it and starts a FRESH polling chain every time it's called (once per boot attempt: the initial
// boot, and again after every in-process retry — start-fresh recovery or a db-unlock retry), while any
// OLDER chain still ticking away in the background self-cancels on its next tick instead of continuing
// to run alongside the new one. Without this, a retry that starts its own poll while an earlier one
// hasn't given up yet would leave two overlapping polling loops running concurrently.
let readinessPollGeneration = 0;

/** Start a brand-new readiness-poll chain, superseding any still-running older one. */
function startReadinessProbe() {
  readinessPollGeneration += 1;
  probeServer(readinessPollGeneration, 0);
}

/**
 * Poll the embedded server until it answers, then tell the host screen it can load the WebView.
 * The server listens asynchronously after require(), so we can't await it here — polling also
 * confirms the HTTP surface is actually serving before the WebView navigates to it. `generation` ties
 * this chain to the `startReadinessProbe` call that started it (the singleton guard, see above) — a
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
    // An explicit code so index.tsx can tell THIS specific give-up apart from other generic errors and
    // keep an active "Preserve old database & start fresh" recovery state (db_encryption_unreadable) from
    // being clobbered when this timeout fires mid-retry. (This give-up doesn't matter for readiness itself —
    // the direct `__loamReportBootReady` signal above doesn't depend on this poll at all — but it's still
    // useful liveness diagnostics, and a fresh `startReadinessProbe()` call on the next retry supersedes it.)
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
      // The bridge routes require the per-boot host token as well as a loopback peer.
      headers: payload
        ? { 'content-type': 'application/json', 'content-length': payload.length, 'x-loam-host-token': hostToken }
        : { 'x-loam-host-token': hostToken },
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

// Delay from a radio receipt to the outbound refresh it triggers (coalesced: one pending refresh at a time).
const MESH_REFRESH_AFTER_RECEIVE_MS = 2_000;
let meshReceiveRefreshTimer = null;

/** Refresh the outbound cache once, MESH_REFRESH_AFTER_RECEIVE_MS after a blob arrived (whatever became of it). */
function scheduleMeshRefreshAfterReceive() {
  if (meshReceiveRefreshTimer) {
    return;
  }
  meshReceiveRefreshTimer = setTimeout(() => {
    meshReceiveRefreshTimer = null;
    refreshMesh();
  }, MESH_REFRESH_AFTER_RECEIVE_MS);
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
  // Taking mail in may change what we now hold to carry — refresh our outbound + have-mail hint. On a fixed
  // delay from RECEIPT, for every blob alike, and never on the inbound answer (which is outcome-free anyway):
  // re-advertising only when a blob was accepted told the neighbour that pushed it, on a non-relaying node,
  // that it had just been delivered here (docs/16 §9).
  scheduleMeshRefreshAfterReceive();
  meshRequest('POST', '/api/mesh/inbound', { messages: [message] }, () => {});
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

/** Write `next` to config.json DURABLY, returning `'durable' | 'failed' | 'indeterminate'` —
 * the three-outcome contract lives in the injected-`fs`, unit-tested `config-write.js` helper. A
 * bare atomic temp+rename only orders metadata; without the contents/dir fsyncs a power loss can still leave
 * a half-written config.json that strands the operator with a host that refuses to boot. */
function writeConfigFile(next) {
  return durableWriteConfig(fs, dataDir, configPath, JSON.stringify(next, null, 2));
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
    const outcome = writeConfigFile(next);
    if (outcome === 'durable') {
      reply(true);
    } else if (outcome === 'failed') {
      // Definite failure BEFORE the rename — config.json is untouched. Report it so the model-manager
      // conditionally rolls its local change back rather than believing it committed.
      reply(false, 'Could not durably save the model configuration; the previous configuration is unchanged.');
    } else {
      // 'indeterminate': the new config is visible but its survival across power loss is unconfirmed. Do
      // NOT claim durable success (the model-manager would treat it as committed) and do NOT report a plain
      // failure (which would trigger a rollback that could conflict with a write that actually landed).
      // WITHHOLD the ack — the RN bridge's timeout path then treats it as AMBIGUOUS: the durable write-ahead
      // pending stays in place and reconciliation settles it on the next open/restart. See
      // model-manager-actions.ts's `'ambiguous'` handling. (No reply posted.)
    }
  } catch (err) {
    reply(false, String((err && err.message) || err));
  }
});

// ---- On-device DB-encryption key handoff (docs/01, docs/21) ---------------------------------------
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
// treated the same way: those tell us nothing about the operator's actual choice, and silently falling
// through to plaintext would downgrade an encrypted node on a merely transient hiccup. Those cases resolve
// to the `'locked-error'` sentinel mode instead. The caller (`resolveDbEncryptionAndBoot` below, via
// boot-config.js) then boots plaintext only when the last-known mode hint says `off` or the node is
// genuinely fresh (no hint, no DB); otherwise it reports `db_encryption_locked` and refuses to start the
// server AT ALL, exactly like the "persistent/passphrase with no usable key" case. Genuine `{mode:'off'}` (RN successfully read an unset/off selection) is
// still a normal, silent boot — crisis messaging still always works for the actual default case.
const DB_KEY_TIMEOUT_MS = 5000;
const DB_ENCRYPTION_MODES = ['off', 'ephemeral', 'persistent', 'passphrase'];
// RN's own sentinel for "I successfully asked, but the read itself failed" (db-encryption.ts's
// `DB_ENCRYPTION_MODE_READ_ERROR`) — not a real encryption mode, so deliberately excluded from
// `DB_ENCRYPTION_MODES` above.
const DB_MODE_READ_ERROR = 'error';
// This file's own sentinel (never sent over the bridge) for "do not resolve a real mode/key this call —
// treat exactly like db_encryption_locked" — covers RN's read-error reply, a timeout, a malformed/
// unrecognized payload, and a thrown post(). Imported from boot-config.js so both agree (see top of file).

/** Ask the RN host for the DB-encryption mode/key, waiting up to `timeoutMs`. Never rejects — any
 * FAILURE (timeout, malformed/unrecognized payload, a post() throw, or RN's own reported read error)
 * resolves to `{ mode: 'locked-error' }`, which the caller gates on the last-known mode hint rather than
 * silently falling back to plaintext. Only a genuinely successful `{mode:'off'}` reply resolves to `'off'`. */
var dbKeyRequestCounter = 0;
function requestDbKey(timeoutMs) {
  // Correlate each request with its response: a request that TIMED OUT removes its
  // listener, but RN may still answer it late; without a correlation id that late answer would be caught by
  // the NEXT request's freshly-registered listener and satisfy it with stale mode/key state (e.g. a
  // pre-passphrase "locked" answer landing on the post-passphrase unlock retry). RN always echoes the id
  // (same bundle ships both sides), so the match is STRICT: a response whose id is missing or differs is
  // ignored. Accepting an untagged response would let a stale answer through.
  var requestId = 'dbkey-' + (++dbKeyRequestCounter);
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
      var responseId = payload && payload.requestId;
      if (responseId !== requestId) {
        // Not the answer to THIS request (a late/foreign response, or an untagged one) — ignore it and keep
        // waiting for ours. Strict match: RN always echoes the id, so a legitimate answer always matches.
        return;
      }
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
      // Return THIS request's id: the boot that follows threads it into the embedded
      // server as an IMMUTABLE per-boot value, so the migration ack the server later emits carries the id of
      // the attempt that actually opened the DB — never a mutable launcher global a later attempt overwrote.
      // A new network from the setup screens carries its starting configuration; the data folder is emptied
      // and the configuration written before anything below reads the folder (startNewNetwork).
      var newNetwork =
        payload && payload.newNetwork && typeof payload.newNetwork === 'object' && !Array.isArray(payload.newNetwork)
          ? payload.newNetwork
          : undefined;
      finish({ mode: mode, key: key, legacyKey: legacyKey, requestId: requestId, newNetwork: newNetwork });
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
      rnBridge.channel.post('loam-db-key-request', { requestId: requestId });
    } catch (err) {
      finish({ mode: DB_KEY_LOCKED_ERROR });
    }
  });
}

// A plaintext "last-known DB-encryption mode" hint. Records ONLY the
// mode NAME (never key/passphrase material — those never touch disk here at all) whenever a mode is
// SUCCESSFULLY resolved from the RN handoff. Its one job is to make a LATER boot's `requestDbKey` FAILURE
// (`locked-error` — a 5s timeout before the RN screen has even mounted, a transient Keystore hiccup, a
// malformed reply) recoverable in the RIGHT direction: `off`/absent means this node has no secret to
// protect, so a transient failure must NOT block boot — crisis-messaging availability wins, boot
// plaintext. `persistent`/`passphrase`/`ephemeral` means the node genuinely has (had) a secret-based mode,
// so a transient failure must LOCK rather than silently downgrade to plaintext. It is NOT key material and NOT secret — it's the same mode string already sent in the clear
// over the bridge and threaded through LOAM_DB_ENCRYPTION_MODE.
var DB_MODE_HINT_PATH = path.join(dataDir, '.loam-db-mode-hint');

/** Persist the last-known mode NAME. Refuses to write anything that isn't a known mode string, so no
 *  key-shaped value can ever land here even by a caller mistake. Returns true only on a genuine write
 *  success: the `loam-db-set-mode-hint` handler below reports that back so the RN picker can warn when a
 *  transactional hint write failed. The boot-time caller ignores the return.
 *
 *  The write is ATOMIC — write to a temp file then rename over the target — so an
 *  interrupted/partial write can never leave a TRUNCATED hint on disk (which `readDbModeHint` would treat
 *  as a `status:'error'` and LOCK on). rename(2) is atomic on the same filesystem.
 *
 *  Durability: atomic is not power-loss durable. RN commits an encrypted SecureStore mode only
 *  AFTER this returns `true`; a crash before the bytes + directory entry reach stable storage could restore
 *  the old `off`/absent hint and permit a later PLAINTEXT boot under a now-encrypted node. So fsync the
 *  staged file, rename it, then fsync `dataDir` — and only report success once all three have completed. */
function writeDbModeHint(mode) {
  if (DB_ENCRYPTION_MODES.indexOf(mode) === -1) {
    return false;
  }
  var tmpPath = DB_MODE_HINT_PATH + '.tmp';
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(tmpPath, mode, 'utf8');
    var fd = fs.openSync(tmpPath, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, DB_MODE_HINT_PATH);
    if (!fsyncDir(dataDir)) {
      // The rename landed but the directory entry isn't provably durable — a power loss could still lose it.
      // Report failure so the caller (the picker's transactional hint write) doesn't treat the hint as safely
      // persisted; the mode itself is still applied, and a later successful write reconciles the hint.
      return false;
    }
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
 * Read the last-known mode NAME as a TRI-STATE result — MIRROR of
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

/**
 * A new network from the setup screens (new-network.js `applyNewNetwork`): empty the data folder, durably
 * write the chosen configuration, record the operation, and acknowledge it so RN stops resending it. RN
 * sends it only after the person confirmed erasing any previous network, and has already cleared that
 * network's stored keys. Returns false when it couldn't be applied: the caller stays locked (Retry resends
 * it), because booting anyway would start the network under defaults (open admission, optional
 * encryption) rather than what the person chose.
 */
function startNewNetwork(operation) {
  var outcome = applyNewNetwork(fs, path, dataDir, operation);
  console.warn('LOAM-SETUP: new network ' + outcome);
  if (outcome === 'failed') {
    return false;
  }
  try {
    rnBridge.channel.post('loam-new-network-applied', { id: operation.id });
  } catch (postErr) {
    // RN resends it with the next key response; the applied record makes that a no-op.
  }
  return true;
}

// Whether an on-disk DB file exists — the fail-closed input to the locked-error plaintext decision
// (boot-config.js). `existsSync` throwing (unexpected) errs on the SAFE side: assume a DB may be
// present, so a locked-error with an absent hint LOCKS rather than downgrades.
function dbFileExists() {
  try {
    return fs.existsSync(path.join(dataDir, 'loam.db'));
  } catch (err) {
    return true;
  }
}

// Write the mode-NAME hint TRANSACTIONALLY with a mode SELECTION, on request from the
// RN picker (db-encryption.ts's `setDbModeHint`), rather than only when a mode is successfully RESOLVED
// at boot. Otherwise an off→encrypted selection would leave the stale `off` hint (or, on a fresh encrypted
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

// A marker file recording that the LAST boot ran in ephemeral mode. `deleteStaleEphemeralDb`
// below always deletes the DB when mode is 'ephemeral' — that's ephemeral's whole design, wipe-on-
// restart — but the marker lets it tell that EXPECTED case apart from an operator having just switched
// INTO ephemeral from a mode with real data (persistent/passphrase/off), where the same deletion is
// actually a silent, unrecoverable data loss the RN picker's confirmation dialog is meant to have
// already warned about. Here it only decides a warning (best-effort, never blocks boot). The server reads
// the same marker (`prepareEphemeralDataDir` in apps/server/src/store-lifecycle.ts), which is why the
// launcher writes it before booting an ephemeral server and clears it under every other mode.
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

// ---- "Preserve old database & start fresh" operator confirmation ------------------------------------
// When boot fails with `db_encryption_unreadable` (an existing encrypted DB the current key can't
// open), the RN error screen offers an explicit "Preserve old database & start fresh" action rather
// than the server silently doing that itself. This marker is the confirmation: the RN UI asks THIS
// process (over the bridge — same reason as the DB-key handoff above, this process owns `dataDir`) to
// write it; the server consumes-and-deletes it on its next boot attempt (the in-process retry the
// `loam-db-start-fresh` listener below drives, or the next app restart when the server is already
// running) as proof a human actually chose this, not an automatic behaviour.
var START_FRESH_MARKER_PATH = path.join(dataDir, '.loam-db-start-fresh');

// fsync a directory so a create/rename/unlink INSIDE it is durable across power-loss (the directory entry,
// not just a file's bytes, must be flushed). Returns whether the fsync succeeded. Mirrors the server's
// `fsyncDir` (apps/server/src/store-lifecycle.ts). Some filesystems reject directory fsync; the wipe/marker callers here
// choose correctness over availability on those platforms and fail closed on false.
function fsyncDir(dir) {
  try {
    var dirFd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
    return true;
  } catch (err) {
    return false;
  }
}

// True while a reboot THIS listener triggered is still running. `bootEmbeddedServer` itself is
// re-entrant-safe (embedded-main.ts joins a concurrent call rather than racing a second `listen()`), but
// debouncing here too means a double-tap of the button doesn't even re-write the marker or post a second
// `loam-db-start-fresh-result` — belt-and-suspenders against two overlapping boots racing `EADDRINUSE`
// into `process.exit(1)` and killing the recovered server.
var startFreshRebootInFlight = false;

// A "Link a node" code for the share screen (server sync-links.ts, `POST /api/host/link-code`): the host
// phone shows it so another LOAM phone can link to this network. Launcher-only, like the other host routes.
rnBridge.channel.on('loam-link-code', function (payload) {
  var requestId = payload && payload.requestId;
  function reply(result) {
    try {
      rnBridge.channel.post('loam-link-code-result', Object.assign({ requestId: requestId }, result));
    } catch (postErr) {
      // RN side isn't listening; nothing more to do.
    }
  }
  try {
    meshRequest('POST', '/api/host/link-code', undefined, function (err, status, json) {
      if (!err && status === 200 && json && typeof json.code === 'string' && typeof json.expiresAt === 'number') {
        reply({ ok: true, code: json.code, expiresAt: json.expiresAt });
      } else {
        reply({ ok: false, error: err ? err.message : 'The host answered ' + status });
      }
    });
  } catch (err) {
    reply({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});

// Emergency Reset from the host menu (index.tsx). The server installs `global.__loamEmergencyReset` once it
// has booted (embedded-main.ts); it runs the same wipe as the admin kill switch, in-process, so there's no
// HTTP request, no session and nothing on the network involved. Encrypted fixed-key modes then hand back
// to the launcher for the key-clear restart through the existing `loam-wipe-restart` protocol. The answer
// (`resetReply`) also says whether an incomplete wipe was journaled, which decides what the host screen tells
// the operator: reopen to finish, or reopen and run the reset again.
rnBridge.channel.on('loam-emergency-reset', function (payload) {
  var requestId = payload && payload.requestId;
  function reply(result) {
    try {
      rnBridge.channel.post('loam-emergency-reset-result', Object.assign({ requestId: requestId }, result));
    } catch (postErr) {
      // RN side isn't listening; nothing more to do.
    }
  }
  var reset = global.__loamEmergencyReset;
  if (typeof reset !== 'function') {
    reply({ ok: false, error: 'The host is not running yet, so there is nothing to reset.' });
    return;
  }
  Promise.resolve()
    .then(function () {
      return reset();
    })
    .then(
      function (result) {
        reply(resetReply(result));
      },
      function (err) {
        reply({ ok: false, error: err && err.message ? err.message : String(err) });
      },
    );
});

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

  // Record the operator's INTENT in the marker. 'delete' = a deliberate destructive
  // mode change (Settings "Delete & start fresh") → the server DELETES + proves the old DB gone; anything
  // else = accidental-lockout recovery → the server renames the old ciphertext aside. Default 'preserve'
  // (never escalate to destruction on a missing/odd intent).
  var intent = payload && payload.intent === 'delete' ? 'delete' : 'preserve';

  // Install the marker DURABLY (fd + fsync + atomic rename + parent-dir fsync) and only ack
  // ok:true AFTER it is on stable storage. When this is requested from the ALREADY-running Settings
  // screen the in-process reboot below is a no-op (the server is already up), so the marker must survive
  // until the NEXT real app restart; a non-durable write that a power-loss then discarded would report a
  // false "scheduled" success and force the operator to repeat the destructive confirmation.
  //
  // `installStartFreshMarker` is a TOTAL three-outcome function that also prepares the directory itself and
  // proves marker absence on every failure path: a durable install, a PROVABLY-absent
  // write (safe to call unscheduled), or an INDETERMINATE commit (a post-rename fsync failure could leave a
  // live marker that a later restart consumes destructively). We do NOT wrap it in a catch that manufactures
  // 'not-installed' — that would let a directory-prep failure claim "nothing was written" without proof.
  var outcome;
  try {
    outcome = installStartFreshMarker({
      fs: fs,
      markerPath: START_FRESH_MARKER_PATH,
      tmpPath: START_FRESH_MARKER_PATH + '.tmp-' + process.pid + '-' + Date.now(),
      dir: path.dirname(START_FRESH_MARKER_PATH),
      contents: intent,
    });
  } catch (err) {
    // The helper is total and should not throw. If it somehow does, default to the SAFE outcome —
    // 'indeterminate', NEVER 'not-installed': we cannot claim absence without proving it.
    outcome = 'indeterminate';
  }

  if (outcome !== 'durable') {
    // Convey the indeterminate case through the `error` STRING only, so the RN caller needs no new field
    // (the bridge result stays `{ ok, error }`). 'not-installed' is provably absent → safe to retry;
    // 'indeterminate' must NOT claim the reset was cancelled/unscheduled.
    var error =
      outcome === 'indeterminate'
        ? 'The reset could NOT be confirmed and MAY still take effect on the next app restart: do NOT ' +
          'assume it was cancelled. Restart the app to let it complete, or check the database state before retrying.'
        : 'The reset was not scheduled: nothing was written to disk. It is safe to try again.';
    try {
      rnBridge.channel.post('loam-db-start-fresh-result', {
        requestId: requestId,
        ok: false,
        error: error,
      });
    } catch (postErr) {
      // RN side isn't listening — nothing more to do.
    }
    return;
  }

  try {
    rnBridge.channel.post('loam-db-start-fresh-result', { requestId: requestId, ok: true });
  } catch (postErr) {
    // RN side isn't listening for the ack — still proceed with the in-process reboot below; the operator
    // will see the recovered server's outcome via the next `loam-status` regardless.
  }

  // Re-attempt boot right here, in the SAME still-alive process. The marker is now on disk, so this time
  // `openInitialStore` (apps/server/src/store-lifecycle.ts) will see it, consume it, and recover instead of
  // throwing again. This only works because embedded-main.ts does not `process.exit()` on a
  // `db_encryption_unreadable` failure — the runtime (and this very listener) stays alive specifically so
  // it can receive this event and drive the retry.
  // Re-run the WHOLE key-resolution-and-boot pipeline, exactly like the `loam-db-unlock` retry below —
  // never the bare boot hook. The failed attempt's `LOAM_DB_KEY` is still installed in
  // `process.env`, and in passphrase mode it was derived from an entry that has since been CONSUMED and is
  // stored nowhere: booting straight into the start-fresh marker would create the fresh database under a
  // key nobody can reproduce (a mistyped passphrase the operator never sees again). Going through
  // `bootWithWipeResume` → `resolveDbEncryptionAndBoot` asks RN for the key again — in passphrase mode that
  // means the locked prompt, so the fresh database is keyed by a passphrase the operator knowingly types —
  // and keeps the wipe-phase gate in the loop. `resolveDbEncryptionAndBoot` re-requires the (cached)
  // server bundle and drives the SAME re-entrant `__loamBootEmbeddedServer` hook underneath.
  startFreshRebootInFlight = true;
  bootWithWipeResume().then(
    function () {
      startFreshRebootInFlight = false;
      // Start a FRESH readiness-probe chain for this retry — the original poll
      // (from the very first boot attempt) may already have given up (~5 minutes) long before the
      // operator got around to confirming "Preserve old database & start fresh", and it never
      // restarts itself. Without this, a successful recovery here would never tell the host screen
      // it's ready (embedded-main.ts's direct `__loamReportBootReady` signal covers the SAME case
      // from the server side too — this is belt-and-suspenders on the client-poll side).
      startReadinessProbe();
    },
    function (err) {
      startFreshRebootInFlight = false;
      console.error('Retry boot after start-fresh confirmation failed', err);
    },
  );
});

// ---- `db_encryption_locked` unlock retry ---------------------------------------------------------------
// Mirrors the "Preserve old database & start fresh" listener above, but for the OTHER recoverable boot
// state: `persistent`/`passphrase` mode found no usable key and `resolveDbEncryptionAndBoot` returned
// without ever requiring the server bundle at all (see its 'locked' outcome) — so there is no running
// server/listener to "reboot" here, just the whole key-resolution pipeline to re-run from scratch. RN
// (index.tsx) posts this after the operator has done something that might now produce a key: for
// passphrase mode, having just called `setPassphraseCandidate`; for persistent mode, as a plain manual
// retry (e.g. after a transient Keystore hiccup).
//
// This MUST go through `bootWithWipeResume()`, never call `resolveDbEncryptionAndBoot()` directly — a
// direct call would bypass the wipe-phase check entirely, so a Retry/Unlock tap could resolve a key (and
// boot) while an earlier wipe's Keystore key-clear was still unconfirmed, opening the fresh post-wipe
// database under the very secret the wipe was meant to destroy. `bootWithWipeResume` re-checks the phase
// file on every call (see its doc comment) and
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

// ---- Wipe-restart handoff: durable PHASE resume ---------------------------------------------------------
// A durable phase (rather than a bare "wipe pending" marker) keeps "deletion still pending" apart from "safe
// to clear the key". SHARED CONTRACT with the server (`executeKillSwitchBody` in
// apps/server/src/kill-switch.ts and the wipe journal in store-lifecycle.ts — update both sides together): a
// durable `.loam-wipe-phase` file whose phase is one of two values:
//   - `delete-pending`  → a fixed-key wipe STARTED but its artifacts are NOT yet PROVEN gone. The launcher
//                         must NOT clear the device key. It DEFERS to the server's boot-time retry: boot the
//                         server under the OLD key (`resolveDbEncryptionAndBoot`), and the server re-runs
//                         artifact deletion before serving (advancing the phase itself, and signaling the
//                         wipe-restart hook once the deletion is verified).
//   - `key-clear-ready` → every artifact + media path is PROVEN absent; the ONLY remaining step is clearing
//                         the device key. ONLY here does the launcher do the key-clear + `loam-wipe-complete`
//                         dance, then DELETE the phase file.
// Route on the PHASE, never on mere presence.
var WIPE_PHASE_MARKER_PATH = path.join(dataDir, '.loam-wipe-phase');
// The legacy single marker an older build wrote. A fail-closed wipe under that build could leave THIS on
// disk alongside a deletion survivor while 503-locked; if the device upgraded before reopening, the launcher
// must still recognise it as an unfinished wipe rather than forgetting it. Both names are cleared together
// only once the whole wipe protocol completes.
var LEGACY_WIPE_PENDING_MARKER_PATH = path.join(dataDir, '.loam-wipe-pending');

// Read the durable wipe phase. Confirmed ENOENT → undefined (no wipe pending). A recognized value → that
// phase. ANY other state (unreadable, or malformed/truncated/unrecognized contents) → 'delete-pending':
// an ambiguous-but-present phase file means a wipe WAS in progress, so err toward the server's deletion
// retry rather than forgetting the wipe / clearing the key prematurely. MIRRORS `readWipeJournal` in
// apps/server/src/store-lifecycle.ts.
function readWipePhase() {
  var raw;
  try {
    raw = fs.readFileSync(WIPE_PHASE_MARKER_PATH, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // No phase file — but a legacy `.loam-wipe-pending` marker may still record an unfinished
      // wipe. If present (or unreadable), treat it as 'delete-pending' so the launcher DEFERS to the
      // server's deletion retry (NEVER 'key-clear-ready' — the old marker cannot prove deletion completed,
      // so it must be re-run first). The server migrates it forward to `.loam-wipe-phase`.
      try {
        fs.lstatSync(LEGACY_WIPE_PENDING_MARKER_PATH);
        return 'delete-pending'; // legacy marker present → a wipe was pending
      } catch (legacyErr) {
        if (legacyErr && legacyErr.code === 'ENOENT') {
          return undefined; // no wipe under EITHER name — a normal boot
        }
        return 'delete-pending'; // unverifiable legacy marker → fail-safe to the deletion retry
      }
    }
    return 'delete-pending';
  }
  // JSON journal format: `{ phase, config? }`. The launcher only needs the PHASE string (it ignores the
  // config snapshot — that is the server's to restore).
  try {
    var parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed.phase === 'key-clear-ready' ? 'key-clear-ready' : 'delete-pending';
    }
  } catch (parseErr) {
    // Not JSON — fall through to the legacy plain-string format below.
  }
  var trimmed = String(raw).trim();
  if (trimmed === 'key-clear-ready') {
    return 'key-clear-ready';
  }
  // 'delete-pending', or anything malformed/truncated/unrecognized → fail-safe to the deletion retry.
  return 'delete-pending';
}

// Delete the wipe-phase file AND VERIFY it's actually gone, returning real success/failure. If unlink
// failures were swallowed, `proceed()` (below) would boot and mint a BRAND-NEW device secret while the phase
// file silently lingered — and the NEXT boot's key-clear-ready resume would then re-clear THAT fresh secret,
// leaving the new database unreadable. A verified return lets `proceed()` refuse to mint a new secret unless
// the phase file is provably gone. ENOENT (already absent)
// counts as success; any other unlink error, or the file still being present/unverifiable afterward, fails.
function clearWipePhase() {
  // Remove BOTH the phase file AND any migrated-from legacy `.loam-wipe-pending` marker: a
  // lingering legacy name would make the NEXT boot re-recognise a pending wipe and re-wipe the fresh DB in a
  // loop. Both must be proven gone (lstat, ENOENT-only) for a clean completion.
  var paths = [WIPE_PHASE_MARKER_PATH, LEGACY_WIPE_PENDING_MARKER_PATH];
  for (var i = 0; i < paths.length; i++) {
    var p = paths[i];
    try {
      fs.unlinkSync(p);
    } catch (err) {
      if (!(err && err.code === 'ENOENT')) {
        return false; // a real delete failure — the file may still be on disk
      }
    }
    // Verify absence with lstatSync, not existsSync: existsSync returns false for MANY stat errors (EACCES,
    // EIO, ...), conflating "confirmed gone" with "could-not-determine" — so a permission/IO fault on the
    // marker path would be misreported as a clean removal. Only ENOENT is proof of absence. Mirrors the
    // server's `provenAbsence` (apps/server/src/store-lifecycle.ts).
    try {
      fs.lstatSync(p);
      return false; // still present after a "successful" unlink (e.g. reappeared) — not a clean removal
    } catch (err2) {
      if (!(err2 && err2.code === 'ENOENT')) {
        return false; // unverifiable stat error → must stay locked
      }
    }
  }
  // fsync the parent DIRECTORY so the unlinks are durable BEFORE `proceed()` mints a new device secret /
  // opens a fresh DB: otherwise a power-loss after the unlink but before it reaches
  // stable storage can RESURRECT the phase file as 'key-clear-ready', and the next boot would clear the
  // freshly minted key and strand the new database. A parent-dir fsync failure → NOT-cleared (fail closed).
  return fsyncDir(dataDir);
}

// The ONLY standalone place the phase file is ever deleted — never speculatively. `loam-wipe-
// complete` means RN VERIFIED the device key is gone, which only ever follows a `key-clear-ready` handoff
// (the live kill switch's, or a resume's) — so at this point the phase file has served its purpose and is
// safe to delete. This covers the LIVE path (a kill-switch wipe while the server is already running); the
// resume path's `proceed()` does its own verified clear-and-decide. A failure here is not fatal on
// the live path: the phase file simply persists, and the NEXT boot's key-clear-ready resume re-drives the
// clear and retries the delete.
rnBridge.channel.on('loam-wipe-complete', function () {
  clearWipePhase();
});

// NOTE: the wipe-restart re-post is intentionally NOT fired here as a bare,
// unsequenced signal. On a resumed-wipe boot the device secret MUST be cleared BEFORE any DB key is
// resolved for this boot — otherwise resolveDbKey races the clear on the same SecureStore item and can
// encrypt the fresh DB under the very secret we're destroying (or brick it). The re-post + the
// wait-for-clear-before-boot are handled together in `bootWithWipeResume()` at the bottom of this file.
var WIPE_RESUME_TIMEOUT_MS = 20000;

/** Best-effort delete of a previous encrypted DB's files. Only called for 'ephemeral' mode, where a
 * fresh random key is generated every launch, so a DB encrypted under a PREVIOUS launch's key can never
 * be opened again — leaving the stale files behind would only stop the server's boot instead of starting
 * clean. ENOENT (nothing to delete on a fresh
 * install, or when the DB was never encrypted) and any other error are both swallowed: failing to
 * delete a stale file must never block boot. Logs (never blocks on) the "this deletion wasn't expected"
 * case per the marker comment above, then marks THIS boot as ephemeral for the next one. */
function deleteStaleEphemeralDb() {
  if (!hasEphemeralMarker()) {
    console.warn(
      'Booting in ephemeral DB-encryption mode, but the previous boot was not marked ephemeral: ' +
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
  // Uploaded media lives OUTSIDE the database as plaintext files (avatars/, attachments/) — with the DB
  // gone every one of them is an orphan, and "nothing survives a reboot" must hold for them too. The
  // server's boot sweeps (and its own `prepareEphemeralDataDir`) are the backstop; this is the direct
  // guarantee.
  ['avatars', 'attachments'].forEach(function (name) {
    try {
      fs.rmSync(path.join(dataDir, name), { recursive: true, force: true });
    } catch (err) {
      console.warn('Failed to remove stale ephemeral media dir ' + name, err);
    }
  });
  writeEphemeralMarker();
}

// The mesh-courier poll must only ever be armed ONCE per process — `resolveDbEncryptionAndBoot`
// can run more than once (a `db_encryption_locked` unlock retry, see `loam-db-unlock` below), and a
// second `setInterval(refreshMesh, ...)` would stack a redundant concurrent poll rather than replacing
// the first.
let meshPollArmed = false;

/** Reset EVERY per-attempt boot env var (so nothing from a prior attempt leaks in), then set only the ones
 * this attempt selected — the shared `applyBootEnvTo` in boot-config.js is the single
 * production implementation (unit-tested), applied here to the real `process.env`. */
function applyBootEnv(values) {
  applyBootEnvTo(process.env, values);
}

/** Whether the SQLCipher native module actually LOADS (not just resolves) in this build — injected into
 * `computeDbBootEnv` so the fail-closed driver-missing lock decision stays pure/testable. Re-probed on every
 * attempt (a failed native `require` isn't cached), so an unlock Retry really re-tries the load. */
function probeEncryptedDriver() {
  try {
    // `require` alone only loads the JS wrapper — the .node addon is dlopen'd lazily by the first
    // `new Database()`. Open (and close) a throwaway in-memory DB so a missing / wrong-ABI binary is caught
    // HERE, as a clean locked state, rather than as a confusing open failure deep in the server's boot.
    var Database = require('better-sqlite3-multiple-ciphers');
    var probe = new Database(':memory:');
    probe.close();
    return true;
  } catch (err) {
    // Do NOT swallow this silently: a failed load is why an operator-selected encrypted mode is LOCKED
    // (`db_encryption_driver_missing`), and without the error there is no way to tell WHY on-device (a
    // missing .node, a wrong-ABI/arch prebuild, a bad OpenSSL/libc link, a resolution failure...). Log it
    // loudly to logcat so `adb logcat | grep LOAM-DB` surfaces the real cause. (better-sqlite3-multiple-
    // ciphers is the SELF-BUILT vendored ABI-108 arm64 prebuild — the plain driver is digidem's
    // device-proven prebuild, also vendored, so this one is the less-proven on-device path.)
    console.warn(
      'LOAM-DB: SQLCipher driver (better-sqlite3-multiple-ciphers) failed to load; encrypted modes will ' +
        'stay LOCKED (no plaintext fallback). Error: ' +
        (err && err.message ? err.message : String(err)) +
        (err && err.stack ? '\n' + String(err.stack).split('\n').slice(0, 4).join('\n') : ''),
    );
    return false;
  }
}

/**
 * Resolve process.env.LOAM_DB_KEY from the RN key handoff, then require + start the embedded server —
 * OR, when the attempt locks (e.g. `persistent`/`passphrase` with no usable key, which must never fall
 * back to a plaintext boot), do neither. Returns a promise resolving once this attempt is fully settled
 * (the embedded server's boot settled, OR left locked) so callers — always via `bootWithWipeResume()` —
 * can tell when it's safe to retry again. Never rejects.
 */
function resolveDbEncryptionAndBoot() {
  return requestDbKey(DB_KEY_TIMEOUT_MS)
    .then(function (result) {
      // Every attempt is a FRESH boot configuration: decide the env purely, DELETE
      // every per-attempt boot var, then apply ONLY this attempt's — so a stale LOAM_DB_KEY / migrate-from /
      // request-id from an earlier (e.g. encrypted) attempt can never leak into an off/locked/downgrade retry
      // in the SAME process (db.ts gives encryptionKey precedence over the plaintext driver, so a leaked key
      // would silently keep an "off" retry on SQLCipher, mis-report posture, and mislead the mode hint).
      if (result && result.newNetwork && !startNewNetwork(result.newNetwork)) {
        applyBootEnv({});
        global.__loamReportBootError(
          "Couldn't set up the new network's storage on this phone: refusing to start it with default settings. Retry.",
          'db_encryption_locked',
        );
        return 'locked';
      }
      // A setup that erased the previous network but never finished (and this response didn't bring the
      // operation back, e.g. a key-request timeout): the folder is neither the old network nor the new one.
      // Booting it could start unencrypted under defaults; stay locked until Retry resends the operation.
      if (setupUnfinished(fs, path, dataDir)) {
        applyBootEnv({});
        global.__loamReportBootError(
          "Setting up the new network didn't finish: refusing to start it with default settings. Retry.",
          'db_encryption_locked',
        );
        return 'locked';
      }
      var cfg = computeDbBootEnv(result, {
        hint: readDbModeHint(),
        dbExists: dbFileExists(),
        probeEncryptedDriver: probeEncryptedDriver,
      });
      applyBootEnv(cfg.env);
      // Boot-decision summary to logcat (`adb logcat | grep LOAM-DB`): the mode RN asked for vs the mode we
      // actually booted, so a silent encrypted->plaintext downgrade is diagnosable on-device. `outcome` +
      // `bootError.code` say WHICH branch fired (unavailable driver / locked / off / proceed).
      console.warn(
        'LOAM-DB: boot decision requestedMode=' +
          ((result && result.mode) || 'unknown') +
          ' effectiveMode=' +
          (cfg.env && cfg.env.LOAM_DB_ENCRYPTION_MODE ? cfg.env.LOAM_DB_ENCRYPTION_MODE : 'off') +
          ' outcome=' +
          (cfg.outcome || 'proceed') +
          (cfg.bootError && cfg.bootError.code ? ' bootError=' + cfg.bootError.code : ''),
      );
      if (cfg.deleteStaleEphemeralDb) {
        deleteStaleEphemeralDb();
      }
      if (cfg.clearEphemeralMarker) {
        clearEphemeralMarker();
      }
      if (cfg.writeHint) {
        writeDbModeHint(cfg.writeHint);
      }
      if (cfg.bootError) {
        global.__loamReportBootError(cfg.bootError.message, cfg.bootError.code);
      }
      return cfg.outcome;
    })
    .catch(function (err) {
      // FAIL CLOSED: an unexpected error must NOT proceed under whatever key a prior
      // attempt happened to leave installed. Clear EVERY boot var and lock; the operator retries.
      applyBootEnv({});
      console.error('Unexpected error resolving DB encryption for boot', err);
      global.__loamReportBootError(
        'An unexpected error occurred while preparing on-device encryption: refusing to start. Retry once the app is responsive.',
        'db_encryption_locked',
      );
      return 'locked';
    })
    .then(function (outcome) {
      if (outcome === 'locked') {
        // Stay locked: do NOT require the server bundle (no plaintext fallback) and do NOT start the readiness probe, since there is no server to
        // probe. `global.__loamReportBootError` above already told the host screen; the
        // `loam-db-unlock` listener re-invokes this whole function once the operator retries.
        return;
      }
      try {
        require('./loam-server.js');
        // A FRESH readiness-probe chain for every attempt that gets this far — including a retry after a
        // `db_encryption_locked` unlock, like the `loam-db-start-fresh` retry above. Superseded automatically if this isn't the latest call
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
        // JOIN the embedded server's REAL boot promise so this — and therefore
        // `bootInFlight`/`dbUnlockRetryInFlight` — stays in flight until the DB open/listen has actually
        // SETTLED, not merely until the synchronous `require` returns. Without this the single-flight guard
        // clears while `buildApp`/`openInitialStore` are still async, so a duplicate/later unlock could
        // accept another attempt and overwrite the boot's `LOAM_DB_KEY_REQUEST_ID` before the first open
        // finishes. `__loamBootEmbeddedServer` is re-entrant-safe (see embedded-main.ts): the module-scope boot fired
        // on first require, so this returns that same in-flight promise (and drives a fresh boot on a cached
        // retry). It never rejects (its own boot errors are reported + swallowed inside).
        var bootHook = global.__loamBootEmbeddedServer;
        if (typeof bootHook === 'function') {
          return bootHook();
        }
      } catch (err) {
        console.error('Failed to start the embedded LOAM server', err);
        notify('error', { message: String((err && err.message) || err) });
      }
    });
}

notify('starting');

// Route on the durable wipe PHASE, not mere marker presence.
//   - phase `undefined`      → no wipe pending → resolve a key + boot normally.
//   - phase `delete-pending` → an earlier fixed-key wipe never PROVED its artifacts gone. DEFER to the
//                              server's boot-time retry: resolve a key + boot the server, which re-runs artifact
//                              deletion before serving (persistent: RN still holds the device secret — we do NOT
//                              clear it here; passphrase: the operator is asked for the passphrase first, since
//                              the device never keeps it — the resume then continues once they enter it) and,
//                              once verified, signals the wipe-restart hook itself. So this is still a normal
//                              `resolveDbEncryptionAndBoot()` call — the server does the rest.
//   - phase `key-clear-ready`→ artifacts are PROVEN gone; the ONLY step left is clearing the device key.
//                              Do the wipe-restart dance: re-post `loam-wipe-restart`, wait for
//                              `loam-wipe-complete` (RN VERIFIED the key is gone), delete the phase file,
//                              and ONLY THEN resolve a NEW key + boot. On timeout we do NOT boot under the
//                              un-cleared key — surface a locked state; reopening retries (the phase file
//                              persists).
//
// The `mayResolveDbKeyThisBoot(keyClearPending)` gate (db-key-gate.js) blocks the fast path ONLY for
// `key-clear-ready`; `delete-pending`/`undefined` both resolve a key and boot. This is the ONE SINGLE CHOKE
// POINT allowed to call `resolveDbEncryptionAndBoot()` — EVERY boot/unlock entry point routes through it.
//
// Always returns a Promise that resolves once THIS call's outcome is settled (key resolved & boot
// attempted, OR still locked pending the resume) — never rejects. A wait-for-resume in progress is a
// SINGLETON (`wipeResumeWait`): a second caller (e.g. `loam-db-unlock` firing while the initial boot's
// own resume wait is still pending) joins the SAME wait rather than registering a second overlapping
// `loam-wipe-complete` listener/timer.
var wipeResumeWait;
// A single-flight guard for the NO-resume fast path below. The resume path is already a singleton via
// `wipeResumeWait`; without this guard on the direct `resolveDbEncryptionAndBoot()` call, two concurrent
// callers (the initial boot at the bottom of
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

  var phase = readWipePhase();

  // `undefined` (no wipe) and `delete-pending` (defer to the server's boot-time deletion retry under the
  // OLD key) both resolve a key + boot; only `key-clear-ready` blocks to do the device-key-clear dance.
  if (mayResolveDbKeyThisBoot(phase === 'key-clear-ready')) {
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
      // RN only posts `loam-wipe-complete` after `clearStoredDbKeys` VERIFIED the
      // device secret is gone — but we must ALSO confirm OUR OWN wipe-phase file is actually deleted before
      // booting. If the delete failed, booting now would mint a fresh device secret while the phase file
      // lingers, and the NEXT boot's key-clear-ready resume would clear THAT fresh secret and brick the new
      // DB. So on a cleanup failure, do NOT resolve a key / mint a secret: leave the phase file in place and
      // surface a distinct "reopen to finish" state. Reopening re-drives the resume — RN re-clears the
      // already-gone key idempotently (destroying no fresh secret, because we never minted one) and the
      // phase-file delete is retried — so recovery completes without data loss.
      if (clearWipePhase() !== true) {
        notify('error', {
          message:
            'The security reset cleared the encryption key, but a cleanup step is still pending: reopen ' +
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
      // The clear didn't complete in time — do NOT boot under the un-destroyed key. The phase file persists,
      // so reopening the app re-attempts; a later `loam-wipe-complete` (if it eventually arrives after
      // this timeout) is picked up by the NEXT call to this function, since `wipeResumeWait` is cleared
      // in the `finally` below.
      notify('error', {
        message:
          'A security reset is still finishing on this device: reopen the app to complete it. The database was not reopened.',
        code: 'db_encryption_locked',
      });
      resolve('locked');
    }, WIPE_RESUME_TIMEOUT_MS);

    // `proceed` also runs once the phase-file-delete handler above has cleared the file on the SAME event.
    rnBridge.channel.on('loam-wipe-complete', proceed);
    try {
      rnBridge.channel.post('loam-wipe-restart');
    } catch (err) {
      proceeded = true;
      clearTimeout(timer);
      rnBridge.channel.removeListener('loam-wipe-complete', proceed);
      console.error('Failed to post loam-wipe-restart for a resumed wipe handoff', err);
      notify('error', {
        message: 'A security reset could not be completed on this device: reopen the app to retry.',
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
