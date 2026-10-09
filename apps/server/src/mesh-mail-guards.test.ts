import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, randomBytes, sign as signEd25519 } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type MeshIdentity, createMeshIdentity, currentEpoch, mailboxTag, meshIdFromSignPublic, sealMailbox, verifyKxBinding } from "@loam/crypto";
import type { MeshIdentityCard, SealedMessage } from "@loam/schema";

import { buildApp, type LoamApp } from "./app.js";
import type { AppOptions } from "./types.js";

/**
 * Guards on the sealed-mail layer (docs/16): a re-offered copy may raise the hop budget of mail this node
 * CARRIES, never of mail a local user sealed here; a contact card's keys must have the lengths the
 * crypto expects, checked when the card is added, when stored cards are loaded, and before sealing, so a
 * malformed card can neither be added nor turn a later send into a 500; and mail sealed here starts with a
 * drawn hop budget and a backdated stated send time, within bounds (docs/16 §9).
 */

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

const DAY_MS = 24 * 3_600_000;
const MESH = { enabled: true, relay: true, ttlMs: 3_600_000, hopLimit: 6, maxCarried: 1000, maxContacts: 1000 };

async function makeApp(config: unknown, opts: Partial<AppOptions> = {}): Promise<{ app: LoamApp; dataDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), "loam-mesh-mail-guards-"));
  writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  const app = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false, maxNewIdentitiesPerWindow: 1_000_000, ...opts });
  cleanups.push(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { app, dataDir };
}

async function newSession(app: LoamApp): Promise<{ cookie: string; userId: string }> {
  const response = await app.server.inject({ method: "GET", url: "/api/config" });
  const setCookie = response.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";")[0];
  if (!cookie) {
    throw new Error("no session cookie");
  }
  return { cookie, userId: (response.json() as { currentUser: { id: string } }).currentUser.id };
}

type FakePeer = { url: string; requests: { path: string; body: unknown }[] };

/** A scripted plaintext sync peer: `respond` returns JSON, or undefined for a 404. */
async function fakePeer(respond: (path: string, body: unknown) => unknown): Promise<FakePeer> {
  const requests: FakePeer["requests"] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body: unknown = raw ? JSON.parse(raw) : undefined;
      const path = req.url ?? "";
      requests.push({ path, body });
      const out = respond(path, body);
      if (out === undefined) {
        res.statusCode = 404;
        res.end("{}");
      } else {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(out));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

async function syncRound(app: LoamApp, cookie: string): Promise<void> {
  const res = await app.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie } });
  expect(res.statusCode).toBe(200);
}

function addContact(app: LoamApp, cookie: string, card: MeshIdentityCard) {
  return app.server.inject({ method: "POST", url: "/api/mesh/contacts", headers: { cookie }, payload: card });
}

function sendSealed(app: LoamApp, cookie: string, toMeshId: string) {
  return app.server.inject({ method: "POST", url: "/api/mesh/messages", headers: { cookie }, payload: { toMeshId, body: "hello over the mesh" } });
}

/** The shareable card of a mesh identity, as `GET /api/mesh/identity` would hand it out. */
function cardOf(identity: MeshIdentity, displayName = "Remote"): MeshIdentityCard {
  return { meshId: identity.meshId, alg: "ed25519", sign: identity.signPublic, kx: identity.kxPublic, kxSig: identity.kxSig, mailboxToken: identity.mailboxToken, displayName };
}

/**
 * A card whose `kx` is 31 bytes but whose id derives from its signing key and whose binding signature over
 * that short `kx` is genuine: both self-certification checks pass, only the length is wrong. Signed with
 * Node's own Ed25519 so the test doesn't need the crypto package's private helpers.
 */
function shortKxCard(): MeshIdentityCard {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const signPublic = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const kx = randomBytes(31);
  const kxSig = signEd25519(null, Buffer.concat([Buffer.from("loam.mesh.kxbind.v1"), kx]), privateKey);
  const sign = signPublic.toString("base64url");
  return {
    meshId: meshIdFromSignPublic(sign),
    alg: "ed25519",
    sign,
    kx: kx.toString("base64url"),
    kxSig: kxSig.toString("base64url"),
    mailboxToken: randomBytes(32).toString("base64url"),
    displayName: "Short key",
  };
}

type SealedRecord = Pick<SealedMessage, "id" | "type" | "authorId" | "createdAt" | "toTag" | "sealed" | "ttlExpiresAt" | "hopLimit">;

