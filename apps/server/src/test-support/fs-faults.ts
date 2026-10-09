/**
 * Fault-injection seams for `node:fs` and `node:fs/promises`, shared by the test files that need to make a
 * specific filesystem call fail or stall (kill switch, encryption at rest, attachment sweep). A test file
 * opts in with:
 *
 *   vi.mock("node:fs", async (importOriginal) =>
 *     (await import("./test-support/fs-faults.js")).faultyFs(await importOriginal()));
 *   vi.mock("node:fs/promises", async (importOriginal) =>
 *     (await import("./test-support/fs-faults.js")).faultyFsPromises(await importOriginal()));
 *
 * and calls `resetFsFaults()` in its `afterEach`. Every seam is inert by default and targets one exact path
 * or call, so a test that never arms one sees the real implementation. This module must not import
 * `node:fs` itself (it is loaded from inside the `node:fs` mock factory).
 */

type Fs = typeof import("node:fs");
type FsPromises = typeof import("node:fs/promises");

/** A single-shot `renameSync` failure: forces `openInitialStore`'s rename-aside step to throw (there is no
 *  other way to fail that one call deterministically: it runs between two other `node:fs` calls in the same
 *  synchronous function). Self-disarms the instant it fires. */
export const renameFailure = { armed: false };

/** Fails every `writeFileSync` of the durable `.loam-wipe-phase` file (its atomic `.tmp-*` staging path AND
 *  the direct fallback write), so the fail-closed kill-switch path runs with no durable phase at all. Stays
 *  armed: `writeWipePhase` writes twice and both must fail. */
export const wipeMarkerWriteFailure = { armed: false };

/** When `dir` is set, the migration's `copyFileSync(loam.db → loam.db.premigration.tmp)` is mirrored to
 *  `<dir>/captured-backup.db`, so a test can open that snapshot under the legacy key and prove it holds rows
 *  that were WAL-resident before the checkpoint folded them in. */
export const backupCapture = { dir: undefined as string | undefined };

/** Records every `rmSync` path while `paths` is an array. Lets a test prove a specific file was explicitly
 *  removed (an end-to-end "no journal after boot" check can't: any successful DB open also cleans a hot
 *  journal). */
export const rmSyncCapture = { paths: undefined as string[] | undefined };

/** A single-shot `rmSync` failure for the migration's post-rekey cleanup of the committed
 *  `loam.db.premigration` backup (exact path, never its sidecars). Self-disarms on fire. */
export const postRekeyCleanupFailure = { armed: false };

/** A PERSISTENT `rmSync` failure for `loam.db.premigration` (exact path, never its sidecars): every delete
 *  attempt fails, so the kill switch's `deleteAndVerifyDbArtifacts()` sees a survivor and must refuse to
 *  signal the launcher. */
export const premigrationDeleteFailure = { armed: false };

/** `readdirSync` of this exact directory throws EACCES: an unreadable data dir is not proof that no
 *  `*.unreadable-*` survivor exists. */
export const readdirFailure = { dir: undefined as string | undefined };

/** `lstatSync` of this exact path throws EIO, so `provenAbsence` answers "unknown", not "absent". */
export const lstatFailure = { path: undefined as string | undefined };

/** `readFileSync` of this exact path throws EIO: a journal that can't be read must be treated as corrupt
 *  (lock), not as a legacy journal with no config. */
export const readFileSyncFailure = { path: undefined as string | undefined };

/** `openSync` of this exact path throws EIO, so the parent-directory fsync (`fsyncDir` opens the dir with
 *  openSync) fails and `durableWriteFileSync`/`clearWipePhase` report not-durable. With `failOnCall` set
 *  (1-based), only the Nth `openSync(path)` fails (`count` tracks how many were seen), so earlier durable
 *  writes can succeed and exactly the phase-clear one fails. */
export const openSyncFailure = {
  path: undefined as string | undefined,
  failOnCall: undefined as number | undefined,
  count: 0,
};

/** Holds `node:fs/promises` `rm` calls open while `promise` is set, so a test can observe what a request
 *  sees during an async deletion window. `entered` fires when a gated `rm` arrives. */
export const rmGate = {
  promise: undefined as Promise<void> | undefined,
  entered: undefined as (() => void) | undefined,
};

/** Holds a `node:fs/promises` `mkdir` of ONE exact directory, so an upload can be suspended between its
 *  session check and its file write and a wipe can land in the gap. `entered` fires when it arrives. */
export const mkdirGate = {
  path: undefined as string | undefined,
  promise: undefined as Promise<void> | undefined,
  entered: undefined as (() => void) | undefined,
};

/** Fails the next N writes of the `config.json.tmp-*` staging path (`persistConfigForRestart` is
 *  synchronous, via `durableWriteFileSync`), to exercise the retry-once + proceed-with-the-wipe policy. */
export const configWriteFailures = { remaining: 0 };

/** Disarm every seam. Call from `afterEach`, so a test that failed before releasing a gate can't leave a
 *  later test's `rm()` waiting on a promise nobody will resolve. */
