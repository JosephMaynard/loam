'use strict';

// Durable install of the "Preserve old database & start fresh" marker (Sol P1) — split out from main.js
// into its own dependency-free CJS module, with no `require('rn-bridge')` and no top-level side effects,
// SPECIFICALLY so the filesystem outcome logic can be unit-tested with an injected `fs` (see
// apps/app/src/lib/start-fresh-marker.test.ts). main.js itself pulls in `rn-bridge` at import time and
// runs `bootWithWipeResume()` as a boot-time side effect the instant it's required, so it can't safely be
// `require()`d from a plain Vitest harness — same reasoning as db-key-gate.js's doc comment.
//
// WHY A DEDICATED PATH (not the shared `durableWriteFileSync`): the START-FRESH marker's CONTENT encodes
// intent — `"delete"` (a deliberate destructive mode change: the server DELETES the old DB) or
// `"preserve"` (accidental-lockout recovery: the server renames it aside). The RN host reports the
// outcome to the operator, so a "could not be scheduled" ack MUST match on-disk reality. The shared
// `durableWriteFileSync` renames the temp onto the final path BEFORE its parent-dir fsync, then returns a
// bare `false` if that dir-fsync fails — leaving the marker INSTALLED in the current filesystem namespace
// even though the caller was told the write failed. For a `"delete"` marker that means a destructive
// recovery can still occur AFTER the UI reported failure. A post-rename dir-fsync failure is an
// INDETERMINATE commit, not the same state as "nothing was written"; a boolean loses that distinction.
// This install therefore reports THREE outcomes and, on an indeterminate commit, ATTEMPTS A ROLLBACK so
// it can downgrade to a provable "not-installed" whenever the marker can be proven gone (and its removal
// made durable).
//
// The WIPE-PHASE `durableWriteFileSync` semantics are deliberately left untouched: for that phase file a
// lingering marker on a false return is FAIL-SAFE (a leftover phase just makes the next boot resume,
// which is correct), so it needs no rollback. This module is only for the start-fresh marker.

/** fsync a directory (via an injected `fs`) so a create/rename/unlink inside it is durable across
 * power-loss. Returns whether the fsync succeeded. Mirrors main.js's `fsyncDir`. */
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
 * Install the start-fresh marker durably, reporting one of three outcomes:
 *   - `'durable'`       staging write + file fsync + atomic rename + parent-dir fsync ALL succeeded. The
 *                       marker is installed and power-loss-durable.
 *   - `'not-installed'` the write/rename failed before installing (marker never on disk), OR the rename
 *                       succeeded but the parent-dir fsync failed AND a rollback (unlink the final marker +
 *                       prove it absent + fsync the dir) then PROVED the marker gone and its removal
 *                       durable. Either way the marker is provably NOT on disk — safe to report "not
 *                       scheduled; nothing was written".
 *   - `'indeterminate'` the rename succeeded, the parent-dir fsync failed, AND the rollback could not be
 *                       proven durable (the unlink, the absence check, or the post-unlink dir-fsync
 *                       failed). The marker MAY be on disk and MAY be consumed on a later restart — the
 *                       caller must NOT report this as cancelled/unscheduled.
 *
 * The helper also PREPARES the parent directory itself (`mkdirSync(dir, { recursive: true })`) as the very
 * first step of Phase 1, so the whole "prepare dir → stage → fsync → rename" operation is a single tested
 * function with the correct three-outcome contract (the caller no longer wraps it in its own mkdir + catch).
 * Because the mkdir is INSIDE the Phase-1 try, a directory-preparation failure falls into the SAME Phase-1
 * catch as a write/rename failure: it proves marker absence (ENOENT-only lstat) before reporting
 * `not-installed`, so a mkdir throw while a PRIOR unconsumed marker exists yields `indeterminate`, never a
 * false "nothing was written".
 *
 * All filesystem access goes through the injected `options.fs` so this is unit-testable with a mock `fs`.
 *
 * @param {object} options
 * @param {object} options.fs         `fs`-like: mkdirSync, writeFileSync, openSync, fsyncSync, closeSync,
 *                                     renameSync, rmSync, unlinkSync, lstatSync.
 * @param {string} options.markerPath final marker path.
 * @param {string} options.tmpPath    staging path (same directory / filesystem as markerPath).
 * @param {string} options.dir        parent directory of the marker, to fsync.
 * @param {string} options.contents   marker contents (the intent string).
 * @returns {'durable'|'not-installed'|'indeterminate'}
 */
