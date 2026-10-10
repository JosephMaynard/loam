import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { User } from "@loam/schema";

import { buildApp, type LoamApp } from "./app.js";
import type { AppOptions, OnDeviceChatHook } from "./types.js";

/**
 * The assistant's launcher-owned config and on-device replies: an admin edit of `llm.onDevice` survives a
 * restart, a repaired legacy bot id leaves no dead assistant on the roster, and a moderator abort holds the
 * assistant slot until the phone's model stops. Each security test was mutation-checked: with its fix
 * reverted, it fails.
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
  const app = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false, maxNewIdentitiesPerWindow: 1_000_000, ...opts });
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

describe("a moderator abort of an on-device reply holds the assistant slot until the phone model stops", () => {
  type Callbacks = Parameters<OnDeviceChatHook>[1];

  afterEach(() => {
    delete (globalThis as { __loamOnDeviceChat?: OnDeviceChatHook }).__loamOnDeviceChat;
  });

  /** Poll `check` until it holds (or a few seconds pass). */
  async function waitUntil(check: () => boolean): Promise<boolean> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && !check()) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return check();
  }

  it("refuses a second generation while the aborted one is still running, and frees the slot on its end", async () => {
    // A fake launcher hook: each request's callbacks are driven by the test (the real bridge has no cancel).
    const requests: Callbacks[] = [];
    (globalThis as { __loamOnDeviceChat?: OnDeviceChatHook }).__loamOnDeviceChat = (_messages, callbacks) => {
      requests.push(callbacks);
    };
    const botId = "llm.ollama.gemma4";
    const app = await boot(tempDataDir({ llm: { onDevice: { enabled: true, model: "phone" } } }));
    const admin = await newSession(app);
    const user = await newSession(app);
    const dm = () =>
      app.server.inject({
        method: "POST",
        url: "/api/messages",
        headers: { cookie: user.cookie },
        payload: { type: "dm", recipientUserId: botId, body: "hi" },
      });

    expect((await dm()).statusCode).toBe(201);
    expect(await waitUntil(() => requests.length === 1)).toBe(true);
    requests[0]?.onDelta("partial");
    const reply = () => app.store.loadMessages().find((message) => message.authorId === botId);
    expect(await waitUntil(() => reply() !== undefined)).toBe(true);

    const removed = await app.server.inject({
      method: "POST",
      url: `/api/moderation/messages/${reply()?.id}/remove`,
      headers: { cookie: admin.cookie },
      payload: {},
    });
    expect(removed.statusCode).toBe(200);
    // The writer notices the removal on the next delta and stops listening — but the phone keeps going.
    requests[0]?.onDelta(" more");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const busy = await dm();
    expect(busy.statusCode).toBe(429);
    expect(codeOf(busy)).toBe("assistant_busy");
    expect(requests).toHaveLength(1);

    // The phone model finishes: the slot is free again.
    requests[0]?.onEnd();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await dm()).statusCode).toBe(201);
    expect(await waitUntil(() => requests.length === 2)).toBe(true);
    requests[1]?.onEnd();
  });
});
