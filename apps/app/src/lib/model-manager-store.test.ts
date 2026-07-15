// P2-3 round 5: the strict, DEEP validity check in model-manager-store.ts. A slot with any malformed
// `downloaded` entry, a bad-typed `activeId`, or a dangling `activeId` must be treated as INVALID so
// `loadModelManagerState` falls through to a good `.bak`, and `saveModelManagerState` never rotates a
// corrupt primary over that good backup. A genuinely-empty state stays valid.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fileSystemMock, resetFileSystemMock, seedFile } from "@/test-utils/mocks";

vi.mock("expo-file-system/legacy", () => fileSystemMock);

const { loadModelManagerState, saveModelManagerState } = await import("@/lib/model-manager-store");

const STATE_PATH = `${fileSystemMock.documentDirectory}loam-model-manager.json`;
const BAK_PATH = `${STATE_PATH}.bak`;

/** A well-formed `DownloadedModel` (passes `isDownloadedModel`). */
function model(id: string) {
  return {
    id,
    displayName: `Model ${id}`,
    uri: `file:///models/${id}.gguf`,
    sizeBytes: 1024,
    isCustom: false,
    sourceUrl: `https://example.test/${id}.gguf`,
    downloadedAt: 123,
  };
}

const GOOD_BACKUP = { downloaded: [model("m1"), model("m2")], activeId: "m1" };

describe("loadModelManagerState — strict validity (P2-3)", () => {
  beforeEach(() => {
    resetFileSystemMock();
  });

  it("falls through to a valid .bak when the primary has a malformed entry", async () => {
    seedFile(STATE_PATH, JSON.stringify({ downloaded: [{}] }));
    seedFile(BAK_PATH, JSON.stringify(GOOD_BACKUP));

    const loaded = await loadModelManagerState();
    expect(loaded).toEqual(GOOD_BACKUP);
  });

  it("falls through to .bak when the primary mixes valid and invalid entries", async () => {
    seedFile(STATE_PATH, JSON.stringify({ downloaded: [model("ok"), { id: "bad" /* missing fields */ }] }));
    seedFile(BAK_PATH, JSON.stringify(GOOD_BACKUP));

    const loaded = await loadModelManagerState();
    expect(loaded).toEqual(GOOD_BACKUP);
  });

  it("falls through to .bak when activeId is the wrong type", async () => {
    seedFile(STATE_PATH, JSON.stringify({ downloaded: [model("m1")], activeId: 42 }));
    seedFile(BAK_PATH, JSON.stringify(GOOD_BACKUP));

    const loaded = await loadModelManagerState();
    expect(loaded).toEqual(GOOD_BACKUP);
  });

  it("falls through to .bak when activeId is dangling (references no downloaded model)", async () => {
    seedFile(STATE_PATH, JSON.stringify({ downloaded: [model("m1")], activeId: "does-not-exist" }));
    seedFile(BAK_PATH, JSON.stringify(GOOD_BACKUP));

    const loaded = await loadModelManagerState();
    expect(loaded).toEqual(GOOD_BACKUP);
  });

  it("accepts a genuinely-empty primary as valid and never consults .bak", async () => {
    seedFile(STATE_PATH, JSON.stringify({ downloaded: [], activeId: undefined }));
    // A DIFFERENT backup — if the empty primary were wrongly treated as invalid, this would surface.
    seedFile(BAK_PATH, JSON.stringify(GOOD_BACKUP));

    const loaded = await loadModelManagerState();
    expect(loaded).toEqual({ downloaded: [], activeId: undefined });
  });

  it("accepts a valid primary with a referencing activeId", async () => {
    seedFile(STATE_PATH, JSON.stringify(GOOD_BACKUP));
    const loaded = await loadModelManagerState();
    expect(loaded).toEqual(GOOD_BACKUP);
  });

  it("returns EMPTY_STATE only when BOTH slots are invalid", async () => {
    seedFile(STATE_PATH, JSON.stringify({ downloaded: [{}] }));
    seedFile(BAK_PATH, JSON.stringify("garbage-not-an-object"));

    const loaded = await loadModelManagerState();
    expect(loaded).toEqual({ downloaded: [], activeId: undefined });
  });
});

describe("saveModelManagerState — corrupt primary not rotated over a good backup (P2-3)", () => {
  beforeEach(() => {
    resetFileSystemMock();
    vi.restoreAllMocks();
  });

  it("discards a corrupt primary rather than rotating it into .bak, and keeps the new write", async () => {
    seedFile(STATE_PATH, JSON.stringify({ downloaded: [{}] })); // corrupt primary
    seedFile(BAK_PATH, JSON.stringify(GOOD_BACKUP)); // last known-good backup

    const moveSpy = vi.spyOn(fileSystemMock, "moveAsync");

    const newState = { downloaded: [model("m3")], activeId: "m3" };
    const ok = await saveModelManagerState(newState);
    expect(ok).toBe(true);

    // The corrupt primary must NEVER have been rotated (moved) into the backup slot — only the temp
    // file should have been moved into place. With the old lenient validator it would have been moved
    // STATE_PATH -> BAK_PATH, clobbering the good backup.
    const rotatedCorruptPrimary = moveSpy.mock.calls.some(([{ from }]) => from === STATE_PATH);
    expect(rotatedCorruptPrimary).toBe(false);

    // The new state is what loads afterwards.
    const loaded = await loadModelManagerState();
    expect(loaded).toEqual(newState);
  });

  it("survives a crash (move failure) with the good backup intact — corrupt primary discarded", async () => {
    seedFile(STATE_PATH, JSON.stringify({ downloaded: [{}] })); // corrupt primary
    seedFile(BAK_PATH, JSON.stringify(GOOD_BACKUP));

    // Simulate the process dying on the final move into place (tmp -> STATE_PATH). Because the corrupt
    // primary was DISCARDED (not rotated), the good backup is still intact and recoverable.
    vi.spyOn(fileSystemMock, "moveAsync").mockRejectedValueOnce(new Error("killed mid-move"));

    const ok = await saveModelManagerState({ downloaded: [model("m3")], activeId: "m3" });
    expect(ok).toBe(false);

    const loaded = await loadModelManagerState();
    expect(loaded).toEqual(GOOD_BACKUP);
  });
});
