import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApp, type LoamApp } from "./app.js";
import {
  cleanups,
  type InjectResponse,
  makeApp,
  newSession,
  reopenApp,
  startMockOllama,
  teardownApps,
  unusedLocalUrl,
} from "./test-support/app-harness.js";

afterEach(teardownApps);

describe("on-device LLM provider", () => {
  const BOT_ID = "llm.ollama.gemma4"; // shared bot identity, default botId

  afterEach(() => {
    delete (globalThis as { __loamOnDeviceChat?: unknown }).__loamOnDeviceChat;
  });

  async function assistantReply(app: LoamApp, cookie: string): Promise<string | undefined> {
    // The bot reply is created + streamed asynchronously after the DM POST returns; poll the thread.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const thread = (
        await app.server.inject({ method: "GET", url: `/api/dms/${BOT_ID}`, headers: { cookie } })
      ).json() as { authorId: string; body?: string }[];
      const reply = thread.find((message) => message.authorId === BOT_ID && (message.body ?? "").length > 0);
      if (reply) {
        return reply.body;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return undefined;
  }

  it("streams a reply from the on-device hook, persists it, and shows the bot when enabled", async () => {
    (globalThis as { __loamOnDeviceChat?: unknown }).__loamOnDeviceChat = (
      _messages: unknown,
      callbacks: { onDelta: (t: string) => void; onEnd: () => void; onError: (m: string) => void },
    ) => {
      callbacks.onDelta("Hello ");
      callbacks.onDelta("from the phone");
      callbacks.onEnd();
    };

    const app = await makeApp({ llm: { onDevice: { enabled: true, model: "gemma-test" } } });
    const user = await newSession(app);

    // The bot DM contact appears once a backend is enabled (here: on-device, with Ollama still off).
    const users = (
      await app.server.inject({ method: "GET", url: "/api/users", headers: { cookie: user.cookie } })
    ).json() as { id: string; type: string }[];
    expect(users.some((entry) => entry.id === BOT_ID && entry.type === "bot")).toBe(true);

    const dm = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: user.cookie },
      payload: { type: "dm", recipientUserId: BOT_ID, body: "hi" },
    });
    expect(dm.statusCode).toBe(201);

    expect(await assistantReply(app, user.cookie)).toBe("Hello from the phone");
  });

  it("degrades to a graceful error when no on-device hook is present (e.g. desktop/CI)", async () => {
    // No globalThis.__loamOnDeviceChat installed — every non-Android host.
    const app = await makeApp({ llm: { onDevice: { enabled: true, model: "gemma-test" } } });
    const user = await newSession(app);

    await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: user.cookie },
      payload: { type: "dm", recipientUserId: BOT_ID, body: "hi" },
    });

    // The member sees one plain sentence; the backend's own words go to the log only.
    const reply = await assistantReply(app, user.cookie);
    expect(reply).toMatch(/could not answer this time/i);
    expect(reply).not.toMatch(/not available|hook|error:/i);
  });

  it("keeps the bot hidden and does not respond when no backend is enabled (default)", async () => {
    const app = await makeApp();
    const user = await newSession(app);

    const users = (
      await app.server.inject({ method: "GET", url: "/api/users", headers: { cookie: user.cookie } })
    ).json() as { id: string }[];
    expect(users.some((entry) => entry.id === BOT_ID)).toBe(false);
  });
});

