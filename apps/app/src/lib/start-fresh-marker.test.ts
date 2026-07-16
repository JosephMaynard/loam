// Tests the pure three-outcome durable install extracted from nodejs-project-template/main.js into
// start-fresh-marker.js (Sol P1). main.js itself can't be `require()`d from this harness — it pulls in
// `rn-bridge` (unavailable outside the embedded nodejs-mobile runtime) at import time and runs
// `bootWithWipeResume()` as a boot-time side effect the instant it's required — so this dependency-free
// helper is the unit-testable seam (same pattern as db-key-gate.test.ts).
//
// The finding: the shared `durableWriteFileSync` renames the temp onto the final marker path BEFORE its
// parent-dir fsync, then returns a bare `false` if that dir-fsync fails — leaving the marker INSTALLED
// even though the caller was told the write failed. For a 'delete' marker that means a destructive
// recovery can still occur AFTER the UI reported failure. `installStartFreshMarker` distinguishes three
// outcomes and, on the post-rename dir-fsync failure, ATTEMPTS A ROLLBACK so it only reports the
// provably-absent 'not-installed' when the marker is truly gone (and its removal durable); otherwise
// 'indeterminate'. These tests drive the helper with an in-memory `fs` that can inject failures on the
// parent-dir fsync (its `openSync`), the staging write, the rename, and the rollback unlink, and assert
// that a 'not-installed' result NEVER leaves a consumable marker behind.
import { describe, expect, it } from "vitest";

// The module under test is dependency-free CJS; require it the same way db-key-gate.test.ts does.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { installStartFreshMarker } = require("../../nodejs-project-template/start-fresh-marker.js");

const MARKER = "/data/loam/.loam-db-start-fresh";
const DIR = "/data/loam";

interface Enoent extends Error {
  code: string;
}
function enoent(): Enoent {
  const err = new Error("ENOENT") as Enoent;
  err.code = "ENOENT";
  return err;
}
function ioError(msg: string, code = "EIO"): Enoent {
  const err = new Error(msg) as Enoent;
  err.code = code;
  return err;
}

interface MockOptions {
  /** make `mkdirSync(DIR)` throw — the directory-preparation step at the START of phase 1. */
  failMkdir?: boolean;
  failWrite?: boolean;
  /** fail `openSync(tmpPath)` — the FILE-inode fsync in phase 1 (before any rename). */
  failFileFsyncOpen?: boolean;
  failRename?: boolean;
  /** 1-based indices of `openSync(DIR)` calls that should throw (phase-2 dir fsync is call #1, the
   *  post-rollback dir fsync is call #2). */
  failDirOpenOn?: number[];
  /** make `unlinkSync(MARKER)` throw a non-ENOENT error (rollback cannot remove the marker). */
  failUnlink?: boolean;
  /** force `lstatSync(MARKER)` to report the marker still present even after a successful unlink. */
  markerLingersAfterUnlink?: boolean;
  /** make `lstatSync(MARKER)` throw a non-ENOENT error (the absence proof is unverifiable). */
  failLstatUnverifiable?: boolean;
  /** seed a PRE-EXISTING (unconsumed) marker on disk before the install runs. */
  priorMarker?: boolean;
}

