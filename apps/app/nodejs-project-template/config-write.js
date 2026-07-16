'use strict';

// Durable, three-outcome write of the launcher's config.json (Sol Fable-round P1-4) — split out of main.js
// into its own dependency-free CJS module (injected `fs`, no `require('rn-bridge')`, no top-level side
// effects) SPECIFICALLY so the filesystem-durability outcomes can be unit-tested with fault injection (see
// apps/app/src/lib/config-write.test.ts). main.js pulls in `rn-bridge` and runs boot side effects the instant
// it is required, so it can't be `require()`d from a plain Vitest harness — same reasoning as
// start-fresh-marker.js / db-key-gate.js.
//
// WHY THREE OUTCOMES: an atomic temp-write + rename only orders the METADATA. Without an explicit fsync of
// the temp file's CONTENTS before the rename, a power loss right after the rename can surface a
// present-but-empty/short config.json — an unparseable file that strands the operator with a host that
// refuses to boot. And a bare boolean can't distinguish "the new file is already visible but its survival is
// unconfirmed" (post-rename directory-fsync failure) from "nothing was written" — reporting the former as a
// plain failure would let the model-manager roll back a change that actually landed. So:
//   - 'failed'        the CONTENTS fsync (or an earlier step) failed BEFORE the rename: the old config.json
//                     is untouched and the temp is cleaned up. A definite, safe failure — the caller reports
//                     it so the model-manager conditionally rolls its local change back.
//   - 'durable'       contents fsync + atomic rename + parent-dir fsync ALL succeeded: power-loss-durable.
//   - 'indeterminate' the rename succeeded (the new config IS visible and may well persist) but the
//                     parent-dir fsync failed, so its survival across power loss is UNKNOWN. NOT a clean
//                     failure (would trigger a conflicting rollback) and NOT durable success — the caller
//                     must withhold the durable-success ack and let the bridge's timeout/reconciliation path
//                     treat it as ambiguous (the model-manager leaves the change in place, to be reconciled).

/** fsync a directory (via an injected `fs`) so a create/rename inside it is durable across power-loss.
 * Returns whether the fsync succeeded. Mirrors main.js's `fsyncDir`. */
function fsyncDirWith(fs, dir) {
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

/**
 * Durably write `contents` to `configPath` (a file inside `dataDir`), returning one of the three outcome
 * strings documented above. `contents` is the already-serialized config text.
 */
function durableWriteConfig(fs, dataDir, configPath, contents) {
  fs.mkdirSync(dataDir, { recursive: true });
  var tmpPath = configPath + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmpPath, contents, 'utf8');

  // Flush the temp file's CONTENTS before the rename. If this fails we have NOT achieved durability, so do
  // NOT rename (a crash could otherwise expose a present-but-empty config): clean up the temp and report a
  // definite failure. The existing config.json is untouched.
  try {
    var fd = fs.openSync(tmpPath, 'r+');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch (cleanupErr) {
      // Best-effort cleanup — the temp is a `.tmp-*` sidecar; a lingering one is harmless and never read.
    }
    return 'failed';
  }

  fs.renameSync(tmpPath, configPath);

  // The new file is now visible. Flush the directory so the rename itself survives a power loss. If THIS
  // fails the write may or may not survive — INDETERMINATE (definitely not a clean failure: the new config
  // is already visible), so the caller must claim neither durable success nor a plain failure.
  if (!fsyncDirWith(fs, dataDir)) {
    return 'indeterminate';
  }
  return 'durable';
}

module.exports = { durableWriteConfig: durableWriteConfig };
