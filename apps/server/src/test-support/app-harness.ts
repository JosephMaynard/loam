/**
 * Shared harness for the server's route-level test files: each boots a real app with `buildApp()` on a
 * throwaway data dir and drives it with `server.inject` (or a real listener for WebSocket tests).
 *
 * Map of the server tests (src/*.test.ts). On this harness:
 *   admin, sessions, http-hardening: bootstrap and claims, config API, profiles; identity minting; headers, logs
 *   channels, messages, content-lifecycle, moderation, attachments: content, rosters, retention, bans, reports
 *   kill-switch, db-encryption: Emergency Reset and panic; SQLCipher at rest, key handoff, the wipe journal
 *   realtime-privacy, transport, sync, mesh, assistant: socket audiences, transport encryption, sync, mail, LLM
 * The rest keep a small harness of their own and are named for their module (db, llm, sync-transport...) or
 * subject (blocks, boot-repair, sync-rounds, sync-sealed-offers, upgrade-quarantine...). `fs-faults.ts`
 * beside this file holds the `node:fs` fault-injection seams.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { vi } from "vitest";

import { openTransport, sealTransport, transportClientDerive, transportClientHello } from "@loam/crypto";
import { TransportHandshakeResponseSchema } from "@loam/schema";

import { buildApp, type AppOptions, type LoamApp } from "../app.js";

export type InjectResponse = Awaited<ReturnType<LoamApp["server"]["inject"]>>;

export const cleanups: (() => Promise<void> | void)[] = [];

/**
 * Tear down everything a test registered in `cleanups` (apps, temp dirs, mock servers), newest first.
 * Every app test file calls this from its `afterEach`. Real timers are restored first, so a test that
 * installed fake timers can't leave `app.close()` (which awaits Fastify shutdown) or the next test running
 * on a frozen clock.
 */
export async function teardownApps(): Promise<void> {
  vi.useRealTimers();
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
}

export async function makeApp(
  config?: unknown,
  opts?: Partial<AppOptions>,
): Promise<{ app: LoamApp; dataDir: string } & LoamApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "loam-app-test-"));

  if (config !== undefined) {
    writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  }

  // A high identity cap so the per-IP new-identity limiter (all inject requests share 127.0.0.1)
  // never trips across a suite that mints many sessions; a dedicated test drives it low on purpose.
  const app = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false, maxNewIdentitiesPerWindow: 1_000_000, ...opts });
  cleanups.push(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { ...app, app, dataDir };
}

/** Reopen an app on an existing data dir (restart simulation). */
export async function reopenApp(app: LoamApp, dataDir: string): Promise<LoamApp> {
  await app.close();
  const next = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false });
  cleanups.push(() => next.close());
  return next;
}

/** The wipe journal's PHASE (the `.loam-wipe-phase` file is JSON `{ phase, config? }`; tolerate the
 *  legacy plain-string format too). Throws if the journal file is absent. */
export function readJournalPhase(dataDir: string): string {
  const raw = readFileSync(join(dataDir, ".loam-wipe-phase"), "utf8");
  try {
    const parsed = JSON.parse(raw) as { phase?: unknown };
    if (parsed && typeof parsed === "object" && typeof parsed.phase === "string") {
      return parsed.phase;
    }
  } catch {
    // Legacy plain-string journal.
  }
  return raw.trim();
}

