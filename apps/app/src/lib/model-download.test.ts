// P2-b: `sweepOrphanedModelFiles` must never delete a `.gguf` a durable pending action still
// references — most critically a pending `delete`'s bytes, kept on disk precisely because the launcher
// clear was never confirmed, so config.json may STILL point at it (the dangling-pointer bug). A pending
// `setActive`'s file is likewise protected. An unreferenced file with NO pending reference is still
// reclaimed as before.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearFileSystemFailure, failFileSystemUri, fileSystemMock, resetFileSystemMock, seedFile } from "@/test-utils/mocks";

vi.mock("expo-file-system/legacy", () => fileSystemMock);

const {
  clearRetainedOrphans,
  deleteModelFileChecked,
  discardUnregisteredDownload,
  prepareCustomModelDownload,
  retainedOrphanCount,
  sweepOrphanedModelFiles,
} = await import("@/lib/model-download");

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

// Finding 1: `deleteModelFileChecked` is the STRICT delete — it propagates a filesystem error AND
// treats "deleteAsync resolved but the file is still on disk" as a failure, unlike the best-effort
// `safeDelete` that swallowed everything (which made the orphan-cleanup failure branch unreachable).
describe("deleteModelFileChecked — strict, verified deletion (Finding 1)", () => {
  const target = `${MODELS_DIR}victim.gguf`;

  beforeEach(() => {
    resetFileSystemMock();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves and leaves no file when the delete truly removes it", async () => {
    seedModelsDir(target);

    await expect(deleteModelFileChecked(target)).resolves.toBeUndefined();
    expect((await fileSystemMock.getInfoAsync(target)).exists).toBe(false);
  });

  it("is idempotent — deleting an already-absent file succeeds (safe for reconciliation to repeat)", async () => {
    seedModelsDir(); // dir exists, no target file
    await expect(deleteModelFileChecked(target)).resolves.toBeUndefined();
  });

  it("PROPAGATES a rejecting deleteAsync (best-effort would have swallowed it)", async () => {
    seedModelsDir(target);
    vi.spyOn(fileSystemMock, "deleteAsync").mockRejectedValueOnce(new Error("EROFS: read-only file system"));

    await expect(deleteModelFileChecked(target)).rejects.toThrow(/read-only/);
  });

  it("treats 'deleteAsync resolved but the file still exists' as a FAILURE and throws", async () => {
    seedModelsDir(target);
    // A driver quirk: delete claims success but the bytes remain. `safeDelete` would have reported done.
    vi.spyOn(fileSystemMock, "deleteAsync").mockResolvedValueOnce(undefined);

    await expect(deleteModelFileChecked(target)).rejects.toThrow(/still exists/);
    // The file really is still there — proving the check caught a silent no-op delete.
    expect((await fileSystemMock.getInfoAsync(target)).exists).toBe(true);
  });
});

// Finding 2: `prepareCustomModelDownload` — malformed percent escapes fail gracefully (no unhandled
// rejection), userinfo is rejected, and the persisted `sourceUrl` is redacted to origin+pathname so a
// pasted `?token=…`/credential is never written to the plain JSON store.
describe("prepareCustomModelDownload — parsing, authorization & credential redaction (Finding 2)", () => {
  it("accepts a plain allowlisted https URL and returns the full download URL + redacted source", () => {
    const result = prepareCustomModelDownload("https://huggingface.co/org/repo/model.gguf");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.downloadUrl).toBe("https://huggingface.co/org/repo/model.gguf");
    expect(result.sourceUrl).toBe("https://huggingface.co/org/repo/model.gguf");
    expect(result.displayName).toBe("model.gguf");
    expect(result.fileName).toBe("model.gguf");
  });

  it("a malformed percent-escape ('https://huggingface.co/%') fails GRACEFULLY (no unhandled rejection)", () => {
    // `new URL(...)` accepts this, but `decodeURIComponent('%')` throws — the inline version let that
    // reject the whole press handler. The pure helper returns a clean error instead.
    const result = prepareCustomModelDownload("https://huggingface.co/%");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/file name isn't valid/);
  });

  it("rejects userinfo credentials in the URL ('user:pass@host')", () => {
    const result = prepareCustomModelDownload("https://user:pass@huggingface.co/x.gguf");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/username\/password/);
  });

  it("a '?token=secret' query is stripped from the PERSISTED sourceUrl (no credential at rest) but kept for the download", () => {
    const result = prepareCustomModelDownload("https://huggingface.co/x.gguf?token=secret#frag");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Persisted metadata carries NO token/query/hash — only origin + pathname.
    expect(result.sourceUrl).toBe("https://huggingface.co/x.gguf");
    expect(result.sourceUrl).not.toContain("token");
    expect(result.sourceUrl).not.toContain("secret");
    // …but the actual fetch still uses the full authorized URL.
    expect(result.downloadUrl).toBe("https://huggingface.co/x.gguf?token=secret#frag");
  });

  it("rejects non-https and off-allowlist hosts", () => {
    expect(prepareCustomModelDownload("http://huggingface.co/x.gguf").ok).toBe(false);
    expect(prepareCustomModelDownload("https://evil-huggingface.co/x.gguf").ok).toBe(false);
    expect(prepareCustomModelDownload("https://huggingface.co.attacker.example/x.gguf").ok).toBe(false);
    // A subdomain of the allowlisted host is fine.
    expect(prepareCustomModelDownload("https://cdn-lfs.huggingface.co/x.gguf").ok).toBe(true);
  });

  it("rejects an unparsable URL and an empty input", () => {
    expect(prepareCustomModelDownload("not a url").ok).toBe(false);
    expect(prepareCustomModelDownload("   ").ok).toBe(false);
  });

  it("appends .gguf when the path segment lacks it", () => {
    const result = prepareCustomModelDownload("https://huggingface.co/org/repo/resolve/main/mymodel");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fileName).toBe("mymodel.gguf");
    expect(result.displayName).toBe("mymodel");
  });
});

