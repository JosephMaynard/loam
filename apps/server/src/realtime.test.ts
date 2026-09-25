import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { openTransport, sealTransport, transportClientDerive, transportClientHello } from "@loam/crypto";
import { TransportHandshakeResponseSchema } from "@loam/schema";

import { buildApp, type LoamApp } from "./app.js";
import { WS_HEARTBEAT_INTERVAL_MS } from "./realtime.js";

// WebSocket heartbeat (pre-release review 2026-09-25): every ADMITTED socket gets a content-free
// `{ type: "ping" }` immediately and then every WS_HEARTBEAT_INTERVAL_MS — sealed + sequenced on an
// encrypted socket, never before its key confirmation — so the client's watchdog can detect a dead
// connection. Only setInterval is faked; sockets, timeouts and I/O stay real.

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  vi.useRealTimers();
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

async function makeApp(config?: unknown): Promise<LoamApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "loam-realtime-test-"));
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

type RawWebSocket = {
  addEventListener: (event: string, listener: (event: unknown) => void) => void;
  send: (data: string) => void;
  close: () => void;
};

function openWs(url: string, cookie?: string): RawWebSocket {
  const socket = new (WebSocket as unknown as new (url: string, opts?: unknown) => RawWebSocket)(
    url,
    cookie ? { headers: { cookie } } : undefined,
  );
  cleanups.push(() => socket.close());
  return socket;
}

async function opened(socket: RawWebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("ws failed to connect")));
  });
}

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(check()).toBe(true);
}

const isPing = (payload: string): boolean => (JSON.parse(payload) as { type?: unknown }).type === "ping";

describe("WebSocket heartbeat", () => {
  it("a plaintext socket gets a ping on admission and then every interval", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const config = await app.server.inject({ method: "GET", url: "/api/config" });
    const cookie = String(config.headers["set-cookie"]).split(";")[0]!;
    const baseUrl = await app.server.listen({ port: 0, host: "127.0.0.1" });

    const frames: string[] = [];
    const socket = openWs(`${baseUrl.replace("http", "ws")}/ws`, cookie);
    socket.addEventListener("message", (event) => frames.push(String((event as MessageEvent).data)));
    await opened(socket);

    await waitFor(() => frames.filter(isPing).length === 1); // the admission beat
    expect(frames.filter(isPing)).toEqual(['{"type":"ping"}']); // content-free

    vi.advanceTimersByTime(WS_HEARTBEAT_INTERVAL_MS);
    await waitFor(() => frames.filter(isPing).length === 2);
    vi.advanceTimersByTime(WS_HEARTBEAT_INTERVAL_MS);
    await waitFor(() => frames.filter(isPing).length === 3);
  });

  it("an encrypted socket gets NO ping before key confirmation, then sealed, sequenced pings", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });
    const baseUrl = await app.server.listen({ port: 0, host: "127.0.0.1" });

    // Handshake + bind an identity (docs/20) so the socket is admissible under `required`.
    const hello = transportClientHello();
    const handshake = TransportHandshakeResponseSchema.parse(
      (await app.server.inject({ method: "POST", url: "/api/transport/handshake", payload: { clientEphemeralPublic: hello.ephemeralPublic } })).json(),
    );
    const key = transportClientDerive({
      clientEphemeralSecret: hello.ephemeralSecret,
      hostPublic: handshake.hostPublicKey,
      hostEphemeralPublic: handshake.hostEphemeralPublic,
    });
    const resume = await app.server.inject({
      method: "POST",
      url: "/api/session/resume",
      headers: { "x-loam-enc": handshake.sessionId, "content-type": "application/json" },
      payload: { enc: sealTransport(key, JSON.stringify({ s: 1, b: {} }), "POST /api/session/resume") },
    });
    expect(resume.statusCode).toBe(200);

    const raw: string[] = [];
    const payloads: { q: number; f: string }[] = [];
    let connectionId = "";
    let challenge: { connectionId: string; nonce: string } | undefined;
    const socket = openWs(`${baseUrl.replace("http", "ws")}/ws?enc=${handshake.sessionId}`);
    socket.addEventListener("message", (event) => {
      const text = String((event as MessageEvent).data);
      raw.push(text);
      if (!connectionId) {
        const opened = openTransport(key, text, "loam.ws.challenge.v1");
        if (opened) {
          challenge = JSON.parse(opened) as { connectionId: string; nonce: string };
        }
        return;
      }
      const frame = openTransport(key, text, `loam.ws.frame.v1 ${connectionId}`);
      if (frame) {
        payloads.push(JSON.parse(frame) as { q: number; f: string });
      }
    });
    await opened(socket);
    await waitFor(() => challenge !== undefined);

    // Unconfirmed: a whole interval passes and nothing but the challenge arrives.
    vi.advanceTimersByTime(WS_HEARTBEAT_INTERVAL_MS);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(raw).toHaveLength(1);

    connectionId = challenge!.connectionId;
    socket.send(
      sealTransport(key, JSON.stringify({ type: "proof", connectionId, nonce: challenge!.nonce }), "loam.ws.proof.v1"),
    );
    await waitFor(() => payloads.some((entry) => isPing(entry.f)));
    vi.advanceTimersByTime(WS_HEARTBEAT_INTERVAL_MS);
    await waitFor(() => payloads.filter((entry) => isPing(entry.f)).length === 2);

    // Never plaintext on the wire, and sequenced like every other frame.
    expect(raw.some((text) => text.includes("ping"))).toBe(false);
    // Strictly increasing: a repeated sequence number is exactly what a replayed frame would look like.
    const seqs = payloads.map((entry) => entry.q);
    expect(seqs.length).toBeGreaterThanOrEqual(2);
    for (let index = 1; index < seqs.length; index += 1) {
      expect(seqs[index]).toBeGreaterThan(seqs[index - 1]!);
    }
  });

  it("stops beating once the socket closes", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const config = await app.server.inject({ method: "GET", url: "/api/config" });
    const cookie = String(config.headers["set-cookie"]).split(";")[0]!;
    const baseUrl = await app.server.listen({ port: 0, host: "127.0.0.1" });
    const intervalsBefore = vi.getTimerCount(); // the app's own intervals (reapers etc.)

    let pings = 0;
    const socket = openWs(`${baseUrl.replace("http", "ws")}/ws`, cookie);
    socket.addEventListener("message", (event) => {
      if (isPing(String((event as MessageEvent).data))) {
        pings += 1;
      }
    });
    await opened(socket);
    await waitFor(() => pings === 1);
    expect(vi.getTimerCount()).toBe(intervalsBefore + 1); // this socket's heartbeat

    socket.close();
    await waitFor(() => vi.getTimerCount() === intervalsBefore); // cleared on close — no leaked interval
  });
});
