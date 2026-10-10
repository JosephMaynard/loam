import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type AppOptions, type LoamApp } from "./app.js";
import { openStore } from "./db.js";
import {
  cleanups,
  type InjectResponse,
  newSession,
  readJournalConfig,
  readJournalPhase,
  recoverySnapshots,
  sessionCookie,
  teardownApps,
} from "./test-support/app-harness.js";
import {
  backupCapture,
  configWriteFailures,
  lstatFailure,
  openSyncFailure,
  postRekeyCleanupFailure,
  premigrationDeleteFailure,
  readdirFailure,
  readFileSyncFailure,
  renameFailure,
  resetFsFaults,
  rmGate,
  rmSyncCapture,
  wipeMarkerWriteFailure,
} from "./test-support/fs-faults.js";

// `node:fs` fault-injection seams (inert unless a test arms one): see test-support/fs-faults.ts.
vi.mock("node:fs", async (importOriginal) =>
  (await import("./test-support/fs-faults.js")).faultyFs(await importOriginal()),
);
vi.mock("node:fs/promises", async (importOriginal) =>
  (await import("./test-support/fs-faults.js")).faultyFsPromises(await importOriginal()),
);

afterEach(async () => {
  resetFsFaults();
  await teardownApps();
});

describe("encryption at rest + key-discard kill switch", () => {
  // Build directly (not via makeApp) so `app.store` stays the live getter across an encrypted wipe.
  async function makeEncryptedApp(
    opts: Pick<AppOptions, "dbEncryptionKey" | "ephemeralDbKey" | "dbEncryptionMode">,
    config?: unknown,
  ): Promise<{ app: LoamApp; dataDir: string }> {
    const dataDir = mkdtempSync(join(tmpdir(), "loam-enc-app-test-"));
    if (config !== undefined) {
      writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
    }
    const app = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false, ...opts });
    cleanups.push(async () => {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    });
    return { app, dataDir };
  }

  async function session(app: LoamApp) {
    const response = await app.server.inject({ method: "GET", url: "/api/config" });
    return {
      cookie: sessionCookie(response),
      user: (response.json() as { currentUser: { id: string; isAdmin: boolean } }).currentUser,
    };
  }

  async function post(app: LoamApp, cookie: string, body: string) {
    return app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie },
      payload: { type: "channelPost", channelId: "general", body },
    });
  }

  function dataDirHasPlaintext(dataDir: string, needle: string): boolean {
    const target = Buffer.from(needle);
    return readdirSync(dataDir)
      .filter((name) => name.startsWith("loam.db"))
      .some((name) => readFileSync(join(dataDir, name)).includes(target));
  }

  it("ephemeral mode writes an encrypted database (no plaintext on disk)", async () => {
    const { app, dataDir } = await makeEncryptedApp({ ephemeralDbKey: true });
    const admin = await session(app);
    expect((await post(app, admin.cookie, "EPHEMERAL_PLAINTEXT_NEEDLE")).statusCode).toBe(201);

    expect(dataDirHasPlaintext(dataDir, "EPHEMERAL_PLAINTEXT_NEEDLE")).toBe(false);
    expect(readFileSync(join(dataDir, "loam.db")).subarray(0, 15).toString("ascii")).not.toBe(
      "SQLite format 3",
    );
  });

  it("kill switch on an ephemeral-key node empties data, rotates the file, and the node recovers", async () => {
    const { app, dataDir } = await makeEncryptedApp(
      { ephemeralDbKey: true },
      { killSwitch: { enabled: true } },
    );
    const admin = await session(app);
    expect(admin.user.isAdmin).toBe(true);
    expect((await post(app, admin.cookie, "DOOMED_SECRET_NEEDLE")).statusCode).toBe(201);

    const before = readFileSync(join(dataDir, "loam.db"));

    const wipe = await app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    expect(wipe.statusCode).toBe(200);
    // The journal written ahead of the rotation is cleared once the fresh store is loaded.
    expect(existsSync(join(dataDir, ".loam-wipe-phase"))).toBe(false);

    // Live getter → the reopened store. Old message gone; node re-seeded and usable.
    expect(app.store.loadMessages()).toEqual([]);
    expect(dataDirHasPlaintext(dataDir, "DOOMED_SECRET_NEEDLE")).toBe(false);
    const after = readFileSync(join(dataDir, "loam.db"));
    expect(after.equals(before)).toBe(false); // fresh key ⇒ entirely different ciphertext
    expect(after.subarray(0, 15).toString("ascii")).not.toBe("SQLite format 3");

    const returning = await session(app);
    expect(returning.user.isAdmin).toBe(true); // firstUser bootstrap re-applies on the fresh node
    expect((await post(app, returning.cookie, "after wipe")).statusCode).toBe(201);
  });

  it("journals an ephemeral-key wipe before it starts, so a wipe that fails after the journal is finished by the next boot", async () => {
    const { app, dataDir } = await makeEncryptedApp({ ephemeralDbKey: true }, { killSwitch: { enabled: true } });
    const admin = await session(app);
    expect(
      (
        await app.server.inject({
          method: "PATCH",
          url: "/api/admin/config",
          headers: { cookie: admin.cookie },
          payload: { retention: { messageTtlMs: 3_600_000 } },
        })
      ).statusCode,
    ).toBe(200);
    expect((await post(app, admin.cookie, "EPHEMERAL_MUST_NOT_OUTLIVE_THE_RESET")).statusCode).toBe(201);

    // The store refuses to close (the branch's first step after the journal), so this run deletes nothing.
    const store = app.store;
    const realClose = store.close.bind(store);
    store.close = () => {
      store.close = realClose;
      throw new Error("I/O error");
    };
    const wipe = await app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    expect(wipe.statusCode).toBe(503);
    expect((wipe.json() as { error: string }).error).toMatch(/restart it to finish the wipe/i);
    expect(readJournalPhase(dataDir)).toBe("delete-pending");
    expect(readJournalConfig(dataDir)?.retention).toMatchObject({ messageTtlMs: 3_600_000 });
    expect(existsSync(join(dataDir, "loam.db"))).toBe(true);
    expect(
      (await app.server.inject({ method: "GET", url: "/api/channels", headers: { cookie: admin.cookie } })).statusCode,
    ).toBe(503);
    await app.close();

    // The restart (a new random key, as on every ephemeral boot) finishes the wipe before it serves.
    const restarted = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false, ephemeralDbKey: true });
    cleanups.push(() => restarted.close());
    expect(existsSync(join(dataDir, ".loam-wipe-phase"))).toBe(false);
    expect(restarted.store.loadMessages()).toEqual([]);
    const fresh = await session(restarted);
    expect(fresh.user.isAdmin).toBe(true);
    const search = await restarted.server.inject({
      method: "GET",
      url: "/api/search?q=EPHEMERAL_MUST_NOT_OUTLIVE_THE_RESET",
      headers: { cookie: fresh.cookie },
    });
    expect((search.json() as { results: unknown[] }).results).toEqual([]);
    const config = (
      await restarted.server.inject({ method: "GET", url: "/api/admin/config", headers: { cookie: fresh.cookie } })
    ).json() as { killSwitch: { enabled: boolean }; retention: { messageTtlMs?: number } };
    expect(config.killSwitch.enabled).toBe(true);
    expect(config.retention.messageTtlMs).toBe(3_600_000);
  });

  it("an Android-style ephemeral boot (ephemeralDbKey + dbEncryptionMode, as embedded.ts " +
    "now derives them) reports the effective posture immediately AND rotates the key on kill switch", async () => {
    // Mirrors exactly what the fixed `embedded.ts` passes for a real ephemeral session: `ephemeralDbKey`
    // is already resolved true (via `resolveEphemeralDbKey`) and `dbEncryptionMode` carries the
    // launcher's declared mode — `dbEncryptionKey` is never set for this path (a real ephemeral session
    // discards whatever hex key LOAM_DB_KEY carried).
    const { app, dataDir } = await makeEncryptedApp(
      { ephemeralDbKey: true, dbEncryptionMode: "ephemeral" },
      { killSwitch: { enabled: true } },
    );
    const admin = await session(app);

    // The wire reports "ephemeral" from the FIRST request — no admin PATCH of the declarative
    // `security.dbEncryption` axis (which defaults "off") is needed to make this true.
    const before = (await app.server.inject({ method: "GET", url: "/api/config" })).json() as {
      networkConfig: { dbEncryption: string };
    };
    expect(before.networkConfig.dbEncryption).toBe("ephemeral");

    expect((await post(app, admin.cookie, "ANDROID_EPHEMERAL_NEEDLE")).statusCode).toBe(201);
    const beforeWipeFile = readFileSync(join(dataDir, "loam.db"));

    // executeKillSwitch's `ephemeralDbKey` branch actually rotates the key for this
    // scenario (the old embedded.ts, checking only the LOAM_DB_KEY==="ephemeral" literal, would have
    // left `ephemeralDbKey` false here and skipped rotation entirely).
    const wipe = await app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    expect(wipe.statusCode).toBe(200);

    expect(app.store.loadMessages()).toEqual([]);
    const afterWipeFile = readFileSync(join(dataDir, "loam.db"));
    expect(afterWipeFile.equals(beforeWipeFile)).toBe(false); // fresh key ⇒ entirely different ciphertext

    // Posture still reports "ephemeral" post-wipe (still encrypted, mode unchanged).
    const after = (await app.server.inject({ method: "GET", url: "/api/config" })).json() as {
      networkConfig: { dbEncryption: string };
    };
    expect(after.networkConfig.dbEncryption).toBe("ephemeral");
  });

  it("a boot-resolved dbEncryptionMode (passphrase/persistent) is reported without an admin PATCH", async () => {
    const { app } = await makeEncryptedApp({
      dbEncryptionKey: "a fixed host passphrase",
      dbEncryptionMode: "persistent",
    });

    const config = (await app.server.inject({ method: "GET", url: "/api/config" })).json() as {
      networkConfig: { dbEncryption: string };
    };
    expect(config.networkConfig.dbEncryption).toBe("persistent");
  });

  it("kill switch on a passphrase-key node also empties and recovers", async () => {
    const { app } = await makeEncryptedApp(
      { dbEncryptionKey: "a fixed host passphrase" },
      { killSwitch: { enabled: true } },
    );
    const admin = await session(app);
    await post(app, admin.cookie, "doomed");

    const wipe = await app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    expect(wipe.statusCode).toBe(200);
    expect(app.store.loadMessages()).toEqual([]);
    expect((await post(app, (await session(app)).cookie, "after")).statusCode).toBe(201);
  });

  /** Install the launcher's `globalThis.__loamRequestWipeRestart` hook and record every
   *  invocation. Auto-uninstalled via the module-level `cleanups` array. */
  function installFakeWipeRestartHook(): { calls: number } {
    const state = { calls: 0 };
    (globalThis as unknown as { __loamRequestWipeRestart?: () => void }).__loamRequestWipeRestart = () => {
      state.calls += 1;
    };
    cleanups.push(() => {
      delete (globalThis as unknown as { __loamRequestWipeRestart?: unknown }).__loamRequestWipeRestart;
    });
    return state;
  }

  it("persistent-mode executeKillSwitch deletes the DB files and does NOT recreate in-process — it hands off to the launcher's wipe-restart hook instead", async () => {
    const hook = installFakeWipeRestartHook();
    const { app, dataDir } = await makeEncryptedApp(
      { dbEncryptionKey: "a fixed persistent key", dbEncryptionMode: "persistent" },
      { killSwitch: { enabled: true } },
    );
    const admin = await session(app);
    expect((await post(app, admin.cookie, "doomed under a fixed key")).statusCode).toBe(201);
    expect(existsSync(join(dataDir, "loam.db"))).toBe(true);

    const wipe = await app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    expect(wipe.statusCode).toBe(200);

    // The launcher hook was invoked exactly once — it owns clearing the Keystore key and restarting
    // the embedded runtime from here; this process must not try to obtain a new key itself.
    expect(hook.calls).toBe(1);

    // The DB files are gone and were NOT recreated in-process (this process has no way to mint the new
    // key the launcher's restart will resolve) — a bare delete, unlike the ephemeral/off paths below.
    expect(existsSync(join(dataDir, "loam.db"))).toBe(false);
    expect(existsSync(join(dataDir, "loam.db-wal"))).toBe(false);
    expect(existsSync(join(dataDir, "loam.db-shm"))).toBe(false);

    // Avatars/attachments still get cleaned up even on this early-return branch (they're plain
    // filesystem, not store-dependent).
    expect(existsSync(join(dataDir, "avatars"))).toBe(false);
    expect(existsSync(join(dataDir, "attachments"))).toBe(false);
  });

  it("passphrase-mode executeKillSwitch also hands off to the wipe-restart hook rather than recreating under the same key", async () => {
    const hook = installFakeWipeRestartHook();
    const { app, dataDir } = await makeEncryptedApp(
      { dbEncryptionKey: "a fixed passphrase-derived key", dbEncryptionMode: "passphrase" },
      { killSwitch: { enabled: true } },
    );
    const admin = await session(app);
    expect((await post(app, admin.cookie, "doomed")).statusCode).toBe(201);

    const wipe = await app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    expect(wipe.statusCode).toBe(200);

    expect(hook.calls).toBe(1);
    expect(existsSync(join(dataDir, "loam.db"))).toBe(false);
  });

  it("persistent-mode wipe-restart takes effect immediately (503 on everything but /api/health) instead of leaving the running process serving stale in-memory content until a manual restart", async () => {
    const hook = installFakeWipeRestartHook();
    const { app } = await makeEncryptedApp(
      { dbEncryptionKey: "a fixed persistent key", dbEncryptionMode: "persistent" },
      { killSwitch: { enabled: true } },
    );
    const admin = await session(app);
    expect((await post(app, admin.cookie, "still readable before the wipe?")).statusCode).toBe(201);

    // Sanity: before the wipe, the admin's cookie sees the node's data as normal.
    const before = await app.server.inject({
      method: "GET",
      url: "/api/channels",
      headers: { cookie: admin.cookie },
    });
    expect(before.statusCode).toBe(200);

    const wipe = await app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    expect(wipe.statusCode).toBe(200);
    expect(hook.calls).toBe(1);

    // The SAME still-valid-looking cookie must not see any in-memory content: no stale 200 while this
    // process waits for the launcher to actually restart it.
    const afterWithCookie = await app.server.inject({
      method: "GET",
      url: "/api/channels",
      headers: { cookie: admin.cookie },
    });
    expect(afterWithCookie.statusCode).toBe(503);

    // A brand-new (cookie-less) request is refused identically — it must not mint a fresh identity or
    // see any re-seeded default content on this still-live process either.
    const afterFreshSession = await app.server.inject({ method: "GET", url: "/api/channels" });
    expect(afterFreshSession.statusCode).toBe(503);

    // Posting is refused too — the process cannot accept new writes while it awaits its restart.
    const afterPost = await post(app, admin.cookie, "should never be accepted");
    expect(afterPost.statusCode).toBe(503);

    // The one exception: the Android launcher's liveness probe still works, so it can tell the process
    // is still alive (and eventually notice/trigger the actual restart).
    const health = await app.server.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
  });

  it("falls back to the existing recreate-under-the-SAME-key behaviour when no launcher restart hook is installed (desktop/CI — documented limitation)", async () => {
    // Deliberately NOT installing __loamRequestWipeRestart — simulates a non-Android host.
    const { app, dataDir } = await makeEncryptedApp(
      { dbEncryptionKey: "a fixed passphrase key", dbEncryptionMode: "passphrase" },
      { killSwitch: { enabled: true } },
    );
    const admin = await session(app);
    expect((await post(app, admin.cookie, "doomed")).statusCode).toBe(201);

    const wipe = await app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    expect(wipe.statusCode).toBe(200);

    // No hook available → the node must still boot usable, recreated in-process (same key) exactly as
    // it always has — this is the documented limitation, not a crash or a stuck kill switch.
    expect(app.store.loadMessages()).toEqual([]);
    expect(existsSync(join(dataDir, "loam.db"))).toBe(true);
    expect((await post(app, (await session(app)).cookie, "after")).statusCode).toBe(201);
  });

  it("a durable `key-clear-ready` phase file is written before signaling the launcher, and this process never deletes it itself (only a verified `loam-wipe-complete` ack may)", async () => {
    const hook = installFakeWipeRestartHook();
    const { app, dataDir } = await makeEncryptedApp(
      { dbEncryptionKey: "a fixed persistent key", dbEncryptionMode: "persistent" },
      { killSwitch: { enabled: true } },
    );
    const admin = await session(app);

    const wipe = await app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    expect(wipe.statusCode).toBe(200);
    expect(hook.calls).toBe(1);

    // Every artifact was proven gone, so the phase advanced to `key-clear-ready` before the launcher was
    // signaled. This process has no way to observe whether the launcher actually cleared the device key —
    // the phase file MUST still be on disk. Only main.js's `loam-wipe-complete` handler (after a VERIFIED
    // `clearStoredDbKeys()`) is allowed to delete it, and that never happens here (the fake hook is a bare
    // recorder, not a real launcher).
    expect(existsSync(join(dataDir, ".loam-wipe-phase"))).toBe(true);
    expect(readJournalPhase(dataDir)).toBe("key-clear-ready");
  });

  it("the host menu's Emergency reset reports a handed-off device-key clear, so the app waits for it before closing", async () => {
    const hook = installFakeWipeRestartHook();
    const { app } = await makeEncryptedApp({ dbEncryptionKey: "a fixed persistent key", dbEncryptionMode: "persistent" });
    // The journal stays on disk for the launcher, which clears it once the device key is gone.
    expect(await app.emergencyReset()).toEqual({ complete: true, keyClearRequested: true, journaled: true });
    expect(hook.calls).toBe(1);
  });

  it("a concurrent request during the slow file-deletion await already sees the lockdown (503), never stale in-memory data", async () => {
    const hook = installFakeWipeRestartHook();
    const { app } = await makeEncryptedApp(
      { dbEncryptionKey: "a fixed persistent key", dbEncryptionMode: "persistent" },
      { killSwitch: { enabled: true } },
    );
    const admin = await session(app);
    expect((await post(app, admin.cookie, "must not leak out mid-deletion")).statusCode).toBe(201);

    let release!: () => void;
    rmGate.promise = new Promise<void>((resolve) => {
      release = resolve;
    });

    const wipePromise = app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });

    // Let the handler's synchronous lockdown, broadcast, launcher signal, and config.json persist all
    // run and reach the gated `rm()` call, without letting that call resolve yet — this is the window
    // the OLD code left unprotected (the lockdown used to run AFTER these awaits, not before them).
    await new Promise((resolve) => setTimeout(resolve, 50));

    const concurrentRead = await app.server.inject({
      method: "GET",
      url: "/api/channels",
      headers: { cookie: admin.cookie },
    });
    expect(concurrentRead.statusCode).toBe(503);

    const concurrentWrite = await post(app, admin.cookie, "must never be accepted mid-deletion");
    expect(concurrentWrite.statusCode).toBe(503);

    const freshSession = await app.server.inject({ method: "GET", url: "/api/channels" });
    expect(freshSession.statusCode).toBe(503);

    release();
    const wipe = await wipePromise;
    expect(wipe.statusCode).toBe(200);
    expect(hook.calls).toBe(1);
  });

  it("config is persisted DURABLY BEFORE the phase in the HOOK fixed-key wipe (config.json exists whenever the phase does), and a DB-only admin change survives the launcher restart", async () => {
    const hook = installFakeWipeRestartHook();
    const { app, dataDir } = await makeEncryptedApp(
      { dbEncryptionKey: "key A", dbEncryptionMode: "persistent" },
      { killSwitch: { enabled: true } },
    );
    const admin = await session(app);
    // A DB-ONLY admin change (lives only in the DB `config` table, never the initial config.json).
    expect(
      (
        await app.server.inject({
          method: "PATCH",
          url: "/api/admin/config",
          headers: { cookie: admin.cookie },
          // No token: a tokenless sync setting rides across unchanged (a token turns sync off, see the next test).
          payload: { sync: { enabled: true } },
        })
      ).statusCode,
    ).toBe(200);

    const wipe = await app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    expect(wipe.statusCode).toBe(200);
    expect(hook.calls).toBe(1);

    // config.json was written BEFORE the phase, so it exists whenever the phase file does — a resume
    // that deletes the DB always has the CURRENT effective config (including the DB-only sync change) to fall
    // back to. The phase reached key-clear-ready.
    expect(readJournalPhase(dataDir)).toBe("key-clear-ready");
    const persisted = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) as {
      sync: { enabled: boolean; token?: string };
    };
    expect(persisted.sync.enabled).toBe(true);
    expect(persisted.sync.token).toBeUndefined();
    expect(existsSync(join(dataDir, ".loam-sync-off-after-reset"))).toBe(false);

    // Simulate the launcher's verified restart with a rotated key: the fresh DB's config table is empty, so
    // config.json is the ONLY carrier of the DB-only sync change into the new boot.
    rmSync(join(dataDir, ".loam-wipe-phase"), { force: true });
    const restarted = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false, dbEncryptionKey: "key B", dbEncryptionMode: "persistent" });
    cleanups.push(() => restarted.close());
    const restartedAdmin = await session(restarted);
    const config = (
      await restarted.server.inject({ method: "GET", url: "/api/admin/config", headers: { cookie: restartedAdmin.cookie } })
    ).json() as { sync: { enabled: boolean } };
    expect(config.sync.enabled).toBe(true);
  });

  it("turns sync off in the config a hooked fixed-key wipe carries across the restart when its token had to be stripped, and the next boot says so", async () => {
    const hook = installFakeWipeRestartHook();
    const { app, dataDir } = await makeEncryptedApp(
      { dbEncryptionKey: "key A", dbEncryptionMode: "persistent" },
      { killSwitch: { enabled: true } },
    );
    const admin = await session(app);
    expect(
      (
        await app.server.inject({
          method: "PATCH",
          url: "/api/admin/config",
          headers: { cookie: admin.cookie },
          payload: { sync: { enabled: true, token: "a-plaintext-bearer-sync-token-z" } },
        })
      ).statusCode,
    ).toBe(200);

    const wipe = await app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    expect(wipe.statusCode).toBe(200);
    expect(hook.calls).toBe(1);

    // The bearer token can't ride in a plain file, and sync without the token it relied on would pull
    // unauthenticated and leave this node's own sync routes open: so the snapshot turns sync off too.
    const persisted = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) as {
      sync: { enabled: boolean; token?: string };
    };
    expect(persisted.sync.token).toBeUndefined();
    expect(persisted.sync.enabled).toBe(false);
    expect(existsSync(join(dataDir, ".loam-sync-off-after-reset"))).toBe(true);

    // The launcher clears the journal and restarts under a rotated key: that boot logs why sync is off and
    // consumes the note, so it is said once.
    rmSync(join(dataDir, ".loam-wipe-phase"), { force: true });
    const lines: string[] = [];
    const restarted = await buildApp({
      requireRulesAcceptance: false,
      dataDir,
      logStream: { write: (line) => void lines.push(line) },
      dbEncryptionKey: "key B",
      dbEncryptionMode: "persistent",
    });
    cleanups.push(() => restarted.close());
    expect(lines.join("")).toContain("Sync was turned off by the Emergency Reset");
    expect(existsSync(join(dataDir, ".loam-sync-off-after-reset"))).toBe(false);

    const restartedAdmin = await session(restarted);
    const config = (
      await restarted.server.inject({ method: "GET", url: "/api/admin/config", headers: { cookie: restartedAdmin.cookie } })
    ).json() as { sync: { enabled: boolean; token?: string } };
    expect(config.sync.enabled).toBe(false);
    expect(config.sync.token).toBeUndefined();
  });

  it("the NO-HOOK fixed-key wipe persists config.json (with DB-only admin changes) BEFORE the phase, so it survives even though the wipe deletes the DB", async () => {
    const { app, dataDir } = await makeEncryptedApp(
      { dbEncryptionKey: "key A", dbEncryptionMode: "persistent" },
      { killSwitch: { enabled: true } },
    );
    const admin = await session(app);
    // DB-only admin changes: retention TTL + a sync bearer token, both of which live in the DB config table.
    expect(
      (
        await app.server.inject({
          method: "PATCH",
          url: "/api/admin/config",
          headers: { cookie: admin.cookie },
          payload: { retention: { messageTtlMs: 3_600_000 }, sync: { enabled: true, token: "a-plaintext-bearer-sync-token-nohook" } },
        })
      ).statusCode,
    ).toBe(200);

    // No hook installed → the in-process no-hook fixed-key wipe runs: persist config.json BEFORE the phase,
    // delete + recreate under the same key.
    const wipe = await app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    expect(wipe.statusCode).toBe(200);
    // config.json carries the DB-only retention change forward.
    const persisted = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) as {
      retention: { messageTtlMs?: number };
      sync: { token?: string };
    };
    expect(persisted.retention.messageTtlMs).toBe(3_600_000);

    // The plaintext config.json blanks the sync bearer token, but the fresh DB's config
    // row — encrypted under the same fixed key — must keep the FULL config (token included), exactly like
    // the ephemeral branch does: that row overrides config.json on the next boot, so a sanitized row would
    // have silently dropped the token.
    expect((persisted as { sync: { token?: string } }).sync.token).toBeUndefined();
    const dbRow = JSON.parse(app.store.getConfigValue("config") ?? "{}") as { sync: { token?: string } };
    expect(dbRow.sync.token).toBe("a-plaintext-bearer-sync-token-nohook");

    // Restart under the same key (no-hook can't rotate): the re-persisted DB row is the source — the retention
    // change AND the sync token survive.
    const restarted = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false, dbEncryptionKey: "key A", dbEncryptionMode: "persistent" });
    cleanups.push(() => restarted.close());
    const restartedAdmin = await session(restarted);
    const config = (
      await restarted.server.inject({ method: "GET", url: "/api/admin/config", headers: { cookie: restartedAdmin.cookie } })
    ).json() as { retention: { messageTtlMs?: number } };
    expect(config.retention.messageTtlMs).toBe(3_600_000);
    const restartedRow = JSON.parse(restarted.store.getConfigValue("config") ?? "{}") as { sync: { token?: string } };
    expect(restartedRow.sync.token).toBe("a-plaintext-bearer-sync-token-nohook");
  });

  it("a config.json persist failure during a fixed-key wipe does NOT lose config or signal the launcher — the journal retains the config snapshot and a reopen recovers it", async () => {
    const hook = installFakeWipeRestartHook();
    const { app, dataDir } = await makeEncryptedApp(
      { dbEncryptionKey: "key A", dbEncryptionMode: "persistent" },
      { killSwitch: { enabled: true } },
    );
    const admin = await session(app);

    // config.json write fails on BOTH the attempt AND its retry.
    configWriteFailures.remaining = 2;
    const wipe = await app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    // FAIL CLOSED: 503, and the launcher is NOT signaled — its key-clear would clear the journal
    // before config could be recovered. But the DB WAS deleted (confidentiality), and the journal carries the
    // config snapshot atomically, so config is never lost.
    expect(wipe.statusCode).toBe(503);
    expect(hook.calls).toBe(0);
    expect(existsSync(join(dataDir, "loam.db"))).toBe(false);
    expect(readJournalPhase(dataDir)).toBe("delete-pending");
    expect(readJournalConfig(dataDir)?.killSwitch).toMatchObject({ enabled: true });
    await app.close();

    // Reopen with the fault cleared: the resume restores config.json FROM THE JOURNAL, re-verifies deletion,
    // advances to key-clear-ready, and signals the launcher — so config survives and the wipe completes.
    configWriteFailures.remaining = 0;
    const hook2 = installFakeWipeRestartHook();
    await expect(
      buildApp({ requireRulesAcceptance: false, dataDir, logger: false, dbEncryptionKey: "key A", dbEncryptionMode: "persistent" }),
    ).rejects.toThrow();
    const recovered = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) as {
      killSwitch: { enabled: boolean };
    };
    expect(recovered.killSwitch.enabled).toBe(true);
    expect(hook2.calls).toBe(1);
  });

  it("a wipe journal with a PRESENT but INVALID config snapshot fails closed (locks + retains the journal) instead of silently dropping config and reverting to defaults", async () => {
    const { app, dataDir } = await makeEncryptedApp({ dbEncryptionKey: "key A", dbEncryptionMode: "persistent" });
    await session(app);
    await app.close();

    // Seed a journal whose config field is PRESENT but schema-invalid (simulating on-disk corruption of the
    // snapshot). Distinct from an absent config (legacy), which is allowed to proceed.
    writeFileSync(
      join(dataDir, ".loam-wipe-phase"),
      JSON.stringify({ phase: "delete-pending", config: { not: "a valid LoamConfig" } }),
    );
    const reports = installFakeBootBridge();

    // The resume refuses to proceed (which would clear the journal and lose the config bytes) — it locks.
    await expect(
      buildApp({ requireRulesAcceptance: false, dataDir, logger: false, dbEncryptionKey: "key A", dbEncryptionMode: "persistent" }),
    ).rejects.toThrow();
    // The journal is RETAINED (not cleared), so the config bytes survive for inspection/repair.
    expect(existsSync(join(dataDir, ".loam-wipe-phase"))).toBe(true);
    expect(reports.some((r) => r.code === "kill_switch_wipe_incomplete")).toBe(true);
  });

  it("when the durable wipe-phase file CANNOT be written, the ciphertext is deleted and VERIFIED gone SYNCHRONOUSLY before the launcher is signaled (fail closed) — a kill right after the hook cannot recover the data", async () => {
    // A launcher hook that records, at the moment it is called, whether ANY ciphertext file still exists.
    // The fix's guarantee is that by the time the launcher is signaled, the ciphertext is already gone —
    // so a kill immediately after `hook()` (with RN's key-clear also interrupted) leaves nothing to recover.
    const reports = installFakeBootBridge();
    const { app, dataDir } = await makeEncryptedApp(
      { dbEncryptionKey: "a fixed persistent key", dbEncryptionMode: "persistent" },
      { killSwitch: { enabled: true } },
    );

    let ciphertextPresentAtHook: boolean | undefined;
    let hookCalls = 0;
    (globalThis as unknown as { __loamRequestWipeRestart?: () => void }).__loamRequestWipeRestart = () => {
      ciphertextPresentAtHook =
        existsSync(join(dataDir, "loam.db")) ||
        existsSync(join(dataDir, "loam.db-wal")) ||
        existsSync(join(dataDir, "loam.db-shm"));
      hookCalls += 1;
    };
    cleanups.push(() => {
      delete (globalThis as unknown as { __loamRequestWipeRestart?: unknown }).__loamRequestWipeRestart;
    });

    const admin = await session(app);
    expect((await post(app, admin.cookie, "MUST_NOT_SURVIVE_A_FAILED_MARKER")).statusCode).toBe(201);
    expect(existsSync(join(dataDir, "loam.db"))).toBe(true);

    // Force the durable phase write to fail — this is exactly the fail-open window being closed.
    wipeMarkerWriteFailure.armed = true;

    const wipe = await app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    expect(wipe.statusCode).toBe(200);

    // The crux: the launcher WAS signaled, but the ciphertext was already gone at that instant — so a stop
    // immediately after the hook cannot recover the encrypted data (the fail-OPEN bug would have had the
    // ciphertext still present here, deleted only by a later async rm that a kill could skip).
    expect(hookCalls).toBe(1);
    expect(ciphertextPresentAtHook).toBe(false);

    // And it is genuinely gone on disk afterward, with NO phase file written (the write failed by design).
    expect(existsSync(join(dataDir, "loam.db"))).toBe(false);
    expect(existsSync(join(dataDir, "loam.db-wal"))).toBe(false);
    expect(existsSync(join(dataDir, "loam.db-shm"))).toBe(false);
    expect(existsSync(join(dataDir, ".loam-wipe-phase"))).toBe(false);

    // A distinct notice was surfaced so the operator knows the wipe completed without a durable resume
    // phase (and must reopen to finish clearing the now-unused key if RN's key-clear was also interrupted).
    expect(reports.some((r) => r.code === "kill_switch_wipe_no_marker")).toBe(true);
  });

  it("a `.premigration` survivor that can't be deleted BLOCKS the launcher handoff — the wipe reports INCOMPLETE (503), stays `delete-pending` + 503-locked, and never signals while recoverable ciphertext remains", async () => {
    const reports = installFakeBootBridge();
    const hook = installFakeWipeRestartHook();
    const { app, dataDir } = await makeEncryptedApp(
      { dbEncryptionKey: "a fixed persistent key", dbEncryptionMode: "persistent" },
      { killSwitch: { enabled: true } },
    );
    const admin = await session(app);
    expect((await post(app, admin.cookie, "doomed under a fixed key")).statusCode).toBe(201);

    // Plant a committed legacy-key `.premigration` snapshot (still-readable ciphertext under the
    // NON-discardable SHA256(passphrase) key) alongside the live DB, then make its deletion FAIL
    // PERSISTENTLY — the survivor the wipe must never signal the launcher past.
    const premigration = join(dataDir, "loam.db.premigration");
    writeFileSync(premigration, Buffer.from("legacy-key ciphertext that must not survive a wipe"));
    premigrationDeleteFailure.armed = true;

    const wipe = await app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    // The endpoint no longer reports success on an INCOMPLETE wipe — it 503s.
    expect(wipe.statusCode).toBe(503);

    // The crux: the launcher was NOT signaled while the survivor remained — so RN can't clear the
    // device secret (which doesn't decrypt `.premigration`) and restart into a Step-0b restore of it.
    expect(hook.calls).toBe(0);
    // The survivor is still on disk (it genuinely couldn't be deleted), and a distinct incomplete notice
    // was surfaced — the phase stays `delete-pending` (durable), so the next boot re-runs deletion.
    expect(existsSync(premigration)).toBe(true);
    expect(existsSync(join(dataDir, ".loam-wipe-phase"))).toBe(true);
    expect(readJournalPhase(dataDir)).toBe("delete-pending");
    expect(reports.some((r) => r.code === "kill_switch_wipe_incomplete")).toBe(true);

    // The node stays locked down (503 everywhere) — the RF-a synchronous in-memory lockdown ran first and
    // was never cleared, so nothing reopened while recoverable ciphertext survives.
    const locked = await app.server.inject({ method: "GET", url: "/api/channels", headers: { cookie: admin.cookie } });
    expect(locked.statusCode).toBe(503);
  });

  it("an upgraded node with only an older build's `.loam-wipe-pending` marker (+ a legacy-key `.premigration` survivor) RESUMES the wipe on boot — deletion runs and the pre-upgrade data is never served", async () => {
    const { app, dataDir } = await makeEncryptedApp(
      { dbEncryptionKey: "a fixed persistent key", dbEncryptionMode: "persistent" },
      { killSwitch: { enabled: true } },
    );
    const admin = await session(app);
    expect((await post(app, admin.cookie, "PRE_UPGRADE_SECRET")).statusCode).toBe(201);
    await app.close();

    // The fail-closed state an older build left behind: only the OLD marker on disk (no
    // `.loam-wipe-phase`), a still-readable legacy-key `.premigration` survivor, and the live DB intact.
    writeFileSync(join(dataDir, ".loam-wipe-pending"), "1");
    writeFileSync(join(dataDir, "loam.db.premigration"), Buffer.from("legacy-key ciphertext survivor"));
    expect(existsSync(join(dataDir, ".loam-wipe-phase"))).toBe(false);

    // Boot the current build (no launcher hook = desktop path): it must recognise the legacy marker as an unfinished
    // wipe, re-run deletion, clear BOTH marker names, and open a FRESH DB — never serve the surviving data.
    const rebooted = await buildApp({ requireRulesAcceptance: false,
      dataDir,
      logger: false,
      dbEncryptionKey: "a fixed persistent key",
      dbEncryptionMode: "persistent",
    });
    cleanups.push(() => rebooted.close());
    expect(existsSync(join(dataDir, "loam.db.premigration"))).toBe(false);
    expect(existsSync(join(dataDir, ".loam-wipe-pending"))).toBe(false);
    expect(existsSync(join(dataDir, ".loam-wipe-phase"))).toBe(false);
    const search = await rebooted.server.inject({
      method: "GET",
      url: "/api/search?q=PRE_UPGRADE_SECRET",
      headers: { cookie: (await session(rebooted)).cookie },
    });
    expect(search.statusCode).toBe(200);
    expect((search.json() as { results: unknown[] }).results.length).toBe(0);
  });

  it("a NO-LAUNCHER fixed-key wipe whose deletion FAILS durably records delete-pending + stays 503-locked, and on the NEXT boot (fault cleared) completes the wipe — old rows never served between attempts", async () => {
    const { app, dataDir } = await makeEncryptedApp(
      { dbEncryptionKey: "a fixed persistent key", dbEncryptionMode: "persistent" },
      { killSwitch: { enabled: true } },
    );
    const admin = await session(app);
    expect((await post(app, admin.cookie, "NOHOOK_WIPE_SECRET")).statusCode).toBe(201);

    // A committed legacy-key `.premigration` whose deletion FAILS persistently — the survivor. NO wipe hook
    // is installed (desktop no-launcher path).
    writeFileSync(join(dataDir, "loam.db.premigration"), Buffer.from("survivor"));
    premigrationDeleteFailure.armed = true;

    const wipe = await app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    // The no-hook wipe deletion could not be verified → 503 (incomplete), with a DURABLE delete-pending phase
    // recorded (previously there was no durable record, so a restart forgot the wipe).
    expect(wipe.statusCode).toBe(503);
    expect(readJournalPhase(dataDir)).toBe("delete-pending");
    expect(
      (await app.server.inject({ method: "GET", url: "/api/channels", headers: { cookie: admin.cookie } })).statusCode,
    ).toBe(503);
    await app.close();

    // Boot 2 with the fault CLEARED: the boot-time resume re-runs deletion (now succeeds), clears the phase,
    // and opens a fresh DB. The old rows are never served.
    premigrationDeleteFailure.armed = false;
    const boot2 = await buildApp({ requireRulesAcceptance: false,
      dataDir,
      logger: false,
      dbEncryptionKey: "a fixed persistent key",
      dbEncryptionMode: "persistent",
    });
    cleanups.push(() => boot2.close());
    expect(existsSync(join(dataDir, "loam.db.premigration"))).toBe(false);
    expect(existsSync(join(dataDir, ".loam-wipe-phase"))).toBe(false);
    const search = await boot2.server.inject({
      method: "GET",
      url: "/api/search?q=NOHOOK_WIPE_SECRET",
      headers: { cookie: (await session(boot2)).cookie },
    });
    expect((search.json() as { results: unknown[] }).results.length).toBe(0);
  });

  it("a no-hook wipe resume whose phase-clear cannot be made durable (parent-directory fsync fails) stays LOCKED rather than opening a fresh DB a resurrected phase would re-wipe", async () => {
    const { app, dataDir } = await makeEncryptedApp({ dbEncryptionKey: "key A", dbEncryptionMode: "persistent" });
    await session(app);
    await app.close();

    // A wipe was mid-flight (durable delete-pending on disk), no launcher hook. Make EVERY parent-directory
    // fsync on the data dir fail, so `clearWipePhase` can never confirm the unlink is power-loss-durable.
    writeFileSync(join(dataDir, ".loam-wipe-phase"), "delete-pending");
    openSyncFailure.path = dataDir;

    // The resume deletes (best-effort), but the no-hook path refuses to open a fresh DB when the phase clear
    // is not durable — it throws (stays locked) rather than risk a resurrected `key-clear-ready` re-wiping the
    // freshly minted key on the next boot.
    await expect(
      buildApp({ requireRulesAcceptance: false, dataDir, logger: false, dbEncryptionKey: "key A", dbEncryptionMode: "persistent" }),
    ).rejects.toThrow();
    openSyncFailure.path = undefined;
  });

  it("a DELIBERATE delete-and-start-fresh (marker intent `delete`) DELETES the old encrypted DB and proves it gone, instead of renaming it aside where it stays recoverable", async () => {
    const { app, dataDir } = await makeEncryptedApp({ dbEncryptionKey: "key A", dbEncryptionMode: "persistent" });
    const admin = await session(app);
    expect((await post(app, admin.cookie, "DELETE_INTENT_SECRET")).statusCode).toBe(201);
    await app.close();

    // The operator confirmed "Delete & start fresh" for a deliberate mode change → the marker carries
    // `delete`. Boot with a DIFFERENT key (the new mode's key can't open the old ciphertext).
    writeFileSync(join(dataDir, ".loam-db-start-fresh"), "delete");
    const boot2 = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false, dbEncryptionKey: "key B", dbEncryptionMode: "persistent" });
    cleanups.push(() => boot2.close());

    // DELETED, not renamed aside: no `.unreadable-*` recovery copies remain, and the fresh DB serves no old data.
    expect(readdirSync(dataDir).filter((n) => n.includes(".unreadable-"))).toEqual([]);
    const search = await boot2.server.inject({
      method: "GET",
      url: "/api/search?q=DELETE_INTENT_SECRET",
      headers: { cookie: (await session(boot2)).cookie },
    });
    expect((search.json() as { results: unknown[] }).results.length).toBe(0);
  });

  it("an accidental-lockout recovery (marker intent `preserve`) renames the old DB ASIDE instead of deleting it", async () => {
    const { app, dataDir } = await makeEncryptedApp({ dbEncryptionKey: "key A", dbEncryptionMode: "persistent" });
    await session(app);
    await app.close();

    // Accidental wrong/lost-key lockout: the operator preserves the old DB while starting fresh. Boot with a
    // different key so the old ciphertext can't open, and the `preserve` marker keeps it on disk.
    writeFileSync(join(dataDir, ".loam-db-start-fresh"), "preserve");
    const boot2 = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false, dbEncryptionKey: "key B", dbEncryptionMode: "persistent" });
    cleanups.push(() => boot2.close());
    expect(recoverySnapshots(dataDir).length).toBeGreaterThan(0);
  });

  it("a DELETE start-fresh also removes USER MEDIA (avatars + attachments), not just the DB files", async () => {
    const { app, dataDir } = await makeEncryptedApp({ dbEncryptionKey: "key A", dbEncryptionMode: "persistent" });
    await session(app);
    await app.close();

    // Seed user media alongside the encrypted DB — attachments are message content, avatars are user data.
    const avatarsDir = join(dataDir, "avatars");
    const attachmentsDir = join(dataDir, "attachments");
    mkdirSync(avatarsDir, { recursive: true });
    mkdirSync(attachmentsDir, { recursive: true });
    writeFileSync(join(avatarsDir, "avt_deadbeefdeadbeef.webp"), "avatar bytes");
    writeFileSync(join(attachmentsDir, "att_00000000000000ff.png"), "attachment bytes");

    // Deliberate delete-and-start-fresh (the new key can't open the old ciphertext).
    writeFileSync(join(dataDir, ".loam-db-start-fresh"), "delete");
    const boot2 = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false, dbEncryptionKey: "key B", dbEncryptionMode: "persistent" });
    cleanups.push(() => boot2.close());

    // The DB was deleted (no `.unreadable-*` copy) AND the media directories are gone.
    expect(readdirSync(dataDir).filter((n) => n.includes(".unreadable-"))).toEqual([]);
    expect(existsSync(avatarsDir)).toBe(false);
    expect(existsSync(attachmentsDir)).toBe(false);
  });

  it("a PRESERVE start-fresh marker on a PLAINTEXT database under an encrypted mode does NOT delete it — it is renamed aside (preserve never escalates to destruction)", async () => {
    // A plaintext DB (no encryption key).
    const { app, dataDir } = await makeEncryptedApp({});
    const admin = await session(app);
    expect((await post(app, admin.cookie, "PLAINTEXT_PRESERVE_SECRET")).statusCode).toBe(201);
    await app.close();

    // An encrypted mode is now configured, but the marker intent is `preserve` (e.g. a legacy/mis-routed
    // marker). The plaintext DB must NOT be deleted — it is renamed aside, honoring the intent.
    writeFileSync(join(dataDir, ".loam-db-start-fresh"), "preserve");
    const encrypted = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false, dbEncryptionKey: "a key", dbEncryptionMode: "persistent" });
    cleanups.push(() => encrypted.close());
    expect(recoverySnapshots(dataDir).length).toBeGreaterThan(0);
  });

  it("a LIVE no-hook fixed-key wipe whose deletion cannot be made DURABLE (parent-dir fsync fails) returns 503 and does NOT open a fresh store", async () => {
    const { app, dataDir } = await makeEncryptedApp(
      { dbEncryptionKey: "key A", dbEncryptionMode: "persistent" },
      { killSwitch: { enabled: true } },
    );
    const admin = await session(app);
    expect((await post(app, admin.cookie, "LIVE_NOHOOK_SECRET")).statusCode).toBe(201);

    // No launcher hook. Make every parent-directory fsync on the data dir fail so the durable deletion (and
    // durable phase clear) can never be confirmed — the wipe must fail closed (503), not reopen a fresh DB.
    openSyncFailure.path = dataDir;
    const wipe = await app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    expect(wipe.statusCode).toBe(503);
    // The node stays locked (nothing served) rather than exposing a fresh store while durability is uncertain.
    expect(
      (await app.server.inject({ method: "GET", url: "/api/channels", headers: { cookie: admin.cookie } })).statusCode,
    ).toBe(503);
    openSyncFailure.path = undefined;
  });

  it("a no-hook wipe reaches clearWipePhase and fails closed when ONLY the phase-clear fsync fails (config, journal, deletion all durable) — 503, no fresh store, and boot 2 retries clean", async () => {
    const { app, dataDir } = await makeEncryptedApp(
      { dbEncryptionKey: "key A", dbEncryptionMode: "persistent" },
      { killSwitch: { enabled: true } },
    );
    const admin = await session(app);
    expect((await post(app, admin.cookie, "CLEAR_FSYNC_SECRET")).statusCode).toBe(201);

    // Let the FIRST THREE data-dir fsyncs succeed (journal write, durable deletion, config.json persist) and
    // fail ONLY the FOURTH — the `clearWipePhase` parent-dir fsync. This exercises the clear-before-open
    // regression that the all-fsyncs-fail test never reached.
    openSyncFailure.path = dataDir;
    openSyncFailure.failOnCall = 4;
    const wipe = await app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    // clearWipePhase reached but could not be made DURABLE (its dir fsync failed) → fail closed: 503, and NO
    // fresh store is opened (the clear-before-open regression). The deletion did happen (DB gone).
    expect(wipe.statusCode).toBe(503);
    expect(existsSync(join(dataDir, "loam.db"))).toBe(false);
    // The node stays locked — never exposes a fresh store while the phase clear is unproven.
    expect(
      (await app.server.inject({ method: "GET", url: "/api/channels", headers: { cookie: admin.cookie } })).statusCode,
    ).toBe(503);
    await app.close();

    // Boot 2 with the fault cleared. Note: clearWipePhase `rmSync`s the journal BEFORE its dir-fsync fails, so
    // boot 1 already physically removed the journal (its return was false only because the fsync couldn't PROVE
    // the removal durable). So boot 2 is a clean fresh boot (`readWipeJournal` → ENOENT → no resume): the DB was
    // deleted on boot 1 and never served, so a fresh empty node comes up with no old data.
    openSyncFailure.path = undefined;
    openSyncFailure.failOnCall = undefined;
    openSyncFailure.count = 0;
    const boot2 = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false, dbEncryptionKey: "key A", dbEncryptionMode: "persistent" });
    cleanups.push(() => boot2.close());
    expect(existsSync(join(dataDir, ".loam-wipe-phase"))).toBe(false);
    const search = await boot2.server.inject({
      method: "GET",
      url: "/api/search?q=CLEAR_FSYNC_SECRET",
      headers: { cookie: (await session(boot2)).cookie },
    });
    expect((search.json() as { results: unknown[] }).results.length).toBe(0);
  });

  it("PRESERVE recovery moves the attachment + avatar bytes into a recovery snapshot — the boot orphan reaper does NOT delete them, and they survive a further restart", async () => {
    const { app, dataDir } = await makeEncryptedApp({ dbEncryptionKey: "key A", dbEncryptionMode: "persistent" });
    await session(app);
    // Seed a REAL message attachment + an avatar file alongside the encrypted DB.
    const avatarsDir = join(dataDir, "avatars");
    const attachmentsDir = join(dataDir, "attachments");
    mkdirSync(avatarsDir, { recursive: true });
    mkdirSync(attachmentsDir, { recursive: true });
    writeFileSync(join(avatarsDir, "avt_cafecafecafecafe.webp"), "AVATAR_BYTES");
    writeFileSync(join(attachmentsDir, "att_00000000000000aa.png"), "ATTACHMENT_BYTES");
    await app.close();

    // Accidental wrong/lost-key lockout recovery: preserve. Boot with a different key + a preserve marker.
    writeFileSync(join(dataDir, ".loam-db-start-fresh"), "preserve");
    const boot2 = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false, dbEncryptionKey: "key B", dbEncryptionMode: "persistent" });
    // Let the boot-time orphan reaper (which runs on start) complete — the fresh DB references no attachments,
    // so if the old attachment were still in the ACTIVE `attachments/` it would be reaped here.
    await new Promise((r) => setTimeout(r, 50));
    await boot2.close();

    // The preserved bytes live in the recovery snapshot, NOT the active namespace — untouched by the reaper.
    const snapshots = recoverySnapshots(dataDir);
    expect(snapshots.length).toBe(1);
    const snap = join(dataDir, snapshots[0]);
    expect(readFileSync(join(snap, "attachments", "att_00000000000000aa.png"), "utf8")).toBe("ATTACHMENT_BYTES");
    expect(readFileSync(join(snap, "avatars", "avt_cafecafecafecafe.webp"), "utf8")).toBe("AVATAR_BYTES");

    // A further restart must not disturb the snapshot either.
    const boot3 = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false, dbEncryptionKey: "key B", dbEncryptionMode: "persistent" });
    cleanups.push(() => boot3.close());
    await new Promise((r) => setTimeout(r, 50));
    expect(readFileSync(join(snap, "attachments", "att_00000000000000aa.png"), "utf8")).toBe("ATTACHMENT_BYTES");
    expect(readFileSync(join(snap, "avatars", "avt_cafecafecafecafe.webp"), "utf8")).toBe("AVATAR_BYTES");
  });

  it("an INTERRUPTED preserve recovery (anchor + a SPLIT DB set) is RESUMED on boot — the move completes coherently, no fresh DB opens over a partial snapshot", async () => {
    const { app, dataDir } = await makeEncryptedApp({ dbEncryptionKey: "key A", dbEncryptionMode: "persistent" });
    const admin = await session(app);
    expect((await post(app, admin.cookie, "SPLIT_PRESERVE_SECRET")).statusCode).toBe(201);
    const avatarsDir = join(dataDir, "avatars");
    const attachmentsDir = join(dataDir, "attachments");
    mkdirSync(avatarsDir, { recursive: true });
    mkdirSync(attachmentsDir, { recursive: true });
    writeFileSync(join(avatarsDir, "avt_split.webp"), "AVATAR_SPLIT");
    writeFileSync(join(attachmentsDir, "att_split.png"), "ATTACH_SPLIT");
    await app.close();

    // Simulate a CRASH mid-preserve-move: the durable anchor is present, and the DB set is SPLIT — a sidecar
    // was already moved into the recovery dir, but loam.db + media are still in the active namespace.
    const recoveryDirName = ".loam-recovery-1700000000000-abcdef";
    const recoveryDir = join(dataDir, recoveryDirName);
    mkdirSync(recoveryDir, { recursive: true });
    writeFileSync(join(recoveryDir, "loam.db-wal"), "PRE_MOVED_WAL");
    writeFileSync(join(dataDir, ".loam-recovery-state"), recoveryDirName);

    // Boot under a DIFFERENT key (realistic wrong-key lockout). resumePreserveRecovery runs FIRST, finishes
    // the move, clears the anchor; then a fresh DB opens under the new key.
    const boot2 = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false, dbEncryptionKey: "key B", dbEncryptionMode: "persistent" });
    cleanups.push(() => boot2.close());

    // The anchor is cleared and the snapshot is COHERENT — every piece is together in ONE recovery dir.
    expect(existsSync(join(dataDir, ".loam-recovery-state"))).toBe(false);
    expect(recoverySnapshots(dataDir)).toEqual([recoveryDirName]);
    expect(existsSync(join(recoveryDir, "loam.db"))).toBe(true);
    expect(existsSync(join(recoveryDir, "loam.db-wal"))).toBe(true); // the pre-moved sidecar stays with it
    expect(readFileSync(join(recoveryDir, "avatars", "avt_split.webp"), "utf8")).toBe("AVATAR_SPLIT");
    expect(readFileSync(join(recoveryDir, "attachments", "att_split.png"), "utf8")).toBe("ATTACH_SPLIT");
    // The active namespace is clean — no split remnants, fresh DB usable.
    expect(existsSync(join(avatarsDir, "avt_split.webp"))).toBe(false);
    const boot2Admin = await session(boot2);
    expect((await post(boot2, boot2Admin.cookie, "after resumed preserve")).statusCode).toBe(201);
  });

  it("a preserve move with an UNVERIFIABLE media dir (non-ENOENT stat) aborts before opening a fresh store — media is never left in the active namespace", async () => {
    const { app, dataDir } = await makeEncryptedApp({ dbEncryptionKey: "key A", dbEncryptionMode: "persistent" });
    await session(app);
    const attachmentsDir = join(dataDir, "attachments");
    mkdirSync(attachmentsDir, { recursive: true });
    writeFileSync(join(attachmentsDir, "att_unverif.png"), "UNVERIF");
    await app.close();

    // A preserve confirmation + an lstat fault on the attachments dir (provenAbsence → "unknown"): the move
    // must ABORT (fail closed) rather than skip the dir as if absent and open a fresh store over live media.
    writeFileSync(join(dataDir, ".loam-db-start-fresh"), "preserve");
    lstatFailure.path = attachmentsDir;
    const reports = installFakeBootBridge();
    await expect(
      buildApp({ requireRulesAcceptance: false, dataDir, logger: false, dbEncryptionKey: "key B", dbEncryptionMode: "persistent" }),
    ).rejects.toThrow();
    lstatFailure.path = undefined;
    expect(reports.some((r) => r.code === "db_encryption_unreadable")).toBe(true);
  });

  describe("a corrupt/unverifiable wipe journal fails closed instead of being read as a legacy no-config journal", () => {
    async function expectJournalLocks(content: string, opts?: { unreadable?: boolean }): Promise<void> {
      const { app, dataDir } = await makeEncryptedApp({ dbEncryptionKey: "key A", dbEncryptionMode: "persistent" });
      await session(app);
      await app.close();
      writeFileSync(join(dataDir, ".loam-wipe-phase"), content);
      if (opts?.unreadable) {
        readFileSyncFailure.path = join(dataDir, ".loam-wipe-phase");
      }
      const reports = installFakeBootBridge();
      await expect(
        buildApp({ requireRulesAcceptance: false, dataDir, logger: false, dbEncryptionKey: "key A", dbEncryptionMode: "persistent" }),
      ).rejects.toThrow();
      readFileSyncFailure.path = undefined;
      // The journal is RETAINED (not cleared/rewritten) so any config bytes survive; a distinct notice fires.
      expect(existsSync(join(dataDir, ".loam-wipe-phase"))).toBe(true);
      expect(reports.some((r) => r.code === "kill_switch_wipe_incomplete")).toBe(true);
    }

    it("truncated JSON", () => expectJournalLocks('{"phase":"delete-pen'));
    it("JSON null", () => expectJournalLocks("null"));
    it("JSON array", () => expectJournalLocks("[1,2,3]"));
    it("JSON object with no phase", () => expectJournalLocks("{}"));
    it("JSON object with an unrecognized phase", () => expectJournalLocks('{"phase":"unknown"}'));
    it("unrecognized non-JSON string", () => expectJournalLocks("garbage-not-a-recognized-phase"));
    it("non-ENOENT read error", () => expectJournalLocks('{"phase":"delete-pending"}', { unreadable: true }));
  });

  describe("EXACT legacy plain-string journals stay valid no-config journals — the no-hook resume proceeds and completes, not a corrupt lock", () => {
    async function expectLegacyStringProceeds(legacyPhase: "delete-pending" | "key-clear-ready"): Promise<void> {
      const { app, dataDir } = await makeEncryptedApp(
        { dbEncryptionKey: "key A", dbEncryptionMode: "persistent" },
        { killSwitch: { enabled: true } },
      );
      const admin = await session(app);
      expect((await post(app, admin.cookie, "LEGACY_STRING_SECRET")).statusCode).toBe(201);
      await app.close();

      writeFileSync(join(dataDir, ".loam-wipe-phase"), legacyPhase); // EXACT legacy plain string (no config)
      const boot2 = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false, dbEncryptionKey: "key A", dbEncryptionMode: "persistent" });
      cleanups.push(() => boot2.close());
      // Proceeded (not a corrupt lock): the no-hook resume deleted + cleared the journal + opened fresh.
      expect(existsSync(join(dataDir, ".loam-wipe-phase"))).toBe(false);
      const search = await boot2.server.inject({
        method: "GET",
        url: "/api/search?q=LEGACY_STRING_SECRET",
        headers: { cookie: (await session(boot2)).cookie },
      });
      expect((search.json() as { results: unknown[] }).results.length).toBe(0);
    }

    it("delete-pending", () => expectLegacyStringProceeds("delete-pending"));
    it("key-clear-ready", () => expectLegacyStringProceeds("key-clear-ready"));
  });

  it("an in-process wipe (ephemeral) 503-gates concurrent requests throughout the shared-tail media-deletion awaits, then serves the fresh state once complete", async () => {
    const { app } = await makeEncryptedApp({ ephemeralDbKey: true }, { killSwitch: { enabled: true } });
    const admin = await session(app);
    expect((await post(app, admin.cookie, "STALE_DURING_WIPE")).statusCode).toBe(201);

    // Hold the shared tail's `await rm(avatarsDir)` open so a concurrent request lands mid-wipe.
    let release!: () => void;
    rmGate.promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const wipePromise = app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    await new Promise((r) => setTimeout(r, 50));

    // The 503 gate is now raised for the WHOLE wipe (not just the hooked fixed-key branch), so a request
    // during the tail's media-deletion await sees 503 — never a stale 200 from the still-populated mirror.
    const during = await app.server.inject({ method: "GET", url: "/api/channels", headers: { cookie: admin.cookie } });
    expect(during.statusCode).toBe(503);

    release();
    expect((await wipePromise).statusCode).toBe(200);

    // The gate is LIFTED on the in-process success return, so the node serves the fresh (re-seeded) state.
    const after = await app.server.inject({ method: "GET", url: "/api/channels" });
    expect(after.statusCode).toBe(200);
  });

  describe("the fixed-key wipe preserves admin-set config across the restart, with plaintext bearer secrets blanked", () => {
    async function expectConfigSurvivesFixedKeyWipe(dbEncryptionMode: "persistent" | "passphrase"): Promise<void> {
      const hook = installFakeWipeRestartHook();
      const { app, dataDir } = await makeEncryptedApp({
        dbEncryptionKey: `key A (${dbEncryptionMode})`,
        dbEncryptionMode,
      });
      const admin = await session(app);

      // Change settings ONLY via the admin API (never the initial config file) — exactly the scenario
      // the fix targets: an armed kill switch and a sync token that only ever lived in the DB `config`
      // table, which the fixed-key wipe branch deletes without ever recreating one in-process.
      const patch = await app.server.inject({
        method: "PATCH",
        url: "/api/admin/config",
        headers: { cookie: admin.cookie },
        payload: {
          killSwitch: { enabled: true },
          sync: { enabled: true, token: "a-plaintext-bearer-sync-token-9" },
        },
      });
      expect(patch.statusCode).toBe(200);

      const wipe = await app.server.inject({
        method: "POST",
        url: "/api/admin/kill-switch",
        headers: { cookie: admin.cookie },
        payload: { confirm: "wipe" },
      });
      expect(wipe.statusCode).toBe(200);
      expect(hook.calls).toBe(1);

      // config.json — the only surviving file — carries the effective config, with the plaintext sync
      // token blanked (unlike the already-scrypt-hashed admin.passphrase/killSwitch.panicToken, which
      // are safe to persist as-is and are NOT asserted away here).
      const rawConfig = readFileSync(join(dataDir, "config.json"), "utf8");
      expect(rawConfig).not.toContain("a-plaintext-bearer-sync-token-9");
      const configOnDisk = JSON.parse(rawConfig) as { killSwitch: { enabled: boolean }; sync: { token?: string } };
      expect(configOnDisk.killSwitch.enabled).toBe(true);
      expect(configOnDisk.sync.token).toBeUndefined();

      // The wipe reached `key-clear-ready` and wrote the durable phase file. Simulate the launcher's
      // `loam-wipe-complete` handoff (main.js's `clearWipePhase()` after RN VERIFIED the key is gone):
      // delete the phase file BEFORE the restart, otherwise the boot-time resume would (correctly) refuse
      // to open the store under the un-rotated key.
      expect(readJournalPhase(dataDir)).toBe("key-clear-ready");
      rmSync(join(dataDir, ".loam-wipe-phase"), { force: true });

      // Simulate the launcher's actual restart: a fresh boot, same dataDir, a NEW (rotated) key — the
      // whole point of the handoff. The fresh DB's config table starts empty, so config.json is
      // the ONLY thing carrying the admin's settings forward into the new boot.
      const restarted = await buildApp({ requireRulesAcceptance: false,
        dataDir,
        logger: false,
        dbEncryptionKey: `key B (${dbEncryptionMode}, rotated)`,
        dbEncryptionMode,
      });
      try {
        const restartedAdmin = await session(restarted);
        const config = (
          await restarted.server.inject({
            method: "GET",
            url: "/api/admin/config",
            headers: { cookie: restartedAdmin.cookie },
          })
        ).json() as { killSwitch: { enabled: boolean }; sync: { enabled: boolean; token?: string } };

        // Not silently reverted to config.json-absent/defaults — the armed kill switch survives. Sync does
        // not stay on without the token it relied on: the snapshot turned it off (the operator sets a new
        // token and turns it on again).
        expect(config.killSwitch.enabled).toBe(true);
        expect(config.sync.enabled).toBe(false);
        expect(config.sync.token).toBeUndefined();
      } finally {
        await restarted.close();
      }
    }

    it("persistent mode", async () => {
      await expectConfigSurvivesFixedKeyWipe("persistent");
    });

    it("passphrase mode", async () => {
      await expectConfigSurvivesFixedKeyWipe("passphrase");
    });
  });

  describe("the kill switch wipes EVERY DB artifact (migration/recovery sidecars), not just the 3 live files", () => {
    const SENTINEL = "PREMIGRATION_LEGACY_SECRET";
    // Every NON-live artifact `dbArtifactPaths()` must reach: the DELETE-mode rollback journal, the full
    // `.premigration` snapshot family (+ the legacy multi-file `-wal`/`-shm` sidecars), and the
    // timestamped `*.unreadable-<ts>` recovery renames.
    const STALE_NAMES = [
      "loam.db-journal",
      "loam.db.premigration.tmp",
      "loam.db.premigration-wal",
      "loam.db.premigration-shm",
      "loam.db.premigration-journal",
      "loam.db-wal.premigration",
      "loam.db-shm.premigration",
      "loam.db.unreadable-1700000000000-abc123",
      "loam.db-wal.unreadable-1700000000000-abc123",
      "loam.db-journal.unreadable-1700000000000-abc123",
    ];

    /** Seed a REAL legacy-key-encrypted `loam.db.premigration` (openable with `legacyKey`, which has no
     *  discardable device secret — THE crypto-wipe hole) plus every other stale DB artifact into
     *  `dataDir`, alongside a running app's live DB. */
    function seedStaleDbArtifacts(dataDir: string, legacyKey: string): void {
      const seedDir = mkdtempSync(join(tmpdir(), "loam-legacy-premig-"));
      cleanups.push(() => rmSync(seedDir, { recursive: true, force: true }));
      const seedDb = join(seedDir, "legacy.db");
      const legacy = openStore(seedDb, { encryptionKey: legacyKey });
      legacy.setConfigValue("legacy-sentinel", SENTINEL);
      legacy.checkpoint();
      legacy.close();
      // Sanity: it really IS a legacy-key DB — anyone with the passphrase can still open it, which is
      // exactly why leaving `.premigration` behind (encrypted under the legacy key, not a discardable
      // device secret) breaks the cryptographic-wipe guarantee.
      const verify = openStore(seedDb, { encryptionKey: legacyKey });
      expect(verify.getConfigValue("legacy-sentinel")).toBe(SENTINEL);
      verify.checkpoint();
      verify.close();
      copyFileSync(seedDb, join(dataDir, "loam.db.premigration"));
      for (const name of STALE_NAMES) {
        writeFileSync(join(dataDir, name), Buffer.from(`stale artifact: ${name}`));
      }
    }

    /** Every stale DB artifact still on disk (empty = a clean wipe). Excludes the LIVE `loam.db`/`-wal`/
     *  `-shm`, which the ephemeral/same-key/off paths legitimately recreate/keep open. */
    function staleArtifactsRemaining(dataDir: string): string[] {
      if (!existsSync(dataDir)) return [];
      const liveNames = new Set(["loam.db", "loam.db-wal", "loam.db-shm"]);
      return readdirSync(dataDir).filter(
        (n) =>
          !liveNames.has(n) &&
          (n.includes(".premigration") || n.includes(".unreadable-") || n === "loam.db-journal"),
      );
    }

    async function fireKillSwitch(app: LoamApp, cookie: string): Promise<InjectResponse> {
      return app.server.inject({
        method: "POST",
        url: "/api/admin/kill-switch",
        headers: { cookie },
        payload: { confirm: "wipe" },
      });
    }

    it("marker-SUCCESS branch (fixed-key + launcher hook): deletes the legacy .premigration + journal + unreadable renames, not just the live files", async () => {
      const hook = installFakeWipeRestartHook();
      const { app, dataDir } = await makeEncryptedApp(
        { dbEncryptionKey: "a fixed persistent key", dbEncryptionMode: "persistent" },
        { killSwitch: { enabled: true } },
      );
      const admin = await session(app);
      expect((await post(app, admin.cookie, "doomed")).statusCode).toBe(201);
      seedStaleDbArtifacts(dataDir, "an old legacy premigration key");
      expect(existsSync(join(dataDir, "loam.db.premigration"))).toBe(true);

      expect((await fireKillSwitch(app, admin.cookie)).statusCode).toBe(200);
      expect(hook.calls).toBe(1);

      expect(existsSync(join(dataDir, "loam.db"))).toBe(false);
      // The legacy-key backup (and every other sidecar) is physically gone — no passphrase can open it.
      expect(staleArtifactsRemaining(dataDir)).toEqual([]);
      expect(existsSync(join(dataDir, "loam.db.premigration"))).toBe(false);
    });

    it("phase-write-FAILURE fail-closed branch (fixed-key, phase write fails): synchronously deletes AND verifies EVERY artifact before signaling the launcher", async () => {
      const { app, dataDir } = await makeEncryptedApp(
        { dbEncryptionKey: "a fixed persistent key", dbEncryptionMode: "persistent" },
        { killSwitch: { enabled: true } },
      );

      let artifactsPresentAtHook: string[] | undefined;
      (globalThis as unknown as { __loamRequestWipeRestart?: () => void }).__loamRequestWipeRestart = () => {
        artifactsPresentAtHook = staleArtifactsRemaining(dataDir);
      };
      cleanups.push(() => {
        delete (globalThis as unknown as { __loamRequestWipeRestart?: unknown }).__loamRequestWipeRestart;
      });

      const admin = await session(app);
      expect((await post(app, admin.cookie, "doomed")).statusCode).toBe(201);
      seedStaleDbArtifacts(dataDir, "an old legacy premigration key");

      wipeMarkerWriteFailure.armed = true;
      expect((await fireKillSwitch(app, admin.cookie)).statusCode).toBe(200);

      // Fail-closed: by the time the launcher was signaled EVERY stale artifact was already gone (not
      // just the 3 live files) — a kill right after the hook can't recover the legacy-key ciphertext.
      expect(artifactsPresentAtHook).toEqual([]);
      expect(staleArtifactsRemaining(dataDir)).toEqual([]);
      expect(existsSync(join(dataDir, "loam.db"))).toBe(false);
      expect(existsSync(join(dataDir, ".loam-wipe-phase"))).toBe(false);
    });

    it("ephemeral branch: deletes stale migration/recovery artifacts before rotating to a fresh key", async () => {
      const { app, dataDir } = await makeEncryptedApp(
        { ephemeralDbKey: true, dbEncryptionMode: "ephemeral" },
        { killSwitch: { enabled: true } },
      );
      const admin = await session(app);
      expect((await post(app, admin.cookie, "doomed")).statusCode).toBe(201);
      seedStaleDbArtifacts(dataDir, "an old legacy premigration key");

      expect((await fireKillSwitch(app, admin.cookie)).statusCode).toBe(200);

      // The live DB is recreated under a fresh key (loam.db exists), but every stale artifact is gone.
      expect(existsSync(join(dataDir, "loam.db"))).toBe(true);
      expect(staleArtifactsRemaining(dataDir)).toEqual([]);
      expect(app.store.loadMessages()).toEqual([]);
      expect((await post(app, (await session(app)).cookie, "after wipe")).statusCode).toBe(201);
    });

    it("same-key fallback branch (fixed-key, NO launcher hook): deletes stale artifacts before recreating under the same key", async () => {
      // Deliberately NOT installing __loamRequestWipeRestart — the desktop/CI same-key fallback.
      const { app, dataDir } = await makeEncryptedApp(
        { dbEncryptionKey: "a fixed passphrase key", dbEncryptionMode: "passphrase" },
        { killSwitch: { enabled: true } },
      );
      const admin = await session(app);
      expect((await post(app, admin.cookie, "doomed")).statusCode).toBe(201);
      seedStaleDbArtifacts(dataDir, "an old legacy premigration key");

      expect((await fireKillSwitch(app, admin.cookie)).statusCode).toBe(200);

      expect(existsSync(join(dataDir, "loam.db"))).toBe(true); // recreated under the same key
      expect(staleArtifactsRemaining(dataDir)).toEqual([]);
      expect(app.store.loadMessages()).toEqual([]);
    });

    it("off/wipeAll branch (unencrypted): removes stale encrypted-era artifacts while keeping the live plaintext DB open", async () => {
      const { app, dataDir } = await makeEncryptedApp({}, { killSwitch: { enabled: true } });
      const admin = await session(app);
      expect((await post(app, admin.cookie, "doomed")).statusCode).toBe(201);
      seedStaleDbArtifacts(dataDir, "an old legacy premigration key");

      expect((await fireKillSwitch(app, admin.cookie)).statusCode).toBe(200);

      expect(existsSync(join(dataDir, "loam.db"))).toBe(true); // live plaintext DB stays open (wipeAll)
      expect(staleArtifactsRemaining(dataDir)).toEqual([]);
      expect(app.store.loadMessages()).toEqual([]);
    });
  });

  /** Install the `globalThis.__loamReportBootError` bridge (the same one `embedded-main.ts` uses for
   *  fatal boot errors — see its own test suite) and capture every report. Auto-uninstalled. */
  function installFakeBootBridge(): { message: string; code: string }[] {
    const reports: { message: string; code: string }[] = [];
    (
      globalThis as unknown as { __loamReportBootError?: (message: string, code: string) => void }
    ).__loamReportBootError = (message, code) => reports.push({ message, code });
    cleanups.push(() => {
      delete (globalThis as unknown as { __loamReportBootError?: unknown }).__loamReportBootError;
    });
    return reports;
  }

  describe("passphrase key-derivation migration (dbEncryptionMigrateFromKey / PRAGMA rekey)", () => {
    /** Install the `globalThis.__loamReportDbKeyMigrated` bridge (main.js's migration-confirmed signal,
     *  see db-encryption.ts's `markPassphraseKeyMigrated`) and count every invocation. Auto-uninstalled. */
    function installFakeMigratedHook(): { calls: number; requestIds: (string | undefined)[]; reset: () => void } {
      const state: { calls: number; requestIds: (string | undefined)[]; reset: () => void } = {
        calls: 0,
        requestIds: [],
        reset() {
          state.calls = 0;
          state.requestIds.length = 0;
        },
      };
      (globalThis as unknown as { __loamReportDbKeyMigrated?: (requestId?: string) => void }).__loamReportDbKeyMigrated =
        (requestId?: string) => {
          state.calls += 1;
          state.requestIds.push(requestId);
        };
      cleanups.push(() => {
        delete (globalThis as unknown as { __loamReportDbKeyMigrated?: unknown }).__loamReportDbKeyMigrated;
      });
      return state;
    }

    it("migrates an existing legacy-keyed passphrase DB in place: rows survive, the current key opens it directly afterward, the legacy key no longer does, and the launcher is told it migrated", async () => {
      const migrated = installFakeMigratedHook();
      const legacyKey = "legacy SHA256(passphrase)-only key";
      const currentKey = "current SHA256(passphrase + deviceSecret) key";

      const dataDir = mkdtempSync(join(tmpdir(), "loam-migrate-test-"));
      cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));

      // An "existing" passphrase DB, encrypted under the legacy derivation.
      const original = await buildApp({ requireRulesAcceptance: false,
        dataDir,
        logger: false,
        dbEncryptionKey: legacyKey,
        dbEncryptionMode: "passphrase",
      });
      const admin = await session(original);
      expect((await post(original, admin.cookie, "MIGRATE_ME")).statusCode).toBe(201);
      await original.close();

      // Every successful passphrase-mode open acks (the launcher retires a legacy stored
      // passphrase only on this confirmation), so creating the legacy DB counted one. Reset so the
      // assertions below isolate the MIGRATION boot's ack.
      expect(migrated.calls).toBe(1);
      migrated.reset();

      // Boot with the CURRENT key plus the legacy key as a migration fallback — mirrors main.js offering
      // both because it hasn't recorded a confirmed migration yet.
      const migratedApp = await buildApp({ requireRulesAcceptance: false,
        dataDir,
        logger: false,
        dbEncryptionKey: currentKey,
        dbEncryptionMigrateFromKey: legacyKey,
        dbEncryptionMode: "passphrase",
        // The launcher's immutable per-boot handoff id must be forwarded VERBATIM in
        // the migration ack (so RN promotes the exact attempt that opened THIS DB, not a mutable global).
        dbKeyRequestId: "dbkey-boot-7",
      });

      expect(migrated.calls).toBe(1);
      expect(migrated.requestIds).toEqual(["dbkey-boot-7"]);
      expect(migratedApp.store.loadMessages().some((m) => "body" in m && m.body === "MIGRATE_ME")).toBe(true);
      // RF-b: a CLEAN migration deletes the pre-migration backup sidecars — none must be left behind (a
      // leftover would be misread as an interrupted migration on the next boot and trigger a restore).
      expect(readdirSync(dataDir).some((name) => name.includes(".premigration"))).toBe(false);
      await migratedApp.close();

      // Rekeyed in place: a LATER boot with only the current key (no legacy key offered at all) opens
      // the same file directly.
      const reopened = await buildApp({ requireRulesAcceptance: false,
        dataDir,
        logger: false,
        dbEncryptionKey: currentKey,
        dbEncryptionMode: "passphrase",
      });
      expect(reopened.store.loadMessages().some((m) => "body" in m && m.body === "MIGRATE_ME")).toBe(true);
      await reopened.close();

      // The OLD legacy key can no longer open the file at all.
      await expect(
        buildApp({ requireRulesAcceptance: false, dataDir, logger: false, dbEncryptionKey: legacyKey, dbEncryptionMode: "passphrase" }),
      ).rejects.toThrow();
    });

    it("an interrupted rekey (a .premigration backup present alongside a corrupt/half loam.db) is restored on boot and migrates successfully", async () => {
      const migrated = installFakeMigratedHook();
      const legacyKey = "legacy SHA256(passphrase)-only key";
      const currentKey = "current SHA256(passphrase + deviceSecret) key";

      const dataDir = mkdtempSync(join(tmpdir(), "loam-migrate-interrupt-test-"));
      cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));

      // A real legacy-encrypted passphrase DB with a row we must not lose.
      const original = await buildApp({ requireRulesAcceptance: false,
        dataDir,
        logger: false,
        dbEncryptionKey: legacyKey,
        dbEncryptionMode: "passphrase",
      });
      const admin = await session(original);
      expect((await post(original, admin.cookie, "SURVIVE_INTERRUPTED_REKEY")).statusCode).toBe(201);
      migrated.reset(); // the legacy-DB creation acked once (every passphrase-mode open does)
      await original.close();

      // Simulate a rekey interrupted by an OS-kill AFTER the pre-migration backup was taken but BEFORE
      // (or during) the in-place PRAGMA rekey completed: the intact legacy files are preserved under
      // `.premigration`, while the live `loam.db` is now half-rekeyed/corrupt (openable under neither key).
      for (const suffix of ["", "-wal", "-shm"]) {
        const live = join(dataDir, `loam.db${suffix}`);
        if (existsSync(live)) {
          copyFileSync(live, `${live}.premigration`);
        }
      }
      writeFileSync(join(dataDir, "loam.db"), Buffer.from("not a database — half-rekeyed corruption"));

      // Boot: Step 0b must restore the intact legacy DB from the sidecars, then the migration branch
      // rekeys it to the current key. The row survives and the launcher is told it migrated.
      const recovered = await buildApp({ requireRulesAcceptance: false,
        dataDir,
        logger: false,
        dbEncryptionKey: currentKey,
        dbEncryptionMigrateFromKey: legacyKey,
        dbEncryptionMode: "passphrase",
      });
      expect(migrated.calls).toBe(1);
      expect(
        recovered.store.loadMessages().some((m) => "body" in m && m.body === "SURVIVE_INTERRUPTED_REKEY"),
      ).toBe(true);
      // The successful re-migration cleaned up the sidecars.
      expect(readdirSync(dataDir).some((name) => name.includes(".premigration"))).toBe(false);
      await recovered.close();

      // And the rekey actually took: a later boot with only the current key opens it directly.
      const reopened = await buildApp({ requireRulesAcceptance: false,
        dataDir,
        logger: false,
        dbEncryptionKey: currentKey,
        dbEncryptionMode: "passphrase",
      });
      expect(
        reopened.store.loadMessages().some((m) => "body" in m && m.body === "SURVIVE_INTERRUPTED_REKEY"),
      ).toBe(true);
      await reopened.close();
    });

    it("a post-rekey CLEANUP failure does NOT fail the boot — the current boot returns a ready, migrated store with data intact (not a plaintext/unreadable fallback)", async () => {
      const migrated = installFakeMigratedHook();
      const legacyKey = "legacy SHA256(passphrase)-only key";
      const currentKey = "current SHA256(passphrase + deviceSecret) key";

      const dataDir = mkdtempSync(join(tmpdir(), "loam-p22-cleanup-fail-"));
      cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));

      const original = await buildApp({ requireRulesAcceptance: false,
        dataDir,
        logger: false,
        dbEncryptionKey: legacyKey,
        dbEncryptionMode: "passphrase",
      });
      const admin = await session(original);
      migrated.reset(); // the legacy-DB creation acked once (every passphrase-mode open does)
      expect((await post(original, admin.cookie, "SURVIVE_CLEANUP_FAILURE")).statusCode).toBe(201);
      await original.close();

      // Force the POST-rekey cleanup `rmSync(loam.db.premigration)` to throw. Before the fix that jumped to
      // the outer migration `catch` and fell through as if the rekey had FAILED — leaking the already-
      // rekeyed handle and running the plaintext/recovery chain against a DB already valid under the current
      // key. The fix treats the rekey as the commit point, so the cleanup failure is swallowed best-effort.
      postRekeyCleanupFailure.armed = true;

      const migratedApp = await buildApp({ requireRulesAcceptance: false,
        dataDir,
        logger: false,
        dbEncryptionKey: currentKey,
        dbEncryptionMigrateFromKey: legacyKey,
        dbEncryptionMode: "passphrase",
      });

      // The rekey is the commit point: the boot returns the LIVE migrated store — the launcher is told it
      // migrated and the row survives (NOT a plaintext/unreadable fallback that would lose or expose data).
      expect(migrated.calls).toBe(1);
      expect(
        migratedApp.store.loadMessages().some((m) => "body" in m && m.body === "SURVIVE_CLEANUP_FAILURE"),
      ).toBe(true);
      // Genuinely encrypted under the current key (not the plaintext fallback) — no plaintext on disk.
      expect(dataDirHasPlaintext(dataDir, "SURVIVE_CLEANUP_FAILURE")).toBe(false);
      // The cleanup failed, so the stale backup is INTENTIONALLY left behind for the next boot's Step-0b.
      expect(existsSync(join(dataDir, "loam.db.premigration"))).toBe(true);
      await migratedApp.close();

      // A later boot with ONLY the current key opens directly (the rekey took) AND Step-0b discards the
      // stale backup the failed cleanup left — proving the cleanup failure never corrupted the migration.
      const reopened = await buildApp({ requireRulesAcceptance: false,
        dataDir,
        logger: false,
        dbEncryptionKey: currentKey,
        dbEncryptionMode: "passphrase",
      });
      expect(
        reopened.store.loadMessages().some((m) => "body" in m && m.body === "SURVIVE_CLEANUP_FAILURE"),
      ).toBe(true);
      expect(existsSync(join(dataDir, "loam.db.premigration"))).toBe(false);
      await reopened.close();
    });

    describe("the pre-migration backup is CRASH-ATOMIC (single-file, checkpoint-folded, commit-by-rename)", () => {
      const legacyKey = "legacy SHA256(passphrase)-only key";
      const currentKey = "current SHA256(passphrase + deviceSecret) key";

      /** Build a legacy-encrypted passphrase DB carrying `body`, closed cleanly (WAL checkpointed away, so
       *  only a single-file `loam.db` remains on disk). Returns the dataDir it lives in. */
      async function makeLegacyDb(body: string): Promise<string> {
        const dataDir = mkdtempSync(join(tmpdir(), "loam-p1a-test-"));
        cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
        const app = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false, dbEncryptionKey: legacyKey, dbEncryptionMode: "passphrase" });
        const admin = await session(app);
        expect((await post(app, admin.cookie, body)).statusCode).toBe(201);
        await app.close();
        return dataDir;
      }

      /** Assert `dataDir` migrates cleanly under the current key with `body` intact and no leftover backup
       *  artifacts (neither a committed `.premigration` nor a stray `.premigration.tmp`). */
      async function expectCleanMigration(dataDir: string, body: string): Promise<void> {
        const migrated = installFakeMigratedHook();
        const app = await buildApp({ requireRulesAcceptance: false,
          dataDir,
          logger: false,
          dbEncryptionKey: currentKey,
          dbEncryptionMigrateFromKey: legacyKey,
          dbEncryptionMode: "passphrase",
        });
        expect(migrated.calls).toBe(1);
        expect(app.store.loadMessages().some((m) => "body" in m && m.body === body)).toBe(true);
        expect(readdirSync(dataDir).some((name) => name.includes(".premigration"))).toBe(false);
        await app.close();
      }

      it("kill AFTER checkpoint but BEFORE the copy: no backup artifacts exist, so the migration simply re-runs on the intact live DB", async () => {
        // A checkpoint is non-destructive; a kill right after it (before any copy) leaves the intact legacy
        // DB and NO `.premigration`/`.tmp` at all. This models that exact on-disk state.
        const dataDir = await makeLegacyDb("AFTER_CHECKPOINT_BEFORE_COPY");
        expect(readdirSync(dataDir).some((name) => name.includes(".premigration"))).toBe(false);
        await expectCleanMigration(dataDir, "AFTER_CHECKPOINT_BEFORE_COPY");
      });

      it("kill AFTER the copy but BEFORE the commit rename: a stray `.premigration.tmp` is DISCARDED, never restored, and the migration re-runs on the intact live DB", async () => {
        const dataDir = await makeLegacyDb("AFTER_COPY_BEFORE_RENAME");
        // Simulate a kill mid-copy: a truncated/partial `.tmp` is present, but no COMMITTED backup exists.
        writeFileSync(join(dataDir, "loam.db.premigration.tmp"), Buffer.from("a half-written backup copy"));
        expect(existsSync(join(dataDir, "loam.db.premigration"))).toBe(false);

        // Step 0b must NOT restore from the uncommitted `.tmp` (that is the whole crash-atomicity guarantee —
        // an incomplete backup can never replace the intact live DB); it discards it and the migration runs.
        await expectCleanMigration(dataDir, "AFTER_COPY_BEFORE_RENAME");
        expect(existsSync(join(dataDir, "loam.db.premigration.tmp"))).toBe(false);
      });

      it("kill AFTER the backup commit but BEFORE the rekey: the committed single-file backup is restored (single atomic rename) and the migration retries", async () => {
        const dataDir = await makeLegacyDb("AFTER_COMMIT_BEFORE_REKEY");
        // The committed backup exists and the rekey never ran, so the live DB still equals the (intact,
        // legacy-encrypted) backup — exactly the state a kill in this window leaves.
        copyFileSync(join(dataDir, "loam.db"), join(dataDir, "loam.db.premigration"));

        await expectCleanMigration(dataDir, "AFTER_COMMIT_BEFORE_REKEY");
      });

      it("kill MID-rekey: the committed single-file backup is restored over the half-rekeyed (corrupt) live DB and the migration retries", async () => {
        const dataDir = await makeLegacyDb("MID_REKEY");
        // Committed backup = the intact legacy DB; live loam.db = half-rekeyed corruption (openable under
        // neither key) plus stale `-wal`/`-shm` from the interrupted rekey.
        copyFileSync(join(dataDir, "loam.db"), join(dataDir, "loam.db.premigration"));
        writeFileSync(join(dataDir, "loam.db"), Buffer.from("half-rekeyed corruption — opens under no key"));
        writeFileSync(join(dataDir, "loam.db-wal"), Buffer.from("stale half-rekey wal"));
        writeFileSync(join(dataDir, "loam.db-shm"), Buffer.from("stale half-rekey shm"));

        await expectCleanMigration(dataDir, "MID_REKEY");
      });

      it("committed data still resident in the WAL: the checkpoint folds it into the single-file backup, which a restore then preserves (no committed rows lost)", async () => {
        // 1. Build a legacy DB whose committed row lives ONLY in the WAL, not in loam.db's main file.
        const dataDir = mkdtempSync(join(tmpdir(), "loam-p1a-wal-test-"));
        cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
        const producer = await buildApp({ requireRulesAcceptance: false,
          dataDir,
          logger: false,
          dbEncryptionKey: legacyKey,
          dbEncryptionMode: "passphrase",
        });
        const admin = await session(producer);
        expect((await post(producer, admin.cookie, "WAL_RESIDENT_ROW")).statusCode).toBe(201);
        // Snapshot the live files WHILE the connection is open (row committed to the WAL, not yet folded
        // into the main file — nothing writes after the synchronous write-through, so the copy is quiescent).
        const snapDir = mkdtempSync(join(tmpdir(), "loam-p1a-wal-snap-"));
        for (const suffix of ["", "-wal", "-shm"]) {
          const live = join(dataDir, `loam.db${suffix}`);
          if (existsSync(live)) copyFileSync(live, join(snapDir, `loam.db${suffix}`));
        }
        await producer.close(); // a clean close checkpoints + deletes the WAL — undone by the restore below
        for (const suffix of ["", "-wal", "-shm"]) {
          const snap = join(snapDir, `loam.db${suffix}`);
          const live = join(dataDir, `loam.db${suffix}`);
          if (existsSync(snap)) copyFileSync(snap, live);
          else rmSync(live, { force: true });
        }

        // Precondition proof: the main file ALONE (no WAL) does not yet contain the row — it is WAL-resident.
        const mainOnlyDir = mkdtempSync(join(tmpdir(), "loam-p1a-mainonly-"));
        cleanups.push(() => rmSync(mainOnlyDir, { recursive: true, force: true }));
        copyFileSync(join(snapDir, "loam.db"), join(mainOnlyDir, "loam.db"));
        const mainOnly = openStore(join(mainOnlyDir, "loam.db"), { encryptionKey: legacyKey });
        expect(mainOnly.loadMessages().some((m) => "body" in m && m.body === "WAL_RESIDENT_ROW")).toBe(false);
        mainOnly.close();
        rmSync(snapDir, { recursive: true, force: true });

        // 2. Capture the single-file backup the migration commits, and run the (clean) migration.
        const captureDir = mkdtempSync(join(tmpdir(), "loam-p1a-capture-"));
        cleanups.push(() => rmSync(captureDir, { recursive: true, force: true }));
        backupCapture.dir = captureDir;
        const migrated = installFakeMigratedHook();
        const migratedApp = await buildApp({ requireRulesAcceptance: false,
          dataDir,
          logger: false,
          dbEncryptionKey: currentKey,
          dbEncryptionMigrateFromKey: legacyKey,
          dbEncryptionMode: "passphrase",
        });
        expect(migrated.calls).toBe(1);
        // The clean migration preserved the WAL-resident row.
        expect(migratedApp.store.loadMessages().some((m) => "body" in m && m.body === "WAL_RESIDENT_ROW")).toBe(true);
        await migratedApp.close();

        // 3. The CAPTURED single-file backup — a copy of loam.db taken AFTER the checkpoint but BEFORE the
        // rekey — contains the row. Without the checkpoint-before-copy this file would be the main-only file
        // proven row-less above, and a restore from it would lose committed data.
        const captured = openStore(join(captureDir, "captured-backup.db"), { encryptionKey: legacyKey });
        expect(captured.loadMessages().some((m) => "body" in m && m.body === "WAL_RESIDENT_ROW")).toBe(true);
        captured.close();

        // 4. End-to-end restore: feed that production-made backup back through Step 0b over a corrupt live
        // DB and confirm the row survives the backup+restore round trip.
        backupCapture.dir = undefined;
        copyFileSync(join(captureDir, "captured-backup.db"), join(dataDir, "loam.db.premigration"));
        writeFileSync(join(dataDir, "loam.db"), Buffer.from("corrupt live db — must be restored from backup"));
        rmSync(join(dataDir, "loam.db-wal"), { force: true });
        rmSync(join(dataDir, "loam.db-shm"), { force: true });
        const migrated2 = installFakeMigratedHook();
        const restored = await buildApp({ requireRulesAcceptance: false,
          dataDir,
          logger: false,
          dbEncryptionKey: currentKey,
          dbEncryptionMigrateFromKey: legacyKey,
          dbEncryptionMode: "passphrase",
        });
        expect(migrated2.calls).toBe(1);
        expect(restored.store.loadMessages().some((m) => "body" in m && m.body === "WAL_RESIDENT_ROW")).toBe(true);
        expect(readdirSync(dataDir).some((name) => name.includes(".premigration"))).toBe(false);
        await restored.close();
      });

      it("an interrupted DELETE-mode rekey leaves a foreign `loam.db-journal` — Step 0b removes it so the restored single file is never paired with a hot rollback journal", async () => {
        const dataDir = await makeLegacyDb("SURVIVES_FOREIGN_JOURNAL");
        // Committed backup = the intact legacy DB. The live loam.db is half-rekeyed corruption (opens
        // under no key) PLUS a `loam.db-journal` — the rollback journal a DELETE-mode rekey (the mode
        // SQLCipher forces for rekey; it refuses under WAL) leaves when killed mid-way. This is NOT a
        // `-wal`/`-shm` pair, which is exactly the state the old Step 0b failed to clean.
        copyFileSync(join(dataDir, "loam.db"), join(dataDir, "loam.db.premigration"));
        writeFileSync(join(dataDir, "loam.db"), Buffer.from("half-rekeyed corruption — opens under no key"));
        writeFileSync(
          join(dataDir, "loam.db-journal"),
          Buffer.from("stale rollback journal left by the interrupted DELETE-mode rekey"),
        );

        // Capture rmSync paths so we can prove Step 0b EXPLICITLY removes the journal (not just that it
        // happens to be gone after a successful open, which SQLite would do regardless of the fix).
        rmSyncCapture.paths = [];
        try {
          await expectCleanMigration(dataDir, "SURVIVES_FOREIGN_JOURNAL");
          expect(rmSyncCapture.paths.some((p) => p.endsWith("loam.db-journal"))).toBe(true);
        } finally {
          rmSyncCapture.paths = undefined;
        }
        // The foreign rollback journal must be gone — a restored self-consistent file paired with a hot
        // journal violates the crash-atomic single-self-consistent-file invariant.
        expect(existsSync(join(dataDir, "loam.db-journal"))).toBe(false);
      });

      it("a stale `.premigration` left by a SUCCESSFUL-but-uncleaned migration is DISCARDED (not restored), preserving the serving session's data", async () => {
        // 1. A legacy DB with a pre-migration row; snapshot the intact legacy single file — this is what a
        // stale, never-cleaned `.premigration` holds (it predates the migration, so ONLY the pre row).
        const dataDir = await makeLegacyDb("PRE_MIGRATION_ROW");
        const staleSnapshot = join(dataDir, "stale-legacy-snapshot.db");
        copyFileSync(join(dataDir, "loam.db"), staleSnapshot);

        // 2. Migrate cleanly to the current key, then write a NEW row during that serving session — the
        // data a full session accrues AFTER a migration that already succeeded.
        const migrated = installFakeMigratedHook();
        const migratedApp = await buildApp({ requireRulesAcceptance: false,
          dataDir,
          logger: false,
          dbEncryptionKey: currentKey,
          dbEncryptionMigrateFromKey: legacyKey,
          dbEncryptionMode: "passphrase",
        });
        expect(migrated.calls).toBe(1);
        const admin = await session(migratedApp);
        expect((await post(migratedApp, admin.cookie, "POST_MIGRATION_SESSION_ROW")).statusCode).toBe(201);
        await migratedApp.close();
        // The clean migration removed its own backup.
        expect(readdirSync(dataDir).some((name) => name.includes(".premigration"))).toBe(false);

        // 3. Simulate the post-success `rmSync(committedBackup)` cleanup having THROWN (read-only dir /
        // locked file): the stale legacy snapshot survives as `loam.db.premigration` into the next boot.
        copyFileSync(staleSnapshot, join(dataDir, "loam.db.premigration"));
        rmSync(staleSnapshot, { force: true });

        // 4. Boot again under the current key. Step 0b PROBES the live DB (it opens under the current key →
        // the migration already succeeded) and DISCARDS the stale backup rather than restoring it. A blind
        // restore would revert to the pre-migration snapshot and LOSE the session row.
        const reopened = await buildApp({ requireRulesAcceptance: false,
          dataDir,
          logger: false,
          dbEncryptionKey: currentKey,
          dbEncryptionMigrateFromKey: legacyKey,
          dbEncryptionMode: "passphrase",
        });
        const bodies = reopened.store.loadMessages().flatMap((m) => ("body" in m ? [m.body] : []));
        expect(bodies).toContain("PRE_MIGRATION_ROW");
        // Preserved — proof the stale backup was discarded, not restored over the live DB.
        expect(bodies).toContain("POST_MIGRATION_SESSION_ROW");
        expect(readdirSync(dataDir).some((name) => name.includes(".premigration"))).toBe(false);
        await reopened.close();
      });
    });

    it("a fresh install (no prior DB) opens cleanly under the current key without ever needing the offered legacy one, and still reports migrated so the launcher stops offering it", async () => {
      const migrated = installFakeMigratedHook();
      const dataDir = mkdtempSync(join(tmpdir(), "loam-migrate-fresh-test-"));
      cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));

      const app = await buildApp({ requireRulesAcceptance: false,
        dataDir,
        logger: false,
        dbEncryptionKey: "current SHA256(passphrase + deviceSecret) key",
        dbEncryptionMigrateFromKey: "a legacy key that will never actually be needed",
        dbEncryptionMode: "passphrase",
      });
      cleanups.push(() => app.close());

      expect(migrated.calls).toBe(1);
      const admin = await session(app);
      expect((await post(app, admin.cookie, "fresh install")).statusCode).toBe(201);
    });

    it("falls through to the existing db_encryption_unreadable recovery path when NEITHER the current nor the offered legacy key opens the database", async () => {
      const reports = installFakeBootBridge();
      const { app: original, dataDir } = await makeEncryptedApp({ dbEncryptionKey: "the real key" });
      await session(original);
      await original.close();

      await expect(
        buildApp({ requireRulesAcceptance: false,
          dataDir,
          logger: false,
          dbEncryptionKey: "a totally wrong current key",
          dbEncryptionMigrateFromKey: "a totally wrong legacy key too",
        }),
      ).rejects.toThrow(/could not be opened/);

      expect(reports).toEqual([expect.objectContaining({ code: "db_encryption_unreadable" })]);
    });
  });

  describe("resilient encrypted-DB open", () => {
    it("an existing PLAINTEXT database under a configured encrypted mode is NOT silently served as plaintext — it reports `db_encryption_plaintext_unconverted` and LOCKS; a start-fresh confirmation then deletes it and starts a fresh ENCRYPTED database", async () => {
      const reports = installFakeBootBridge();

      // A plaintext DB already on disk (no encryption ever configured) — simulates a node switched
      // into an encrypted mode without a rekey of the existing data.
      const dataDir = mkdtempSync(join(tmpdir(), "loam-enc-plaintext-unconverted-test-"));
      cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
      const plain = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false });
      const plainAdmin = await session(plain);
      expect((await post(plain, plainAdmin.cookie, "PLAINTEXT_ALREADY_ON_DISK")).statusCode).toBe(201);
      await plain.close();

      // Reopen the SAME data dir with an encryption key configured. The keyed open fails against the real
      // plaintext file, and a plaintext probe SUCCEEDS — the old code silently served that plaintext file
      // (a confidentiality downgrade). Now it must LOCK with the distinct code, NOT serve.
      await expect(
        buildApp({ requireRulesAcceptance: false, dataDir, logger: false, dbEncryptionKey: "a newly configured key" }),
      ).rejects.toThrow(/refusing to serve it unencrypted/);
      expect(reports).toEqual([expect.objectContaining({ code: "db_encryption_plaintext_unconverted" })]);
      // The key itself must never appear in the reported message.
      expect(reports[0]?.message).not.toContain("a newly configured key");
      // Nothing on disk was touched — the plaintext file is still there, still plaintext.
      expect(readFileSync(join(dataDir, "loam.db")).subarray(0, 15).toString("ascii")).toBe("SQLite format 3");

      // The operator confirms "delete data and start encrypted": the RN start-fresh marker is written with
      // the DELETE intent (the plaintext-unconverted recovery is a deliberate destructive action).
      reports.length = 0;
      writeFileSync(join(dataDir, ".loam-db-start-fresh"), "delete");

      const encrypted = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false, dbEncryptionKey: "a newly configured key" });
      cleanups.push(() => encrypted.close());

      // The plaintext DB was DELETED (not preserved as a readable `.unreadable-` rename) and a FRESH
      // encrypted database was created — reported as a recovered-fresh start.
      expect(reports).toEqual([expect.objectContaining({ code: "db_encryption_recovered_fresh" })]);
      // The old plaintext data is gone (a fresh DB), and the marker was consumed.
      expect(encrypted.store.loadMessages()).toEqual([]);
      expect(existsSync(join(dataDir, ".loam-db-start-fresh"))).toBe(false);
      // The plaintext file was DELETED, not renamed aside — no `*.unreadable-*` copy of it survives.
      expect(readdirSync(dataDir).some((n) => n.includes(".unreadable-"))).toBe(false);
      // The new loam.db is genuinely encrypted: an UNKEYED open now fails ("not a database").
      expect(() => openStore(join(dataDir, "loam.db"), {}).close()).toThrow();
      // Fully usable, and reports encrypted posture.
      const encAdmin = await session(encrypted);
      expect((await post(encrypted, encAdmin.cookie, "after encrypted start")).statusCode).toBe(201);
      expect(dataDirHasPlaintext(dataDir, "after encrypted start")).toBe(false);
    });

    /** Path to the shared launcher "start fresh" confirmation marker inside `dataDir`. */
    function startFreshMarkerPath(dataDir: string): string {
      return join(dataDir, ".loam-db-start-fresh");
    }

    /** Every `loam.db*` file in `dataDir`, for asserting nothing (or something specific) was touched. */
    function dbFileNames(dataDir: string): string[] {
      return readdirSync(dataDir).filter((name) => name.startsWith("loam.db"));
    }

    it("a genuinely unopenable DB with NO start-fresh marker present THROWS non-destructively — the original files are untouched, not silently opened as plaintext or auto-replaced", async () => {
      const reports = installFakeBootBridge();

      const { app: original, dataDir } = await makeEncryptedApp({ dbEncryptionKey: "the original key" });
      const originalAdmin = await session(original);
      expect((await post(original, originalAdmin.cookie, "LOCKED_BEHIND_KEY_A")).statusCode).toBe(201);
      await original.close();

      const filesBefore = dbFileNames(dataDir).sort();
      const bytesBefore = readFileSync(join(dataDir, "loam.db"));

      // Reopen with a DIFFERENT key — case 1 (keyed open under the new key) fails, and case 2 (plaintext
      // open) also fails because the file is genuinely SQLCipher ciphertext, not a valid plain SQLite
      // header. With no marker present, this must THROW rather than auto-replace the DB.
      await expect(
        buildApp({ requireRulesAcceptance: false, dataDir, logger: false, dbEncryptionKey: "a completely different key" }),
      ).rejects.toThrow(/could not be opened/);

      expect(reports).toEqual([expect.objectContaining({ code: "db_encryption_unreadable" })]);
      expect(reports[0]?.message).not.toContain("the original key");
      expect(reports[0]?.message).not.toContain("a completely different key");

      // Nothing on disk was touched — no rename, no new/renamed files, identical bytes.
      expect(dbFileNames(dataDir).sort()).toEqual(filesBefore);
      expect(readFileSync(join(dataDir, "loam.db")).equals(bytesBefore)).toBe(true);
    });

    it("a ciphertext DB with NO key configured at all ALSO gets non-destructive recovery treatment, instead of buildApp's raw 'not a database' throw", async () => {
      const reports = installFakeBootBridge();

      const { app: original, dataDir } = await makeEncryptedApp({ dbEncryptionKey: "some key" });
      await session(original);
      await original.close();

      const filesBefore = dbFileNames(dataDir).sort();

      // No dbEncryptionKey/ephemeralDbKey at all this time — encryptionEnabled starts false, but the
      // file on disk is genuine SQLCipher ciphertext. Before the fix this bypassed recovery entirely
      // (encryptionEnabled gated it) and buildApp rejected with a raw "file is not a database" error;
      // now it must reach the same marker-gated non-destructive path as the keyed case.
      await expect(buildApp({ requireRulesAcceptance: false, dataDir, logger: false })).rejects.toThrow(/could not be opened/);

      expect(reports).toEqual([expect.objectContaining({ code: "db_encryption_unreadable" })]);
      expect(dbFileNames(dataDir).sort()).toEqual(filesBefore); // untouched
    });

    it("an explicit .loam-db-start-fresh marker consumes itself and triggers a unique-suffix recovery, reporting db_encryption_recovered_fresh", async () => {
      const reports = installFakeBootBridge();

      const { app: original, dataDir } = await makeEncryptedApp({ dbEncryptionKey: "the original key" });
      const originalAdmin = await session(original);
      expect((await post(original, originalAdmin.cookie, "LOCKED_BEHIND_KEY_A")).statusCode).toBe(201);
      await original.close();

      // The RN host's explicit start-fresh confirmation UI writes this marker before restarting.
      writeFileSync(startFreshMarkerPath(dataDir), "");

      const recovered = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false, dbEncryptionKey: "a completely different key" });
      cleanups.push(() => recovered.close());

      expect(reports).toEqual([expect.objectContaining({ code: "db_encryption_recovered_fresh" })]);
      expect(reports[0]?.message).not.toContain("the original key");
      expect(reports[0]?.message).not.toContain("a completely different key");

      // The marker is consumed (deleted), never re-triggering recovery on a later boot.
      expect(existsSync(startFreshMarkerPath(dataDir))).toBe(false);

      // The old ciphertext is preserved on disk in a UNIQUE recovery-snapshot directory, not
      // deleted and not overwriting any earlier snapshot; the old DB set lives INSIDE it (out of the active
      // namespace + the orphan reaper's path).
      const snapshots = recoverySnapshots(dataDir);
      expect(snapshots.length).toBe(1);
      expect(existsSync(join(dataDir, snapshots[0], "loam.db"))).toBe(true);

      // The fresh DB has no memory of the old data, but is fully usable (and still encrypted — the
      // effective posture wasn't downgraded, unlike the plaintext-fallback case above).
      expect(recovered.store.loadMessages()).toEqual([]);
      const recoveredAdmin = await session(recovered);
      expect((await post(recovered, recoveredAdmin.cookie, "fresh after recovery")).statusCode).toBe(201);
    });

    it("a rename/open failure during marker-confirmed recovery is recast as a recoverable db_encryption_unreadable, not a generic throw that would kill the process", async () => {
      const reports = installFakeBootBridge();

      const { app: original, dataDir } = await makeEncryptedApp({ dbEncryptionKey: "key A" });
      const originalAdmin = await session(original);
      expect((await post(original, originalAdmin.cookie, "seed")).statusCode).toBe(201);
      await original.close();

      writeFileSync(startFreshMarkerPath(dataDir), "");

      // Force the marker-confirmed recovery's rename-aside step to throw AFTER the marker has already
      // been consumed by step 0 — the exact scenario being fixed (a failure here used to propagate as a
      // generic, untyped error rather than the recoverable `db_encryption_unreadable` case). Single-shot:
      // it fires on the very next `renameSync` call (the recovery block's — nothing else in this boot
      // path calls it first) and immediately self-disarms.
      renameFailure.armed = true;

      await expect(buildApp({ requireRulesAcceptance: false, dataDir, logger: false, dbEncryptionKey: "key B" })).rejects.toThrow(
        /Start-fresh recovery failed/,
      );

      // Recast as the SAME typed, recoverable error case 3 (no marker / genuinely unopenable) throws —
      // NOT a generic error, which `embedded-main.ts` would treat as unrecoverable and `process.exit(1)`
      // on instead of staying alive for a retry.
      expect(reports).toEqual([expect.objectContaining({ code: "db_encryption_unreadable" })]);

      // The marker was already consumed before the injected failure (step 0 runs first) — it must not
      // linger to silently re-authorize some LATER, unrelated failure the operator never confirmed.
      expect(existsSync(startFreshMarkerPath(dataDir))).toBe(false);

      // A fresh confirmation lets the operator retry immediately and actually succeed this time — the
      // fault injection was single-shot, so this second attempt hits the real (un-mocked) renameSync.
      writeFileSync(startFreshMarkerPath(dataDir), "");
      const recovered = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false, dbEncryptionKey: "key B" });
      cleanups.push(() => recovered.close());
      expect(recovered.store.loadMessages()).toEqual([]);
      const recoveredAdmin = await session(recovered);
      expect((await post(recovered, recoveredAdmin.cookie, "after RF4 retry")).statusCode).toBe(201);
    });

    it("two successive marker-confirmed recoveries each keep their OWN preserved copy — the second never overwrites the first", async () => {
      installFakeBootBridge();

      const { app: original, dataDir } = await makeEncryptedApp({ dbEncryptionKey: "key A" });
      const originalAdmin = await session(original);
      expect((await post(original, originalAdmin.cookie, "seed")).statusCode).toBe(201);
      await original.close();

      // First recovery: wrong key + marker present.
      writeFileSync(startFreshMarkerPath(dataDir), "");
      const first = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false, dbEncryptionKey: "key B" });
      const admin1 = await session(first);
      expect((await post(first, admin1.cookie, "after first recovery")).statusCode).toBe(201);
      await first.close();

      const preservedAfterFirst = recoverySnapshots(dataDir);
      expect(preservedAfterFirst.length).toBe(1);

      // Second recovery: open under yet ANOTHER wrong key, with a fresh marker again.
      writeFileSync(startFreshMarkerPath(dataDir), "");
      const second = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false, dbEncryptionKey: "key C" });
      cleanups.push(() => second.close());

      const preservedAfterSecond = recoverySnapshots(dataDir);
      // Both the first recovery's snapshot dir AND the second's are present — nothing was overwritten.
      expect(preservedAfterSecond.length).toBe(2);
      for (const name of preservedAfterFirst) {
        expect(preservedAfterSecond).toContain(name);
      }
    });

    it("a start-fresh marker present when the NORMAL open already succeeds is still consumed — it can never linger to authorize a LATER, unrelated failure", async () => {
      const reports = installFakeBootBridge();

      const { app: original, dataDir } = await makeEncryptedApp({ dbEncryptionKey: "the correct key" });
      const originalAdmin = await session(original);
      expect((await post(original, originalAdmin.cookie, "seed")).statusCode).toBe(201);
      await original.close();

      // The operator wrote the marker (e.g. anticipating a key problem) but then the RIGHT key ended up
      // being used after all — case 1 (keyed open) succeeds immediately, never reaching the recovery
      // branch at all.
      writeFileSync(startFreshMarkerPath(dataDir), "");

      const reopened = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false, dbEncryptionKey: "the correct key" });
      cleanups.push(() => reopened.close());

      // No boot-bridge report at all — this was a perfectly normal open, not a degrade or a recovery.
      expect(reports).toEqual([]);

      // Old data is untouched (normal open, not a destructive replace).
      expect(reopened.store.loadMessages().some((m) => "body" in m && m.body === "seed")).toBe(true);

      // The marker is GONE — consumed up front, not left behind to silently authorize some LATER,
      // unrelated unopenable-DB failure the operator never actually confirmed for.
      expect(existsSync(startFreshMarkerPath(dataDir))).toBe(false);
    });

    it("if the marker can't actually be deleted, boot fails CLOSED — it is NOT treated as a valid confirmation", async () => {
      const reports = installFakeBootBridge();

      const { app: original, dataDir } = await makeEncryptedApp({ dbEncryptionKey: "key A" });
      await session(original);
      await original.close();

      const filesBefore = dbFileNames(dataDir).sort();

      // Force the marker deletion itself to fail: create it as a NON-EMPTY directory instead of a file.
      // `rmSync(path, { force: true })` (no `recursive`) throws ENOTEMPTY/EISDIR for this, exactly the
      // "delete failed" case that must fail closed — `force` only swallows ENOENT (already-absent),
      // never a genuine deletion failure.
      const markerPath = startFreshMarkerPath(dataDir);
      mkdirSync(markerPath);
      writeFileSync(join(markerPath, "not-empty"), "");

      // Wrong key too — case 1 and case 2 both fail, so this reaches the marker-gated recovery check.
      await expect(buildApp({ requireRulesAcceptance: false, dataDir, logger: false, dbEncryptionKey: "a completely different key" })).rejects.toThrow(
        /could not be opened/,
      );

      expect(reports).toEqual([expect.objectContaining({ code: "db_encryption_unreadable" })]);

      // Fail closed: no destructive replace happened — the original files are untouched...
      expect(dbFileNames(dataDir).sort()).toEqual(filesBefore);
      // ...and the marker (still an undeleted directory) is exactly where it was — NOT silently
      // "consumed" despite authorizing nothing.
      expect(existsSync(markerPath)).toBe(true);
    });
  });

  describe("durable wipe-phase state machine + fail-closed deletion", () => {
    function fireKillSwitch(app: LoamApp, cookie: string): Promise<InjectResponse> {
      return app.server.inject({
        method: "POST",
        url: "/api/admin/kill-switch",
        headers: { cookie },
        payload: { confirm: "wipe" },
      });
    }

    it("a two-boot fixed-key lifecycle — boot 1 leaves phase `delete-pending` when a legacy-key `.premigration` deletion fails PERSISTENTLY (incomplete 503, NO key-clear signal, survivor recoverable); a fresh boot with deletion now succeeding RE-RUNS deletion, advances to `key-clear-ready`, and ONLY THEN signals the key-clear", async () => {
      const reports = installFakeBootBridge();
      const hook = installFakeWipeRestartHook();
      const { app, dataDir } = await makeEncryptedApp(
        { dbEncryptionKey: "a fixed persistent key", dbEncryptionMode: "persistent" },
        { killSwitch: { enabled: true } },
      );
      const admin = await session(app);
      expect((await post(app, admin.cookie, "doomed")).statusCode).toBe(201);

      // Seed a VALID legacy-key `.premigration` snapshot — still-readable ciphertext under the
      // NON-discardable SHA256(passphrase) key (THE crypto-wipe hole a surviving `.premigration` leaves;
      // clearing the device secret does NOT decrypt it).
      const legacyKey = "an old legacy premigration key";
      const seedDir = mkdtempSync(join(tmpdir(), "loam-two-boot-legacy-"));
      cleanups.push(() => rmSync(seedDir, { recursive: true, force: true }));
      const seedDb = join(seedDir, "legacy.db");
      const legacy = openStore(seedDb, { encryptionKey: legacyKey });
      legacy.setConfigValue("legacy-sentinel", "TWO_BOOT_PREMIG_SECRET");
      legacy.checkpoint();
      legacy.close();
      copyFileSync(seedDb, join(dataDir, "loam.db.premigration"));

      // --- Boot 1: PERSISTENT deletion failure on the survivor; fire the wipe.
      premigrationDeleteFailure.armed = true;
      const wipe1 = await fireKillSwitch(app, admin.cookie);
      // Incomplete → the endpoint 503s (never a false `{ ok: true }`), NO key-clear signal, phase stays
      // `delete-pending` (durable), and the survivor is still on disk AND still recoverable under the legacy key.
      expect(wipe1.statusCode).toBe(503);
      expect(hook.calls).toBe(0);
      expect(readJournalPhase(dataDir)).toBe("delete-pending");
      expect(existsSync(join(dataDir, "loam.db.premigration"))).toBe(true);
      const stillReadable = openStore(join(dataDir, "loam.db.premigration"), { encryptionKey: legacyKey });
      expect(stillReadable.getConfigValue("legacy-sentinel")).toBe("TWO_BOOT_PREMIG_SECRET");
      stillReadable.close();
      // The node is 503-locked (nothing reopened while recoverable ciphertext survives).
      expect(
        (await app.server.inject({ method: "GET", url: "/api/channels", headers: { cookie: admin.cookie } })).statusCode,
      ).toBe(503);

      // --- Boot 2: a fresh boot on the same dataDir with the OLD key, deletion now succeeding. The
      // boot-time resume (drive it directly via buildApp — a full two-process launcher test isn't feasible
      // in-suite) re-runs deletion under the old key, advances the phase, hands off, and refuses to serve.
      premigrationDeleteFailure.armed = false;
      reports.length = 0;
      await expect(
        buildApp({ requireRulesAcceptance: false,
          dataDir,
          logger: false,
          dbEncryptionKey: "a fixed persistent key",
          dbEncryptionMode: "persistent",
        }),
      ).rejects.toThrow(/Resuming an interrupted emergency wipe/);

      // The retry RE-RAN deletion (the survivor is finally gone), advanced to `key-clear-ready` DURABLY,
      // and ONLY THEN signaled the launcher to clear the device key — never before deletion was proven.
      expect(existsSync(join(dataDir, "loam.db.premigration"))).toBe(false);
      expect(readJournalPhase(dataDir)).toBe("key-clear-ready");
      expect(hook.calls).toBe(1);
      expect(reports.some((r) => r.code === "kill_switch_wipe_resumed")).toBe(true);
    });

    it("an unreadable data dir (readdir fault) BLOCKS a fixed-key wipe — 'can't enumerate' is not 'nothing to enumerate', so it fails closed (incomplete 503, phase `delete-pending`, launcher NOT signaled)", async () => {
      const reports = installFakeBootBridge();
      const hook = installFakeWipeRestartHook();
      const { app, dataDir } = await makeEncryptedApp(
        { dbEncryptionKey: "a fixed persistent key", dbEncryptionMode: "persistent" },
        { killSwitch: { enabled: true } },
      );
      const admin = await session(app);
      expect((await post(app, admin.cookie, "doomed")).statusCode).toBe(201);

      // The data dir can't be enumerated — a `*.unreadable-*` survivor could exist unseen, so the wipe
      // must NOT declare itself clean.
      readdirFailure.dir = dataDir;
      const wipe = await fireKillSwitch(app, admin.cookie);
      expect(wipe.statusCode).toBe(503);
      expect(hook.calls).toBe(0);
      expect(readJournalPhase(dataDir)).toBe("delete-pending");
      expect(reports.some((r) => r.code === "kill_switch_wipe_incomplete")).toBe(true);
      readdirFailure.dir = undefined;
      // Still locked down.
      expect(
        (await app.server.inject({ method: "GET", url: "/api/channels", headers: { cookie: admin.cookie } })).statusCode,
      ).toBe(503);
    });

    it("an UNVERIFIABLE deletion (lstat throws a non-ENOENT error) fails closed on the EPHEMERAL path — the key is NOT rotated / the DB NOT reopened while absence can't be proven (503-locked)", async () => {
      const reports = installFakeBootBridge();
      const { app, dataDir } = await makeEncryptedApp(
        { ephemeralDbKey: true, dbEncryptionMode: "ephemeral" },
        { killSwitch: { enabled: true } },
      );
      const admin = await session(app);
      expect((await post(app, admin.cookie, "doomed")).statusCode).toBe(201);

      // After the live DB is unlinked, its proven-absence check throws EIO (NOT ENOENT) — "could-not-
      // determine", which must NOT be treated as confirmed absence.
      lstatFailure.path = join(dataDir, "loam.db");
      const wipe = await fireKillSwitch(app, admin.cookie);
      expect(wipe.statusCode).toBe(503);
      expect(reports.some((r) => r.code === "kill_switch_wipe_incomplete")).toBe(true);
      lstatFailure.path = undefined;
      // Fail closed: the node is locked down (503), NOT reopened under a rotated key as if the wipe succeeded.
      expect(
        (await app.server.inject({ method: "GET", url: "/api/channels", headers: { cookie: admin.cookie } })).statusCode,
      ).toBe(503);
    });

    it("a persistent deletion failure fails closed on the fixed-key/NO-hook same-key fallback path — it does NOT recreate a usable node while recoverable ciphertext survives (503-locked)", async () => {
      // Deliberately NOT installing __loamRequestWipeRestart — the desktop/CI same-key fallback path.
      const reports = installFakeBootBridge();
      const { app, dataDir } = await makeEncryptedApp(
        { dbEncryptionKey: "a fixed passphrase key", dbEncryptionMode: "passphrase" },
        { killSwitch: { enabled: true } },
      );
      const admin = await session(app);
      expect((await post(app, admin.cookie, "doomed")).statusCode).toBe(201);

      // Plant a legacy-key `.premigration` whose deletion fails persistently — a survivor the same-key
      // fallback must fail closed on rather than recreating a clean-looking node over it.
      writeFileSync(join(dataDir, "loam.db.premigration"), Buffer.from("legacy-key ciphertext survivor"));
      premigrationDeleteFailure.armed = true;

      const wipe = await fireKillSwitch(app, admin.cookie);
      expect(wipe.statusCode).toBe(503);
      expect(existsSync(join(dataDir, "loam.db.premigration"))).toBe(true);
      expect(reports.some((r) => r.code === "kill_switch_wipe_incomplete")).toBe(true);
      // Fail closed: locked down (503), NOT recreated as a usable node under the same key.
      expect(
        (await app.server.inject({ method: "GET", url: "/api/channels", headers: { cookie: admin.cookie } })).statusCode,
      ).toBe(503);
    });
  });
});

