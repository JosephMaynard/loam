import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApp, type LoamApp } from "./app.js";

// The Ollama/LLM streaming path (docs/15 #15). These tests exercise `createAssistantResponse` end
// to end: a user DMs the configured bot, the server streams Ollama's `/api/chat` reply out as
// StreamEvent deltas over the WebSocket, and converges to a single persisted `messageUpdated`. They
// mock Ollama with a tiny local `node:http` server (pointed at via `llm.ollama.baseUrl`) so nothing
// real is contacted, and drive a genuine WebSocket to observe the privacy-scoped stream events.
// This file is intentionally standalone (its own helpers) so it never collides with app.test.ts.

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

/** The default bot id from `defaultLoamConfig()` — unchanged by the `enabled`/`baseUrl` overrides. */
const BOT_ID = "llm.ollama.gemma4";

/**
 * Boot an app on a throwaway data dir with an optional config overlay. A high identity cap keeps the
 * per-IP new-identity limiter (every inject shares 127.0.0.1) from tripping across a suite.
 */
async function makeApp(config?: unknown): Promise<LoamApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "loam-llm-test-"));
  if (config !== undefined) {
    writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  }
  const app = await buildApp({ dataDir, logger: false, maxNewIdentitiesPerWindow: 1_000_000 });
  cleanups.push(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return app;
}

/** Boot an app with an Ollama config overlay (merged onto the default `llm.ollama` block). */
async function makeLlmApp(ollama: Record<string, unknown>): Promise<LoamApp> {
  return makeApp({ llm: { ollama } });
}

function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const first = Array.isArray(header) ? (header[0] as string) : (header as string | undefined);
  const cookie = first?.split(";")[0];
  if (!cookie?.startsWith("loam_session=")) {
    throw new Error("No session cookie in response");
  }
  return cookie;
}

async function newSession(app: LoamApp): Promise<{ cookie: string; userId: string }> {
  const response = await app.server.inject({ method: "GET", url: "/api/config" });
  const body = response.json() as { currentUser: { id: string } };
  return { cookie: sessionCookie(response), userId: body.currentUser.id };
}

type OllamaChatRequestBody = { model?: string; stream?: boolean; messages?: { role: string; content: string }[] };

/**
 * Minimal mock of Ollama's streaming `/api/chat`. In the default (200) mode it emits the same
 * newline-delimited JSON `streamOllamaChat` parses — one `{"message":{"content":...},"done":false}`
 * line per delta (with a real inter-delta delay so a test can tell genuine streaming from one lump),
 * then a final `{"done":true}`. With `opts.status` set to a non-200 it replies with that status and
 * no stream, exercising the `!response.ok` error arm. Captures every request body for assertions.
 */
function startMockOllama(
  deltas: string[],
  opts: { delayMs?: number; status?: number } = {},
): { url: Promise<string>; close: () => Promise<void>; requests: OllamaChatRequestBody[] } {
  const delayMs = opts.delayMs ?? 10;
  const requests: OllamaChatRequestBody[] = [];

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk));
    req.on("end", () => {
      void (async () => {
        try {
          requests.push(JSON.parse(raw || "{}") as OllamaChatRequestBody);
        } catch {
          // Irrelevant to the behaviour under test.
        }

        if (opts.status && opts.status !== 200) {
          res.writeHead(opts.status, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "model not found" }));
          return;
        }

        res.writeHead(200, { "content-type": "application/x-ndjson" });
        for (const delta of deltas) {
          res.write(`${JSON.stringify({ message: { role: "assistant", content: delta }, done: false })}\n`);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        res.end(`${JSON.stringify({ done: true })}\n`);
      })();
    });
  });

  const url = new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });

  return { url, close: () => new Promise<void>((resolve) => server.close(() => resolve())), requests };
}