describe("Ollama LLM streaming", () => {
  const BOT_ID = "llm.ollama.gemma4"; // shared bot identity, default botId

  /** The bot reply is created + streamed asynchronously after the DM POST returns; poll for it to
   * settle (a body present and no longer marked `streaming`), mirroring the on-device helper above. */
  async function settledAssistantReply(
    app: LoamApp,
    cookie: string,
  ): Promise<{ body?: string; streaming?: boolean } | undefined> {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const thread = (
        await app.server.inject({ method: "GET", url: `/api/dms/${BOT_ID}`, headers: { cookie } })
      ).json() as { authorId: string; body?: string; meta?: { streaming?: boolean } }[];
      const reply = thread.find((message) => message.authorId === BOT_ID && (message.body ?? "").length > 0);
      if (reply && reply.meta?.streaming !== true) {
        return { body: reply.body, streaming: reply.meta?.streaming };
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return undefined;
  }

  it("degrades to a graceful assistant error when Ollama is unreachable, without crashing the server", async () => {
    const app = await makeApp({ llm: { ollama: { enabled: true, baseUrl: await unusedLocalUrl() } } });
    const user = await newSession(app);

    const dm = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: user.cookie },
      payload: { type: "dm", recipientUserId: BOT_ID, body: "hi" },
    });
    // The POST itself never fails because of a bad LLM backend — the failure surfaces async, in the
    // assistant's own reply, exactly like an on-device hook failure.
    expect(dm.statusCode).toBe(201);

    const reply = await settledAssistantReply(app, user.cookie);
    expect(reply?.body).toMatch(/could not answer this time/i);
    expect(reply?.body).not.toMatch(/ECONNREFUSED|fetch|127\.0\.0\.1/i);

    // The server itself stayed healthy — an unrelated request right after still succeeds.
    expect((await app.server.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
  });

  it("gates the bot contact and enableLLMChat/enableLLMStreaming on llm.ollama.enabled", async () => {
    const disabledApp = await makeApp();
    const disabledUser = await newSession(disabledApp);

    const disabledConfig = (
      await disabledApp.server.inject({
        method: "GET",
        url: "/api/config",
        headers: { cookie: disabledUser.cookie },
      })
    ).json() as { networkConfig: { enableLLMChat: boolean; enableLLMStreaming: boolean } };
    expect(disabledConfig.networkConfig.enableLLMChat).toBe(false);
    expect(disabledConfig.networkConfig.enableLLMStreaming).toBe(false);

    const disabledUsers = (
      await disabledApp.server.inject({ method: "GET", url: "/api/users", headers: { cookie: disabledUser.cookie } })
    ).json() as { id: string }[];
    expect(disabledUsers.some((entry) => entry.id === BOT_ID)).toBe(false);

    // With no backend enabled the bot doesn't exist at all, so a DM "to" its id is just a DM to a
    // nonexistent recipient — no assistant reply is ever triggered.
    const blindDm = await disabledApp.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: disabledUser.cookie },
      payload: { type: "dm", recipientUserId: BOT_ID, body: "hi" },
    });
    expect(blindDm.statusCode).toBe(400);

    const ollama = startMockOllama(["hi there"]);
    cleanups.push(ollama.close);
    const enabledApp = await makeApp({ llm: { ollama: { enabled: true, baseUrl: await ollama.url } } });
    const enabledUser = await newSession(enabledApp);

    const enabledConfig = (
      await enabledApp.server.inject({ method: "GET", url: "/api/config", headers: { cookie: enabledUser.cookie } })
    ).json() as { networkConfig: { enableLLMChat: boolean; enableLLMStreaming: boolean } };
    expect(enabledConfig.networkConfig.enableLLMChat).toBe(true);
    expect(enabledConfig.networkConfig.enableLLMStreaming).toBe(true);

    const enabledUsers = (
      await enabledApp.server.inject({ method: "GET", url: "/api/users", headers: { cookie: enabledUser.cookie } })
    ).json() as { id: string; type: string }[];
    expect(enabledUsers.some((entry) => entry.id === BOT_ID && entry.type === "bot")).toBe(true);
  });
});