describe("encrypted kill switch keeps admin config edits", () => {
  it("encrypted kill switch re-persists admin config edits into the fresh database", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "loam-enc-config-test-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const key = "a fixed host passphrase";
    const first = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false, dbEncryptionKey: key });
    cleanups.push(() => first.close());

    const admin = await newSession(first);
    // Arm the kill switch purely via the admin API — persisted only in the DB config table.
    const patch = await first.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { killSwitch: { enabled: true }, features: { enableReactions: false } },
    });
    expect(patch.statusCode).toBe(200);

    const wipe = await first.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    expect(wipe.statusCode).toBe(200);

    // Restart on the same data dir + key: the admin edits must survive the wipe.
    await first.close();
    const second = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false, dbEncryptionKey: key });
    cleanups.push(() => second.close());

    const nextAdmin = await newSession(second);
    const config = await second.server.inject({
      method: "GET",
      url: "/api/admin/config",
      headers: { cookie: nextAdmin.cookie },
    });
    const body = config.json() as { killSwitch: { enabled: boolean }; features: { enableReactions: boolean } };
    expect(body.killSwitch.enabled).toBe(true);
    expect(body.features.enableReactions).toBe(false);
  });
});

describe("passphrase-mode key handoff", () => {
  it("a passphrase-mode open acks the launcher even without a legacy key to migrate from", async () => {
    const calls: (string | undefined)[] = [];
    (globalThis as unknown as { __loamReportDbKeyMigrated?: (requestId?: string) => void }).__loamReportDbKeyMigrated = (
      requestId?: string,
    ) => {
      calls.push(requestId);
    };
    cleanups.push(() => {
      delete (globalThis as unknown as { __loamReportDbKeyMigrated?: unknown }).__loamReportDbKeyMigrated;
    });
    const dataDir = mkdtempSync(join(tmpdir(), "loam-ack-test-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const app = await buildApp({ requireRulesAcceptance: false,
      dataDir,
      logger: false,
      dbEncryptionKey: "a passphrase-derived key",
      dbEncryptionMode: "passphrase",
      dbKeyRequestId: "dbkey-42",
    });
    cleanups.push(() => app.close());
    // The launcher retires a pre-change install's stored passphrase ONLY on this ack — so it must fire on
    // every successful passphrase-mode open, not just when a legacy key was offered.
    expect(calls).toEqual(["dbkey-42"]);

    // A persistent-mode open (no passphrase) still acks nothing.
    const other = mkdtempSync(join(tmpdir(), "loam-ack-test-"));
    cleanups.push(() => rmSync(other, { recursive: true, force: true }));
    const persistent = await buildApp({ requireRulesAcceptance: false, dataDir: other, logger: false, dbEncryptionKey: "device secret", dbEncryptionMode: "persistent" });
    cleanups.push(() => persistent.close());
    expect(calls).toEqual(["dbkey-42"]);
  });
});
