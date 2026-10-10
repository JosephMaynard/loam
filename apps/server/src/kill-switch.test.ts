import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { LoamApp } from "./app.js";
import { openStore } from "./db.js";
import type { SocketSession } from "./types.js";
import {
  cleanups,
  makeApp,
  newSession,
  readJournalConfig,
  readJournalPhase,
  reopenApp,
  teardownApps,
} from "./test-support/app-harness.js";
import { mkdirGate, resetFsFaults, wipeMarkerWriteFailure } from "./test-support/fs-faults.js";

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

describe("kill switch", () => {
  async function postKillSwitch(
    app: LoamApp,
    cookie: string,
    payload: Record<string, unknown> = { confirm: "wipe" },
  ) {
    return app.server.inject({ method: "POST", url: "/api/admin/kill-switch", headers: { cookie }, payload });
  }

  it("requires typed confirmation when requireConfirmation is on (the default)", async () => {
    const app = await makeApp({ killSwitch: { enabled: true } });
    const admin = await newSession(app);

    expect((await postKillSwitch(app, admin.cookie, {})).statusCode).toBe(400);
    expect((await postKillSwitch(app, admin.cookie, { confirm: "yes" })).statusCode).toBe(400);
    expect(app.store.loadSessions().length).toBeGreaterThan(0);
    expect((await postKillSwitch(app, admin.cookie, { confirm: "wipe" })).statusCode).toBe(200);
    expect(app.store.loadSessions()).toEqual([]);
  });

  it("fires without confirmation when requireConfirmation is off", async () => {
    const app = await makeApp({ killSwitch: { enabled: true, requireConfirmation: false } });
    const admin = await newSession(app);

    expect((await postKillSwitch(app, admin.cookie, {})).statusCode).toBe(200);
  });

  it("abandons an in-flight sync round when a kill switch fires mid-pull", async () => {
    // A controllable peer: it advertises one message, then HOLDS the /api/sync/messages response until
    // we release it — so we can fire the kill switch while node A is suspended awaiting that fetch.
    let sawMessagesRequest!: () => void;
    const messagesRequested = new Promise<void>((resolve) => (sawMessagesRequest = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const peerMessage = {
      id: "msg.peer-race",
      type: "channelPost",
      authorId: "user.peerauthor",
      channelId: "general",
      body: "from the peer",
      createdAt: 1,
    };
    const peerAuthor = {
      id: "user.peerauthor",
      displayName: "Peer Author",
      type: "human",
      isAdmin: false,
      createdAt: 1,
      ephemeral: true,
    };

    const peer = createServer((req, res) => {
      if (req.url === "/api/sync/digest") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ channels: [], messages: [{ id: peerMessage.id }] }));
        return;
      }
      if (req.url === "/api/sync/messages") {
        sawMessagesRequest();
        void gate.then(() => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ messages: [peerMessage], users: [peerAuthor] }));
        });
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => peer.close(() => resolve())));
    const peerUrl = `http://127.0.0.1:${(peer.address() as AddressInfo).port}`;

    const app = await makeApp({
      killSwitch: { enabled: true, requireConfirmation: false },
      sync: { enabled: true, peers: [{ url: peerUrl }] },
    });
    const admin = await newSession(app);

    // Kick off a sync round; it blocks awaiting the held /api/sync/messages response.
    const syncInFlight = app.server.inject({
      method: "POST",
      url: "/api/admin/sync/run",
      headers: { cookie: admin.cookie },
    });

    await messagesRequested; // A is now mid-pull, suspended on the peer's message payload
    try {
      expect((await postKillSwitch(app, admin.cookie, {})).statusCode).toBe(200); // wipe fires mid-round
    } finally {
      release(); // always release the held response, even if the assertion throws, so nothing hangs
    }
    await syncInFlight;

    // The peer's message (and author) were NOT written back onto the freshly wiped store.
    const stored = app.store.loadMessages();
    expect(stored.some((message) => message.id === peerMessage.id)).toBe(false);
    expect(app.store.loadUsers().some((user) => user.id === peerAuthor.id)).toBe(false);
  });

  it("rejects non-admins and admins on nodes where it is disabled", async () => {
    const disabled = await makeApp();
    const admin = await newSession(disabled);
    const visitor = await newSession(disabled);

    expect((await postKillSwitch(disabled, visitor.cookie)).statusCode).toBe(403);
    expect((await postKillSwitch(disabled, admin.cookie)).statusCode).toBe(403);
    expect(disabled.store.loadMessages().length).toBe(0);
  });

  it("wipes all data, invalidates sessions, clears avatars, and re-seeds defaults", async () => {
    const { app, dataDir } = await makeApp({ killSwitch: { enabled: true } });
    const admin = await newSession(app);

    const avatarsDir = join(dataDir, "avatars");
    mkdirSync(avatarsDir, { recursive: true });
    writeFileSync(join(avatarsDir, "avt_deadbeefdeadbeef.webp"), "fake");

    const post = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: admin.cookie },
      payload: { type: "channelPost", channelId: "general", body: "to be wiped" },
    });
    expect(post.statusCode).toBe(201);

    const wipe = await postKillSwitch(app, admin.cookie);
    expect(wipe.statusCode).toBe(200);

    expect(app.store.loadMessages()).toEqual([]);
    expect(app.store.loadSessions()).toEqual([]);
    expect(app.store.loadUsers().every((user) => !user.isAdmin)).toBe(true);
    expect(app.store.loadChannels().map((channel) => channel.id).sort()).toEqual(["announcements", "general"]);
    expect(existsSync(join(avatarsDir, "avt_deadbeefdeadbeef.webp"))).toBe(false);

    const returning = await app.server.inject({
      method: "GET",
      url: "/api/config",
      headers: { cookie: admin.cookie },
    });
    const returningUser = (returning.json() as { currentUser: { id: string; isAdmin: boolean } }).currentUser;
    expect(returningUser.id).not.toBe(admin.userId);

    const fresh = await newSession(app);
    expect(fresh.isAdmin).toBe(false);
  });

  it.each([
    {
      name: "avatar",
      dir: "avatars",
      request: { method: "PUT" as const, url: "/api/users/me/avatar-image" },
    },
    {
      name: "attachment",
      dir: "attachments",
      request: { method: "POST" as const, url: "/api/attachments" },
    },
  ])("an $name upload that straddles a wipe restores nothing and leaves no file", async ({ dir, request }) => {
    const { app, dataDir } = await makeApp({
      killSwitch: { enabled: true },
      identity: { allowUserAvatarEdit: true, allowUserAvatarUpload: true },
    });
    const admin = await newSession(app);
    const targetDir = join(dataDir, dir);
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      mkdirGate.entered = resolve;
    });
    mkdirGate.promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    mkdirGate.path = targetDir;

    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]).toString("base64");
    const upload = app.server
      .inject({ ...request, headers: { cookie: admin.cookie }, payload: { mimeType: "image/png", data: png } })
      .then((response) => response);
    await entered;

    expect((await postKillSwitch(app, admin.cookie)).statusCode).toBe(200);
    release();

    expect((await upload).statusCode).toBe(409);
    expect(app.store.loadUsers().some((user) => user.id === admin.userId)).toBe(false);
    expect(existsSync(targetDir) ? readdirSync(targetDir) : []).toEqual([]);
  });

  it("reports an incomplete wipe (503, clients told to purge, node locked) when the store throws partway, never a 500", async () => {
    const app = await makeApp({ killSwitch: { enabled: true } });
    const admin = await newSession(app);
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: "/api/messages",
          headers: { cookie: admin.cookie },
          payload: { type: "channelPost", channelId: "general", body: "still here" },
        })
      ).statusCode,
    ).toBe(201);

    // A connected client, as the realtime layer sees it: it must be told to purge and then be closed.
    const sent: string[] = [];
    let closed = false;
    app.sockets.add({
      userId: admin.userId,
      socket: {
        readyState: 1,
        OPEN: 1,
        send: (payload: string) => {
          sent.push(payload);
        },
        close: () => {
          closed = true;
        },
      } as unknown as SocketSession["socket"],
    });

    // The plaintext wipe's one store call fails (a full disk, a locked file).
    app.store.wipeAll = () => {
      throw new Error("disk full");
    };

    const wipe = await postKillSwitch(app, admin.cookie);
    expect(wipe.statusCode).toBe(503);
    expect((wipe.json() as { error: string }).error).toMatch(/could not be completed/);

    expect(sent.map((payload) => (JSON.parse(payload) as { type: string }).type)).toContain("wipe");
    expect(closed).toBe(true);
    expect(app.sockets.size).toBe(0);

    // Locked down: nothing but the liveness probe answers, so the surviving rows are never served.
    expect((await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie: admin.cookie } })).statusCode).toBe(503);
    expect((await app.server.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
  });

  it("journals a plaintext wipe before it starts, so a wipe the store refuses is finished by the next boot instead of the old messages being served", async () => {
    const { app, dataDir } = await makeApp({ killSwitch: { enabled: true } });
    const admin = await newSession(app);
    // An admin edit that lives only in the database's config row: the journal's snapshot must carry it across.
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
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: "/api/messages",
          headers: { cookie: admin.cookie },
          payload: { type: "channelPost", channelId: "general", body: "MUST_NOT_OUTLIVE_THE_RESET" },
        })
      ).statusCode,
    ).toBe(201);
    const avatarsDir = join(dataDir, "avatars");
    mkdirSync(avatarsDir, { recursive: true });
    const avatar = join(avatarsDir, "avt_deadbeefdeadbeef.webp");
    writeFileSync(avatar, "fake");

    // The plaintext wipe's one store call fails, so this run deletes nothing.
    app.store.wipeAll = () => {
      throw new Error("disk full");
    };
    const wipe = await postKillSwitch(app, admin.cookie);
    expect(wipe.statusCode).toBe(503);
    expect((wipe.json() as { error: string }).error).toMatch(/restart it to finish the wipe/i);
    // A client that translates by code tells the admin a restart finishes it; the launcher reads `journaled`.
    expect(wipe.json()).toMatchObject({ code: "wipe_incomplete", journaled: true });

    // The intent and the config snapshot are on disk; the surviving rows are not served in the meantime.
    expect(readJournalPhase(dataDir)).toBe("delete-pending");
    expect(readJournalConfig(dataDir)?.retention).toMatchObject({ messageTtlMs: 3_600_000 });
    expect(app.store.loadMessages()).toHaveLength(1);
    expect(
      (await app.server.inject({ method: "GET", url: "/api/messages/general", headers: { cookie: admin.cookie } })).statusCode,
    ).toBe(503);

    // The restart finishes the wipe before it serves: database and media gone, journal cleared, config kept.
    const restarted = await reopenApp(app, dataDir);
    expect(existsSync(join(dataDir, ".loam-wipe-phase"))).toBe(false);
    expect(existsSync(avatar)).toBe(false);
    expect(restarted.store.loadMessages()).toEqual([]);
    const fresh = await newSession(restarted);
    expect(fresh.isAdmin).toBe(true);
    const served = (
      await restarted.server.inject({ method: "GET", url: "/api/messages/general", headers: { cookie: fresh.cookie } })
    ).json() as { body?: string }[];
    expect(served.map((message) => message.body)).not.toContain("MUST_NOT_OUTLIVE_THE_RESET");
    const config = (
      await restarted.server.inject({ method: "GET", url: "/api/admin/config", headers: { cookie: fresh.cookie } })
    ).json() as { killSwitch: { enabled: boolean }; retention: { messageTtlMs?: number } };
    expect(config.killSwitch.enabled).toBe(true);
    expect(config.retention.messageTtlMs).toBe(3_600_000);
  });

  it("clears the wipe journal once an in-process wipe completes, and a restart serves the fresh node", async () => {
    const { app, dataDir } = await makeApp({ killSwitch: { enabled: true } });
    const admin = await newSession(app);
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: "/api/messages",
          headers: { cookie: admin.cookie },
          payload: { type: "channelPost", channelId: "general", body: "gone after the reset" },
        })
      ).statusCode,
    ).toBe(201);

    expect((await postKillSwitch(app, admin.cookie)).statusCode).toBe(200);
    expect(existsSync(join(dataDir, ".loam-wipe-phase"))).toBe(false);

    const restarted = await reopenApp(app, dataDir);
    expect(existsSync(join(dataDir, ".loam-wipe-phase"))).toBe(false);
    const fresh = await newSession(restarted);
    expect(fresh.isAdmin).toBe(true);
    expect(
      (await restarted.server.inject({ method: "GET", url: "/api/messages/general", headers: { cookie: fresh.cookie } })).json(),
    ).toEqual([]);
    const config = (
      await restarted.server.inject({ method: "GET", url: "/api/admin/config", headers: { cookie: fresh.cookie } })
    ).json() as { killSwitch: { enabled: boolean } };
    expect(config.killSwitch.enabled).toBe(true);
  });

  it("puts a plaintext wipe's deletion into loam.db itself before it clears the journal, so a power cut cannot roll it back", async () => {
    const { app, dataDir } = await makeApp({ killSwitch: { enabled: true } });
    const admin = await newSession(app);
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: "/api/messages",
          headers: { cookie: admin.cookie },
          payload: { type: "channelPost", channelId: "general", body: "ROLLED_BACK_BY_A_POWER_CUT" },
        })
      ).statusCode,
    ).toBe(201);
    // SQLite folds the WAL into loam.db on its own (every 1000 pages, and on a clean close), so on a node that
    // has run for a while the message is in the main file. Fold it now to stand in for that.
    app.store.checkpoint();

    const copyDir = mkdtempSync(join(tmpdir(), "loam-wipe-copy-"));
    cleanups.push(() => rmSync(copyDir, { recursive: true, force: true }));
    /** What a power cut leaves behind: `loam.db` alone, everything only in the unsynced `-wal` lost. */
    function bodiesInMainFileAlone(name: string): string[] {
      const copy = join(copyDir, name);
      copyFileSync(join(dataDir, "loam.db"), copy);
      const store = openStore(copy);
      try {
        return store.loadMessages().map((message) => ("body" in message ? message.body : ""));
      } finally {
        store.close();
      }
    }
    expect(bodiesInMainFileAlone("before.db")).toContain("ROLLED_BACK_BY_A_POWER_CUT");

    const wipe = await postKillSwitch(app, admin.cookie);
    expect(wipe.statusCode).toBe(200);
    // The journal, the deletion's only recovery record, is gone; the main file alone must not hold the old row.
    expect(existsSync(join(dataDir, ".loam-wipe-phase"))).toBe(false);
    expect(bodiesInMainFileAlone("after.db")).not.toContain("ROLLED_BACK_BY_A_POWER_CUT");
  });

  it("stays locked with its journal on disk when the plaintext wipe cannot be made durable", async () => {
    const { app, dataDir } = await makeApp({ killSwitch: { enabled: true } });
    const admin = await newSession(app);
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: "/api/messages",
          headers: { cookie: admin.cookie },
          payload: { type: "channelPost", channelId: "general", body: "kept until the restart" },
        })
      ).statusCode,
    ).toBe(201);

    // Another connection pins the WAL, so the checkpoint after `wipeAll()` comes back busy.
    app.store.checkpoint = () => {
      throw new Error("wal_checkpoint(TRUNCATE) did not fully fold and truncate the WAL (busy=1)");
    };
    const wipe = await postKillSwitch(app, admin.cookie);
    expect(wipe.statusCode).toBe(503);
    expect(wipe.json()).toMatchObject({ code: "wipe_incomplete", journaled: true });
    // The journal is not cleared, so the next boot deletes the database files before it serves anything.
    expect(readJournalPhase(dataDir)).toBe("delete-pending");
    expect((await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie: admin.cookie } })).statusCode).toBe(503);

    const restarted = await reopenApp(app, dataDir);
    expect(existsSync(join(dataDir, ".loam-wipe-phase"))).toBe(false);
    expect(restarted.store.loadMessages()).toEqual([]);
  });

  it("answers wipe_unrecorded with journaled false when the wipe journal could not be written, so no client promises a restart will finish it", async () => {
    const { app, dataDir } = await makeApp({ killSwitch: { enabled: true } });
    const admin = await newSession(app);

    wipeMarkerWriteFailure.armed = true;
    app.store.wipeAll = () => {
      throw new Error("disk full");
    };
    const wipe = await postKillSwitch(app, admin.cookie);
    expect(wipe.statusCode).toBe(503);
    expect(wipe.json()).toMatchObject({
      error: expect.stringMatching(/fire the Emergency Reset again/),
      code: "wipe_unrecorded",
      journaled: false,
    });
    expect(existsSync(join(dataDir, ".loam-wipe-phase"))).toBe(false);
  });

  it("keeps the kill switch enabled after a wipe so it can fire again", async () => {
    const app = await makeApp({ killSwitch: { enabled: true } });
    const admin = await newSession(app);
    expect((await postKillSwitch(app, admin.cookie)).statusCode).toBe(200);

    const nextAdmin = await newSession(app);
    expect(nextAdmin.isAdmin).toBe(true);
    expect((await postKillSwitch(app, nextAdmin.cookie)).statusCode).toBe(200);
  });
});

