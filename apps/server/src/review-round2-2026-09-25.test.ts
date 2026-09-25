import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { Channel, Message, User } from "@loam/schema";

import { buildApp, type LoamApp } from "./app.js";
import type { AppOptions } from "./types.js";

/**
 * Second-round findings from the 2026-09-25 pre-release review. Each security test was mutation-checked:
 * with its fix reverted, it fails.
 */

type InjectResponse = Awaited<ReturnType<LoamApp["server"]["inject"]>>;

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

/** A fresh temp data dir (optionally seeded with a config.json), removed after the test. */
function tempDataDir(config?: unknown): string {
  const dataDir = mkdtempSync(join(tmpdir(), "loam-round2-0925-"));
  if (config !== undefined) {
    writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  }
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

/** Boot an app on `dataDir` (closed after the test; closing twice is harmless). */
async function boot(dataDir: string, opts?: Partial<AppOptions>): Promise<LoamApp> {
  const app = await buildApp({ dataDir, logger: false, maxNewIdentitiesPerWindow: 1_000_000, ...opts });
  cleanups.push(() => app.close());
  return app;
}

/** A fresh cookie session (the first one on a firstUser node is the admin). */
async function newSession(app: LoamApp): Promise<{ cookie: string; userId: string }> {
  const response = await app.server.inject({ method: "GET", url: "/api/config" });
  const setCookie = response.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";")[0];
  if (!cookie) {
    throw new Error("no session cookie");
  }
  return { cookie, userId: (response.json() as { currentUser: { id: string } }).currentUser.id };
}

function codeOf(response: InjectResponse): string | undefined {
  return (response.json() as { code?: string }).code;
}