describe("assistant bot identity", () => {
  const BOT_ID = "llm.ollama.gemma4";

  async function seedHumanAdmin(id: string): Promise<{ app: LoamApp; dataDir: string; adminCookie: string }> {
    const made = await makeApp();
    const admin = await newSession(made.app);
    made.app.store.upsertUser({ id, displayName: "Victim", type: "human", isAdmin: true, createdAt: 1, ephemeral: false });
    const app = await reopenApp(made.app, made.dataDir);
    return { app, dataDir: made.dataDir, adminCookie: admin.cookie };
  }

  it("refuses a botId that names an existing person (no hijack / demotion of an admin)", async () => {
    const { app, adminCookie } = await seedHumanAdmin("llm.victim");
    const res = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: adminCookie },
      payload: { llm: { ollama: { enabled: true, botId: "llm.victim" } } },
    });
    expect(res.statusCode).toBe(400);
    const victim = app.store.loadUsers().find((user) => user.id === "llm.victim");
    expect(victim).toMatchObject({ type: "human", isAdmin: true });
    const cfg = (await app.server.inject({ method: "GET", url: "/api/admin/config", headers: { cookie: adminCookie } })).json() as {
      llm: { ollama: { botId: string; enabled: boolean } };
    };
    expect(cfg.llm.ollama).toMatchObject({ botId: BOT_ID, enabled: false });
  });

  it("refuses a person's user.* id as botId at the schema", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const res = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { llm: { ollama: { enabled: true, botId: admin.userId } } },
    });
    expect(res.statusCode).toBe(400);
    expect(app.store.loadUsers().find((user) => user.id === admin.userId)).toMatchObject({ type: "human", isAdmin: true });
  });

  it("boots (skipping the bot) when config.json points botId at an existing person", async () => {
    const { app, dataDir } = await seedHumanAdmin("llm.victim");
    await app.close();
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ llm: { ollama: { enabled: true, botId: "llm.victim" } } }));
    const reopened = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false });
    cleanups.push(() => reopened.close());
    expect(reopened.store.loadUsers().find((user) => user.id === "llm.victim")).toMatchObject({ type: "human", isAdmin: true });
  });

  it("rejects an over-long botDisplayName with a 400 (not a 500) and the node still reboots", async () => {
    const { app, dataDir } = await makeApp();
    const admin = await newSession(app);
    const res = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { llm: { ollama: { enabled: true, botDisplayName: "x".repeat(81) } } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain("too_big");
    const reopened = await reopenApp(app, dataDir);
    expect((await reopened.server.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
  });
});

describe("assistant replies: crashes, moderation and concurrency", () => {
  const BOT_ID = "llm.ollama.gemma4";

  async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  }

  async function post(app: LoamApp, cookie: string, payload: Record<string, unknown>): Promise<InjectResponse> {
    return app.server.inject({ method: "POST", url: "/api/messages", headers: { cookie }, payload });
  }

  it("finalizes an assistant reply left streaming by a crash at the next boot (reapable, deletable)", async () => {
    const { app, dataDir } = await makeApp();
    const admin = await newSession(app);
    const user = await newSession(app);
    app.store.insertMessage({
      id: "llm_0123456789abcdef",
      type: "dm",
      authorId: BOT_ID,
      recipientUserId: user.userId,
      body: "",
      createdAt: Date.now(),
      meta: { source: "llm", model: "gemma4", markdown: true, streaming: true },
    });

    const reopened = await reopenApp(app, dataDir);
    const repaired = reopened.store.loadMessages().find((message) => message.id === "llm_0123456789abcdef") as
      | { body: string; meta?: { streaming?: boolean } }
      | undefined;
    expect(repaired?.meta?.streaming).toBe(false);
    expect(repaired?.body).toContain("interrupted");

    const deleted = await reopened.server.inject({
      method: "DELETE",
      url: "/api/messages/llm_0123456789abcdef",
      headers: { cookie: admin.cookie },
    });
    expect(deleted.statusCode).toBe(200);
  });

  it("a moderator can remove an assistant reply mid-stream; the writer never restores its body", async () => {
    const ollama = startMockOllama(["alpha", " beta", " gamma", " delta", " epsilon"], { delayMs: 80 });
    cleanups.push(ollama.close);
    const app = await makeApp({ llm: { ollama: { enabled: true, baseUrl: await ollama.url } } });
    const admin = await newSession(app);
    const user = await newSession(app);
    expect((await post(app, user.cookie, { type: "dm", recipientUserId: BOT_ID, body: "hi" })).statusCode).toBe(201);

    const reply = () =>
      app.store.loadMessages().find((message) => message.authorId === BOT_ID) as
        | { id: string; body: string; meta?: { streaming?: boolean; removedByModerator?: boolean } }
        | undefined;
    const liveBody = async () => {
      const dms = (await app.server.inject({ method: "GET", url: `/api/dms/${BOT_ID}`, headers: { cookie: user.cookie } })).json() as {
        authorId: string;
        body: string;
      }[];
      return dms.find((message) => message.authorId === BOT_ID)?.body ?? "";
    };
    expect(await waitUntil(async () => (await liveBody()).length > 0)).toBe(true);

    const removed = await app.server.inject({
      method: "POST",
      url: `/api/moderation/messages/${reply()?.id}/remove`,
      headers: { cookie: admin.cookie },
      payload: { reason: "test" },
    });
    expect(removed.statusCode).toBe(200);

    // Let the mock finish streaming everything it had queued.
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(reply()).toMatchObject({ body: "", meta: { removedByModerator: true, streaming: false } });
    expect(await liveBody()).toBe("");
  });

  it("bounds assistant replies: one in flight per user and two node-wide (429 assistant_busy)", async () => {
    const ollama = startMockOllama(["one", " two", " three", " four"], { delayMs: 120 });
    cleanups.push(ollama.close);
    const app = await makeApp({ llm: { ollama: { enabled: true, baseUrl: await ollama.url } } });
    const u1 = await newSession(app);
    const u2 = await newSession(app);
    const u3 = await newSession(app);
    const dm = (cookie: string) => post(app, cookie, { type: "dm", recipientUserId: BOT_ID, body: "hi" });

    expect((await dm(u1.cookie)).statusCode).toBe(201);
    const again = await dm(u1.cookie);
    expect(again.statusCode).toBe(429);
    expect(again.json()).toMatchObject({ code: "assistant_busy" });
    expect((await dm(u2.cookie)).statusCode).toBe(201);
    const third = await dm(u3.cookie);
    expect(third.statusCode).toBe(429);
    // A refused request created nothing.
    expect(app.store.loadMessages().filter((message) => message.authorId === u3.userId)).toHaveLength(0);

    const finished = () =>
      app.store
        .loadMessages()
        .filter((message) => message.authorId === BOT_ID)
        .every((message) => message.meta?.streaming === false);
    expect(await waitUntil(finished)).toBe(true);
    expect((await dm(u1.cookie)).statusCode).toBe(201);
    expect(await waitUntil(finished)).toBe(true);
  });
});

