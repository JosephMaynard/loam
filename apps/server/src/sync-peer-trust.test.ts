import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTransportIdentity, openTransport, sealTransport, transportServerAccept } from "@loam/crypto";

import { buildApp, type LoamApp } from "./app.js";
import type { AppOptions } from "./types.js";

/**
 * What this node sends an ENCRYPTED sync peer, seen from the peer's side (docs/08, docs/11). The peer here
 * is scripted: it runs the transport handshake itself, so every sealed envelope the puller sends can be
 * opened and recorded, its static key can be swapped the way an ephemeral-key host's is at a reboot (or an
 * on-path attacker's would be), and it can answer any route with anything. Covered: the link request
 * carries no `sync.token`; an unpinned peer whose key changes mid-boot keeps getting public pulls but no
 * longer the token, and the admin status says so; attachment answers are capped and metered.
 */

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

const PEER_AUTHOR = { id: "user.peer", type: "human", isAdmin: false, ephemeral: true, createdAt: 1, displayName: "Peer" };
const OUR_TOKEN = "our-mesh-token-0123456789";

async function makeApp(config: unknown, opts: Partial<AppOptions> = {}): Promise<{ app: LoamApp; logs: string[] }> {
  const dataDir = mkdtempSync(join(tmpdir(), "loam-sync-peer-trust-"));
  writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  const logs: string[] = [];
  const app = await buildApp({
    requireRulesAcceptance: false,
    dataDir,
    logger: true,
    logStream: { write: (line) => void logs.push(line) },
    maxNewIdentitiesPerWindow: 1_000_000,
    ...opts,
  });
  cleanups.push(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { app, logs };
}

async function newSession(app: LoamApp): Promise<string> {
  const response = await app.server.inject({ method: "GET", url: "/api/config" });
  const setCookie = response.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";")[0];
  if (!cookie) {
    throw new Error("no session cookie");
  }
  return cookie;
}

type SyncReport = { peers: { link?: string; status?: { lastError?: string; keyChanged?: boolean } }[] };

async function syncRound(app: LoamApp, cookie: string): Promise<SyncReport> {
  const res = await app.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json() as SyncReport;
}