/** An in-memory `fs` exposing only the calls `installStartFreshMarker` makes, with injectable faults. */
function makeFs(opts: MockOptions) {
  const files = new Set<string>();
  if (opts.priorMarker) {
    files.add(MARKER);
  }
  let nextFd = 10;
  let dirOpenCount = 0;
  // The `markerLingersAfterUnlink` / `failLstatUnverifiable` faults target the ABSENCE-PROOF `lstat(MARKER)`
  // calls (the Phase-1 catch and the Phase-2 rollback). The NEW start-of-install prior-marker probe
  // (CodeRabbit) is the FIRST `lstat(MARKER)` call and must reflect real on-disk state, so it is exempt.
  let startCheckDone = false;
  const fdPath = new Map<number, string>();

  const fs = {
    mkdirSync(pathArg: string) {
      if (pathArg === DIR && opts.failMkdir) {
        throw ioError("mkdir failed");
      }
    },
    writeFileSync(pathArg: string) {
      if (opts.failWrite) {
        throw ioError("write failed");
      }
      files.add(pathArg);
    },
    openSync(pathArg: string) {
      if (pathArg === DIR) {
        dirOpenCount += 1;
        if (opts.failDirOpenOn && opts.failDirOpenOn.includes(dirOpenCount)) {
          throw ioError("dir open failed");
        }
      } else if (opts.failFileFsyncOpen) {
        // Any non-dir open here is the tmp-file inode fsync in phase 1.
        throw ioError("file open failed");
      }
      const fd = nextFd++;
      fdPath.set(fd, pathArg);
      return fd;
    },
    fsyncSync() {
      /* no injected fault at the fsync step — faults are injected at openSync */
    },
    closeSync(fd: number) {
      fdPath.delete(fd);
    },
    renameSync(from: string, to: string) {
      if (opts.failRename) {
        throw ioError("rename failed");
      }
      files.delete(from);
      files.add(to);
    },
    rmSync(pathArg: string) {
      files.delete(pathArg);
    },
    unlinkSync(pathArg: string) {
      if (opts.failUnlink) {
        throw ioError("unlink failed", "EACCES");
      }
      if (!files.has(pathArg)) {
        throw enoent();
      }
      files.delete(pathArg);
    },
    lstatSync(pathArg: string) {
      if (pathArg === MARKER && !startCheckDone) {
        // The install's initial prior-marker probe — reflect real on-disk state (faults target the later
        // absence-proof lstat calls, not this one).
        startCheckDone = true;
        if (!files.has(pathArg)) {
          throw enoent();
        }
        return {};
      }
      if (pathArg === MARKER && opts.failLstatUnverifiable) {
        throw ioError("lstat failed", "EACCES"); // cannot prove absence
      }
      if (pathArg === MARKER && opts.markerLingersAfterUnlink) {
        return {}; // pretend the marker is still there despite the unlink
      }
      if (!files.has(pathArg)) {
        throw enoent();
      }
      return {};
    },
    // test-only inspection
    _has(pathArg: string) {
      return files.has(pathArg);
    },
    _tmpFilesRemaining() {
      return [...files].filter((p) => p.startsWith(MARKER + ".tmp"));
    },
  };
  return fs;
}

function install(fs: ReturnType<typeof makeFs>) {
  return installStartFreshMarker({
    fs,
    markerPath: MARKER,
    tmpPath: MARKER + ".tmp-123-456",
    dir: DIR,
    contents: "delete",
  });
}

