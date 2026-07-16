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
}

/** An in-memory `fs` exposing only the calls `installStartFreshMarker` makes, with injectable faults. */
function makeFs(opts: MockOptions) {
  const files = new Set<string>();
  let nextFd = 10;
  let dirOpenCount = 0;
  const fdPath = new Map<number, string>();

  const fs = {
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
});
