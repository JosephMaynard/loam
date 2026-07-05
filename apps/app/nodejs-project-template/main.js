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
  const request = http.get(
    { host: '127.0.0.1', port: PORT, path: '/api/config', timeout: 2000 },
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

notify('starting');

try {
  require('./loam-server.js');
  waitForServer(0);
} catch (err) {
  console.error('Failed to start the embedded LOAM server', err);
  notify('error', { message: String((err && err.message) || err) });
}