describe("emergency reset from the host device", () => {
  it("wipes the node through the in-process hook, even with the remote kill switch disabled", async () => {
    const app = await makeApp({ killSwitch: { enabled: false } });
    const admin = await newSession(app);
    await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: admin.cookie },
      payload: { type: "channelPost", channelId: "general", body: "on the phone" },
    });
    expect(app.store.loadMessages().length).toBe(1);

    // The remote route stays refused while the switch is off...
    const remote = await app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    expect(remote.statusCode).toBe(403);
    expect(app.store.loadMessages().length).toBe(1);

    // ...but the phone's owner can always wipe it from the host menu.
    expect(await app.emergencyReset()).toEqual({ complete: true, keyClearRequested: false, journaled: false });
    expect(app.store.loadMessages()).toEqual([]);
  });

  it("leaves nothing in a plaintext database file that an older build deleted without secure_delete", async () => {
    const { app, dataDir } = await makeApp({ killSwitch: { enabled: true } });
    const admin = await newSession(app);
    const needle = "PRE_UPGRADE_NEEDLE_41c9";
    for (let index = 0; index < 40; index += 1) {
      const posted = await app.server.inject({
        method: "POST",
        url: "/api/messages",
        headers: { cookie: admin.cookie },
        payload: { type: "channelPost", channelId: "general", body: `${needle} ${index} ${"x".repeat(200)}` },
      });
      expect(posted.statusCode).toBe(201);
    }
    await app.close();

    // An older build deletes those rows with secure_delete off (SQLite's default), leaving their text in
    // freed pages and cell space.
    const dbPath = join(dataDir, "loam.db");
    const { DatabaseSync } = await import("node:sqlite");
    const older = new DatabaseSync(dbPath);
    older.exec("PRAGMA secure_delete = OFF");
    older.exec("DELETE FROM messages");
    older.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    older.close();
    expect(readFileSync(dbPath).includes(needle)).toBe(true);

    // This build opens it and runs the plaintext Emergency Reset.
    const upgraded = await reopenApp(app, dataDir);
    expect((await upgraded.emergencyReset()).complete).toBe(true);
    const leftovers = [dbPath, `${dbPath}-wal`].filter((file) => existsSync(file) && readFileSync(file).includes(needle));
    expect(leftovers).toEqual([]);
  });

  it("tells the launcher, and the terminal UI, whether a restart finishes an incomplete wipe", async () => {
    const app = await makeApp({ killSwitch: { enabled: false } });
    app.store.wipeAll = () => {
      throw new Error("disk full");
    };

    // The journal could not be written, so the reset has to be run again after the restart.
    wipeMarkerWriteFailure.armed = true;
    expect(await app.emergencyReset()).toEqual({ complete: false, keyClearRequested: false, journaled: false });
    expect(await app.host.emergencyReset()).toEqual({ complete: false, journaled: false });

    // The journal was written, so a restart finishes it.
    wipeMarkerWriteFailure.armed = false;
    expect(await app.emergencyReset()).toEqual({ complete: false, keyClearRequested: false, journaled: true });
    expect(await app.host.emergencyReset()).toEqual({ complete: false, journaled: true });
  });
});