describe("installStartFreshMarker", () => {
  it("returns 'durable' and installs the marker when every step succeeds", () => {
    const fs = makeFs({});
    expect(install(fs)).toBe("durable");
    expect(fs._has(MARKER)).toBe(true);
    expect(fs._tmpFilesRemaining()).toEqual([]);
  });

  it("returns 'not-installed' when the staging write fails (marker never on disk)", () => {
    const fs = makeFs({ failWrite: true });
    expect(install(fs)).toBe("not-installed");
    expect(fs._has(MARKER)).toBe(false);
  });

  it("returns 'not-installed' when the file-inode fsync fails before any rename", () => {
    const fs = makeFs({ failFileFsyncOpen: true });
    expect(install(fs)).toBe("not-installed");
    expect(fs._has(MARKER)).toBe(false);
    // staging temp is cleaned up on the failure path
    expect(fs._tmpFilesRemaining()).toEqual([]);
  });

  it("returns 'not-installed' when the rename fails (marker never installed, temp cleaned)", () => {
    const fs = makeFs({ failRename: true });
    expect(install(fs)).toBe("not-installed");
    expect(fs._has(MARKER)).toBe(false);
    expect(fs._tmpFilesRemaining()).toEqual([]);
  });

  it("returns 'not-installed' when the dir-fsync fails but the rollback provably removes the marker", () => {
    // Phase-2 dir fsync (call #1) fails; the rollback's unlink + absence proof + post-unlink dir fsync
    // (call #2) all succeed → the marker is provably gone, so the write is safe to call unscheduled.
    const fs = makeFs({ failDirOpenOn: [1] });
    expect(install(fs)).toBe("not-installed");
    // CRITICAL: a 'not-installed' claim of absence must match on-disk reality — no consumable marker.
    expect(fs._has(MARKER)).toBe(false);
  });

  it("returns 'indeterminate' and LEAVES the marker when rollback cannot unlink it", () => {
    // Dir fsync fails after the rename; the rollback unlink then fails too — the marker MAY be consumed
    // on a later restart, so we must NOT claim it was unscheduled.
    const fs = makeFs({ failDirOpenOn: [1], failUnlink: true });
    expect(install(fs)).toBe("indeterminate");
    // The marker is still installed — but because we returned 'indeterminate', we did NOT claim absence.
    expect(fs._has(MARKER)).toBe(true);
  });

  it("returns 'indeterminate' when the marker is still present after the rollback unlink", () => {
    const fs = makeFs({ failDirOpenOn: [1], markerLingersAfterUnlink: true });
    expect(install(fs)).toBe("indeterminate");
  });

  it("returns 'indeterminate' when the post-rollback dir-fsync is not durable", () => {
    // Both dir fsyncs fail: phase-2 (#1) triggers the rollback, and the post-unlink flush (#2) fails, so
    // the removal itself is not proven durable → indeterminate (never a false 'not scheduled').
    const fs = makeFs({ failDirOpenOn: [1, 2] });
    expect(install(fs)).toBe("indeterminate");
  });

  it("PRESERVES a pre-existing marker on a dir-fsync rollback instead of deleting it (CodeRabbit)", () => {
    // A reset was ALREADY scheduled (a prior unconsumed marker). This install's atomic rename overwrites it,
    // then the phase-2 durability fsync fails. The rollback must NOT unlink — that would drop the
    // previously-scheduled reset AND falsely report 'not-installed'. Keep the (superseding) marker on disk
    // and report the honest uncertainty.
    const fs = makeFs({ priorMarker: true, failDirOpenOn: [1] });
    expect(install(fs)).toBe("indeterminate");
    expect(fs._has(MARKER)).toBe(true); // the reset request survives
  });

  it("returns 'not-installed' when the RENAME fails and NO marker exists on disk (provably absent)", () => {
    const fs = makeFs({ failRename: true });
    expect(install(fs)).toBe("not-installed");
    expect(fs._has(MARKER)).toBe(false);
  });

  it("returns 'indeterminate' (NOT 'not-installed') when the rename fails but a PRE-EXISTING marker is still on disk", () => {
    // CodeRabbit round-10 CRITICAL: the atomic rename leaves a prior unconsumed marker untouched, so a
    // Phase-1 failure does NOT prove the marker path is absent. Reporting 'not-installed' here would let the
    // caller claim "nothing was written" while a consumable (possibly destructive) marker remains.
    const fs = makeFs({ failRename: true });
    fs.writeFileSync(MARKER); // a stale marker from an earlier unconsumed request
    expect(install(fs)).toBe("indeterminate");
    expect(fs._has(MARKER)).toBe(true);
  });

  // Sol P2: directory preparation now lives INSIDE the helper's phase-1 try, so a mkdir failure routes
  // through the same ENOENT-only absence proof as a write/rename failure — the caller no longer wraps the
  // helper in its own mkdir + outer catch that reported 'not-installed' without proving marker absence.
  it("returns 'not-installed' when directory preparation fails and NO marker exists on disk (provably absent)", () => {
    const fs = makeFs({ failMkdir: true });
    expect(install(fs)).toBe("not-installed");
    expect(fs._has(MARKER)).toBe(false);
    // the staging file was never written (mkdir threw first), so nothing lingers
    expect(fs._tmpFilesRemaining()).toEqual([]);
  });

  it("returns 'indeterminate' (NOT 'not-installed') when directory preparation fails but a PRE-EXISTING marker is still on disk", () => {
    // A prior unconsumed 'delete' marker exists; mkdir throws before this call stages anything. Reporting
    // 'not-installed' here would let the caller claim "nothing was written" while an armed, possibly
    // destructive marker remains consumable on a later restart.
    const fs = makeFs({ failMkdir: true });
    fs.writeFileSync(MARKER); // a stale 'delete' marker from an earlier unconsumed request
    expect(install(fs)).toBe("indeterminate");
    // the pre-existing marker is untouched — because we returned 'indeterminate', we did NOT claim absence.
    expect(fs._has(MARKER)).toBe(true);
  });

  it("returns 'indeterminate' when directory preparation fails and the absence-proof lstat is unverifiable", () => {
    // mkdir throws, then the ENOENT-only absence proof itself hits a non-ENOENT stat error (EACCES/EIO):
    // absence cannot be verified, so the marker MAY be present → indeterminate, never a false 'not scheduled'.
    const fs = makeFs({ failMkdir: true, failLstatUnverifiable: true });
    expect(install(fs)).toBe("indeterminate");
  });
});