/** A `http://127.0.0.1:<port>` URL nothing is listening on, to simulate Ollama being unreachable. */
async function unusedLocalUrl(): Promise<string> {
  const probe = createServer();
  const url = await new Promise<string>((resolve) => {
    probe.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(probe.address() as AddressInfo).port}`));
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return url;
}

type WireEvent = {
  type?: string;
  messageId?: string;
  text?: string;
  error?: string;
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

/** Open a real WebSocket carrying the session cookie and collect every event it receives. */
function connect(baseUrl: string, cookie: string): Promise<{ socket: WebSocket; events: WireEvent[] }> {
  return new Promise((resolve, reject) => {
    // Undici's WebSocket accepts an options bag with headers (needed to send the session cookie).
    const socket = new (WebSocket as unknown as new (url: string, opts: unknown) => WebSocket)(
      `${baseUrl.replace("http", "ws")}/ws`,
      { headers: { cookie } },
    );
    const events: WireEvent[] = [];
    socket.addEventListener("message", (event) => {
      events.push(JSON.parse(String((event as MessageEvent).data)) as WireEvent);
    });
    socket.addEventListener("open", () => {
      openSockets.push(socket);
      resolve({ socket, events });
    });
    socket.addEventListener("error", () => reject(new Error("websocket failed to connect")));
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

/** Bounded wait so positive assertions don't race CI scheduling the way a fixed sleep can. */
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

/** POST a DM to the configured bot as the given session. */
function dmBot(app: LoamApp, cookie: string, body: string) {
  return app.server.inject({
    method: "POST",
    url: "/api/messages",
    headers: { cookie },
    payload: { type: "dm", recipientUserId: BOT_ID, body },
  });
}

describe("LLM streaming — convergence (docs/15 #15)", () => {
  it("streams deltas then converges to exactly one final messageUpdated with streaming:false", async () => {
    const ollama = startMockOllama(["Hello", " from", " Ollama"]);
    cleanups.push(ollama.close);
    const app = await makeLlmApp({ enabled: true, baseUrl: await ollama.url });
    const user = await newSession(app);
    const baseUrl = await listen(app);
    const userSocket = await connect(baseUrl, user.cookie);

    const dm = await dmBot(app, user.cookie, "hi");
    expect(dm.statusCode).toBe(201);

    expect(await waitFor(() => userSocket.events.some((event) => event.type === "end"))).toBe(true);

    // Genuinely streamed (more than one delta) and the deltas concatenate to the full reply.
    const deltas = userSocket.events.filter((event) => event.type === "delta");
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((event) => event.text).join("")).toBe("Hello from Ollama");

    // Convergence: exactly one persisted messageUpdated for the assistant message, carrying the final
    // body with streaming cleared — so non-streaming clients that ignore deltas still converge.
    const updates = userSocket.events.filter(
      (event) => event.type === "messageUpdated" && event.message?.authorId === BOT_ID,
    );
    expect(updates.length).toBe(1);
    expect(updates[0]?.message?.body).toBe("Hello from Ollama");
    expect(updates[0]?.message?.meta?.streaming).toBe(false);

    // The placeholder was created streaming, and the DM history was actually forwarded to Ollama.
    const created = userSocket.events.find(
      (event) => event.type === "messageCreated" && event.message?.authorId === BOT_ID,
    );
    expect(created?.message?.meta?.streaming).toBe(true);
    expect(ollama.requests[0]?.messages?.at(-1)).toEqual({ role: "user", content: "hi" });

    // The persisted message matches the converged broadcast (single source of truth).
    const history = (
      await app.server.inject({ method: "GET", url: `/api/dms/${BOT_ID}`, headers: { cookie: user.cookie } })
    ).json() as { authorId: string; body: string; meta?: { streaming?: boolean } }[];
    const persisted = history.find((message) => message.authorId === BOT_ID);
    expect(persisted?.body).toBe("Hello from Ollama");
    expect(persisted?.meta?.streaming).toBe(false);
  });
});

describe("LLM streaming — delta privacy (docs/15 #15)", () => {
  it("delivers stream events (and the bot DM) only to the DM participant, never a bystander", async () => {
    const ollama = startMockOllama(["secret", " reply"]);
    cleanups.push(ollama.close);
    const app = await makeLlmApp({ enabled: true, baseUrl: await ollama.url });
    const user = await newSession(app);
    const bystander = await newSession(app);
    const baseUrl = await listen(app);
    const userSocket = await connect(baseUrl, user.cookie);
    const bystanderSocket = await connect(baseUrl, bystander.cookie);

    await dmBot(app, user.cookie, "hi");

    // The DM participant seeing the whole stream (start → deltas → end) proves the round completed,
    // making the bystander's silence below a real verdict rather than a timing artifact.
    expect(await waitFor(() => userSocket.events.some((event) => event.type === "end"))).toBe(true);
    expect(userSocket.events.some((event) => event.type === "start")).toBe(true);
    expect(userSocket.events.filter((event) => event.type === "delta").length).toBeGreaterThan(0);

    // The bystander is outside the DM: it must see none of the stream lifecycle...
    expect(bystanderSocket.events.some((event) => event.type === "start")).toBe(false);
    expect(bystanderSocket.events.some((event) => event.type === "delta")).toBe(false);
    expect(bystanderSocket.events.some((event) => event.type === "end")).toBe(false);
    // ...nor the DM message itself (its creation or its converged update).
    expect(
      bystanderSocket.events.some(
        (event) =>
          (event.type === "messageCreated" || event.type === "messageUpdated") && event.message?.authorId === BOT_ID,
      ),
    ).toBe(false);
    // ...and the secret body never leaked in any event.
    expect(bystanderSocket.events.some((event) => JSON.stringify(event).includes("secret"))).toBe(false);
  });
});

describe("LLM streaming — Ollama-unreachable handling (docs/15 #15)", () => {
  it("emits a StreamEvent error and unsticks the message when Ollama is down (connection refused)", async () => {
    const app = await makeLlmApp({ enabled: true, baseUrl: await unusedLocalUrl() });
    const user = await newSession(app);
    const baseUrl = await listen(app);
    const userSocket = await connect(baseUrl, user.cookie);

    const dm = await dmBot(app, user.cookie, "hi");
    expect(dm.statusCode).toBe(201);

    // An error stream event is delivered to the participant instead of an `end`.
    expect(await waitFor(() => userSocket.events.some((event) => event.type === "error"))).toBe(true);
    expect(userSocket.events.some((event) => event.type === "end")).toBe(false);

    // The placeholder message is not left permanently streaming: it converges via messageUpdated with
    // streaming:false and a surfaced error note, so a reconnecting client is never stuck on a spinner.
    const update = await waitFor(() =>
      userSocket.events.some(
        (event) =>
          event.type === "messageUpdated" &&
          event.message?.authorId === BOT_ID &&
          event.message?.meta?.streaming === false,
      ),
    );
    expect(update).toBe(true);
    const finalUpdate = userSocket.events.find(
      (event) => event.type === "messageUpdated" && event.message?.authorId === BOT_ID,
    );
    expect(finalUpdate?.message?.body).toContain("LLM error");

    // Graceful degradation: the node did not crash — it still serves requests afterwards.
    const health = await app.server.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
  });

  it("emits a StreamEvent error when Ollama replies with a non-OK HTTP status", async () => {
    const ollama = startMockOllama([], { status: 500 });
    cleanups.push(ollama.close);
    const app = await makeLlmApp({ enabled: true, baseUrl: await ollama.url });
    const user = await newSession(app);
    const baseUrl = await listen(app);
    const userSocket = await connect(baseUrl, user.cookie);

    await dmBot(app, user.cookie, "hi");

    const errorEvent = await waitFor(() => userSocket.events.some((event) => event.type === "error"));
    expect(errorEvent).toBe(true);
    expect(userSocket.events.some((event) => event.type === "end")).toBe(false);

    // The message still converges to a non-streaming state (no orphaned spinner) and reports the failure.
    const finalUpdate = await waitFor(() =>
      userSocket.events.some(
        (event) =>
          event.type === "messageUpdated" &&
          event.message?.authorId === BOT_ID &&
          event.message?.meta?.streaming === false,
      ),
    );
    expect(finalUpdate).toBe(true);
    const update = userSocket.events.find(
      (event) => event.type === "messageUpdated" && event.message?.authorId === BOT_ID,
    );
    expect(update?.message?.body).toContain("500");
  });
});

describe("LLM streaming — feature-flag gating (docs/15 #15)", () => {
  it("does not stream, expose the bot, or advertise LLM when the backend is disabled (default)", async () => {
    // Default config: llm.ollama.enabled = false and llm.onDevice.enabled = false.
    const app = await makeApp();
    const user = await newSession(app);
    const baseUrl = await listen(app);
    const userSocket = await connect(baseUrl, user.cookie);

    // The derived network flags are off, so the client never offers LLM chat/streaming.
    const config = (
      await app.server.inject({ method: "GET", url: "/api/config" })
    ).json() as { networkConfig: { enableLLMChat: boolean; enableLLMStreaming: boolean } };
    expect(config.networkConfig.enableLLMChat).toBe(false);
    expect(config.networkConfig.enableLLMStreaming).toBe(false);

    // The bot user is never seeded, so it is not even a DM contact.
    const users = (
      await app.server.inject({ method: "GET", url: "/api/users", headers: { cookie: user.cookie } })
    ).json() as { id: string }[];
    expect(users.some((candidate) => candidate.id === BOT_ID)).toBe(false);

    // DMing the (absent) bot is rejected outright — no message, and nothing to stream.
    const dm = await dmBot(app, user.cookie, "hi");
    expect(dm.statusCode).toBe(400);
    expect((dm.json() as { code?: string }).code).toBe("recipient_not_found");

    // Give any (non-existent) async assistant flow ample time; the socket must stay stream-free.
    await settle();
    expect(userSocket.events.some((event) => event.type === "start")).toBe(false);
    expect(userSocket.events.some((event) => event.type === "delta")).toBe(false);
    expect(userSocket.events.some((event) => event.type === "end")).toBe(false);
  });
});

describe("LLM context bounding (docs/25 P2)", () => {
  it("caps the DM history sent to the model at the most-recent turns, not the whole conversation", async () => {
    const ollama = startMockOllama(["ok"], { delayMs: 0 });
    cleanups.push(ollama.close);
    const app = await makeLlmApp({ enabled: true, baseUrl: await ollama.url });
    const user = await newSession(app);
    const baseUrl = await listen(app);
    const socket = await connect(baseUrl, user.cookie);

    // Drive 25 exchanges (each adds a user + a bot message) so the history grows to ~49 — well past the
    // 40-message cap. Wait for each turn's `end` (by count) before the next so the history is well-formed.
    const turns = 25;
    for (let i = 0; i < turns; i += 1) {
      expect((await dmBot(app, user.cookie, `q${i}`)).statusCode).toBe(201);
      expect(await waitFor(() => socket.events.filter((event) => event.type === "end").length >= i + 1)).toBe(true);
    }

    // No request ever carried more than the cap (+1 for an optional system prompt). Uncapped, the final
    // turns would have sent ~49 messages — so a max of 40/41 proves the bound actually engaged (not a
    // vacuous pass): >= 40 means the history exceeded the cap, <= 41 means it was held there.
    const sizes = ollama.requests.map((request) => request.messages?.length ?? 0);
    expect(ollama.requests.length).toBe(turns);
    expect(Math.max(...sizes)).toBeGreaterThanOrEqual(40);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(41);
  }, 20_000);
});