describe("panic endpoint", () => {
  async function panic(app: LoamApp, token: string) {
    return app.server.inject({ method: "POST", url: "/api/panic", payload: { token } });
  }

  it("404s when the kill switch or token is not configured", async () => {
    const noKillSwitch = await makeApp();
    expect((await panic(noKillSwitch, "whatever")).statusCode).toBe(404);

    const noToken = await makeApp({ killSwitch: { enabled: true } });
    expect((await panic(noToken, "whatever")).statusCode).toBe(404);
  });

  it("wipes without authentication given the correct token, rejects wrong tokens", async () => {
    const app = await makeApp({
      killSwitch: { enabled: true, panicToken: "panic-token-0123456789" },
    });
    const admin = await newSession(app);

    await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: admin.cookie },
      payload: { type: "channelPost", channelId: "general", body: "to be wiped" },
    });

    // A wrong token answers 404 — identical to an unconfigured node — so the panic route can't be
    // fingerprinted; the message survives.
    expect((await panic(app, "wrong-token")).statusCode).toBe(404);
    expect(app.store.loadMessages().length).toBe(1);

    expect((await panic(app, "panic-token-0123456789")).statusCode).toBe(200);
    expect(app.store.loadMessages()).toEqual([]);
  });

  it("tells the token holder whether a restart finishes an incomplete wipe (code and journaled)", async () => {
    // One node per case: the first incomplete wipe leaves its node locked, so a second panic would meet the gate.
    for (const [journalWrites, expected] of [
      [false, { code: "wipe_unrecorded", journaled: false }],
      [true, { code: "wipe_incomplete", journaled: true }],
    ] as const) {
      const { app } = await makeApp({
        killSwitch: { enabled: true, panicToken: "panic-token-0123456789" },
      });
      app.store.wipeAll = () => {
        throw new Error("disk full");
      };
      wipeMarkerWriteFailure.armed = !journalWrites;
      const wipe = await panic(app, "panic-token-0123456789");
      expect(wipe.statusCode).toBe(503);
      expect(wipe.json()).toMatchObject(expected);
    }
  });

  it("rate-limits repeated attempts (indistinguishably) and blocks the wipe once tripped", async () => {
    const app = await makeApp({
      killSwitch: { enabled: true, panicToken: "panic-token-0123456789" },
    });
    const admin = await newSession(app);
    await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: admin.cookie },
      payload: { type: "channelPost", channelId: "general", body: "survives the brute force" },
    });

    // Every wrong attempt looks like a 404 (not a distinguishable 403/429).
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await panic(app, `wrong-${attempt}`)).statusCode).toBe(404);
    }

    // Once the attempt limiter trips, even the CORRECT token is refused (checked after the limiter)
    // and the node is NOT wiped.
    expect((await panic(app, "panic-token-0123456789")).statusCode).toBe(404);
    expect(app.store.loadMessages().length).toBe(1);
  });

  it("counts wrong tokens per address: a neighbour on the same IPv6 /64 can't lock the operator's real token out", async () => {
    const app = await makeApp({
      killSwitch: { enabled: true, panicToken: "panic-token-0123456789" },
    });
    const from = (remoteAddress: string, token: string) =>
      app.server.inject({ method: "POST", url: "/api/panic", payload: { token }, remoteAddress });

    // Past both the attempt limiter (5) and the route limiter (10/min), which count per address too.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      expect((await from("2001:db8:9:9::66", `wrong-${attempt}`)).statusCode).toBe(404);
    }
    // That address is now locked out, still with the same 404 and no limiter headers...
    const locked = await from("2001:db8:9:9::66", "panic-token-0123456789");
    expect(locked.statusCode).toBe(404);
    expect(Object.keys(locked.headers).filter((name) => name.startsWith("x-ratelimit") || name === "retry-after")).toEqual([]);
    // ...but the operator's phone on the same LAN still fires the wipe.
    expect((await from("2001:db8:9:9::5", "panic-token-0123456789")).statusCode).toBe(200);
  });

  it("answers 404 (never 429) even past the route-level rate limit", async () => {
    const app = await makeApp({
      killSwitch: { enabled: true, panicToken: "panic-token-0123456789" },
    });

    // The route allows 10/min; push well past it. Every rejection — including the route-level
    // rate-limit hit — must be a 404, so a 429 can never reveal that the panic route exists here.
    const codes: number[] = [];
    for (let attempt = 0; attempt < 13; attempt += 1) {
      codes.push((await panic(app, `wrong-${attempt}`)).statusCode);
    }
    expect(codes).not.toContain(429);
    expect(codes.every((code) => code === 404)).toBe(true);
  });

  it("sends no rate-limit headers, before or past the limit, that an absent route wouldn't", async () => {
    const app = await makeApp({
      killSwitch: { enabled: true, panicToken: "panic-token-0123456789" },
    });

    // A configured route used to answer with its own `x-ratelimit-limit` (and `retry-after` once
    // tripped) while an unknown path sent none, which told a prober the panic route exists.
    const absent = await app.server.inject({ method: "POST", url: "/api/not-a-route", payload: {} });
    for (let attempt = 0; attempt < 13; attempt += 1) {
      const response = await panic(app, `wrong-${attempt}`);
      const names = Object.keys(response.headers);
      expect(names.filter((name) => name.startsWith("x-ratelimit") || name === "retry-after")).toEqual([]);
      expect(names.sort()).toEqual(Object.keys(absent.headers).sort());
    }
  });
});