function installStartFreshMarker(options) {
  var fs = options.fs;
  var markerPath = options.markerPath;
  var tmpPath = options.tmpPath;
  var dir = options.dir;
  var contents = options.contents;

  // CodeRabbit: detect a PRE-EXISTING (unconsumed) marker BEFORE Phase 1's atomic rename overwrites it. If
  // that rename then succeeds but the Phase-2 durability fsync fails, the rollback must NOT unlink the marker
  // — doing so would delete a reset request that was ALREADY pending and falsely report 'not-installed'.
  // lstat; treat any non-ENOENT stat error as "possibly present" so we fail safe toward preserving.
  var hadPriorMarker;
  try {
    fs.lstatSync(markerPath);
    hadPriorMarker = true;
  } catch (statErr) {
    hadPriorMarker = !(statErr && statErr.code === 'ENOENT');
  }

  // Phase 1 — prepare the parent directory, stage the bytes, fsync the file inode, then atomically rename
  // onto the marker path. A failure here (INCLUDING the directory preparation) means THIS call did not
  // install a new marker. But the atomic rename leaves any PRE-EXISTING marker (from an earlier unconsumed
  // request) untouched, so "this write failed" does NOT prove the marker path is absent (CodeRabbit round-10
  // CRITICAL; keeping mkdir inside this try is the Sol P2 fix so a mkdir throw routes through the same
  // absence-proof rather than a false "not scheduled"). Clean up the staging file, then PROVE absence (lstat,
  // ENOENT-only) before reporting `not-installed`; if a marker still exists — or absence can't be verified —
  // report `indeterminate` so the caller never claims "nothing was written" while a consumable marker is on
  // disk.
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmpPath, contents, 'utf8');
    var fd = fs.openSync(tmpPath, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, markerPath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch (cleanupErr) {
      // ENOENT is the common case (the staging write itself failed) — nothing to clean up.
    }
    try {
      fs.lstatSync(markerPath);
      return 'indeterminate'; // a marker (this call's or a prior one's) is still on disk
    } catch (statErr) {
      return statErr && statErr.code === 'ENOENT' ? 'not-installed' : 'indeterminate';
    }
  }

  // Phase 2 — the marker is now installed. A successful parent-dir fsync makes the rename durable.
  if (fsyncDirWith(fs, dir)) {
    return 'durable';
  }

  // The dir-fsync failed AFTER the rename installed the marker: an INDETERMINATE commit. Roll back so the
  // reported outcome matches on-disk reality — unlink the marker, PROVE it's gone, and fsync the dir to
  // make that removal durable. Only a fully proven rollback downgrades to 'not-installed'; any step we
  // cannot prove leaves the marker possibly-consumable, which is 'indeterminate'.
  //
  // BUT (CodeRabbit): if a marker was ALREADY pending before this call, the just-installed marker supersedes
  // it — unlinking would delete a real, previously-scheduled reset and lie 'not-installed'. Keep the marker
  // (a reset is genuinely pending; only its durability is unproven) and report the honest uncertainty.
  if (hadPriorMarker) {
    return 'indeterminate';
  }
  try {
    fs.unlinkSync(markerPath);
  } catch (unlinkErr) {
    if (!(unlinkErr && unlinkErr.code === 'ENOENT')) {
      // Could not remove the just-installed marker — it may survive and be consumed on a later restart.
      return 'indeterminate';
    }
    // ENOENT: already absent — fall through to prove absence + durably flush the directory.
  }

  // Prove absence: only ENOENT from lstat is proof. lstat (not existsSync) because existsSync reports
  // false for many stat errors (EACCES/EIO/...), conflating "confirmed gone" with "could-not-determine".
  // Mirrors main.js's `provenAbsence`-style checks in `clearWipePhase`.
  try {
    fs.lstatSync(markerPath);
    return 'indeterminate'; // still present after the unlink — not a clean rollback.
  } catch (statErr) {
    if (!(statErr && statErr.code === 'ENOENT')) {
      return 'indeterminate'; // unverifiable stat error — cannot prove the marker is gone.
    }
  }

  // The marker is provably gone; make its removal durable. If THIS fails the deletion might not survive a
  // power-loss (the marker could be resurrected), so the rollback is not proven durable → indeterminate.
  if (!fsyncDirWith(fs, dir)) {
    return 'indeterminate';
  }
  return 'not-installed';
}

module.exports = { installStartFreshMarker: installStartFreshMarker };