/** A stranger's sealed mail (canonical blob) under `id`, offered at hop budget `hopLimit`. */
function strangerMail(id: string, ttlExpiresAt: number, hopLimit: number): SealedRecord {
  const now = Date.now();
  const recipient = createMeshIdentity();
  const sender = createMeshIdentity();
  const toTag = mailboxTag(recipient.mailboxToken, currentEpoch(now, DAY_MS));
  const sealed = sealMailbox({
    recipientKxPublic: recipient.kxPublic,
    sender: { signPublic: sender.signPublic, signSecret: sender.signSecret, kxPublic: sender.kxPublic },
    plaintext: `body of ${id}`,
    aad: `${toTag}|${ttlExpiresAt}`,
  });
  return { id, type: "sealed", authorId: "mesh.sealed", createdAt: now, toTag, sealed, ttlExpiresAt, hopLimit };
}

function heldHop(app: LoamApp, id: string): number | undefined {
  const held = app.store.loadMessages().find((message) => message.id === id);
  return held?.type === "sealed" ? held.hopLimit : undefined;
}

describe("a re-offered copy with a larger hop budget", () => {
  it("raises mail this node carries, never mail a local user sealed here", async () => {
    let records: SealedRecord[] = [];
    const peer = await fakePeer((path, body) => {
      if (path === "/api/sync/digest") {
        return { channels: [], messages: [], sealed: records.map(({ id, toTag, ttlExpiresAt, hopLimit }) => ({ id, toTag, ttlExpiresAt, hopLimit })) };
      }
      if (path === "/api/sync/messages") {
        const ids = new Set((body as { ids: string[] }).ids);
        return { messages: records.filter((record) => ids.has(record.id)), users: [] };
      }
      return undefined;
    });
    const { app } = await makeApp({ sync: { enabled: true, peers: [{ url: peer.url }], intervalMs: 3_600_000 }, mesh: MESH });
    const { cookie } = await newSession(app);

    // A local user seals mail to a remote contact: stored here at a hop budget drawn just below the configured
    // maximum (docs/16 §9), waiting to be carried.
    const remote = createMeshIdentity();
    expect((await addContact(app, cookie, cardOf(remote))).statusCode).toBe(200);
    expect((await sendSealed(app, cookie, remote.meshId)).statusCode).toBe(200);
    const own = app.store.loadMessages().find((message): message is SealedMessage => message.type === "sealed");
    const ownHop = own?.hopLimit ?? -1;
    expect(ownHop).toBeGreaterThanOrEqual(MESH.hopLimit - 2);
    expect(ownHop).toBeLessThanOrEqual(MESH.hopLimit);

    // A stranger's mail arrives from the peer at hop 3 and is carried at 2.
    const foreign = strangerMail("seal_foreign", Date.now() + 60_000, 3);
    records = [foreign];
    await syncRound(app, cookie);
    expect(heldHop(app, "seal_foreign")).toBe(2);

    // The peer re-offers both blobs under fresh ids with far larger budgets.
    records = [
      { ...foreign, id: "seal_foreign_again", hopLimit: 8 },
      { id: "seal_own_again", type: "sealed", authorId: "mesh.sealed", createdAt: own?.createdAt ?? 0, toTag: own?.toTag ?? "", sealed: own?.sealed ?? "", ttlExpiresAt: own?.ttlExpiresAt ?? 0, hopLimit: 16 },
    ];
    await syncRound(app, cookie);
    expect(heldHop(app, "seal_foreign")).toBe(7);
    expect(heldHop(app, own?.id ?? "")).toBe(ownHop);
    const ids = new Set(app.store.loadMessages().map((message) => message.id));
    expect(ids.has("seal_foreign_again")).toBe(false);
    expect(ids.has("seal_own_again")).toBe(false);
  });
});