async function syncReport(app: LoamApp, cookie: string): Promise<SyncReport> {
  const res = await app.server.inject({ method: "GET", url: "/api/admin/sync", headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json() as SyncReport;
}

function hasMessage(app: LoamApp, id: string): boolean {
  return app.store.loadMessages().some((message) => message.id === id);
}

/** The inner plaintext of a sealed sync request (docs/08). */
type Envelope = { s?: number; b?: unknown; tok?: unknown };
type Respond = (path: string, envelope: Envelope) => unknown | Promise<unknown>;

/**
 * A scripted peer that advertises `optional` transport, completes the handshake against its own static
 * key, opens each sealed request and records its envelope, and seals `respond`'s answer back under the
 * request's sequence. `rotateKey` gives it a new static key and forgets every session, as a host whose
 * transport key is re-minted at boot does; the puller's next request then 401s and re-handshakes.
 */
async function encryptedPeer(respond: Respond) {
  const state = {
    url: "",
    identity: createTransportIdentity(),
    sessions: new Map<string, string>(),
    requests: [] as { path: string; envelope: Envelope }[],
    handshakes: 0,
    rotateKey(): void {
      state.identity = createTransportIdentity();
      state.sessions.clear();
    },
  };
  const server = createServer((req, res) => {
    req.socket.on("error", () => undefined);
    res.on("error", () => undefined);
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void (async () => {
        const path = req.url ?? "";
        const raw = Buffer.concat(chunks).toString("utf8");
        const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
          res.writeHead(status, { "content-type": "application/json", ...headers });
          res.end(JSON.stringify(body));
        };
        if (path === "/api/bootstrap") {
          json(200, { networkConfig: { transportEncryption: "optional", transportPublicKey: state.identity.publicKey } });
          return;
        }
        if (path === "/api/transport/handshake") {
          state.handshakes += 1;
          const hello = JSON.parse(raw) as { clientEphemeralPublic: string };
          const accepted = transportServerAccept({ hostSecret: state.identity.secretKey, clientEphemeralPublic: hello.clientEphemeralPublic });
          const sessionId = randomBytes(16).toString("base64url");
          state.sessions.set(sessionId, accepted.sessionKey);
          json(200, { sessionId, hostEphemeralPublic: accepted.hostEphemeralPublic, hostPublicKey: state.identity.publicKey });
          return;
        }
        const sessionId = req.headers["x-loam-enc"];
        const key = typeof sessionId === "string" ? state.sessions.get(sessionId) : undefined;
        if (!key) {
          json(401, { error: "Unknown transport session" });
          return;
        }
        const opened = openTransport(key, (JSON.parse(raw) as { enc: string }).enc, `POST ${path}`);
        if (opened === null) {
          json(400, { error: "Bad seal" });
          return;
        }
        const envelope = JSON.parse(opened) as Envelope;
        state.requests.push({ path, envelope });
        const out = await respond(path, envelope);
        json(
          out === undefined ? 404 : 200,
          { enc: sealTransport(key, JSON.stringify(out ?? { error: "Not found" }), `POST ${path}#${envelope.s}`) },
          { "x-loam-enc": "1" },
        );
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return state;
}

function post(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, type: "channelPost", authorId: PEER_AUTHOR.id, channelId: "general", createdAt: 1_000, body: id, ...overrides };
}

/** A `respond` that serves `records()` as the public offer and answers everything else with `extra`. */
function serving(records: () => Record<string, unknown>[], extra: (path: string, envelope: Envelope) => unknown = () => undefined): Respond {
  return (path, envelope) => {
    if (path === "/api/sync/digest") {
      return { channels: [], messages: records().map(({ id }) => ({ id })) };
    }
    if (path === "/api/sync/messages") {
      const ids = new Set((envelope.b as { ids: string[] }).ids);
      return { messages: records().filter((record) => ids.has(record.id as string)), users: [PEER_AUTHOR] };
    }
    return extra(path, envelope);
  };
}

describe("linking to a peer", () => {
  it("sends the link request without this node's sync.token; the round's pulls still carry it", async () => {
    const code = "AAAAAAAAAAAAAAAA";
    const peer = await encryptedPeer(serving(() => [], (path) => (path === "/api/sync/link" ? { name: "Other network", token: "their-token" } : undefined)));
    const { app } = await makeApp({
      sync: { enabled: true, peers: [{ url: peer.url, transportKey: peer.identity.publicKey, linkCode: code }], intervalMs: 3_600_000, token: OUR_TOKEN },
    });
    const cookie = await newSession(app);

    const report = await syncRound(app, cookie);
    expect(report.peers[0]?.status?.lastError).toBeUndefined();

    const link = peer.requests.find((request) => request.path === "/api/sync/link");
    expect(link).toBeDefined();
    expect(link?.envelope.tok).toBeUndefined();
    expect((link?.envelope.b as { code: string }).code).toBe(code);
    const digest = peer.requests.find((request) => request.path === "/api/sync/digest");
    expect(digest?.envelope.tok).toBe(OUR_TOKEN);
    // The spent code is gone from the peer entry.
    expect(report.peers[0]?.link).toBeUndefined();
  });
});

describe("an unpinned peer that answers a later handshake with a different key", () => {
  it("still has its public data pulled, but no longer receives sync.token, is logged once, and is flagged in the admin status", async () => {
    let offered = [post("msg_before")];
    const peer = await encryptedPeer(serving(() => offered));
    const { app, logs } = await makeApp({ sync: { enabled: true, peers: [{ url: peer.url }], intervalMs: 3_600_000, token: OUR_TOKEN } });
    const cookie = await newSession(app);
    const keyWarnings = () => logs.filter((line) => line.includes("different transport key") && line.includes(peer.url)).length;

    expect((await syncRound(app, cookie)).peers[0]?.status?.lastError).toBeUndefined();
    expect(hasMessage(app, "msg_before")).toBe(true);
    expect(peer.requests.length).toBeGreaterThan(0);
    expect(peer.requests.every((request) => request.envelope.tok === OUR_TOKEN)).toBe(true);
    expect((await syncReport(app, cookie)).peers[0]?.status?.keyChanged).toBeUndefined();

    // The peer comes back with another static key. The puller's cached session 401s, it re-handshakes,
    // sees the new key, and from that retry on seals no token to it.
    peer.rotateKey();
    offered = [...offered, post("msg_after")];
    let mark = peer.requests.length;
    const report = await syncRound(app, cookie);
    expect(report.peers[0]?.status?.lastError).toBeUndefined();
    expect(report.peers[0]?.status?.keyChanged).toBe(true);
    expect(hasMessage(app, "msg_after")).toBe(true);
    const afterRotation = peer.requests.slice(mark);
    expect(afterRotation.length).toBeGreaterThan(0);
    expect(afterRotation.every((request) => request.envelope.tok === undefined)).toBe(true);
    expect(keyWarnings()).toBe(1);

    // And stays that way on later rounds, without repeating the warning.
    offered = [...offered, post("msg_later")];
    mark = peer.requests.length;
    expect((await syncRound(app, cookie)).peers[0]?.status?.lastError).toBeUndefined();
    expect(hasMessage(app, "msg_later")).toBe(true);
    expect(peer.requests.slice(mark).every((request) => request.envelope.tok === undefined)).toBe(true);
    expect((await syncReport(app, cookie)).peers[0]?.status?.keyChanged).toBe(true);
    expect(keyWarnings()).toBe(1);
  });

  it("a peer that keeps its key across a session loss keeps receiving the token", async () => {
    const offered = [post("msg_one")];
    const peer = await encryptedPeer(serving(() => offered));
    const { app } = await makeApp({ sync: { enabled: true, peers: [{ url: peer.url }], intervalMs: 3_600_000, token: OUR_TOKEN } });
    const cookie = await newSession(app);
    expect((await syncRound(app, cookie)).peers[0]?.status?.lastError).toBeUndefined();

    // Same key, sessions forgotten (an ordinary restart): the re-handshake finds the key it already knew.
    peer.sessions.clear();
    const mark = peer.requests.length;
    const report = await syncRound(app, cookie);
    expect(report.peers[0]?.status?.lastError).toBeUndefined();
    expect(report.peers[0]?.status?.keyChanged).toBeUndefined();
    expect(peer.handshakes).toBe(2);
    const afterRestart = peer.requests.slice(mark);
    expect(afterRestart.length).toBeGreaterThan(0);
    expect(afterRestart.every((request) => request.envelope.tok === OUR_TOKEN)).toBe(true);
  });
});

describe("attachment fetches from an encrypted peer", () => {
  /** `count` posts, each naming four attachments. */
  function postsWithAttachments(count: number): Record<string, unknown>[] {
    return Array.from({ length: count }, (_, index) =>
      post(`msg_${index}`, {
        createdAt: 1_000 + index,
        attachments: Array.from({ length: 4 }, (_, slot) => ({
          id: `att_${String(index).padStart(8, "0")}${String(slot).padStart(8, "0")}`,
          mimeType: "text/plain",
          name: "file.txt",
        })),
      }),
    );
  }

  function attachmentRequests(peer: Awaited<ReturnType<typeof encryptedPeer>>): number {
    return peer.requests.filter((request) => request.path === "/api/sync/attachment").length;
  }

  it("cost at most 2 MiB each: eight answers of 8 MiB junk stay inside the round's 32 MiB budget", async () => {
    const junk = { data: "A".repeat(8 * 1024 * 1024) };
    const records = postsWithAttachments(2);
    const peer = await encryptedPeer(serving(() => records, (path) => (path === "/api/sync/attachment" ? junk : undefined)));
    const { app } = await makeApp({ sync: { enabled: true, peers: [{ url: peer.url }], intervalMs: 3_600_000 } });
    const cookie = await newSession(app);

    const report = await syncRound(app, cookie);
    expect(report.peers[0]?.status?.lastError).toBeUndefined();
    expect(hasMessage(app, "msg_0")).toBe(true);
    expect(hasMessage(app, "msg_1")).toBe(true);
    expect(attachmentRequests(peer)).toBe(8);
    // Every fetch failed (over the cap) and was queued for the retry pass.
    expect(app.store.loadMissingAttachments()).toHaveLength(8);
  });

  it("count toward the budget: twenty over-cap answers spend it, and the round stops fetching", async () => {
    const junk = { data: "A".repeat(3 * 1024 * 1024) };
    const records = postsWithAttachments(5);
    const peer = await encryptedPeer(serving(() => records, (path) => (path === "/api/sync/attachment" ? junk : undefined)));
    const { app } = await makeApp({ sync: { enabled: true, peers: [{ url: peer.url }], intervalMs: 3_600_000 } });
    const cookie = await newSession(app);

    const report = await syncRound(app, cookie);
    expect(report.peers[0]?.status?.lastError).toMatch(/byte budget/);
    // 2 MiB a fetch: the seventeenth takes the round past 32 MiB, so the last three are never fetched.
    expect(attachmentRequests(peer)).toBe(17);
    // The messages themselves still import, and every attachment is queued for the retry pass.
    for (let index = 0; index < 5; index += 1) {
      expect(hasMessage(app, `msg_${index}`)).toBe(true);
    }
    expect(app.store.loadMissingAttachments()).toHaveLength(20);
  });
});
