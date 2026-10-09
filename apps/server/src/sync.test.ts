import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createMeshIdentity } from "@loam/crypto";

import type { LoamApp } from "./app.js";
import {
  cleanups,
  type InjectResponse,
  makeApp,
  newSession,
  reopenApp,
  teardownApps,
} from "./test-support/app-harness.js";

afterEach(teardownApps);

describe("node-to-node sync", () => {
  async function listenApp(app: LoamApp): Promise<string> {
    return app.server.listen({ port: 0, host: "127.0.0.1" });
  }

  async function post(app: LoamApp, cookie: string, channelId: string, body: string): Promise<string> {
    const response = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie },
      payload: { type: "channelPost", channelId, body },
    });
    return (response.json() as { message: { id: string } }).message.id;
  }

  async function runSync(app: LoamApp, cookie: string) {
    return app.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie } });
  }

  async function generalBodies(app: LoamApp, cookie: string): Promise<string[]> {
    const response = await app.server.inject({
      method: "GET",
      url: "/api/messages/general",
      headers: { cookie },
    });
    return (response.json() as { body?: string }[]).map((message) => message.body ?? "");
  }

  it("answers 404 on the sync endpoints unless enabled", async () => {
    const app = await makeApp();
    expect((await app.server.inject({ method: "GET", url: "/api/sync/digest" })).statusCode).toBe(404);
    expect(
      (await app.server.inject({ method: "POST", url: "/api/sync/messages", payload: { ids: ["x"] } })).statusCode,
    ).toBe(404);
  });

  it("pulls public messages and channels from a peer, sanitizing imported users", async () => {
    const source = await makeApp({ sync: { enabled: true, peers: [], intervalMs: 3_600_000 } });
    const sourceAdmin = await newSession(source);
    expect(sourceAdmin.isAdmin).toBe(true);
    await post(source, sourceAdmin.cookie, "general", "hello from the other node");
    await source.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie: sourceAdmin.cookie },
      payload: { name: "Relief Ops" },
    });
    await post(source, sourceAdmin.cookie, "relief-ops", "supplies at the depot");
    const sourceUrl = await listenApp(source);

    const puller = await makeApp({
      sync: { enabled: true, peers: [{ url: sourceUrl, label: "source" }], intervalMs: 3_600_000 },
    });
    const pullerAdmin = await newSession(puller);

    const run = await runSync(puller, pullerAdmin.cookie);
    expect(run.statusCode).toBe(200);
    const report = run.json() as { peers: { status?: { lastError?: string; imported: number } }[] };
    expect(report.peers[0]?.status?.lastError).toBeUndefined();

    expect(await generalBodies(puller, pullerAdmin.cookie)).toContain("hello from the other node");

    // The peer's channel was imported too, with its messages.
    const channels = (
      await puller.server.inject({ method: "GET", url: "/api/channels", headers: { cookie: pullerAdmin.cookie } })
    ).json() as { id: string }[];
    expect(channels.some((channel) => channel.id === "relief-ops")).toBe(true);

    // The source's admin author arrives as a plain user — authority never syncs.
    const importedAuthor = puller.store.loadUsers().find((user) => user.id === sourceAdmin.userId);
    expect(importedAuthor).toBeDefined();
    expect(importedAuthor?.isAdmin).toBe(false);

    // Running again imports nothing new (idempotent by id).
    const again = (await runSync(puller, pullerAdmin.cookie)).json() as {
      peers: { status?: { imported: number } }[];
    };
    const importedTotal = again.peers[0]?.status?.imported ?? -1;
    expect(importedTotal).toBeGreaterThan(0);
    const third = (await runSync(puller, pullerAdmin.cookie)).json() as {
      peers: { status?: { imported: number } }[];
    };
    expect(third.peers[0]?.status?.imported).toBe(importedTotal);
  });

  it("re-syncs metadata for a channel it IMPORTED from the peer (C1: provenance-gated)", async () => {
    const source = await makeApp({ sync: { enabled: true, peers: [], intervalMs: 3_600_000 } });
    const sourceAdmin = await newSession(source);
    await source.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie: sourceAdmin.cookie },
      payload: { name: "Relief Ops" },
    });
    const sourceUrl = await listenApp(source);

    const puller = await makeApp({ sync: { enabled: true, peers: [{ url: sourceUrl }], intervalMs: 3_600_000 } });
    const pullerAdmin = await newSession(puller);

    // First sync imports relief-ops → it's recorded as synced-origin.
    await runSync(puller, pullerAdmin.cookie);
    const imported = puller.store.loadChannels().find((channel) => channel.id === "relief-ops");
    expect(imported?.name).toBe("Relief Ops");
    // The peer's ownerUserId is stripped — an imported channel is ownerless here, never attributed to a
    // (possibly locally-authoritative) foreign id.
    expect(imported?.ownerUserId).toBeUndefined();

    // Rename + archive on the source, then sync again — the imported copy tracks the change.
    await source.server.inject({
      method: "PATCH",
      url: "/api/channels/relief-ops",
      headers: { cookie: sourceAdmin.cookie },
      payload: { name: "Relief Ops (closed)", archived: true },
    });
    await runSync(puller, pullerAdmin.cookie);
    const after = puller.store.loadChannels().find((channel) => channel.id === "relief-ops");
    expect(after?.name).toBe("Relief Ops (closed)");
    expect(after?.archived).toBe(true);
  });

  it("never clobbers a locally-created channel that shares a peer's slug — default channels stay put (C1)", async () => {
    const source = await makeApp({ sync: { enabled: true, peers: [], intervalMs: 3_600_000 } });
    const sourceAdmin = await newSession(source);
    // Rename + archive the source's OWN default `general` (every node ships general with the same id).
    await source.server.inject({
      method: "PATCH",
      url: "/api/channels/general",
      headers: { cookie: sourceAdmin.cookie },
      payload: { name: "Source General", archived: true },
    });
    const sourceUrl = await listenApp(source);

    const puller = await makeApp({ sync: { enabled: true, peers: [{ url: sourceUrl }], intervalMs: 3_600_000 } });
    const pullerAdmin = await newSession(puller);
    await runSync(puller, pullerAdmin.cookie);

    // The puller's own general is locally-created (not synced-origin), so the peer's same-slug edit is ignored.
    const general = puller.store.loadChannels().find((channel) => channel.id === "general");
    expect(general?.name).toBe("General");
    expect(general?.archived ?? false).toBe(false);
  });

  it("never exports private channels, DMs, or shadow-banned authors' messages", async () => {
    const source = await makeApp({ sync: { enabled: true, peers: [], intervalMs: 3_600_000 } });
    const admin = await newSession(source);
    const owner = await newSession(source);
    const shadowed = await newSession(source);

    // Private channel + message.
    const created = await source.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie: owner.cookie },
      payload: { name: "Quiet", visibility: "private" },
    });
    const privateId = (created.json() as { id: string }).id;
    await source.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: owner.cookie },
      payload: { type: "channelPost", channelId: privateId, body: "private words" },
    });

    // DM.
    await source.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: admin.cookie },
      payload: { type: "dm", recipientUserId: owner.userId, body: "dm words" },
    });

    // Shadow-banned author's public post.
    await post(source, shadowed.cookie, "general", "shadow words");
    await source.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${shadowed.userId}`,
      headers: { cookie: admin.cookie },
      payload: { shadowBanned: true },
    });

    await post(source, admin.cookie, "general", "public words");

    const digest = (
      await source.server.inject({ method: "GET", url: "/api/sync/digest" })
    ).json() as { channels: { id: string }[]; messages: { id: string }[] };

    expect(digest.channels.some((channel) => channel.id === privateId)).toBe(false);

    // Resolve each advertised id and confirm none of the withheld bodies appear.
    const fetched = (
      await source.server.inject({
        method: "POST",
        url: "/api/sync/messages",
        payload: { ids: digest.messages.map((entry) => entry.id) },
      })
    ).json() as { messages: { body?: string }[] };
    const bodies = fetched.messages.map((message) => message.body ?? "");
    expect(bodies).toContain("public words");
    expect(bodies).not.toContain("private words");
    expect(bodies).not.toContain("dm words");
    expect(bodies).not.toContain("shadow words");
  });

  it("a locally deleted channel is tombstoned and never re-imported from a peer that still has it", async () => {
    const source = await makeApp({ sync: { enabled: true, peers: [], intervalMs: 3_600_000 } });
    const sourceAdmin = await newSession(source);
    await source.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie: sourceAdmin.cookie },
      payload: { name: "Persistent Topic" },
    });
    await post(source, sourceAdmin.cookie, "persistent-topic", "peer still holds this");
    const sourceUrl = await listenApp(source);

    const puller = await makeApp({
      sync: { enabled: true, peers: [{ url: sourceUrl }], intervalMs: 3_600_000 },
    });
    const pullerAdmin = await newSession(puller);
    await runSync(puller, pullerAdmin.cookie);

    const listed = async () =>
      (
        (
          await puller.server.inject({ method: "GET", url: "/api/channels", headers: { cookie: pullerAdmin.cookie } })
        ).json() as { id: string }[]
      ).some((entry) => entry.id === "persistent-topic");
    expect(await listed()).toBe(true);

    // Delete the imported channel locally — permanent, so a re-sync from the still-holding peer
    // must NOT resurrect it (channel-id tombstone, docs/11).
    const deleted = await puller.server.inject({
      method: "DELETE",
      url: "/api/channels/persistent-topic",
      headers: { cookie: pullerAdmin.cookie },
    });
    expect(deleted.statusCode).toBe(200);

    await runSync(puller, pullerAdmin.cookie);
    expect(await listed()).toBe(false);
  });

  it("tombstones keep locally deleted messages from re-importing, and edits propagate", async () => {
    const source = await makeApp({ sync: { enabled: true, peers: [], intervalMs: 3_600_000 } });
    const sourceAdmin = await newSession(source);
    const keepId = await post(source, sourceAdmin.cookie, "general", "keep me");
    const doomedId = await post(source, sourceAdmin.cookie, "general", "delete me locally");
    const sourceUrl = await listenApp(source);

    const puller = await makeApp({
      sync: { enabled: true, peers: [{ url: sourceUrl }], intervalMs: 3_600_000 },
    });
    const pullerAdmin = await newSession(puller);
    await runSync(puller, pullerAdmin.cookie);
    expect(await generalBodies(puller, pullerAdmin.cookie)).toContain("delete me locally");

    // Delete locally on the puller; the source still holds it — it must not come back.
    await puller.server.inject({
      method: "DELETE",
      url: `/api/messages/${doomedId}`,
      headers: { cookie: pullerAdmin.cookie },
    });
    await runSync(puller, pullerAdmin.cookie);
    expect(await generalBodies(puller, pullerAdmin.cookie)).not.toContain("delete me locally");

    // An edit on the source propagates (newer editedAt wins).
    await source.server.inject({
      method: "PATCH",
      url: `/api/messages/${keepId}`,
      headers: { cookie: sourceAdmin.cookie },
      payload: { body: "keep me (edited)" },
    });
    await runSync(puller, pullerAdmin.cookie);
    expect(await generalBodies(puller, pullerAdmin.cookie)).toContain("keep me (edited)");
  });

  it("horizon GC: a tombstone blocks re-import within the horizon, but is prunable past it", async () => {
    const source = await makeApp({ sync: { enabled: true, peers: [], intervalMs: 3_600_000 } });
    const sourceAdmin = await newSession(source);
    const doomedId = await post(source, sourceAdmin.cookie, "general", "delete me locally, horizon test");
    const sourceUrl = await listenApp(source);

    // A tiny horizon (test-only override) so the GC boundary can be exercised without waiting days.
    const puller = await makeApp(
      { sync: { enabled: true, peers: [{ url: sourceUrl }], intervalMs: 3_600_000 } },
      { tombstoneHorizonMs: 50 },
    );
    const pullerAdmin = await newSession(puller);
    await runSync(puller, pullerAdmin.cookie);
    expect(await generalBodies(puller, pullerAdmin.cookie)).toContain("delete me locally, horizon test");

    await puller.server.inject({
      method: "DELETE",
      url: `/api/messages/${doomedId}`,
      headers: { cookie: pullerAdmin.cookie },
    });
    expect(puller.store.loadTombstones()).toContain(doomedId);

    // Still within the horizon: the reaper leaves the tombstone alone, and sync must not resurrect it.
    puller.reapExpiredMessages();
    expect(puller.store.loadTombstones()).toContain(doomedId);
    await runSync(puller, pullerAdmin.cookie);
    expect(await generalBodies(puller, pullerAdmin.cookie)).not.toContain("delete me locally, horizon test");

    // Past the horizon: the reaper GCs the tombstone, and a subsequent pull can hand the message
    // back — the accepted DTN limitation for a peer that was offline longer than the horizon.
    await new Promise((resolve) => setTimeout(resolve, 75));
    puller.reapExpiredMessages();
    expect(puller.store.loadTombstones()).not.toContain(doomedId);
    await runSync(puller, pullerAdmin.cookie);
    expect(await generalBodies(puller, pullerAdmin.cookie)).toContain("delete me locally, horizon test");
  });
});

describe("sync peer authentication (shared token)", () => {
  const TOKEN = "mesh-shared-secret-token-01";

  function digest(app: LoamApp, token?: string): Promise<InjectResponse> {
    return app.server.inject({
      method: "GET",
      url: "/api/sync/digest",
      headers: token ? { "x-loam-sync-token": token } : {},
    });
  }

  it("serves the digest openly when no token is configured", async () => {
    const app = await makeApp({ sync: { enabled: true } });
    expect((await digest(app)).statusCode).toBe(200);
  });

  it("404s an unauthenticated or wrong-token peer, 200s the right token", async () => {
    const app = await makeApp({ sync: { enabled: true, token: TOKEN } });

    // Missing token and wrong token both look exactly like sync being disabled (404) — a prober
    // can't tell a token-guarded node from one without the feature.
    expect((await digest(app)).statusCode).toBe(404);
    expect((await digest(app, "not-the-token-xxxxxxxxxx")).statusCode).toBe(404);
    expect((await digest(app, TOKEN)).statusCode).toBe(200);
  });

  it("gates the messages endpoint on the same token", async () => {
    const app = await makeApp({ sync: { enabled: true, token: TOKEN } });

    const unauth = await app.server.inject({
      method: "POST",
      url: "/api/sync/messages",
      payload: { ids: ["message.unknown"] },
    });
    expect(unauth.statusCode).toBe(404);

    const authed = await app.server.inject({
      method: "POST",
      url: "/api/sync/messages",
      headers: { "x-loam-sync-token": TOKEN },
      payload: { ids: ["message.unknown"] },
    });
    expect(authed.statusCode).toBe(200);
    expect((authed.json() as { messages: unknown[] }).messages).toEqual([]);
  });

  it("clears the token when an admin PATCHes it to an empty string", async () => {
    const app = await makeApp({ sync: { enabled: true, token: TOKEN } });
    const admin = await newSession(app);

    // Confirmed guarded first.
    expect((await digest(app)).statusCode).toBe(404);

    const patch = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { sync: { token: "" } },
    });
    expect(patch.statusCode).toBe(200);

    // Token cleared → open again.
    expect((await digest(app)).statusCode).toBe(200);
  });

  it("attaches the configured token to outbound pulls (two-node end-to-end)", async () => {
    const meshToken = "mesh-shared-secret-token-02";

    // Peer node: token-guarded, offering one public channel + message.
    const peer = await makeApp({ sync: { enabled: true, token: meshToken } });
    const peerAdmin = await newSession(peer);
    const channel = (
      await peer.server.inject({
        method: "POST",
        url: "/api/channels",
        headers: { cookie: peerAdmin.cookie },
        payload: { name: "Mesh News" },
      })
    ).json() as { id: string };
    await peer.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: peerAdmin.cookie },
      payload: { type: "channelPost", channelId: channel.id, body: "hello from the peer" },
    });
    const peerUrl = await peer.server.listen({ host: "127.0.0.1", port: 0 });

    // A puller with the MATCHING token imports the peer's message — only possible if the pull loop
    // attached x-loam-sync-token (the peer 404s the digest otherwise).
    const puller = await makeApp({ sync: { enabled: true, token: meshToken, peers: [{ url: peerUrl }] } });
    const pullerAdmin = await newSession(puller);
    const run = await puller.server.inject({
      method: "POST",
      url: "/api/admin/sync/run",
      headers: { cookie: pullerAdmin.cookie },
    });
    expect(run.statusCode).toBe(200);
    const pulled = (
      await puller.server.inject({
        method: "GET",
        url: `/api/messages/${channel.id}`,
        headers: { cookie: pullerAdmin.cookie },
      })
    ).json() as { body: string }[];
    expect(pulled.some((message) => message.body === "hello from the peer")).toBe(true);

    // A puller with the WRONG token gets nothing — the peer really gates on the exact token, so the
    // channel is never imported and its messages 404 (existence is not leaked).
    const badPuller = await makeApp({
      sync: { enabled: true, token: "wrong-token-abcdefghij", peers: [{ url: peerUrl }] },
    });
    const badAdmin = await newSession(badPuller);
    await badPuller.server.inject({
      method: "POST",
      url: "/api/admin/sync/run",
      headers: { cookie: badAdmin.cookie },
    });
    const none = await badPuller.server.inject({
      method: "GET",
      url: `/api/messages/${channel.id}`,
      headers: { cookie: badAdmin.cookie },
    });
    expect(none.statusCode).toBe(404);
  });

  it("refuses to import messages attributed to a locally-authoritative identity (anti-impersonation)", async () => {
    const peer = await makeApp({ sync: { enabled: true } });
    const peerAdmin = await newSession(peer);
    const channel = (
      await peer.server.inject({
        method: "POST",
        url: "/api/channels",
        headers: { cookie: peerAdmin.cookie },
        payload: { name: "Mesh" },
      })
    ).json() as { id: string };
    const post = (body: string) =>
      peer.server.inject({
        method: "POST",
        url: "/api/messages",
        headers: { cookie: peerAdmin.cookie },
        payload: { type: "channelPost", channelId: channel.id, body },
      });
    await post("m1");
    const peerUrl = await peer.server.listen({ host: "127.0.0.1", port: 0 });

    const puller = await makeApp({ sync: { enabled: true, peers: [{ url: peerUrl }] } });
    const pullerAdmin = await newSession(puller);
    const sync = () =>
      puller.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie: pullerAdmin.cookie } });
    const bodies = async (): Promise<string[]> =>
      (
        (
          await puller.server.inject({
            method: "GET",
            url: `/api/messages/${channel.id}`,
            headers: { cookie: pullerAdmin.cookie },
          })
        ).json() as { body?: string }[]
      ).map((message) => message.body ?? "");

    // First sync imports m1 and creates a local (authority-stripped) copy of the peer's author.
    await sync();
    expect(await bodies()).toContain("m1");

    // Promote that imported identity to a LOCAL admin — its id is now locally authoritative.
    const promote = await puller.server.inject({
      method: "POST",
      url: `/api/admin/users/${peerAdmin.userId}/promote`,
      headers: { cookie: pullerAdmin.cookie },
    });
    expect(promote.statusCode).toBe(200);

    // A further message the peer serves under that same id is now refused — a peer can't inject
    // content that renders as authored by an identity this node treats as an authority.
    await post("m2");
    await sync();
    const seen = await bodies();
    expect(seen).toContain("m1"); // the pre-promotion import stays
    expect(seen).not.toContain("m2"); // the impersonating message is dropped
  });
});

describe("sync import guards", () => {
  const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  async function uploadAttachment(app: LoamApp, cookie: string) {
    const response = await app.server.inject({
      method: "POST",
      url: "/api/attachments",
      headers: { cookie },
      payload: { mimeType: "image/png", data: tinyPng },
    });
    return response.json() as { id: string; mimeType: string };
  }

  it("skips a sync-imported message whose body exceeds the import cap, still imports a normal one", async () => {
    // The create path caps bodies at 8000 chars, so an oversized body can only arrive from a peer — model a
    // hostile peer serving one directly. 300KB > the 256KB sync-import cap.
    const author = { id: "user.peerbig", displayName: "Peer", type: "human", isAdmin: false, createdAt: 1, ephemeral: true };
    const normal = { id: "msg.peer-normal", type: "channelPost", authorId: author.id, channelId: "general", body: "hi", createdAt: 1 };
    const oversized = { id: "msg.peer-oversized", type: "channelPost", authorId: author.id, channelId: "general", body: "x".repeat(300 * 1024), createdAt: 2 };

    const peer = createServer((req, res) => {
      if (req.url === "/api/sync/digest") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ channels: [], messages: [{ id: normal.id }, { id: oversized.id }] }));
        return;
      }
      if (req.url === "/api/sync/messages") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ messages: [normal, oversized], users: [author] }));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => peer.close(() => resolve())));
    const peerUrl = `http://127.0.0.1:${(peer.address() as AddressInfo).port}`;

    const app = await makeApp({ sync: { enabled: true, peers: [{ url: peerUrl }] } });
    const admin = await newSession(app);
    await app.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie: admin.cookie } });

    const messages = (
      await app.server.inject({ method: "GET", url: "/api/messages/general", headers: { cookie: admin.cookie } })
    ).json() as { id: string }[];
    expect(messages.some((message) => message.id === normal.id)).toBe(true); // normal body imported
    expect(messages.some((message) => message.id === oversized.id)).toBe(false); // oversized body skipped
  });

  it("never lets a peer reclassify a private message or alias its attachment into the public flow", async () => {
    // A hostile peer that knows a DM's id / attachment id (e.g. a former participant) offers (1) the DM's
    // id re-typed as a public post and (2) a brand-new public post naming the DM's attachment id.
    let offered: Record<string, unknown>[] = [];
    let offeredUsers: Record<string, unknown>[] = [];
    const peer = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/sync/digest") {
        res.end(JSON.stringify({ channels: [], messages: offered.map((message) => ({ id: message.id, editedAt: message.editedAt })) }));
        return;
      }
      if (req.url === "/api/sync/messages") {
        res.end(JSON.stringify({ messages: offered, users: offeredUsers }));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => peer.close(() => resolve())));
    const peerUrl = `http://127.0.0.1:${(peer.address() as AddressInfo).port}`;

    const app = await makeApp({ sync: { enabled: true, peers: [{ url: peerUrl }], intervalMs: 3_600_000 } });
    const admin = await newSession(app);
    const sender = await newSession(app);
    const recipient = await newSession(app);
    const attachment = await uploadAttachment(app, sender.cookie);
    const dm = (
      (
        await app.server.inject({
          method: "POST",
          url: "/api/messages",
          headers: { cookie: sender.cookie },
          payload: { type: "dm", recipientUserId: recipient.userId, body: "PRIVATE", attachments: [attachment] },
        })
      ).json() as { message: { id: string; createdAt: number } }
    ).message;
    const filePath = `/api/attachments/${attachment.id}.png`;
    expect((await app.server.inject({ method: "GET", url: filePath })).statusCode).toBe(404);

    const runSync = () => app.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie: admin.cookie } });

    offered = [
      { id: dm.id, type: "channelPost", authorId: sender.userId, channelId: "general", body: "now public", createdAt: dm.createdAt, editedAt: Date.now() + 1000 },
    ];
    await runSync();
    const stored = app.store.loadMessages().find((message) => message.id === dm.id);
    expect(stored?.type).toBe("dm");
    expect(stored && "body" in stored ? stored.body : undefined).toBe("PRIVATE");

    // The identity check runs BEFORE any attachment work: a refused import must not fetch bytes or
    // queue a retry under the local message's id (the peer 404s this file, which used to record one).
    offered = [
      {
        id: dm.id, type: "channelPost", authorId: sender.userId, channelId: "general", body: "with file",
        createdAt: dm.createdAt, editedAt: Date.now() + 2000, attachments: [{ id: "att_0123456789abcdef", mimeType: "image/png" }],
      },
    ];
    await runSync();
    expect(app.store.loadMissingAttachments()).toEqual([]);
    expect(app.store.loadMessages().find((message) => message.id === dm.id)?.type).toBe("dm");

    // A reply can't be re-parented, and ids inside the mesh replay-key namespace are never imported.
    const post = async (payload: Record<string, unknown>) =>
      ((await app.server.inject({ method: "POST", url: "/api/messages", headers: { cookie: sender.cookie }, payload })).json() as {
        message: { id: string; createdAt: number };
      }).message;
    const parentA = await post({ type: "channelPost", channelId: "general", body: "parent A" });
    const parentB = await post({ type: "channelPost", channelId: "general", body: "parent B" });
    const child = await post({ type: "channelReply", channelId: "general", parentMessageId: parentA.id, body: "child" });
    offered = [
      { id: child.id, type: "channelReply", authorId: sender.userId, channelId: "general", parentMessageId: parentB.id, body: "moved", createdAt: child.createdAt, editedAt: Date.now() + 3000 },
      { id: `sealed.${"a".repeat(64)}`, type: "channelPost", authorId: "user.peeralias", channelId: "general", body: "planted", createdAt: 2 },
    ];
    await runSync();
    expect(app.store.loadMessages().find((message) => message.id === child.id)).toMatchObject({ parentMessageId: parentA.id, body: "child" });
    expect(app.store.loadMessages().some((message) => message.id.startsWith("sealed."))).toBe(false);

    // A peer can't rewrite a message a LOCAL user wrote, even with every identity field right — only
    // records this node imported are editable by a later import.
    offered = [
      { id: parentA.id, type: "channelPost", authorId: sender.userId, channelId: "general", body: "PEER REWROTE THIS", createdAt: parentA.createdAt, editedAt: Date.now() + 4000 },
    ];
    await runSync();
    expect(app.store.loadMessages().find((message) => message.id === parentA.id)).toMatchObject({ body: "parent A" });

    // ...while a message that CAME from the peer still takes the peer's edits.
    const peerPost = { id: "msg.peer-own", type: "channelPost", authorId: "user.peerown", channelId: "general", body: "v1", createdAt: 3 };
    offered = [peerPost];
    await runSync();
    offered = [{ ...peerPost, body: "v2", editedAt: Date.now() + 5000 }];
    await runSync();
    expect(app.store.loadMessages().find((message) => message.id === peerPost.id)).toMatchObject({ body: "v2" });

    offered = [
      { id: "msg.peer-alias", type: "channelPost", authorId: "user.peeralias", channelId: "general", body: "alias", createdAt: 1, attachments: [attachment] },
    ];
    await runSync();
    expect(app.store.loadMessages().some((message) => message.id === "msg.peer-alias")).toBe(false);

    expect((await app.server.inject({ method: "GET", url: filePath })).statusCode).toBe(404);
    const exported = (
      await app.server.inject({ method: "POST", url: "/api/sync/messages", payload: { ids: [dm.id] } })
    ).json() as { messages: unknown[] };
    expect(exported.messages).toEqual([]);

    // A moderator removal is sticky: the origin's next (newer) edit must not restore the content.
    expect(
      (await app.server.inject({ method: "POST", url: `/api/moderation/messages/${peerPost.id}/remove`, headers: { cookie: admin.cookie } }))
        .statusCode,
    ).toBe(200);
    offered = [{ ...peerPost, body: "back again", editedAt: Date.now() + 60_000 }];
    await runSync();
    expect(app.store.loadMessages().find((message) => message.id === peerPost.id)).toMatchObject({
      body: "",
      meta: { removedByModerator: true },
    });

    // An imported record can't be re-routed or re-attributed either (the identity check on its own —
    // provenance passes here).
    const other = (
      await app.server.inject({ method: "POST", url: "/api/channels", headers: { cookie: admin.cookie }, payload: { name: "Elsewhere" } })
    ).json() as { id: string };
    const peerSecond = { id: "msg.peer-second", type: "channelPost", authorId: "user.peerown", channelId: "general", body: "stay", createdAt: 5 };
    offered = [peerSecond];
    await runSync();
    offered = [
      { ...peerSecond, channelId: other.id, body: "moved", editedAt: Date.now() + 6000 },
      { ...peerSecond, authorId: sender.userId, body: "re-attributed", editedAt: Date.now() + 7000 },
    ];
    await runSync();
    expect(app.store.loadMessages().find((message) => message.id === peerSecond.id)).toMatchObject({
      channelId: "general", authorId: "user.peerown", body: "stay",
    });

    // A peer's mesh key is never adopted onto one of OUR users — even one with no live session.
    const peerIdentity = createMeshIdentity();
    await app.server.inject({ method: "POST", url: "/api/session/end", headers: { cookie: recipient.cookie } });
    offeredUsers = [
      {
        id: recipient.userId, displayName: "x", type: "human", isAdmin: false, createdAt: 1, ephemeral: true,
        identityKey: { alg: "ed25519", sign: peerIdentity.signPublic, kx: peerIdentity.kxPublic, kxSig: peerIdentity.kxSig },
      },
    ];
    offered = [{ id: "msg.peer-third", type: "channelPost", authorId: recipient.userId, channelId: "general", body: "hi", createdAt: 6 }];
    await runSync();
    expect(app.store.loadUsers().find((user) => user.id === recipient.userId)?.identityKey).toBeUndefined();
    offeredUsers = [];

    // After a restart pending-upload ownership (in-memory) is gone; an unowned file already on disk must
    // still never be bound to a public import — whatever MIME class the peer declares for its id (the
    // download gate and the orphan sweep resolve files by ID, so a `.bin` claim would alias the `.png`).
    const reopened = await reopenApp(app.app, app.dataDir);
    const unownedId = "att_feedfacefeedface";
    mkdirSync(join(app.dataDir, "attachments"), { recursive: true });
    writeFileSync(join(app.dataDir, "attachments", `${unownedId}.png`), "unowned");
    offered = [
      { id: "msg.peer-orphan", type: "channelPost", authorId: "user.peeralias", channelId: "general", body: "orphan", createdAt: 4, attachments: [{ id: unownedId, mimeType: "text/plain", name: "x.txt" }] },
      { id: "msg.peer-control", type: "channelPost", authorId: "user.peeralias", channelId: "general", body: "control", createdAt: 4 },
    ];
    const rerun = await reopened.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie: admin.cookie } });
    expect(rerun.statusCode).toBe(200);
    const afterReopen = reopened.store.loadMessages().map((message) => message.id);
    expect(afterReopen).toContain("msg.peer-control"); // the round really ran
    expect(afterReopen).not.toContain("msg.peer-orphan");
  });

  it.each([
    // >256 KiB over the sealed JSON route: the response schema capped `data` at the IMAGE limit.
    { name: "a 300 KiB file over encrypted sync", pinned: true, plaintextSource: false, size: 300 * 1024 },
    // A SMALL file isolates the other cause: the sealed route omitted `mimeType` for `.bin` files.
    { name: "a small file over encrypted sync", pinned: false, plaintextSource: false, size: 2048 },
    // The legacy binary GET used for a plaintext (Developer Mode) peer capped the stream at the image limit.
    { name: "a 300 KiB file from a plaintext peer", pinned: false, plaintextSource: true, size: 300 * 1024 },
  ])("syncs a non-image attachment: $name", async ({ pinned, plaintextSource, size }) => {
    if (plaintextSource) {
      process.env.LOAM_DEV_MODE = "1"; // read once, at buildApp time
    }
    const source = await makeApp({ sync: { enabled: true, peers: [], intervalMs: 3_600_000 } }).finally(() => {
      delete process.env.LOAM_DEV_MODE;
    });
    const sourceAdmin = await newSession(source);
    const bytes = Buffer.alloc(size, 65);
    const attachment = (
      await source.server.inject({
        method: "POST",
        url: "/api/attachments",
        headers: { cookie: sourceAdmin.cookie },
        payload: { mimeType: "text/plain", name: "notes.txt", data: bytes.toString("base64") },
      })
    ).json() as { id: string; mimeType: string };
    const posted = await source.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: sourceAdmin.cookie },
      payload: { type: "channelPost", channelId: "general", body: "a file", attachments: [attachment] },
    });
    expect(posted.statusCode).toBe(201);
    await source.server.listen({ host: "127.0.0.1", port: 0 });
    const peerUrl = `http://127.0.0.1:${(source.server.server.address() as AddressInfo).port}`;

    const puller = await makeApp({
      sync: {
        enabled: true,
        peers: [pinned ? { url: peerUrl, transportKey: source.getTransportPublicKey() } : { url: peerUrl }],
        intervalMs: 3_600_000,
      },
    });
    const pullerAdmin = await newSession(puller);
    await puller.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie: pullerAdmin.cookie } });

    expect(puller.store.loadMissingAttachments()).toEqual([]);
    const copied = readdirSync(join(puller.dataDir, "attachments"));
    expect(copied).toHaveLength(1);
    expect(readFileSync(join(puller.dataDir, "attachments", copied[0])).equals(bytes)).toBe(true);
  });

  it("still refuses an IMAGE over the 256 KiB image cap from a peer (the wire cap is now the 1 MiB file cap)", async () => {
    const source = await makeApp({ sync: { enabled: true, peers: [], intervalMs: 3_600_000 } });
    const sourceAdmin = await newSession(source);
    const attachment = await uploadAttachment(source, sourceAdmin.cookie);
    await source.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: sourceAdmin.cookie },
      payload: { type: "channelPost", channelId: "general", body: "big image", attachments: [attachment] },
    });
    // A hostile/buggy peer's copy is bigger than any honest upload could be (valid PNG signature, 300 KiB).
    const oversized = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(300 * 1024)]);
    writeFileSync(join(source.dataDir, "attachments", `${attachment.id}.png`), oversized);
    await source.server.listen({ host: "127.0.0.1", port: 0 });
    const peerUrl = `http://127.0.0.1:${(source.server.server.address() as AddressInfo).port}`;

    const puller = await makeApp({
      sync: { enabled: true, peers: [{ url: peerUrl, transportKey: source.getTransportPublicKey() }], intervalMs: 3_600_000 },
    });
    const pullerAdmin = await newSession(puller);
    await puller.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie: pullerAdmin.cookie } });

    const attachmentsDir = join(puller.dataDir, "attachments");
    expect(existsSync(attachmentsDir) ? readdirSync(attachmentsDir) : []).toEqual([]);
    expect(puller.store.loadMissingAttachments()).toHaveLength(1); // recorded for retry, never written
  });

  it("keeps shadow-banned users' reactions out of the sync export", async () => {
    const app = await makeApp({ sync: { enabled: true, peers: [], intervalMs: 3_600_000 } });
    const admin = await newSession(app);
    const shadowed = await newSession(app);

    const posted = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: admin.cookie },
      payload: { type: "channelPost", channelId: "general", body: "react to me" },
    });
    const messageId = (posted.json() as { message: { id: string } }).message.id;

    const reacted = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: shadowed.cookie },
      payload: { type: "reaction", targetMessageId: messageId, reaction: "👍" },
    });
    const reactionId = (reacted.json() as { message: { id: string } }).message.id;

    await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${shadowed.userId}`,
      headers: { cookie: admin.cookie },
      payload: { shadowBanned: true },
    });

    const digest = (await app.server.inject({ method: "GET", url: "/api/sync/digest" })).json() as {
      messages: { id: string }[];
    };
    expect(digest.messages.some((entry) => entry.id === messageId)).toBe(true);
    expect(digest.messages.some((entry) => entry.id === reactionId)).toBe(false);
  });

  it("refuses to import a reply whose parent was tombstoned locally", async () => {
    const source = await makeApp({ sync: { enabled: true, peers: [], intervalMs: 3_600_000 } });
    const sourceAdmin = await newSession(source);
    const parentPost = await source.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: sourceAdmin.cookie },
      payload: { type: "channelPost", channelId: "general", body: "thread root" },
    });
    const parentId = (parentPost.json() as { message: { id: string } }).message.id;
    const sourceUrl = await source.server.listen({ port: 0, host: "127.0.0.1" });

    const puller = await makeApp({
      sync: { enabled: true, peers: [{ url: sourceUrl }], intervalMs: 3_600_000 },
    });
    const pullerAdmin = await newSession(puller);
    await puller.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie: pullerAdmin.cookie } });

    // The puller deletes the imported thread root (tombstoning it)...
    await puller.server.inject({
      method: "DELETE",
      url: `/api/messages/${parentId}`,
      headers: { cookie: pullerAdmin.cookie },
    });

    // ...then the source grows a reply under that root.
    await source.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: sourceAdmin.cookie },
      payload: { type: "channelReply", channelId: "general", parentMessageId: parentId, body: "late reply" },
    });

    await puller.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie: pullerAdmin.cookie } });

    const bodies = (
      (
        await puller.server.inject({ method: "GET", url: "/api/messages/general", headers: { cookie: pullerAdmin.cookie } })
      ).json() as { body?: string }[]
    ).map((message) => message.body ?? "");
    expect(bodies).not.toContain("thread root");
    expect(bodies).not.toContain("late reply");
  });
});

describe("missing-attachment retries", () => {
  const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  async function uploadAttachment(app: LoamApp, cookie: string) {
    const response = await app.server.inject({
      method: "POST",
      url: "/api/attachments",
      headers: { cookie },
      payload: { mimeType: "image/png", data: tinyPng },
    });
    return response.json() as { id: string; mimeType: string };
  }

  it("retries a transiently-failed sync attachment copy independently, without re-importing the message", async () => {
    const source = await makeApp({ sync: { enabled: true, peers: [], intervalMs: 3_600_000 } });
    const sourceAdmin = await newSession(source);
    const attachment = await uploadAttachment(source, sourceAdmin.cookie);
    await source.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: sourceAdmin.cookie },
      payload: { type: "channelPost", channelId: "general", body: "", attachments: [attachment] },
    });

    const sourceFilePath = join(source.dataDir, "attachments", `${attachment.id}.png`);
    expect(existsSync(sourceFilePath)).toBe(true);

    // Simulate a transient failure: the peer's copy of the file is briefly unavailable (a hiccup, a
    // mid-write) at the moment the puller's sync round asks for it — the message itself still
    // imports (best-effort), but the attachment fetch throws.
    const bytes = readFileSync(sourceFilePath);
    rmSync(sourceFilePath);

    const sourceUrl = await source.server.listen({ port: 0, host: "127.0.0.1" });
    const puller = await makeApp({ sync: { enabled: true, peers: [{ url: sourceUrl }], intervalMs: 3_600_000 } });
    const pullerAdmin = await newSession(puller);

    const firstRun = (
      await puller.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie: pullerAdmin.cookie } })
    ).json() as { peers: { status?: { imported: number } }[] };
    const importedAfterFirstRun = firstRun.peers[0]?.status?.imported ?? -1;
    expect(importedAfterFirstRun).toBeGreaterThan(0); // the message (text) imported fine

    const pullerFilePath = join(puller.dataDir, "attachments", `${attachment.id}.png`);
    expect(existsSync(pullerFilePath)).toBe(false); // ...but the image is still missing

    // A second sync round is idempotent (the message id is already known — `imported` is a
    // cumulative counter, so it stays unchanged) and — this is the bug being fixed — on its own never
    // re-offers or re-fetches the attachment.
    const again = (
      await puller.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie: pullerAdmin.cookie } })
    ).json() as { peers: { status?: { imported: number } }[] };
    expect(again.peers[0]?.status?.imported).toBe(importedAfterFirstRun);
    expect(existsSync(pullerFilePath)).toBe(false);

    // The peer's file comes back (the transient failure resolves) — the independent retry pass
    // (NOT a re-import: no /api/admin/sync/run here) picks it up from the recorded work item.
    writeFileSync(sourceFilePath, bytes);
    await puller.retryMissingAttachments();

    expect(existsSync(pullerFilePath)).toBe(true);
    expect(readFileSync(pullerFilePath)).toEqual(bytes);

    // The work item is cleared on success — a further retry pass is a no-op, not a repeated fetch.
    await puller.retryMissingAttachments();
    expect(existsSync(pullerFilePath)).toBe(true);
  });

  it("backs off between attempts, so a work item survives far more than the old fixed attempt cap without hitting its age bound", async () => {
    const source = await makeApp({ sync: { enabled: true, peers: [], intervalMs: 3_600_000 } });
    const sourceAdmin = await newSession(source);
    const attachment = await uploadAttachment(source, sourceAdmin.cookie);
    await source.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: sourceAdmin.cookie },
      payload: { type: "channelPost", channelId: "general", body: "", attachments: [attachment] },
    });

    // The peer's copy stays missing for the whole test — every retry attempt fails.
    rmSync(join(source.dataDir, "attachments", `${attachment.id}.png`));

    const sourceUrl = await source.server.listen({ port: 0, host: "127.0.0.1" });
    const puller = await makeApp({ sync: { enabled: true, peers: [{ url: sourceUrl }], intervalMs: 3_600_000 } });
    const pullerAdmin = await newSession(puller);
    await puller.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie: pullerAdmin.cookie } });
    expect(puller.store.loadMissingAttachments()).toHaveLength(1);

    // Simulate 25 reaper ticks back-to-back — more than the old fixed cap of 20 attempts, which used
    // to exhaust (and drop) the work item well before its days-scale age bound. With backoff, almost
    // all of these are throttled (skipped) instead of actually contacting the still-unreachable peer.
    for (let i = 0; i < 25; i += 1) {
      await puller.retryMissingAttachments();
    }

    const records = puller.store.loadMissingAttachments();
    expect(records).toHaveLength(1); // NOT given up — only the age bound (days) governs give-up now
    expect(records[0]?.attempts).toBeLessThan(5); // backoff meant most of the 25 ticks were skipped
  });

  it("no-ops entirely when sync is disabled, without touching queued work items", async () => {
    const app = await makeApp({ sync: { enabled: false, peers: [{ url: "http://peer.example" }] } });
    app.store.addMissingAttachment({
      messageId: "msg_1",
      attachmentId: "att_1",
      mimeType: "image/png",
      peerUrl: "http://peer.example",
    });

    await app.retryMissingAttachments();

    const [record] = app.store.loadMissingAttachments();
    expect(record).toMatchObject({ messageId: "msg_1", attachmentId: "att_1", attempts: 0 });
  });

  it("drops a queued retry immediately once its peer is removed from sync.peers, via the admin config PATCH", async () => {
    const app = await makeApp({ sync: { enabled: true, peers: [{ url: "http://peer.example" }] } });
    const admin = await newSession(app);
    app.store.addMissingAttachment({
      messageId: "msg_1",
      attachmentId: "att_1",
      mimeType: "image/png",
      peerUrl: "http://peer.example",
    });
    expect(app.store.loadMissingAttachments()).toHaveLength(1);

    const patch = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { sync: { peers: [] } },
    });
    expect(patch.statusCode).toBe(200);

    // Dropped immediately by the PATCH handler — no reaper tick needed.
    expect(app.store.loadMissingAttachments()).toEqual([]);
  });

  it("retryMissingAttachments also defensively drops a record for a peer that isn't in the current sync.peers (belt-and-suspenders)", async () => {
    // A peer no longer in sync.peers — e.g. the config.json was edited between boots rather than via
    // the admin PATCH, so the PATCH-handler cleanup above never ran.
    const app = await makeApp({ sync: { enabled: true, peers: [{ url: "http://still-active.example" }] } });
    app.store.addMissingAttachment({
      messageId: "msg_1",
      attachmentId: "att_1",
      mimeType: "image/png",
      peerUrl: "http://long-gone.example",
    });

    await app.retryMissingAttachments();

    expect(app.store.loadMissingAttachments()).toEqual([]);
  });

  it("a tick overlapping an in-flight (slow) pass no-ops instead of running a second concurrent pass", async () => {
    // A local, definitely-unlistened port — the eventual peer fetch fails fast (ECONNREFUSED, no real
    // network/DNS involved), so the test stays quick while still giving the first pass a genuine async
    // suspension point (see below) to be "in flight" at.
    const unreachablePeerUrl = "http://127.0.0.1:39217";
    const app = await makeApp({ sync: { enabled: true, peers: [{ url: unreachablePeerUrl }] } });
    const admin = await newSession(app);

    // A record referencing a REAL local message that lists the attachment (so it survives the F2b and
    // message-references-attachment checks and reaches its first genuine `await` — `await stat(filePath)`
    // — instead of being dropped synchronously). That's what makes the first call still "in flight"
    // (suspended, not yet past its `try`/`finally`) at the instant the second, overlapping call is fired.
    const attachment = await uploadAttachment(app, admin.cookie);
    const posted = (await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: admin.cookie },
      payload: { type: "channelPost", channelId: "general", body: "carries a missing attachment", attachments: [attachment] },
    })).json() as { message: { id: string } };

    app.store.addMissingAttachment({
      messageId: posted.message.id,
      attachmentId: attachment.id,
      mimeType: "image/png",
      peerUrl: unreachablePeerUrl,
    });

    // A pass calls `store.loadDueMissingAttachments()` exactly once, synchronously, right at its start
    // — so counting calls to it distinguishes "a second pass actually ran" from "the mutex
    // no-op'd it".
    let calls = 0;
    const original = app.store.loadDueMissingAttachments.bind(app.store);
    app.store.loadDueMissingAttachments = (...args: Parameters<typeof original>): ReturnType<typeof original> => {
      calls += 1;
      return original(...args);
    };

    const first = app.retryMissingAttachments(); // synchronously runs up to `await stat(filePath)`, then suspends
    const second = app.retryMissingAttachments(); // fired while `first` is still in flight
    await Promise.all([first, second]);

    expect(calls).toBe(1);
    // The mutex was released once the (slow) first pass finished — a later, non-overlapping call runs
    // normally again.
    await app.retryMissingAttachments();
    expect(calls).toBe(2);
  });

  it("bounds work per pass at missingAttachmentMaxRecordsPerPass (25), leaving the rest for the next tick", async () => {
    const app = await makeApp({ sync: { enabled: true, peers: [{ url: "http://still-active.example" }] } });

    // All 30 point at a peer NOT in sync.peers, so every record the pass actually looks at is dropped
    // immediately (F2b) — a fast, deterministic way to observe exactly how many records one pass
    // touched, without any network mocking.
    for (let i = 0; i < 30; i += 1) {
      app.store.addMissingAttachment({
        messageId: `msg_${i}`,
        attachmentId: `att_${i}`,
        mimeType: "image/png",
        peerUrl: "http://long-gone.example",
      });
    }
    expect(app.store.loadMissingAttachments()).toHaveLength(30);

    await app.retryMissingAttachments();

    // Only the first 25 (the per-pass cap) were looked at and dropped; the remaining 5 are untouched.
    expect(app.store.loadMissingAttachments()).toHaveLength(5);

    // A second pass picks up where the first left off.
    await app.retryMissingAttachments();
    expect(app.store.loadMissingAttachments()).toEqual([]);
  });

  it("the due set is looked at even when the first 25 (by creation order) are all still in backoff — no starvation", async () => {
    const app = await makeApp({ sync: { enabled: true, peers: [{ url: "http://still-active.example" }] } });

    // First 25 (in creation/rowid order) are all bumped into the future — deliberately still in backoff.
    for (let i = 0; i < 25; i += 1) {
      app.store.addMissingAttachment({
        messageId: `future_${i}`,
        attachmentId: "att",
        mimeType: "image/png",
        peerUrl: "http://long-gone.example", // dropped on sight (F2b) once actually looked at
      });
      app.store.bumpMissingAttachmentAttempts(`future_${i}`, "att", Date.now() + 3_600_000);
    }

    // Last 5 (created after) are due right now (default nextAttemptAt = 0).
    for (let i = 0; i < 5; i += 1) {
      app.store.addMissingAttachment({
        messageId: `due_${i}`,
        attachmentId: "att",
        mimeType: "image/png",
        peerUrl: "http://long-gone.example",
      });
    }

    expect(app.store.loadMissingAttachments()).toHaveLength(30);

    await app.retryMissingAttachments();

    // The old rowid-order slice-then-check-backoff logic looked at the first 25 (all still in backoff,
    // all skipped) and NEVER reached the 5 due records added after them — permanent starvation. The
    // fixed pass selects by due-ness (loadDueMissingAttachments), not creation order, so the 5 due ones
    // ARE processed (F2b drops them immediately — the peer is gone) while the 25 not-yet-due ones are
    // left untouched for a later tick.
    const remaining = app.store.loadMissingAttachments();
    expect(remaining).toHaveLength(25);
    expect(remaining.every((record) => record.messageId.startsWith("future_"))).toBe(true);
  });
});

describe("sync import honours local posting policy", () => {
  function patchChannel(app: LoamApp, cookie: string, channelId: string, payload: Record<string, unknown>): Promise<InjectResponse> {
    return app.server.inject({ method: "PATCH", url: `/api/channels/${channelId}`, headers: { cookie }, payload });
  }

  function post(app: LoamApp, cookie: string, channelId: string, body: string): Promise<InjectResponse> {
    return app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie },
      payload: { type: "channelPost", channelId, body },
    });
  }

  async function bodiesIn(app: LoamApp, cookie: string, channelId: string): Promise<string[]> {
    const response = await app.server.inject({ method: "GET", url: `/api/messages/${channelId}`, headers: { cookie } });
    return (response.json() as { body?: string }[]).map((message) => message.body ?? "");
  }

  it("sync import honours a local channel's posting policy and the node's feature flags", async () => {
    const source = await makeApp({ sync: { enabled: true, peers: [], intervalMs: 3_600_000 } });
    const sourceAdmin = await newSession(source);
    expect((await post(source, sourceAdmin.cookie, "announcements", "peer announcement")).statusCode).toBe(201);
    const general = await post(source, sourceAdmin.cookie, "general", "peer general");
    expect(general.statusCode).toBe(201);
    const generalId = (general.json() as { message: { id: string } }).message.id;
    expect(
      (
        await source.server.inject({
          method: "POST",
          url: "/api/messages",
          headers: { cookie: sourceAdmin.cookie },
          payload: { type: "reaction", targetMessageId: generalId, reaction: "👍" },
        })
      ).statusCode,
    ).toBe(201);
    const sourceUrl = await source.server.listen({ port: 0, host: "127.0.0.1" });

    const puller = await makeApp({
      sync: { enabled: true, peers: [{ url: sourceUrl, label: "source" }], intervalMs: 3_600_000 },
      features: { enableReactions: false },
    });
    const pullerAdmin = await newSession(puller);
    // The puller's OWN announcements channel is admins-only; the source's admin arrives as a plain user.
    expect((await patchChannel(puller, pullerAdmin.cookie, "announcements", { allowPosting: "admins" })).statusCode).toBe(200);

    const run = await puller.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie: pullerAdmin.cookie } });
    expect(run.statusCode).toBe(200);

    expect(await bodiesIn(puller, pullerAdmin.cookie, "general")).toContain("peer general");
    expect(await bodiesIn(puller, pullerAdmin.cookie, "announcements")).not.toContain("peer announcement");
    expect(puller.store.loadMessages().some((message) => message.type === "reaction")).toBe(false);
  });
});

describe("sync import honours a tightened policy on an imported channel", () => {
  const MESH_OFF_SYNC = (peers: { url: string; label?: string }[]) => ({
    sync: { enabled: true, peers, intervalMs: 3_600_000 },
  });

  it("sync import honours a locally-tightened posting policy on an IMPORTED channel and refuses reactions into a locally archived one", async () => {
    const source = await makeApp(MESH_OFF_SYNC([]));
    const sourceAdmin = await newSession(source);
    expect(
      (
        await source.server.inject({
          method: "POST",
          url: "/api/channels",
          headers: { cookie: sourceAdmin.cookie },
          payload: { name: "Relief Ops" },
        })
      ).statusCode,
    ).toBe(201);
    const first = await source.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: sourceAdmin.cookie },
      payload: { type: "channelPost", channelId: "relief-ops", body: "first" },
    });
    expect(first.statusCode).toBe(201);
    const firstId = (first.json() as { message: { id: string } }).message.id;
    const sourceUrl = await source.server.listen({ port: 0, host: "127.0.0.1" });

    const puller = await makeApp(MESH_OFF_SYNC([{ url: sourceUrl, label: "source" }]));
    const pullerAdmin = await newSession(puller);
    const sync = () => puller.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie: pullerAdmin.cookie } });
    const bodies = async () =>
      ((await puller.server.inject({ method: "GET", url: "/api/messages/relief-ops", headers: { cookie: pullerAdmin.cookie } })).json() as {
        body?: string;
        type: string;
      }[]);
    expect((await sync()).statusCode).toBe(200);
    expect((await bodies()).map((m) => m.body)).toContain("first"); // the channel + post imported

    // The local admin locks the IMPORTED channel to admins-only. The source's admin is an ordinary user
    // here, so its later posts must not land.
    expect(
      (
        await puller.server.inject({
          method: "PATCH",
          url: "/api/channels/relief-ops",
          headers: { cookie: pullerAdmin.cookie },
          payload: { allowPosting: "admins" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await source.server.inject({
          method: "POST",
          url: "/api/messages",
          headers: { cookie: sourceAdmin.cookie },
          payload: { type: "channelPost", channelId: "relief-ops", body: "after lockdown" },
        })
      ).statusCode,
    ).toBe(201);
    expect((await sync()).statusCode).toBe(200);
    expect((await bodies()).map((m) => m.body)).not.toContain("after lockdown");

    // Now the local admin ARCHIVES it; a peer reaction on the already-imported post must not land either.
    expect(
      (
        await puller.server.inject({
          method: "PATCH",
          url: "/api/channels/relief-ops",
          headers: { cookie: pullerAdmin.cookie },
          payload: { archived: true },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await source.server.inject({
          method: "POST",
          url: "/api/messages",
          headers: { cookie: sourceAdmin.cookie },
          payload: { type: "reaction", targetMessageId: firstId, reaction: "👍" },
        })
      ).statusCode,
    ).toBe(201);
    expect((await sync()).statusCode).toBe(200);
    expect(puller.store.loadMessages().some((message) => message.type === "reaction")).toBe(false);
  });
});

describe("peer status housekeeping", () => {
  it("prunes peerSyncStatus when a peer is removed via config PATCH", async () => {
    const app = await makeApp({ sync: { enabled: true, peers: [{ url: "http://peer-a.invalid" }] } });
    const admin = await newSession(app);

    // Force a sync attempt so the peer gets a live status entry, then confirm it's reported.
    await app.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie: admin.cookie } });
    const before = (
      await app.server.inject({ method: "GET", url: "/api/admin/sync", headers: { cookie: admin.cookie } })
    ).json() as { peers: { url: string; status?: unknown }[] };
    expect(before.peers.some((peer) => peer.url === "http://peer-a.invalid" && peer.status)).toBe(true);

    // Remove the peer; its status must be pruned, not linger.
    await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { sync: { peers: [] } },
    });
    const after = (
      await app.server.inject({ method: "GET", url: "/api/admin/sync", headers: { cookie: admin.cookie } })
    ).json() as { peers: { url: string }[] };
    expect(after.peers.some((peer) => peer.url === "http://peer-a.invalid")).toBe(false);

    // Re-adding the same peer creates a fresh status entry — the prune cleared the slot, it didn't
    // just filter the report.
    await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { sync: { peers: [{ url: "http://peer-a.invalid" }] } },
    });
    await app.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie: admin.cookie } });
    const readded = (
      await app.server.inject({ method: "GET", url: "/api/admin/sync", headers: { cookie: admin.cookie } })
    ).json() as { peers: { url: string; status?: unknown }[] };
    expect(readded.peers.some((peer) => peer.url === "http://peer-a.invalid" && peer.status)).toBe(true);
  });
});

describe("sync import honours a local moderator removal for new replies and reactions", () => {
  it("refuses a peer's new reply or reaction under a post this node's moderator removed", async () => {
    const sync = { enabled: true, peers: [], intervalMs: 3_600_000 };
    const { app: source } = await makeApp({ sync });
    const sourceAdmin = await newSession(source);
    const postMessage = (payload: Record<string, unknown>) =>
      source.server.inject({ method: "POST", url: "/api/messages", headers: { cookie: sourceAdmin.cookie }, payload });
    const created = await postMessage({ type: "channelPost", channelId: "general", body: "contested" });
    const postId = (created.json() as { message: { id: string } }).message.id;
    const sourceUrl = await source.server.listen({ port: 0, host: "127.0.0.1" });

    const { app: puller } = await makeApp({ sync: { ...sync, peers: [{ url: sourceUrl }] } });
    const pullerAdmin = await newSession(puller);
    const runSync = () =>
      puller.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie: pullerAdmin.cookie } });
    await runSync();
    expect(puller.store.loadMessages().some((message) => message.id === postId)).toBe(true);

    const removed = await puller.server.inject({
      method: "POST",
      url: `/api/moderation/messages/${postId}/remove`,
      headers: { cookie: pullerAdmin.cookie },
      payload: {},
    });
    expect(removed.statusCode).toBe(200);

    // The source never saw the removal, so it accepts a reply and a reaction under the post.
    const reply = await postMessage({ type: "channelReply", channelId: "general", parentMessageId: postId, body: "pile-on" });
    expect(reply.statusCode).toBe(201);
    const reaction = await postMessage({ type: "reaction", targetMessageId: postId, reaction: "👍" });
    expect(reaction.statusCode).toBe(201);
    const replyId = (reply.json() as { message: { id: string } }).message.id;
    const reactionId = (reaction.json() as { message: { id: string } }).message.id;

    expect((await runSync()).statusCode).toBe(200);
    const ids = puller.store.loadMessages().map((message) => message.id);
    expect(ids).not.toContain(replyId);
    expect(ids).not.toContain(reactionId);
  });
});