describe("a contact card with a wrong-length key", () => {
  it("is refused when added, even though its id and binding signature verify", async () => {
    const card = shortKxCard();
    // The two self-certification checks alone would let it through.
    expect(meshIdFromSignPublic(card.sign)).toBe(card.meshId);
    expect(verifyKxBinding(card.sign, card.kx, card.kxSig)).toBe(true);

    const { app } = await makeApp({ mesh: MESH });
    const { cookie } = await newSession(app);
    const res = await addContact(app, cookie, card);
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/kx/);
    const contacts = (await app.server.inject({ method: "GET", url: "/api/mesh/contacts", headers: { cookie } })).json() as unknown[];
    expect(contacts).toEqual([]);
  });

  it("stored by an older build is dropped at boot, so a send to it is a 404, never a 500", async () => {
    const bad = shortKxCard();
    const good = cardOf(createMeshIdentity(), "Good");
    const { app, dataDir } = await makeApp({ mesh: MESH });
    const { cookie, userId } = await newSession(app);
    expect((await addContact(app, cookie, good)).statusCode).toBe(200);
    // What an older build's add left in `mesh_contacts` for this card.
    app.store.upsertMeshContact(userId, bad.meshId, JSON.stringify(bad));

    await app.close();
    const reopened = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false, maxNewIdentitiesPerWindow: 1_000_000 });
    cleanups.push(() => reopened.close());

    const contacts = (await reopened.server.inject({ method: "GET", url: "/api/mesh/contacts", headers: { cookie } })).json() as { meshId: string }[];
    expect(contacts.map((contact) => contact.meshId)).toEqual([good.meshId]);
    expect((await sendSealed(reopened, cookie, bad.meshId)).statusCode).toBe(404);
    expect((await sendSealed(reopened, cookie, good.meshId)).statusCode).toBe(200);
  });
});

/**
 * Seal one message from a local user to each of `count` fresh remote contacts (none of them on this node, so
 * every copy is stored to wait for a carrier), in broadcasts of 40, and return the stored sealed rows.
 */
async function sealToStrangers(app: LoamApp, cookie: string, count: number): Promise<SealedMessage[]> {
  const meshIds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const remote = createMeshIdentity();
    expect((await addContact(app, cookie, cardOf(remote))).statusCode).toBe(200);
    meshIds.push(remote.meshId);
  }
  for (let start = 0; start < meshIds.length; start += 40) {
    const res = await app.server.inject({
      method: "POST",
      url: "/api/mesh/broadcast",
      headers: { cookie },
      payload: { toMeshIds: meshIds.slice(start, start + 40), body: "spread me" },
    });
    expect(res.statusCode).toBe(200);
  }
  const sealed = app.store.loadMessages().filter((message): message is SealedMessage => message.type === "sealed");
  expect(sealed).toHaveLength(count);
  return sealed;
}

describe("origination blurs the fields that marked mail as sealed here (docs/16 §9)", () => {
  it("starts the hop budget anywhere in the top three values and states a send time up to a fifth of the TTL early", async () => {
    const { app } = await makeApp({ mesh: MESH });
    const { cookie } = await newSession(app);
    const before = Date.now();
    const sealed = await sealToStrangers(app, cookie, 50);
    const after = Date.now();

    const hops = new Set(sealed.map((message) => message.hopLimit));
    // Never above the configured maximum, never more than two below it, and (50 independent draws) all three seen.
    expect([...hops].sort((a, b) => a - b)).toEqual([MESH.hopLimit - 2, MESH.hopLimit - 1, MESH.hopLimit]);

    const maxBackdate = MESH.ttlMs / 5;
    for (const message of sealed) {
      // One stated send time behind both fields: the lifetime is still exactly the configured TTL from it.
      expect(message.ttlExpiresAt - message.createdAt).toBe(MESH.ttlMs);
      expect(message.createdAt).toBeLessThanOrEqual(after);
      expect(message.createdAt).toBeGreaterThanOrEqual(before - maxBackdate);
    }
    // The stated send times spread over the window rather than sitting at the real one.
    const stated = sealed.map((message) => message.createdAt);
    expect(Math.max(...stated) - Math.min(...stated)).toBeGreaterThan(60_000);
  });

  it("keeps a hop budget of 2 as it is, and backdates by at most a fifth of the node's retention TTL", async () => {
    const retentionMs = 10 * 60_000;
    const { app } = await makeApp({ mesh: { ...MESH, hopLimit: 2 }, retention: { messageTtlMs: retentionMs } });
    const { cookie } = await newSession(app);
    const before = Date.now();
    const sealed = await sealToStrangers(app, cookie, 20);

    // Two hops are what one carrier between sender and recipient needs: the spread never goes below that.
    expect(new Set(sealed.map((message) => message.hopLimit))).toEqual(new Set([2]));
    for (const message of sealed) {
      // Retention ages sealed rows by `createdAt`, so a larger step could let the reaper take fresh mail.
      expect(message.createdAt).toBeGreaterThanOrEqual(before - retentionMs / 5);
    }
  });
});
