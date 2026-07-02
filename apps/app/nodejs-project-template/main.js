'use strict';

// nodejs-mobile launcher for the embedded LOAM server (docs/04). nodejs-mobile copies the whole
// nodejs-project into an app-writable dir and runs this CJS file on the embedded Node 18 runtime.
//
// This file is a COMMITTED TEMPLATE (apps/app/nodejs-project-template/main.js). The build copies it
// into nodejs-assets/nodejs-project/ (which is gitignored build output) alongside the esbuild
// bundle (loam-server.js), the web client (client/), and the better-sqlite3 native prebuild
// (node_modules/better-sqlite3/). See apps/app/scripts/bundle-server.mjs.

const http = require('http');
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
