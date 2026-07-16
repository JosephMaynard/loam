// Tests the pure three-outcome durable config.json write extracted from nodejs-project-template/main.js
// into config-write.js (Sol Fable-round P1-4). main.js itself can't be `require()`d from this harness — it
// pulls in `rn-bridge` and runs boot side effects at import time — so this dependency-free helper is the
// unit-testable seam (same pattern as start-fresh-marker.test.ts / db-key-gate.test.ts).
//
// The finding: the old inline write swallowed the temp-file fsync failure and ignored `fsyncDir`'s return,
// then always acked `ok:true`, so on the exact filesystem failure the fsyncs were added to cover a power
// loss could still surface an empty/short config while the model manager believed the change committed.
// `durableWriteConfig` returns three distinct outcomes; these tests inject faults at the CONTENTS fsync
// (openSync of the temp file, before the rename) and the DIRECTORY fsync (openSync of the dir, after the
// rename) and assert: a definite failure leaves the old config untouched and never renames; a post-rename
// dir-fsync failure is 'indeterminate' (never a clean failure); and the happy path is 'durable'.
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { durableWriteConfig } = require("../../nodejs-project-template/config-write.js");

const DIR = "/data/loam";
const CONFIG = "/data/loam/config.json";

interface CodedError extends Error {
  code: string;
}
function ioError(msg: string, code = "EIO"): CodedError {
  const err = new Error(msg) as CodedError;
  err.code = code;
  return err;
}

interface MockOptions {
  /** fail `openSync(tmpPath, 'r+')` — the CONTENTS fsync in the pre-rename phase. */
  failFileFsyncOpen?: boolean;
  /** fail `openSync(DIR, 'r')` — the post-rename directory fsync. */
  failDirFsyncOpen?: boolean;
  failRename?: boolean;
}

/** An in-memory `fs` exposing only the calls `durableWriteConfig` makes, with injectable faults. */
function makeFs(opts: MockOptions) {
  const files = new Map<string, string>();
  let nextFd = 10;

  const fs = {
    mkdirSync() {
      /* no-op — the data dir always exists in these tests */
    },
    writeFileSync(pathArg: string, contents: string) {
      files.set(pathArg, contents);
    },
    openSync(pathArg: string) {
      if (pathArg === DIR) {
        if (opts.failDirFsyncOpen) {
          throw ioError("dir open failed");
        }
      } else if (opts.failFileFsyncOpen) {
        // Any non-dir open here is the temp-file contents fsync (before the rename).
        throw ioError("file open failed");
      }
      return nextFd++;
    },
    fsyncSync() {
      /* faults are injected at openSync, matching start-fresh-marker.test.ts */
    },
    closeSync() {
      /* no-op */
    },
    renameSync(from: string, to: string) {
      if (opts.failRename) {
        throw ioError("rename failed");
      }
      const contents = files.get(from);
      files.delete(from);
      if (contents !== undefined) {
        files.set(to, contents);
      }
    },
    unlinkSync(pathArg: string) {
      files.delete(pathArg);
    },
    // test-only inspection
    _get(pathArg: string) {
      return files.get(pathArg);
    },
    _tmpFilesRemaining() {
      return [...files.keys()].filter((p) => p.startsWith(CONFIG + ".tmp"));
    },
  };
  return fs;
}

function write(fs: ReturnType<typeof makeFs>, contents: string) {
  return durableWriteConfig(fs, DIR, CONFIG, contents);
}

describe("durableWriteConfig three outcomes (Sol Fable-round P1-4)", () => {
  it("returns 'durable' and writes the config when every fsync succeeds", () => {
    const fs = makeFs({});
    expect(write(fs, '{"a":1}')).toBe("durable");
    expect(fs._get(CONFIG)).toBe('{"a":1}');
    expect(fs._tmpFilesRemaining()).toEqual([]);
  });

  it("returns 'failed' and leaves the OLD config untouched when the contents fsync fails (no rename)", () => {
    const fs = makeFs({ failFileFsyncOpen: true });
    fs.writeFileSync(CONFIG, '{"old":true}'); // a pre-existing config that must survive
    expect(write(fs, '{"new":true}')).toBe("failed");
    // The old config is intact — the temp was never renamed over it — and the temp is cleaned up.
    expect(fs._get(CONFIG)).toBe('{"old":true}');
    expect(fs._tmpFilesRemaining()).toEqual([]);
  });

  it("returns 'failed' when the rename itself fails (old config untouched)", () => {
    const fs = makeFs({ failRename: true });
    fs.writeFileSync(CONFIG, '{"old":true}');
    // A rename failure throws out of the helper; the caller's try/catch reports failure. Assert it throws
    // rather than silently claiming success, and the old config survives.
    expect(() => write(fs, '{"new":true}')).toThrow();
    expect(fs._get(CONFIG)).toBe('{"old":true}');
  });

  it("returns 'indeterminate' when the post-rename directory fsync fails (new config already visible)", () => {
    const fs = makeFs({ failDirFsyncOpen: true });
    expect(write(fs, '{"new":true}')).toBe("indeterminate");
    // The rename DID land — the new config is visible; its survival across power loss is just unconfirmed.
    // Crucially NOT 'failed' (which would trigger a conflicting rollback of a write that actually happened).
    expect(fs._get(CONFIG)).toBe('{"new":true}');
  });
});