describe("Emergency Reset sweeps preserve-recovery snapshots in every branch", () => {
  /** Plant a `.loam-recovery-*` snapshot dir (with an old DB copy) + the recovery anchor after boot. */
  function plantRecoveryArtifacts(dataDir: string): string[] {
    const snapshot = join(dataDir, ".loam-recovery-1700000000000-abcd");
    mkdirSync(join(snapshot, "avatars"), { recursive: true });
    writeFileSync(join(snapshot, "loam.db"), "old still-readable database");
    writeFileSync(join(snapshot, "avatars", "a.png"), "old avatar");
    const anchor = join(dataDir, ".loam-recovery-state");
    writeFileSync(anchor, ".loam-recovery-1700000000000-abcd");
    return [snapshot, anchor];
  }

  async function wipe(app: LoamApp): Promise<number> {
    const admin = await newSession(app);
    const res = await app.server.inject({
      method: "POST",
      url: "/api/admin/kill-switch",
      headers: { cookie: admin.cookie },
      payload: { confirm: "wipe" },
    });
    return res.statusCode;
  }

  it("plaintext (logical) wipe removes the snapshot dir and the anchor", async () => {
    const { app, dataDir } = await makeApp({ killSwitch: { enabled: true } });
    const planted = plantRecoveryArtifacts(dataDir);
    expect(await wipe(app)).toBe(200);
    for (const path of planted) {
      expect(existsSync(path)).toBe(false);
    }
  });

  it("ephemeral-key (cryptographic) wipe removes the snapshot dir and the anchor", async () => {
    const { app, dataDir } = await makeApp(
      { killSwitch: { enabled: true } },
      { ephemeralDbKey: true, dbEncryptionMode: "ephemeral" },
    );
    const planted = plantRecoveryArtifacts(dataDir);
    expect(await wipe(app)).toBe(200);
    for (const path of planted) {
      expect(existsSync(path)).toBe(false);
    }
  });
});