/** Count the rows of a table straight from the SQLite file (the app must be closed). */
function rawRowCount(dataDir: string, table: string, id: string): number {
  const db = new DatabaseSync(join(dataDir, "loam.db"));
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id = ?`).get(id) as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

describe("rows an older release wrote past today's bounds don't stop an upgraded node from booting", () => {
  it("skips an over-long-id row (left on disk), truncates an over-long meta.model and config model", async () => {
    const dataDir = tempDataDir();
    const first = await boot(dataDir);
    const admin = await newSession(first);
    const posted = await first.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: admin.cookie },
      payload: { type: "channelPost", channelId: "general", body: "kept" },
    });
    expect(posted.statusCode).toBe(201);
    const kept = (posted.json() as { message: Message }).message;

    const longId = `x${"a".repeat(199)}`;
    const longModel = "m".repeat(200);
    const template = first.store.loadChannels()[0] as Channel;
    first.store.upsertChannel({ ...template, id: longId, name: "legacy" });
    const author = first.store.loadUsers().find((user) => user.id === admin.userId) as User;
    first.store.upsertUser({ ...author, id: `user.${"b".repeat(200)}` });
    first.store.insertMessage({ ...kept, id: longId, body: "legacy long id" });
    first.store.updateMessage({ ...kept, meta: { ...kept.meta, source: "llm", model: longModel } });
    await first.close();

    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ llm: { ollama: { model: longModel } } }));

    const app = await boot(dataDir);
    expect(app.store.loadChannels().some((channel) => channel.id === longId)).toBe(false);
    expect(app.store.loadMessages().some((message) => message.id === longId)).toBe(false);
    expect(app.store.loadUsers().some((user) => user.id.length > 128)).toBe(false);

    // The over-long model label is repaired, not the whole message dropped.
    const history = (
      await app.server.inject({ method: "GET", url: "/api/messages/general", headers: { cookie: admin.cookie } })
    ).json() as Message[];
    const repaired = history.find((message) => message.id === kept.id);
    expect(repaired?.meta?.model).toBe(longModel.slice(0, 120));

    const config = (
      await app.server.inject({ method: "GET", url: "/api/admin/config", headers: { cookie: admin.cookie } })
    ).json() as { llm: { ollama: { model: string } } };
    expect(config.llm.ollama.model).toBe(longModel.slice(0, 120));

    // Skipped rows are left on disk, not deleted.
    await app.close();
    expect(rawRowCount(dataDir, "channels", longId)).toBe(1);
    expect(rawRowCount(dataDir, "messages", longId)).toBe(1);
  });
});

describe("sync import honours a local moderator removal for new replies and reactions", () => {
  it("refuses a peer's new reply or reaction under a post this node's moderator removed", async () => {
    const sync = { enabled: true, peers: [], intervalMs: 3_600_000 };
    const source = await boot(tempDataDir({ sync }));
    const sourceAdmin = await newSession(source);
    const postMessage = (payload: Record<string, unknown>) =>
      source.server.inject({ method: "POST", url: "/api/messages", headers: { cookie: sourceAdmin.cookie }, payload });
    const created = await postMessage({ type: "channelPost", channelId: "general", body: "contested" });
    const postId = (created.json() as { message: { id: string } }).message.id;
    const sourceUrl = await source.server.listen({ port: 0, host: "127.0.0.1" });

    const puller = await boot(tempDataDir({ sync: { ...sync, peers: [{ url: sourceUrl }] } }));
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

describe("an admin edit of llm.onDevice survives a restart when config.json owns the block", () => {
  /** The effective `llm.onDevice` block, as the admin config API reports it. */
  async function onDevice(app: LoamApp, cookie: string): Promise<{ enabled: boolean; model?: string }> {
    const response = await app.server.inject({ method: "GET", url: "/api/admin/config", headers: { cookie } });
    return (response.json() as { llm: { onDevice: { enabled: boolean; model?: string } } }).llm.onDevice;
  }

  it("writes the edit through to config.json, and a later launcher edit of config.json still wins", async () => {
    const launcherConfig = { node: { name: "Host" }, llm: { onDevice: { enabled: true, model: "gemma", modelPath: "/data/m.gguf" } } };
    const dataDir = tempDataDir(launcherConfig);
    const first = await boot(dataDir);
    const admin = await newSession(first);
    expect((await onDevice(first, admin.cookie)).enabled).toBe(true);

    const patched = await first.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { llm: { onDevice: { enabled: false } } },
    });
    expect(patched.statusCode).toBe(200);
    await first.close();

    // config.json now carries the edit, with every other key it had kept.
    const file = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) as typeof launcherConfig;
    expect(file.node.name).toBe("Host");
    expect(file.llm.onDevice).toMatchObject({ enabled: false, model: "gemma", modelPath: "/data/m.gguf" });

    const second = await boot(dataDir);
    expect((await onDevice(second, admin.cookie)).enabled).toBe(false);
    await second.close();

    // The launcher's model manager re-activates a model by rewriting config.json — that still wins.
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ ...file, llm: { onDevice: { ...file.llm.onDevice, enabled: true, model: "qwen" } } }));
    const third = await boot(dataDir);
    expect(await onDevice(third, admin.cookie)).toMatchObject({ enabled: true, model: "qwen" });
  });

  it("leaves config.json alone when it doesn't carry llm.onDevice (the DB row holds the edit)", async () => {
    const dataDir = tempDataDir({ node: { name: "Pi" } });
    const first = await boot(dataDir);
    const admin = await newSession(first);
    const before = readFileSync(join(dataDir, "config.json"), "utf8");
    await first.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { llm: { onDevice: { enabled: true } } },
    });
    await first.close();
    expect(readFileSync(join(dataDir, "config.json"), "utf8")).toBe(before);

    const second = await boot(dataDir);
    expect((await onDevice(second, admin.cookie)).enabled).toBe(true);
  });
});

describe("a legacy bot id the config repair drops doesn't leave a dead assistant on the roster", () => {
  it("hides the old bot record, lists the configured bot, and logs the orphaned id", async () => {
    const ollama = { enabled: true, baseUrl: "http://127.0.0.1:9", model: "m", botDisplayName: "Gemma" };
    const dataDir = tempDataDir({ llm: { ollama: { ...ollama, botId: "llm.ollama.gemma4" } } });
    const first = await boot(dataDir);
    const admin = await newSession(first);
    // What a 0.4 node configured with `botId: "ollama.gemma"` left behind: a bot record under that id.
    const bot = first.store.loadUsers().find((user) => user.id === "llm.ollama.gemma4") as User;
    first.store.upsertUser({ ...bot, id: "ollama.gemma" });
    await first.close();

    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ llm: { ollama: { ...ollama, botId: "ollama.gemma" } } }));
    const logs: string[] = [];
    const app = await boot(dataDir, { logger: true, logStream: { write: (line) => void logs.push(line) } });

    const roster = (
      await app.server.inject({ method: "GET", url: "/api/users", headers: { cookie: admin.cookie } })
    ).json() as User[];
    const bots = roster.filter((user) => user.type === "bot").map((user) => user.id);
    expect(bots).toEqual(["llm.ollama.gemma4"]);
    // The record itself is kept (its DM history still points at it) — only hidden.
    expect(app.store.loadUsers().some((user) => user.id === "ollama.gemma")).toBe(true);
    expect(logs.join("")).toContain('old bot id \\"ollama.gemma\\"');
  });
});
