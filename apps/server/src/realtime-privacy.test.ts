import { afterEach, describe, expect, it } from "vitest";

import type { LoamApp } from "./app.js";
import {
  cleanups,
  type InjectResponse,
  makeApp,
  newSession,
  startMockOllama,
  teardownApps,
} from "./test-support/app-harness.js";

afterEach(teardownApps);

describe("websocket privacy filtering", () => {
  type WireEvent = {
    type?: string;
    messageId?: string;
    text?: string;
    error?: string;
    user?: { id?: string; pending?: boolean };
    message?: { id?: string; authorId?: string; body?: string; meta?: { streaming?: boolean } };
  };

  const openSockets: WebSocket[] = [];

  afterEach(() => {
    for (const socket of openSockets) {
      socket.close();
    }
    openSockets.length = 0;
  });

  async function listen(app: LoamApp): Promise<string> {
    return app.server.listen({ port: 0, host: "127.0.0.1" });
  }

  function connect(baseUrl: string, cookie: string): Promise<{ socket: WebSocket; events: WireEvent[]; closed: Promise<void> }> {
    return new Promise((resolve, reject) => {
      // Undici's WebSocket accepts an options bag with headers (needed to send the session cookie).
      const socket = new (WebSocket as unknown as new (url: string, opts: unknown) => WebSocket)(
        `${baseUrl.replace("http", "ws")}/ws`,
        { headers: { cookie } },
      );
      const events: WireEvent[] = [];
      const closed = new Promise<void>((resolveClose) => {
        socket.addEventListener("close", () => resolveClose());
      });
      socket.addEventListener("message", (event) => {
        events.push(JSON.parse(String((event as MessageEvent).data)) as WireEvent);
      });
      socket.addEventListener("open", () => {
        openSockets.push(socket);
        resolve({ socket, events, closed });
      });
      socket.addEventListener("error", () => reject(new Error("websocket failed to connect")));
    });
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

  /**
   * Bounded wait for an expected event, so positive assertions don't race CI scheduling the way a
   * fixed sleep can. Negative assertions ("never delivered") still use `settle` — or first await
   * the *other* party's copy of the same broadcast, which proves delivery completed.
   */
  async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (check()) {
        return true;
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    return check();
  }

  it("withholds a shadow-banned author's deleted message body from everyone else", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const target = await newSession(app);
    const viewer = await newSession(app);
    const baseUrl = await listen(app);

    const posted = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: target.cookie },
      payload: { type: "channelPost", channelId: "general", body: "the hidden text" },
    });
    const messageId = (posted.json() as { message: { id: string } }).message.id;

    await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${target.userId}`,
      headers: { cookie: admin.cookie },
      payload: { shadowBanned: true },
    });

    const viewerSocket = await connect(baseUrl, viewer.cookie);
    const targetSocket = await connect(baseUrl, target.cookie);

    const deleted = await app.server.inject({
      method: "DELETE",
      url: `/api/messages/${messageId}`,
      headers: { cookie: admin.cookie },
    });
    expect(deleted.statusCode).toBe(200);

    // The delete event carries the full body — it must stay between the author and nobody else.
    // The author receiving their copy proves the broadcast completed, making the viewer's silence
    // a real verdict rather than a timing artifact.
    expect(
      await waitFor(() =>
        targetSocket.events.some((event) => event.type === "messageDeleted" && event.messageId === messageId),
      ),
    ).toBe(true);
    expect(viewerSocket.events.some((event) => event.type === "messageDeleted")).toBe(false);
  });

  it("rejects a banned user's websocket reconnect", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const target = await newSession(app);
    const baseUrl = await listen(app);

    await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${target.userId}`,
      headers: { cookie: admin.cookie },
      payload: { banned: true },
    });

    const reconnect = await connect(baseUrl, target.cookie);
    await reconnect.closed;
    expect(reconnect.events.some((event) => event.type === "error")).toBe(true);

    // A healthy user still connects and stays connected.
    const healthy = await connect(baseUrl, admin.cookie);
    await settle();
    expect(healthy.socket.readyState).toBe(WebSocket.OPEN);
  });

  it("limits a pending user's feed to node notices and their own approval", async () => {
    const app = await makeApp({ access: { joinPolicy: "approval" } });
    const admin = await newSession(app);
    const joiner = await newSession(app);
    const baseUrl = await listen(app);

    const joinerSocket = await connect(baseUrl, joiner.cookie);

    await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: admin.cookie },
      payload: { type: "channelPost", channelId: "general", body: "members only chatter" },
    });
    await settle();
    expect(joinerSocket.events.some((event) => event.type === "messageCreated")).toBe(false);

    await app.server.inject({
      method: "POST",
      url: `/api/access/users/${joiner.userId}/approve`,
      headers: { cookie: admin.cookie },
    });
    expect(
      await waitFor(() =>
        joinerSocket.events.some(
          (event) => event.type === "userUpserted" && event.user?.id === joiner.userId && event.user?.pending !== true,
        ),
      ),
    ).toBe(true);
  });

  it("announces hidden identities only to themselves and to moderators", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const bystander = await newSession(app);
    const target = await newSession(app);
    const baseUrl = await listen(app);

    const adminSocket = await connect(baseUrl, admin.cookie);
    const bystanderSocket = await connect(baseUrl, bystander.cookie);

    await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${target.userId}`,
      headers: { cookie: admin.cookie },
      payload: { banned: true },
    });

    const sawBanned = (events: WireEvent[]) =>
      events.some((event) => event.type === "userUpserted" && event.user?.id === target.userId);
    // The moderator receiving their copy proves the broadcast completed before the negative check.
    expect(await waitFor(() => sawBanned(adminSocket.events))).toBe(true);
    expect(sawBanned(bystanderSocket.events)).toBe(false);
  });

  it("streams Ollama deltas to the DM and converges to a single final messageUpdated", async () => {
    const ollama = startMockOllama(["Hello", " from", " Ollama"]);
    cleanups.push(ollama.close);
    const app = await makeApp({ llm: { ollama: { enabled: true, baseUrl: await ollama.url } } });
    const user = await newSession(app);
    const baseUrl = await listen(app);
    const userSocket = await connect(baseUrl, user.cookie);
    const BOT_ID = "llm.ollama.gemma4"; // default botId (unchanged by the config override above)

    const dm = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: user.cookie },
      payload: { type: "dm", recipientUserId: BOT_ID, body: "hi" },
    });
    expect(dm.statusCode).toBe(201);

    expect(await waitFor(() => userSocket.events.some((event) => event.type === "end"))).toBe(true);

    // Genuinely streamed (more than one delta event), and the deltas concatenate to the full reply.
    const deltas = userSocket.events.filter((event) => event.type === "delta");
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((event) => event.text).join("")).toBe("Hello from Ollama");

    // Exactly one persisted messageUpdated for the assistant message — clients converge on a single
    // final body instead of one broadcast per delta.
    const updates = userSocket.events.filter(
      (event) => event.type === "messageUpdated" && event.message?.authorId === BOT_ID,
    );
    expect(updates.length).toBe(1);
    expect(updates[0]?.message?.body).toBe("Hello from Ollama");
    expect(updates[0]?.message?.meta?.streaming).toBe(false);

    // The DM history was actually forwarded to Ollama.
    expect(ollama.requests[0]?.messages?.at(-1)).toEqual({ role: "user", content: "hi" });
  });

  it("never delivers Ollama stream deltas (or the bot DM) to a bystander outside the DM", async () => {
    const ollama = startMockOllama(["secret", " reply"]);
    cleanups.push(ollama.close);
    const app = await makeApp({ llm: { ollama: { enabled: true, baseUrl: await ollama.url } } });
    const user = await newSession(app);
    const bystander = await newSession(app);
    const baseUrl = await listen(app);
    const userSocket = await connect(baseUrl, user.cookie);
    const bystanderSocket = await connect(baseUrl, bystander.cookie);
    const BOT_ID = "llm.ollama.gemma4";

    await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: user.cookie },
      payload: { type: "dm", recipientUserId: BOT_ID, body: "hi" },
    });

    // The DM participant seeing the stream complete proves the round finished, making the
    // bystander's silence below a real verdict rather than a timing artifact.
    expect(await waitFor(() => userSocket.events.some((event) => event.type === "end"))).toBe(true);

    expect(bystanderSocket.events.some((event) => event.type === "start")).toBe(false);
    expect(bystanderSocket.events.some((event) => event.type === "delta")).toBe(false);
    expect(bystanderSocket.events.some((event) => event.type === "end")).toBe(false);
    expect(
      bystanderSocket.events.some(
        (event) =>
          (event.type === "messageCreated" || event.type === "messageUpdated") && event.message?.authorId === BOT_ID,
      ),
    ).toBe(false);
  });
});

describe("websocket frame cap and typing audience", () => {
  type WireEvent = { type?: string; userId?: string; channelId?: string };
  const openSockets: WebSocket[] = [];

  afterEach(() => {
    for (const socket of openSockets) {
      socket.close();
    }
    openSockets.length = 0;
  });

  /** A plaintext cookie socket (transport `optional`, no `?enc=`) — admitted directly, no challenge. */
  function connect(
    baseUrl: string,
    cookie: string,
  ): Promise<{ socket: WebSocket; events: WireEvent[]; closed: Promise<number> }> {
    return new Promise((resolve, reject) => {
      const socket = new (WebSocket as unknown as new (url: string, opts: unknown) => WebSocket)(
        `${baseUrl.replace("http", "ws")}/ws`,
        { headers: { cookie } },
      );
      const events: WireEvent[] = [];
      const closed = new Promise<number>((resolveClose) => {
        socket.addEventListener("close", (event) => resolveClose((event as CloseEvent).code));
      });
      socket.addEventListener("message", (event) => {
        events.push(JSON.parse(String((event as MessageEvent).data)) as WireEvent);
      });
      socket.addEventListener("open", () => {
        openSockets.push(socket);
        resolve({ socket, events, closed });
      });
      socket.addEventListener("error", () => reject(new Error("websocket failed to connect")));
    });
  }

  async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (check()) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return check();
  }

  const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

  function patchChannel(app: LoamApp, cookie: string, channelId: string, payload: Record<string, unknown>): Promise<InjectResponse> {
    return app.server.inject({ method: "PATCH", url: `/api/channels/${channelId}`, headers: { cookie }, payload });
  }

  it("closes a WebSocket that sends a frame over the 16 KiB inbound cap (1009) and keeps a small one open", async () => {
    const app = await makeApp();
    const user = await newSession(app);
    const baseUrl = await app.server.listen({ port: 0, host: "127.0.0.1" });

    const small = await connect(baseUrl, user.cookie);
    small.socket.send("x".repeat(1024));
    await settle();
    expect(small.socket.readyState).toBe(WebSocket.OPEN);

    const big = await connect(baseUrl, user.cookie);
    big.socket.send("x".repeat(32 * 1024));
    expect(await big.closed).toBe(1009);
  });

  it("does not broadcast a typing signal from a member the channel's posting policy excludes", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const member = await newSession(app);
    const viewer = await newSession(app);
    expect((await patchChannel(app, admin.cookie, "announcements", { allowPosting: "admins" })).statusCode).toBe(200);
    const baseUrl = await app.server.listen({ port: 0, host: "127.0.0.1" });
    const { events } = await connect(baseUrl, viewer.cookie);

    const typing = (cookie: string) =>
      app.server.inject({ method: "POST", url: "/api/typing", headers: { cookie }, payload: { channelId: "announcements" } });
    expect((await typing(member.cookie)).statusCode).toBe(204); // silent no-op, never leaks
    expect((await typing(admin.cookie)).statusCode).toBe(204); // control: an allowed poster does broadcast

    expect(await waitFor(() => events.some((event) => event.type === "typing" && event.userId === admin.userId))).toBe(true);
    expect(events.some((event) => event.type === "typing" && event.userId === member.userId)).toBe(false);
  });
});