/** The config snapshot embedded in the wipe journal, or undefined if none / not JSON. */
export function readJournalConfig(dataDir: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, ".loam-wipe-phase"), "utf8")) as { config?: unknown };
    return parsed && typeof parsed.config === "object" ? (parsed.config as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Preserve-recovery snapshot directories (`.loam-recovery-<suffix>/`), excluding the transient
 *  `.loam-recovery-state` anchor file. */
export function recoverySnapshots(dataDir: string): string[] {
  return readdirSync(dataDir).filter(
    (name) => name.startsWith(".loam-recovery-") && name !== ".loam-recovery-state" && !name.includes(".tmp-"),
  );
}

export function sessionCookie(response: InjectResponse): string {
  const header = response.headers["set-cookie"];
  const first = Array.isArray(header) ? header[0] : header;
  const cookie = first?.split(";")[0];

  if (!cookie?.startsWith("loam_session=")) {
    throw new Error("No session cookie in response");
  }

  return cookie;
}

export async function newSession(app: LoamApp): Promise<{ cookie: string; userId: string; isAdmin: boolean }> {
  const response = await app.server.inject({ method: "GET", url: "/api/config" });
  const body = response.json() as { currentUser: { id: string; isAdmin: boolean } };
  return { cookie: sessionCookie(response), userId: body.currentUser.id, isAdmin: body.currentUser.isAdmin };
}

/** Run a docs/08 transport handshake against a node → the session id + derived client key. */
export async function openTransport08(app: LoamApp): Promise<{ sessionId: string; key: string }> {
  const hello = transportClientHello();
  const res = await app.server.inject({
    method: "POST",
    url: "/api/transport/handshake",
    payload: { clientEphemeralPublic: hello.ephemeralPublic },
  });
  const body = TransportHandshakeResponseSchema.parse(res.json());
  return {
    sessionId: body.sessionId,
    key: transportClientDerive({
      clientEphemeralSecret: hello.ephemeralSecret,
      hostPublic: body.hostPublicKey,
      hostEphemeralPublic: body.hostEphemeralPublic,
    }),
  };
}

/** Seal a `{ s, b? }` anti-replay envelope (docs/08) at an explicit sequence. */
export function sealSeq(key: string, seq: number, aad: string, body?: unknown): string {
  return sealTransport(key, JSON.stringify(body === undefined ? { s: seq } : { s: seq, b: body }), aad);
}

/** Bind a transport session to an identity (docs/20 resume): seal `{ token? }` at `seq`, unseal the
 *  `{ currentUser, token }` reply. Afterwards the session is `bound` and reaches content via the tunnel. */
export async function resumeIdentity(
  app: LoamApp,
  session: { sessionId: string; key: string },
  seq: number,
  token?: string,
): Promise<{ status: number; currentUser: { id: string; isAdmin: boolean; pending?: boolean }; token: string }> {
  const aad = "POST /api/session/resume";
  const res = await app.server.inject({
    method: "POST",
    url: "/api/session/resume",
    headers: { "x-loam-enc": session.sessionId, "content-type": "application/json" },
    payload: { enc: sealSeq(session.key, seq, aad, token === undefined ? {} : { token }) },
  });
  if (res.statusCode !== 200) {
    return { status: res.statusCode, currentUser: { id: "", isAdmin: false }, token: "" };
  }
  const opened = openTransport(session.key, (res.json() as { enc: string }).enc, aad);
  const body = JSON.parse(opened as string) as { currentUser: { id: string; isAdmin: boolean; pending?: boolean }; token: string };
  return { status: res.statusCode, ...body };
}

/** Send an inner request through the metadata-hiding tunnel (docs/08 v2) on a bound session (docs/20):
 *  seal `{ m, p, body? }` at `seq`, unseal the `{ status, contentType, body }` descriptor. */
export async function tunnelInner(
  app: LoamApp,
  session: { sessionId: string; key: string },
  seq: number,
  inner: { m: string; p: string; body?: unknown },
): Promise<{ outerStatus: number; status: number; contentType: string; body: Buffer }> {
  const aad = "POST /api/transport/tunnel";
  const res = await app.server.inject({
    method: "POST",
    url: "/api/transport/tunnel",
    headers: { "x-loam-enc": session.sessionId, "content-type": "application/json" },
    payload: { enc: sealSeq(session.key, seq, aad, inner) },
  });
  if (res.statusCode !== 200) {
    return { outerStatus: res.statusCode, status: res.statusCode, contentType: "", body: Buffer.alloc(0) };
  }
  const opened = openTransport(session.key, (res.json() as { enc: string }).enc, aad);
  const desc = JSON.parse(opened as string) as { status: number; contentType: string; bodyB64: string };
  return {
    outerStatus: res.statusCode,
    status: desc.status,
    contentType: desc.contentType,
    body: Buffer.from(desc.bodyB64, "base64"),
  };
}

export async function claim(app: LoamApp, cookie: string, secret: string): Promise<InjectResponse> {
  return app.server.inject({
    method: "POST",
    url: "/api/admin/claim",
    headers: { cookie },
    payload: { secret },
  });
}

export type OllamaChatRequestBody = { model?: string; stream?: boolean; messages?: { role: string; content: string }[] };

/**
 * Minimal mock of Ollama's streaming `/api/chat` endpoint (node:http), emitting the same
 * newline-delimited JSON shape `streamOllamaChat` (apps/server/src/app.ts) parses: one
 * `{"message":{"content":...},"done":false}` line per delta (with a real delay between them, so a
 * test can tell genuine streaming from one lump), then a final `{"done":true}` line. Captures every
 * request body it receives for assertions (e.g. that the DM history was forwarded as `messages`).
 */
export function startMockOllama(
  deltas: string[],
  opts: { delayMs?: number } = {},
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
          // Malformed capture is surfaced by an empty `requests` entry never appearing; irrelevant
          // to the streaming behaviour under test.
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
export async function unusedLocalUrl(): Promise<string> {
  const probe = createServer();
  const url = await new Promise<string>((resolve) => {
    probe.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(probe.address() as AddressInfo).port}`));
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return url;
}
