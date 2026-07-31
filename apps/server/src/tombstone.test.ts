import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { buildApp, type AppOptions, type LoamApp } from "./app.js";
import { openStore, type LoamStore } from "./db.js";

// ---------------------------------------------------------------------------
// Horizon-based tombstone GC (docs/15 #7).
//
// A tombstone is written on EVERY local delete (unconditionally — never gated on `sync.enabled`) so
// node-to-node sync / mesh carriers can't re-hand a locally deleted message back. Left unbounded the
// table grows forever on a long-lived node, so a horizon GC prunes tombstones older than a window
// comfortably longer than any realistic sync interval. These tests pin the two moving parts:
//   - the DAL primitive (`pruneTombstonesOlderThan`), which both prunes the DB and RETURNS the pruned
//     ids so the caller can reconcile its in-memory mirror;
//   - the app-level GC pass (`pruneTombstonesHorizon`, run by `reapExpiredMessages`), which keeps the
//     in-memory `tombstones` Set and the DB in agreement — proven behaviourally via sync resurrection.
// ---------------------------------------------------------------------------

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

/** Open an in-memory DAL store, registering it for teardown. */
function makeStore(): LoamStore {
  const store = openStore(":memory:");
  cleanups.push(() => store.close());
  return store;
}

describe("tombstone GC — DAL layer (pruneTombstonesOlderThan)", () => {
  it("keeps a freshly stamped tombstone (a past cutoff prunes nothing)", () => {
    const store = makeStore();
    store.addTombstone("msg_fresh");

    // `addTombstone` stamps `created_at = now`, so a cutoff even one minute in the past is older than
    // the tombstone → it survives GC.
    const pruned = store.pruneTombstonesOlderThan(Date.now() - 60_000);

    expect(pruned).toEqual([]);
    expect(store.loadTombstones()).toEqual(["msg_fresh"]);
  });

  it("removes a tombstone stamped before the horizon cutoff, and returns it for reconciliation", () => {
    const store = makeStore();
    store.addTombstone("msg_old");
    store.addTombstone("msg_recent");

    // A cutoff in the future stands in for a tombstone aged past the horizon without mocking the clock.
    // The pruned ids MUST be returned — that return value is exactly how the app reconciles its
    // in-memory Set after the DB delete.
    const pruned = store.pruneTombstonesOlderThan(Date.now() + 60_000);

    expect(pruned.sort()).toEqual(["msg_old", "msg_recent"]);
    expect(store.loadTombstones()).toEqual([]);
  });

  it("prunes only the tombstones older than the cutoff, leaving newer ones intact", () => {
    // Manufacture two distinct ages on a file-backed store by pinning one tombstone's `created_at`
    // into the deep past directly on the table, then GC with a cutoff that falls between the two ages.
    const dataDir = mkdtempSync(join(tmpdir(), "loam-tombstone-ages-"));
    const dbPath = join(dataDir, "loam.db");
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));

    const store = openStore(dbPath);
    cleanups.push(() => store.close());
    store.addTombstone("msg_old");
    store.addTombstone("msg_new");

    // Age "msg_old" to the epoch; "msg_new" keeps its ~now stamp.
    const raw = new DatabaseSync(dbPath);
    raw.prepare("UPDATE tombstones SET created_at = 1 WHERE message_id = ?").run("msg_old");
    raw.close();

    const pruned = store.pruneTombstonesOlderThan(Date.now() - 60_000);

    expect(pruned).toEqual(["msg_old"]);
    expect(store.loadTombstones()).toEqual(["msg_new"]);
  });

  it("migrates a pre-horizon-GC tombstones table (no created_at column) cleanly and keeps working", () => {
    // A database created before horizon GC existed has a bare `tombstones (message_id)` table with no
    // `created_at`. `CREATE TABLE IF NOT EXISTS` is a no-op on it, so only the ALTER-based migration in
    // `openStore` adds the column; existing rows are backfilled to "now" (the safe direction — starts
    // their horizon clock fresh rather than expiring an old delete early).
    const dataDir = mkdtempSync(join(tmpdir(), "loam-tombstone-migration-"));
    const dbPath = join(dataDir, "loam.db");
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));

    // Materialise the DB file with the current schema, then reshape `tombstones` to the legacy form.
    const initial = openStore(dbPath);
    initial.close();

    const raw = new DatabaseSync(dbPath);
    raw.exec("DROP TABLE tombstones");
    raw.exec("CREATE TABLE tombstones (message_id TEXT PRIMARY KEY)");
    raw.prepare("INSERT INTO tombstones (message_id) VALUES (?)").run("msg_legacy");
    raw.close();

    // Reopen through `openStore`, which runs `migrateTombstonesCreatedAt`.
    const reopened = openStore(dbPath);
    cleanups.push(() => reopened.close());

    // The legacy row survived the migration and is fully usable under the new column semantics.
    expect(reopened.loadTombstones()).toEqual(["msg_legacy"]);
    // Backfilled to "now" → not immediately prunable with a past cutoff…
    expect(reopened.pruneTombstonesOlderThan(Date.now() - 60_000)).toEqual([]);
    expect(reopened.loadTombstones()).toEqual(["msg_legacy"]);
    // …and a new tombstone still writes correctly on the migrated table.
    reopened.addTombstone("msg_after_migration");
    expect(reopened.loadTombstones().sort()).toEqual(["msg_after_migration", "msg_legacy"]);
    // A future cutoff prunes both, proving the whole table participates in GC post-migration.
    expect(reopened.pruneTombstonesOlderThan(Date.now() + 60_000).sort()).toEqual([
      "msg_after_migration",
      "msg_legacy",
    ]);
    expect(reopened.loadTombstones()).toEqual([]);
  });
});

