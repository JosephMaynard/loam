import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
