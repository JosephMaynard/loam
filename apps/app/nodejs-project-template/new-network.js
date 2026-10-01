'use strict';

// Applying a new network from the setup screens (RN `setPendingNewNetwork`), before the boot decision
// reads the data folder. Extracted from main.js so it can be tested against a real folder (main.js itself
// pulls in rn-bridge at import time). See main.js `startNewNetwork` for how the outcome is used.

const { durableWriteConfig } = require('./config-write');

/** The file recording which setup operation created the network in this folder. Not secret. */
const SETUP_APPLIED_FILE = '.loam-setup-applied';
const OPERATION_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** fsync a directory; false when it can't be proven durable. */
function fsyncDirWith(fs, dir) {
  try {
    var fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Empty `dataDir` (the previous network's database, media, configuration and mode hint), durably write
 * `operation.config` as config.json, then record `operation.id`. Returns:
 *   - 'applied'  the folder now holds exactly the new network's starting configuration;
 *   - 'already'  this operation was applied before (a retried request after a lost acknowledgement, or a
 *                boot attempt that failed afterwards): nothing is touched, so a network the operation itself
 *                created is never emptied again;
 *   - 'failed'   malformed, or the folder couldn't be emptied, or the configuration (or the record) isn't
 *                durably on disk. The caller must not boot: it would start under defaults instead.
 * The record is written last, so a crash part-way leaves none and a retry starts over.
 */
function applyNewNetwork(fs, path, dataDir, operation) {
  var id = operation && typeof operation.id === 'string' ? operation.id : '';
  var config = operation && operation.config;
  if (!OPERATION_ID.test(id) || !config || typeof config !== 'object' || Array.isArray(config)) {
    return 'failed';
  }
  var recordPath = path.join(dataDir, SETUP_APPLIED_FILE);
  try {
    if (fs.readFileSync(recordPath, 'utf8').trim() === id) {
      return 'already';
    }
  } catch (err) {
    // No record (or unreadable): this operation hasn't been applied here.
  }
  try {
    if (fs.existsSync(dataDir)) {
      fs.readdirSync(dataDir).forEach(function (entry) {
        fs.rmSync(path.join(dataDir, entry), { recursive: true, force: true });
      });
    }
    fs.mkdirSync(dataDir, { recursive: true });
    if (fs.readdirSync(dataDir).length > 0 || !fsyncDirWith(fs, dataDir)) {
      return 'failed';
    }
    var configPath = path.join(dataDir, 'config.json');
    if (durableWriteConfig(fs, dataDir, configPath, JSON.stringify(config, null, 2)) !== 'durable') {
      return 'failed';
    }
    fs.writeFileSync(recordPath, id, 'utf8');
    var fd = fs.openSync(recordPath, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return fsyncDirWith(fs, dataDir) ? 'applied' : 'failed';
  } catch (err) {
    return 'failed';
  }
}

module.exports = { applyNewNetwork: applyNewNetwork, SETUP_APPLIED_FILE: SETUP_APPLIED_FILE };