describe("tombstone GC — app layer (reconciles the in-memory Set with the DB)", () => {
  /** Build an app on a throwaway data dir, registering it for teardown. */
  async function makeApp(config: unknown, opts?: Partial<AppOptions>): Promise<LoamApp & { dataDir: string }> {
    const dataDir = mkdtempSync(join(tmpdir(), "loam-tombstone-app-"));
    writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
    const app = await buildApp({ dataDir, logger: false, maxNewIdentitiesPerWindow: 1_000_000, ...opts });
    cleanups.push(async () => {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    });
    return { ...app, dataDir };
  }

  function sessionCookie(setCookie: string | string[] | undefined): string {
    const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const cookie = first?.split(";")[0];
    if (!cookie?.startsWith("loam_session=")) {
      throw new Error("No session cookie in response");
    }
    return cookie;
  }

  async function newAdmin(app: LoamApp): Promise<string> {
    const response = await app.server.inject({ method: "GET", url: "/api/config" });
    return sessionCookie(response.headers["set-cookie"]);
  }

  async function post(app: LoamApp, cookie: string, body: string): Promise<string> {
    const response = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie },
      payload: { type: "channelPost", channelId: "general", body },
    });
    return (response.json() as { message: { id: string } }).message.id;
  }

  async function generalBodies(app: LoamApp, cookie: string): Promise<string[]> {
    const response = await app.server.inject({ method: "GET", url: "/api/messages/general", headers: { cookie } });
    return (response.json() as { body?: string }[]).map((message) => message.body ?? "");
  }

  const syncConfig = (peers: { url: string }[]) => ({
    sync: { enabled: true, peers, intervalMs: 3_600_000 },
  });

  it("GC past the horizon drops the tombstone from both the DB and the in-memory Set (sync can resurrect)", async () => {
    // Source node holds the message; it stays a live copy the puller can pull back.
    const source = await makeApp(syncConfig([]));
    const sourceAdmin = await newAdmin(source);
    await post(source, sourceAdmin, "delete me locally");
    const sourceUrl = await source.server.listen({ port: 0, host: "127.0.0.1" });

    // Puller with a tiny horizon so the GC boundary is exercised in-test rather than after 30 days.
    const puller = await makeApp(syncConfig([{ url: sourceUrl }]), { tombstoneHorizonMs: 60 });
    const pullerAdmin = await newAdmin(puller);
    await puller.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie: pullerAdmin } });
    expect(await generalBodies(puller, pullerAdmin)).toContain("delete me locally");

    const doomedId = puller.store.loadMessages().find((m) => "body" in m && m.body === "delete me locally")!.id;

    // Delete locally → tombstone lands in BOTH the DB and the in-memory Set.
    await puller.server.inject({ method: "DELETE", url: `/api/messages/${doomedId}`, headers: { cookie: pullerAdmin } });
    expect(puller.store.loadTombstones()).toContain(doomedId);

    // Within the horizon: GC leaves the tombstone in place (DB), and the Set still blocks re-import.
    puller.reapExpiredMessages();
    expect(puller.store.loadTombstones()).toContain(doomedId);
    await puller.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie: pullerAdmin } });
    expect(await generalBodies(puller, pullerAdmin)).not.toContain("delete me locally");

    // Past the horizon: GC prunes the tombstone. Both mirrors must agree it is gone —
    //   • DB side: `loadTombstones()` no longer lists it;
    //   • Set side: sync resurrects the message (the diff skips only ids still in the in-memory Set,
    //     so re-import PROVES the Set was reconciled, not just the DB).
    await new Promise((resolve) => setTimeout(resolve, 80));
    puller.reapExpiredMessages();
    expect(puller.store.loadTombstones()).not.toContain(doomedId);
    await puller.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie: pullerAdmin } });
    expect(await generalBodies(puller, pullerAdmin)).toContain("delete me locally");
  });

  it("tombstoning is unconditional — a delete with sync OFF still blocks a later peer re-import", async () => {
    // The message exists on a peer that WILL be synced from later.
    const source = await makeApp(syncConfig([]));
    const sourceAdmin = await newAdmin(source);
    await post(source, sourceAdmin, "moderated away");
    const sourceUrl = await source.server.listen({ port: 0, host: "127.0.0.1" });

    // Puller pulls the message while sync is on, then we simulate "sync was off at delete time" by
    // asserting the tombstone is written regardless: the delete path never checks `sync.enabled`.
    const puller = await makeApp(syncConfig([{ url: sourceUrl }]), { tombstoneHorizonMs: 30 * 24 * 60 * 60 * 1000 });
    const pullerAdmin = await newAdmin(puller);
    await puller.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie: pullerAdmin } });
    const doomedId = puller.store.loadMessages().find((m) => "body" in m && m.body === "moderated away")!.id;

    await puller.server.inject({ method: "DELETE", url: `/api/messages/${doomedId}`, headers: { cookie: pullerAdmin } });

    // Tombstone present, and a horizon GC well inside the window is a no-op (nothing to reconcile).
    expect(puller.store.loadTombstones()).toContain(doomedId);
    puller.reapExpiredMessages();
    expect(puller.store.loadTombstones()).toContain(doomedId);

    // The peer still holds it, but a re-sync must NOT re-import — the tombstone (Set) blocks it.
    await puller.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie: pullerAdmin } });
    expect(await generalBodies(puller, pullerAdmin)).not.toContain("moderated away");
  });
});
