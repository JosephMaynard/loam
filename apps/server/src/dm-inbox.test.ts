import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DmInboxSchema } from "@loam/schema";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import type { LoamApp } from "./types.js";

type Session = { cookie: string; userId: string };

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()!();
  }
});

async function makeApp(): Promise<LoamApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "loam-dm-inbox-"));
  const app = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false, maxNewIdentitiesPerWindow: 1_000_000 });
  cleanups.push(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return app;
}

async function session(app: LoamApp): Promise<Session> {
  const response = await app.server.inject({ method: "GET", url: "/api/config" });
  const cookie = String(response.headers["set-cookie"]).split(";")[0]!;
  return { cookie, userId: (response.json() as { currentUser: { id: string } }).currentUser.id };
}

async function dm(app: LoamApp, from: Session, to: Session, body: string): Promise<void> {
  const response = await app.server.inject({
    method: "POST",
    url: "/api/messages",
    headers: { cookie: from.cookie },
    payload: { type: "dm", recipientUserId: to.userId, body },
  });
  expect(response.statusCode).toBe(201);
}

async function inbox(app: LoamApp, who: Session) {
  const response = await app.server.inject({ method: "GET", url: "/api/dms", headers: { cookie: who.cookie } });
  expect(response.statusCode).toBe(200);
  return DmInboxSchema.parse(response.json()).conversations;
}

describe("GET /api/dms (DM inbox)", () => {
  it("lists each DM partner once with the latest message, newest conversation first", async () => {
    const app = await makeApp();
    const admin = await session(app);
    const me = await session(app);
    const alice = await session(app);
    const bob = await session(app);
    await session(app); // someone I never talk to

    await dm(app, alice, me, "hi");
    await dm(app, me, alice, "hello back");
    await dm(app, bob, me, "hey");

    const conversations = await inbox(app, me);
    expect(conversations.map((entry) => entry.userId)).toEqual([bob.userId, alice.userId]);
    expect(conversations[0]!.lastAuthorId).toBe(bob.userId);
    expect(conversations[1]!.lastAuthorId).toBe(me.userId);
    expect(conversations[0]!.lastMessageAt).toBeGreaterThanOrEqual(conversations[1]!.lastMessageAt);

    // Each side sees only their own conversations.
    expect((await inbox(app, alice)).map((entry) => entry.userId)).toEqual([me.userId]);
    expect(await inbox(app, admin)).toEqual([]);
  });

  it("hides a shadow-banned sender's DMs from the recipient, but not from the sender", async () => {
    const app = await makeApp();
    const admin = await session(app);
    const me = await session(app);
    const troll = await session(app);
    await dm(app, troll, me, "spam");

    const ban = await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${troll.userId}`,
      headers: { cookie: admin.cookie },
      payload: { shadowBanned: true },
    });
    expect(ban.statusCode).toBe(200);

    expect(await inbox(app, me)).toEqual([]);
    expect((await inbox(app, troll)).map((entry) => entry.userId)).toEqual([me.userId]);
  });

  it("leaves out someone the caller can no longer see (banned)", async () => {
    const app = await makeApp();
    const admin = await session(app);
    const me = await session(app);
    const gone = await session(app);
    await dm(app, gone, me, "bye");

    const ban = await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${gone.userId}`,
      headers: { cookie: admin.cookie },
      payload: { banned: true },
    });
    expect(ban.statusCode).toBe(200);
    expect(await inbox(app, me)).toEqual([]);
  });
});