// Finding 2: a download whose bytes landed but couldn't be registered is discarded with a CHECKED delete;
// if that cleanup ALSO fails the URI is retained in a module-level SET (not a scalar), and no new download
// may start until every retained orphan is confirmed gone. This is the registry both the catalog and custom
// paths funnel their registration-failure cleanup through, so an orphan can never accumulate.
describe("retained-orphan registry — discard + clear-first guard (Finding 2)", () => {
  const orphan1 = `${MODELS_DIR}orphan-1.gguf`;
  const orphan2 = `${MODELS_DIR}orphan-2.gguf`;

  beforeEach(async () => {
    resetFileSystemMock();
    // Drain any orphan URIs retained by a previous test (the registry is module-level). With a fresh mock
    // the files are absent, so each checked delete is an idempotent no-op success and drops from the set.
    await clearRetainedOrphans();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("catalog/custom success-then-persist-fail with a SUCCESSFUL cleanup leaves NO orphan", async () => {
    seedModelsDir(orphan1);

    const result = await discardUnregisteredDownload(orphan1);

    expect(result.removed).toBe(true);
    expect((await fileSystemMock.getInfoAsync(orphan1)).exists).toBe(false);
    expect(retainedOrphanCount()).toBe(0);
    // Nothing retained → a subsequent download is unblocked.
    expect(await clearRetainedOrphans()).toEqual({ ok: true });
  });

  it("a FAILED cleanup retains the URI and blocks every later download until it can be removed", async () => {
    seedModelsDir(orphan1);
    failFileSystemUri(orphan1, new Error("EROFS: read-only file system"));

    const result = await discardUnregisteredDownload(orphan1);

    expect(result.removed).toBe(false);
    expect(retainedOrphanCount()).toBe(1);
    // The clean-first guard reports NOT ok while the orphan can't be removed — the caller must abort.
    const blocked = await clearRetainedOrphans();
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toMatch(/read-only/);
    expect(retainedOrphanCount()).toBe(1);

    // Once the filesystem lets the delete through, the guard clears it and unblocks downloads.
    clearFileSystemFailure(orphan1);
    expect(await clearRetainedOrphans()).toEqual({ ok: true });
    expect(retainedOrphanCount()).toBe(0);
    expect((await fileSystemMock.getInfoAsync(orphan1)).exists).toBe(false);
  });

  it("multiple retained URIs don't overwrite each other (a SET, not a scalar)", async () => {
    seedModelsDir(orphan1, orphan2);
    failFileSystemUri(orphan1, new Error("orphan-1 stuck"));
    failFileSystemUri(orphan2, new Error("orphan-2 stuck"));

    expect((await discardUnregisteredDownload(orphan1)).removed).toBe(false);
    expect((await discardUnregisteredDownload(orphan2)).removed).toBe(false);
    // Both retained — the second did NOT clobber the first (a scalar retained-uri would have lost orphan1).
    expect(retainedOrphanCount()).toBe(2);

    // Clear only orphan2's failure: clearRetainedOrphans removes it, keeps orphan1, reports NOT ok.
    clearFileSystemFailure(orphan2);
    const partial = await clearRetainedOrphans();
    expect(partial.ok).toBe(false);
    // orphan2 removed + dropped; orphan1 still stuck (its failure is still injected) so still retained.
    expect(retainedOrphanCount()).toBe(1);
    expect((await fileSystemMock.getInfoAsync(orphan2)).exists).toBe(false);

    // Clear the last one → the guard drains fully and downloads are unblocked.
    clearFileSystemFailure(orphan1);
    expect(await clearRetainedOrphans()).toEqual({ ok: true });
    expect(retainedOrphanCount()).toBe(0);
  });
});
