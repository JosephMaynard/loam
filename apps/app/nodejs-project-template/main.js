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

/**
 * The host's non-internal IPv4 addresses. The hotspot's AP interface (192.168.49.1 on stock Android
 * LocalOnlyHotspot, but not guaranteed) only appears once the hotspot is up, so we re-post these
 * periodically — the host UI builds the Step-2 join QR from the real address rather than a guess.
 */
function lanAddresses() {
  const addresses = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
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
const fs = require('fs');
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

notify('starting');

try {
  require('./loam-server.js');
  waitForServer(0);
  // Start the mesh courier poll once the server is required. refreshMesh no-ops (404) until an operator
  // enables mesh, so this costs one cheap loopback GET per 30s while off.
  setInterval(refreshMesh, MESH_POLL_MS);
  setTimeout(refreshMesh, 5000);
} catch (err) {
  console.error('Failed to start the embedded LOAM server', err);
  notify('error', { message: String((err && err.message) || err) });
}
