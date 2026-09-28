import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cachedBlockListFor, persistBlockList } from "./blocks";
import { clearAllRecords, destroyDatabase, getAllRecords, markLocalStoreWiped, resetLocalStoreForTests } from "./local-store";

// The cached block list (pre-release review 2026-09-25 #4): it must be readable on a cold boot for the
// identity it belongs to, and gone after both purges — the identity-change purge and the wipe.

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetLocalStoreForTests();
});

afterEach(async () => {
  await destroyDatabase().catch(() => undefined);
  resetLocalStoreForTests();
});

async function cached(userId: string | undefined): Promise<ReadonlySet<string> | undefined> {
  return cachedBlockListFor(await getAllRecords<{ id: string }>("sync"), userId);
}

describe("cached block list", () => {
  it("round-trips for its own identity only", async () => {
    await persistBlockList("user.me", new Set(["user.troll"]));
    expect(await cached("user.me")).toEqual(new Set(["user.troll"]));
    expect(await cached("user.other")).toBeUndefined();
    expect(await cached(undefined)).toBeUndefined();
  });

  it("is cleared by the identity-change purge", async () => {
    await persistBlockList("user.me", new Set(["user.troll"]));
    await clearAllRecords();
    expect(await cached("user.me")).toBeUndefined();
  });

  it("is deleted by a wipe, and a write after the wipe latch is dropped", async () => {
    await persistBlockList("user.me", new Set(["user.troll"]));
    markLocalStoreWiped();
    await destroyDatabase();
    await persistBlockList("user.me", new Set(["user.troll"])); // an in-flight fetch landing mid-wipe
    resetLocalStoreForTests();
    expect(await cached("user.me")).toBeUndefined();
  });

  it("reads a malformed record as nothing cached", () => {
    expect(cachedBlockListFor([{ id: "blockList", userId: "user.me", blockedUserIds: "x" } as { id: string }], "user.me")).toBeUndefined();
  });
});
