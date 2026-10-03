'use strict';

// Applying a new network from the setup screens (RN `setPendingNewNetwork`), before the boot decision
// reads the data folder. Extracted from main.js so it can be tested against a real folder (main.js itself
// pulls in rn-bridge at import time). See main.js `startNewNetwork` for how the outcome is used.

const { durableWriteConfig } = require('./config-write');

/** The file recording which setup operation created the network in this folder. Not secret. */
const SETUP_APPLIED_FILE = '.loam-setup-applied';
/**
 * Written (with the operation id) before anything is erased and left in place until the operation is
 * recorded as applied: while it names an operation the folder doesn't record, setup is unfinished, and the
 * launcher must not boot whatever is (or isn't) left. See `setupUnfinished`.
 */
const SETUP_PENDING_FILE = '.loam-setup-pending';
/**
 * The launcher's mode hint. RN's setup writes the NEW network's mode there before the runtime starts, so
 * emptying the folder keeps it: losing it would turn an encrypted choice into "nothing to protect" if the
 * key handoff then failed (boot-config.js `mayBootPlaintextOnLockedError`).
 */
const MODE_HINT_FILE = '.loam-db-mode-hint';
const KEPT_ENTRIES = [SETUP_PENDING_FILE, MODE_HINT_FILE];
const OPERATION_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Write `content` to `filePath` and fsync it; false when it can't be proven durable. */
function durableWrite(fs, filePath, content) {
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    var fd = fs.openSync(filePath, 'r');
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

/** A trimmed file, or undefined when it's missing or unreadable. */
function readTrimmed(fs, filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch (err) {
    return undefined;
  }
}

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
 * Empty `dataDir` (the previous network's database, media and configuration; the mode hint, which already
 * holds the new network's mode, is kept), durably write `operation.config` as config.json, then record
 * `operation.id`. A pending marker naming the operation is made durable before anything is erased, so a
 * failure part-way leaves the folder marked unfinished rather than looking like a fresh install. Returns:
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
  var pendingPath = path.join(dataDir, SETUP_PENDING_FILE);
  if (readTrimmed(fs, recordPath) === id) {
    return 'already';
  }
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    if (!durableWrite(fs, pendingPath, id) || !fsyncDirWith(fs, dataDir)) {
      return 'failed';
    }
    fs.readdirSync(dataDir).forEach(function (entry) {
      if (KEPT_ENTRIES.indexOf(entry) === -1) {
        fs.rmSync(path.join(dataDir, entry), { recursive: true, force: true });
      }
    });
    var left = fs.readdirSync(dataDir).filter(function (entry) {
      return KEPT_ENTRIES.indexOf(entry) === -1;
    });
    if (left.length > 0 || !fsyncDirWith(fs, dataDir)) {
      return 'failed';
    }
    var configPath = path.join(dataDir, 'config.json');
    if (durableWriteConfig(fs, dataDir, configPath, JSON.stringify(config, null, 2)) !== 'durable') {
      return 'failed';
    }
    if (!durableWrite(fs, recordPath, id) || !fsyncDirWith(fs, dataDir)) {
      return 'failed';
    }
  } catch (err) {
    return 'failed';
  }
  // Applied. The marker now matches the record, which already reads as finished; removing it is tidying.
  try {
    fs.rmSync(pendingPath, { force: true });
    fsyncDirWith(fs, dataDir);
  } catch (err) {
    // Harmless: `setupUnfinished` compares it with the record.
  }
  return 'applied';
}

/**
 * Whether a setup operation started in `dataDir` hasn't finished: the pending marker exists and names an
 * operation the folder doesn't record as applied (an unreadable marker counts as unfinished). The launcher
 * stays locked then, whatever the key response says, until the operation is resent and applied: booting
 * would start the half-erased folder under defaults, possibly unencrypted.
 */
function setupUnfinished(fs, path, dataDir) {
  var pendingPath = path.join(dataDir, SETUP_PENDING_FILE);
  try {
    if (!fs.existsSync(pendingPath)) {
      return false;
    }
  } catch (err) {
    return true;
  }
  var pending = readTrimmed(fs, pendingPath);
  return pending === undefined || pending !== readTrimmed(fs, path.join(dataDir, SETUP_APPLIED_FILE));
}

module.exports = {
  applyNewNetwork: applyNewNetwork,
  setupUnfinished: setupUnfinished,
  SETUP_APPLIED_FILE: SETUP_APPLIED_FILE,
  SETUP_PENDING_FILE: SETUP_PENDING_FILE,
};