describe("launcher-owned llm.onDevice", () => {
  it("an admin save no longer freezes the launcher's later model activate/deactivate", async () => {
    const onDevice = { enabled: true, model: "gemma-test", modelPath: "/data/model.gguf" };
    const { app, dataDir } = await makeApp({ llm: { onDevice } });
    const admin = await newSession(app);
    // Any admin save persists the full effective config (llm.onDevice included) into the DB layer.
    const saved = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { features: { enableReactions: false } },
    });
    expect(saved.statusCode).toBe(200);

    // The launcher's model manager then deactivates the model in config.json (main.js).
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ llm: { onDevice: { ...onDevice, enabled: false } } }));
    const reopened = await reopenApp(app, dataDir);
    const cfg = (await reopened.server.inject({ method: "GET", url: "/api/admin/config", headers: { cookie: admin.cookie } })).json() as {
      llm: { onDevice: { enabled: boolean } };
      features: { enableReactions: boolean };
    };
    expect(cfg.llm.onDevice.enabled).toBe(false);
    // ...while the admin's own edit still survives the restart.
    expect(cfg.features.enableReactions).toBe(false);
  });

  it("keeps an admin's llm.onDevice edit where config.json never mentions it (desktop/Pi)", async () => {
    const { app, dataDir } = await makeApp();
    const admin = await newSession(app);
    const saved = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: admin.cookie },
      payload: { llm: { onDevice: { enabled: true, model: "gemma-admin" } } },
    });
    expect(saved.statusCode).toBe(200);
    const reopened = await reopenApp(app, dataDir);
    const cfg = (await reopened.server.inject({ method: "GET", url: "/api/admin/config", headers: { cookie: admin.cookie } })).json() as {
      llm: { onDevice: { enabled: boolean; model?: string } };
    };
    expect(cfg.llm.onDevice).toMatchObject({ enabled: true, model: "gemma-admin" });
  });
});