export function resetFsFaults(): void {
  rmGate.promise = undefined;
  rmGate.entered = undefined;
  mkdirGate.path = undefined;
  mkdirGate.promise = undefined;
  mkdirGate.entered = undefined;
  configWriteFailures.remaining = 0;
  openSyncFailure.path = undefined;
  openSyncFailure.failOnCall = undefined;
  openSyncFailure.count = 0;
  readFileSyncFailure.path = undefined;
  wipeMarkerWriteFailure.armed = false;
  backupCapture.dir = undefined;
  postRekeyCleanupFailure.armed = false;
  premigrationDeleteFailure.armed = false;
  readdirFailure.dir = undefined;
  lstatFailure.path = undefined;
  rmSyncCapture.paths = undefined;
  renameFailure.armed = false;
}

/** `node:fs` with the seams above wired in; every other export is the real one. */
export function faultyFs(actual: Fs): Fs {
  return ({
    ...actual,
    openSync: (...args: Parameters<Fs["openSync"]>) => {
      if (openSyncFailure.path && String(args[0]) === openSyncFailure.path) {
        openSyncFailure.count += 1;
        if (openSyncFailure.failOnCall === undefined || openSyncFailure.count === openSyncFailure.failOnCall) {
          const err = new Error("simulated openSync EIO (test fault injection)") as NodeJS.ErrnoException;
          err.code = "EIO";
          throw err;
        }
      }
      return actual.openSync(...(args as Parameters<Fs["openSync"]>));
    },
    readdirSync: (...args: Parameters<Fs["readdirSync"]>) => {
      if (readdirFailure.dir && String(args[0]) === readdirFailure.dir) {
        const err = new Error("simulated readdir EACCES (test fault injection)") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return actual.readdirSync(...(args as Parameters<Fs["readdirSync"]>));
    },
    readFileSync: (...args: Parameters<Fs["readFileSync"]>) => {
      if (readFileSyncFailure.path && String(args[0]) === readFileSyncFailure.path) {
        const err = new Error("simulated readFileSync EIO (test fault injection)") as NodeJS.ErrnoException;
        err.code = "EIO";
        throw err;
      }
      return actual.readFileSync(...(args as Parameters<Fs["readFileSync"]>));
    },
    lstatSync: (...args: Parameters<Fs["lstatSync"]>) => {
      if (lstatFailure.path && String(args[0]) === lstatFailure.path) {
        const err = new Error("simulated lstat EIO (test fault injection)") as NodeJS.ErrnoException;
        err.code = "EIO";
        throw err;
      }
      return actual.lstatSync(...(args as Parameters<Fs["lstatSync"]>));
    },
    rmSync: (...args: Parameters<Fs["rmSync"]>) => {
      if (rmSyncCapture.paths) {
        rmSyncCapture.paths.push(String(args[0]));
      }
      if (postRekeyCleanupFailure.armed && String(args[0]).endsWith("loam.db.premigration")) {
        postRekeyCleanupFailure.armed = false;
        throw new Error("simulated post-rekey cleanup rmSync failure (test fault injection)");
      }
      if (premigrationDeleteFailure.armed && String(args[0]).endsWith("loam.db.premigration")) {
        // Persistent: no self-disarm, so the survivor can never be deleted this test run.
        throw new Error("simulated persistent .premigration rmSync failure (test fault injection)");
      }
      return actual.rmSync(...args);
    },
    renameSync: (...args: Parameters<Fs["renameSync"]>) => {
      if (renameFailure.armed) {
        renameFailure.armed = false;
        throw new Error("simulated renameSync failure (test fault injection)");
      }
      return actual.renameSync(...args);
    },
    writeFileSync: (...args: Parameters<Fs["writeFileSync"]>) => {
      const target = String(args[0]);
      if (wipeMarkerWriteFailure.armed && target.includes(".loam-wipe-phase")) {
        throw new Error("simulated wipe-phase write failure (test fault injection)");
      }
      if (configWriteFailures.remaining > 0 && target.includes("config.json.tmp-")) {
        configWriteFailures.remaining -= 1;
        throw new Error("simulated config.json write failure (test fault injection)");
      }
      return actual.writeFileSync(...args);
    },
    copyFileSync: (...args: Parameters<Fs["copyFileSync"]>) => {
      const result = actual.copyFileSync(...args);
      if (backupCapture.dir && String(args[1]).endsWith(".premigration.tmp")) {
        actual.copyFileSync(String(args[1]), `${backupCapture.dir}/captured-backup.db`);
      }
      return result;
    },
  }) as Fs;
}

/** `node:fs/promises` with the `rm` and `mkdir` gates wired in; every other export is the real one. */
export function faultyFsPromises(actual: FsPromises): FsPromises {
  return ({
    ...actual,
    rm: async (...args: Parameters<FsPromises["rm"]>) => {
      if (rmGate.promise) {
        rmGate.entered?.();
        await rmGate.promise;
      }
      return actual.rm(...args);
    },
    mkdir: async (...args: Parameters<FsPromises["mkdir"]>) => {
      if (mkdirGate.path !== undefined && String(args[0]) === mkdirGate.path) {
        mkdirGate.entered?.();
        await mkdirGate.promise;
      }
      return actual.mkdir(...args);
    },
  }) as FsPromises;
}
