import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deleteRecord, destroyDatabase, getAllRecords, putRecord, putRecords } from "./local-store";

// Each test gets a fresh in-memory IndexedDB. The module caches its connection promise across calls,
// so we also destroy the DB (which clears that cache) between tests.
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
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
});
