// P2-b: `sweepOrphanedModelFiles` must never delete a `.gguf` a durable pending action still
// references — most critically a pending `delete`'s bytes, kept on disk precisely because the launcher
// clear was never confirmed, so config.json may STILL point at it (the dangling-pointer bug). A pending
// `setActive`'s file is likewise protected. An unreferenced file with NO pending reference is still
// reclaimed as before.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fileSystemMock, resetFileSystemMock, seedFile } from "@/test-utils/mocks";

vi.mock("expo-file-system/legacy", () => fileSystemMock);

const { sweepOrphanedModelFiles } = await import("@/lib/model-download");

const MODELS_DIR = `${fileSystemMock.documentDirectory}models/`;
const keep = `${MODELS_DIR}keep.gguf`;
const orphan = `${MODELS_DIR}orphan.gguf`;
const pendingDelete = `${MODELS_DIR}pending-delete.gguf`;
const pendingSetActive = `${MODELS_DIR}pending-set-active.gguf`;

/** Seed the models dir (so `getInfoAsync(MODELS_DIR).exists` is true) plus the given final `.gguf`s. */
function seedModelsDir(...files: string[]) {
  seedFile(MODELS_DIR, ""); // directory marker (uri ends in `/`)
  for (const uri of files) {
    seedFile(uri, "bytes");
  }
}

describe("sweepOrphanedModelFiles — pending-referenced files are never swept (P2-b)", () => {
  beforeEach(() => {
    resetFileSystemMock();
  });

  it("deletes a truly-unreferenced orphan but keeps a referenced file", async () => {
    seedModelsDir(keep, orphan);

    await sweepOrphanedModelFiles([keep]);

    expect((await fileSystemMock.getInfoAsync(keep)).exists).toBe(true);
    expect((await fileSystemMock.getInfoAsync(orphan)).exists).toBe(false);
  });

  it("does NOT delete a pending-delete's bytes even though it's absent from `downloaded`/referencedUris", async () => {
    // `pendingDelete` was removed from `downloaded` last session (so it's not in referencedUris) but its
    // bytes were deliberately kept because the clear was never confirmed. It MUST survive the sweep.
    seedModelsDir(keep, orphan, pendingDelete);

    await sweepOrphanedModelFiles([keep], [pendingDelete]);

    expect((await fileSystemMock.getInfoAsync(pendingDelete)).exists).toBe(true);
    expect((await fileSystemMock.getInfoAsync(keep)).exists).toBe(true);
    expect((await fileSystemMock.getInfoAsync(orphan)).exists).toBe(false); // still reclaimed
  });

  it("does NOT delete a pending-setActive's file passed via the protected set", async () => {
    seedModelsDir(pendingSetActive, orphan);

    await sweepOrphanedModelFiles([], [pendingSetActive]);

    expect((await fileSystemMock.getInfoAsync(pendingSetActive)).exists).toBe(true);
    expect((await fileSystemMock.getInfoAsync(orphan)).exists).toBe(false);
  });

  it("defaults the pending set to empty (backwards-compatible one-arg call)", async () => {
    seedModelsDir(keep, orphan);

    await sweepOrphanedModelFiles([keep]);

    expect((await fileSystemMock.getInfoAsync(orphan)).exists).toBe(false);
  });
});
