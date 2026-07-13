import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  deleteRecord,
  destroyDatabase,
  getAllRecords,
  markLocalStoreWiped,
  putRecord,
  putRecords,
  recoverPendingWipe,
  resetLocalStoreForTests,
} from "./local-store";

// Each test gets a fresh in-memory IndexedDB. The module caches its connection promise across calls
// and latches a wipe flag, so we reset both between tests to simulate a fresh page load.
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetLocalStoreForTests();
});

afterEach(async () => {
  await destroyDatabase().catch(() => undefined);
});

type Channel = { id: string; name: string };

describe("local-store", () => {
  it("round-trips records through put and getAll", async () => {
    await putRecords<Channel>("channels", [
      { id: "general", name: "General" },
      { id: "announcements", name: "Announcements" },
    ]);

    const channels = await getAllRecords<Channel>("channels");
    expect(channels).toHaveLength(2);
    expect(channels.map((channel) => channel.id).sort()).toEqual(["announcements", "general"]);
  });

  it("overwrites a record with the same id (put semantics)", async () => {
    await putRecord<Channel>("channels", { id: "general", name: "General" });
    await putRecord<Channel>("channels", { id: "general", name: "Renamed" });

    const channels = await getAllRecords<Channel>("channels");
    expect(channels).toEqual([{ id: "general", name: "Renamed" }]);
  });

  it("deletes a record by id", async () => {
    await putRecords<Channel>("channels", [
      { id: "general", name: "General" },
      { id: "gone", name: "Gone" },
    ]);
    await deleteRecord("channels", "gone");

    const channels = await getAllRecords<Channel>("channels");
    expect(channels.map((channel) => channel.id)).toEqual(["general"]);
  });

  it("returns an empty array for an empty store", async () => {
    expect(await getAllRecords<Channel>("messages")).toEqual([]);
  });

  it("destroyDatabase wipes all data (the kill-switch purge)", async () => {
    await putRecords<Channel>("channels", [{ id: "general", name: "General" }]);
    await putRecords("messages", [{ id: "m1" }, { id: "m2" }]);

    await destroyDatabase();

    // Reopen on the SAME factory: the data written above must be gone (destroyDatabase deleted the
    // database and cleared the cached connection, so this opens a fresh empty one). Swapping in a
    // new factory here would trivially pass without proving the purge did anything.
    expect(await getAllRecords<Channel>("channels")).toEqual([]);
    expect(await getAllRecords("messages")).toEqual([]);
  });

  it("putRecords with an empty array is a no-op", async () => {
    await putRecords<Channel>("channels", []);
    expect(await getAllRecords<Channel>("channels")).toEqual([]);
  });

  it("stops writes after the wipe latch, so an in-flight fetch can't rebuild the DB (docs/15 #4)", async () => {
    await putRecords<Channel>("channels", [{ id: "general", name: "General" }]);

    markLocalStoreWiped();

    // A racing write that resolves after the wipe is a no-op, and reads are gated (no re-open).
    await putRecords<Channel>("channels", [{ id: "late", name: "Late" }]);
    await putRecord<Channel>("channels", { id: "late2", name: "Late2" });
    await deleteRecord("channels", "general");
    expect(await getAllRecords<Channel>("channels")).toEqual([]);

    // After a reload (latch cleared) the late writes never persisted — only the pre-wipe record.
    resetLocalStoreForTests();
    expect((await getAllRecords<Channel>("channels")).map((channel) => channel.id)).toEqual(["general"]);
  });

  describe("durable wipe-pending flag (docs/20 — survives reload)", () => {
    const WIPE_PENDING_KEY = "loam.wipePending";

    it("markLocalStoreWiped persists the flag; destroyDatabase clears it once deletion succeeds", async () => {
      await putRecord<Channel>("channels", { id: "c1", name: "One" });
      markLocalStoreWiped();
      expect(localStorage.getItem(WIPE_PENDING_KEY)).toBe("1"); // persisted, so a reload can't rehydrate
      await destroyDatabase(); // single connection in the test → succeeds
      expect(localStorage.getItem(WIPE_PENDING_KEY)).toBeNull(); // cleared only on actual deletion
    });

    it("recoverPendingWipe latches the store and completes the pending deletion, clearing the flag", async () => {
      // A prior wipe set the durable flag (still pending). Boot recovery must latch the store (so nothing
      // hydrates) and finish the deletion, clearing the flag once it lands.
      await putRecord<Channel>("channels", { id: "c1", name: "One" });
      markLocalStoreWiped(); // persists the flag + latch, as the wipe flow does
      expect(localStorage.getItem(WIPE_PENDING_KEY)).toBe("1");

      await recoverPendingWipe(); // closes the connection, deletes the DB, clears the flag
      expect(localStorage.getItem(WIPE_PENDING_KEY)).toBeNull();
      expect(await getAllRecords<Channel>("channels")).toEqual([]); // gone + latched
    });

    it("recoverPendingWipe is a no-op when no wipe is pending", async () => {
      await recoverPendingWipe();
      expect(localStorage.getItem(WIPE_PENDING_KEY)).toBeNull();
    });
  });

  describe("cross-tab (docs/20 round-4 Medium)", () => {
    it("closes its connection on versionchange so a sibling tab's deletion is NOT blocked", async () => {
      await putRecord<Channel>("channels", { id: "c1", name: "One" }); // opens a connection (with onversionchange)

      // A "sibling tab" deletes the DB directly (bypassing local-store). Without the versionchange handler
      // this would block on our still-open connection; with it, our connection closes and the deletion lands.
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase("loam-poc");
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error("blocked — the versionchange handler did not close the connection"));
      });

      // Our store latched itself in the versionchange handler → it won't rehydrate the DB the sibling erased.
      expect(await getAllRecords<Channel>("channels")).toEqual([]);
    });
  });
});
