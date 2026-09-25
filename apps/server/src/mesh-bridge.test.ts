import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMeshIdentity, currentEpoch, mailboxTag, sealMailbox } from "@loam/crypto";
import { type MeshIdentityCard, MeshIdentityCardSchema } from "@loam/schema";

import { buildApp, type AppOptions, type LoamApp } from "./app.js";

/**
 * The opportunistic-mesh transport bridge (`GET /api/mesh/outbound` + `POST /api/mesh/inbound`, docs/16
 * §5 / docs/17). Moved out of app.test.ts when the bridge started requiring the launcher's per-boot host
 * token on EVERY host (review 2026-09-25 #12): the only real caller is the Android launcher's courier,
 * which always sends `x-loam-host-token`, so these tests boot every node with a host token and drive the
 * bridge the way the courier does (see `asCourier`). The authorization rules themselves are pinned by the
 * "bridge authorization" block at the end.
 */

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

type InjectResponse = Awaited<ReturnType<LoamApp["server"]["inject"]>>;

/** The per-boot token the Android launcher mints (`LOAM_HOST_TOKEN`) — the courier presents it. */
const HOST_TOKEN = "bridge-test-host-token-0123456789abcdef";
const MESH = { enabled: true, relay: true, ttlMs: 3_600_000, hopLimit: 6, maxCarried: 1000, maxContacts: 1000 };
const BRIDGE_PATHS = new Set(["/api/mesh/outbound", "/api/mesh/inbound"]);

/** Make `inject` behave like the launcher's courier: bridge requests carry the host token unless the test
 * sets `x-loam-host-token` itself (so authorization tests still control it explicitly). */
function asCourier(app: LoamApp): LoamApp {
  const inject = app.server.inject.bind(app.server);
  const patched = ((options: Parameters<typeof inject>[0]) => {
    if (options && typeof options === "object" && BRIDGE_PATHS.has(String((options as { url?: unknown }).url))) {
      const opts = options as { headers?: Record<string, string> };
      if (!opts.headers || !("x-loam-host-token" in opts.headers)) {
        opts.headers = { ...opts.headers, "x-loam-host-token": HOST_TOKEN };
      }
    }
    return inject(options);
  }) as typeof app.server.inject;
  app.server.inject = patched;
  return app;
}

async function makeApp(
  config?: unknown,
  opts?: Partial<AppOptions>,
): Promise<{ app: LoamApp; dataDir: string } & LoamApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "loam-mesh-bridge-test-"));
  if (config !== undefined) {
    writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  }
  const app = asCourier(
    await buildApp({ dataDir, logger: false, maxNewIdentitiesPerWindow: 1_000_000, hostToken: HOST_TOKEN, ...opts }),
  );
  cleanups.push(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { ...app, app, dataDir };
}

/** Reopen an app on an existing data dir (restart simulation) — the launcher mints a new token each boot,
 * but the courier always knows the current one, so reuse it here. */
async function reopenApp(app: LoamApp, dataDir: string): Promise<LoamApp> {
  await app.close();
  const next = asCourier(await buildApp({ dataDir, logger: false, hostToken: HOST_TOKEN }));
  cleanups.push(() => next.close());
  return next;
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

/** A session on a node (not admin — a host token forces the hostDevice bootstrap; nothing here needs admin). */
function adminOf(app: LoamApp): Promise<{ cookie: string; userId: string }> {
  return newSession(app);
}

async function roster(app: LoamApp, cookie: string): Promise<{ id: string }[]> {
  return (await app.server.inject({ method: "GET", url: "/api/users", headers: { cookie } })).json() as { id: string }[];
}

async function dmBodies(app: LoamApp, cookie: string, peerId: string): Promise<string[]> {
  return (
    (await app.server.inject({ method: "GET", url: `/api/dms/${peerId}`, headers: { cookie } })).json() as {
      body?: string;
    }[]
  ).map((message) => message.body ?? "");
}

async function meshCard(app: LoamApp, cookie: string): Promise<MeshIdentityCard> {
  const res = await app.server.inject({ method: "GET", url: "/api/mesh/identity", headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return MeshIdentityCardSchema.parse(res.json());
}

function addContact(app: LoamApp, cookie: string, card: MeshIdentityCard): Promise<InjectResponse> {
  return app.server.inject({ method: "POST", url: "/api/mesh/contacts", headers: { cookie }, payload: card });
}

/** What an inbound blob can change on a node: its DMs and its sealed rows (with their hop budget). */
function heldMail(app: LoamApp): Map<string, number> {
  return new Map(
    app.store
      .loadMessages()
      .filter((message) => message.type === "dm" || message.type === "sealed")
      .map((message) => [message.id, message.type === "sealed" ? message.hopLimit : -1]),
  );
}

/**
 * POST blobs to the inbound bridge as the courier does. The answer never says what became of them (docs/16
 * §9: a courier acting on it re-advertised only after a delivery), so what was accepted — delivered (a new
 * DM), carried (a new sealed row) or a raised hop budget — is read off the store instead.
 */
async function inbound(app: LoamApp, messages: unknown[]): Promise<number> {
  const before = heldMail(app);
  const response = await app.server.inject({ method: "POST", url: "/api/mesh/inbound", payload: { messages } });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ ok: true });
  let changed = 0;
  for (const [id, hopLimit] of heldMail(app)) {
    if (before.get(id) !== hopLimit) {
      changed += 1;
    }
  }
  return changed;
}

describe("opportunistic mesh: transport bridge", () => {
  describe("transport bridge (GET /api/mesh/outbound + POST /api/mesh/inbound)", () => {
    it("404s both endpoints when mesh is disabled", async () => {
      const app = await makeApp(); // mesh off by default
      const out = await app.server.inject({ method: "GET", url: "/api/mesh/outbound" });
      expect(out.statusCode).toBe(404);
      const inbound = await app.server.inject({
        method: "POST",
        url: "/api/mesh/inbound",
        payload: { messages: [] },
      });
      // Empty batch also fails the min(1) schema, but the 404 gate short-circuits before validation.
      expect(inbound.statusCode).toBe(404);
    });

    it("hands a sealed blob A→B over the bridge without the sync loop", async () => {
      // Two mesh nodes with NO sync peers configured — delivery rides only the transport bridge.
      const nodeA = await makeApp({ mesh: MESH });
      const nodeB = await makeApp({ mesh: MESH });
      const alice = await adminOf(nodeA);
      const bob = await adminOf(nodeB);

      // Alice adds Bob's card (out-of-band) and seals a message to him. It has no local recipient on
      // A, so it sits in A's outbound queue waiting for a carrier.
      const bobCard = await meshCard(nodeB, bob.cookie);
      expect((await addContact(nodeA, alice.cookie, bobCard)).statusCode).toBe(200);
      const send = await nodeA.server.inject({
        method: "POST",
        url: "/api/mesh/messages",
        headers: { cookie: alice.cookie },
        payload: { toMeshId: bobCard.meshId, body: "carry me over the mesh" },
      });
      expect(send.statusCode).toBe(200);

      // The courier reads A's outbound queue (what it would push over the radio).
      const out = await nodeA.server.inject({ method: "GET", url: "/api/mesh/outbound" });
      expect(out.statusCode).toBe(200);
      const outbound = out.json() as { messages: { type: string; sealed: string }[] };
      expect(outbound.messages).toHaveLength(1);
      expect(outbound.messages[0].type).toBe("sealed");
      // Opaque on the wire — the plaintext is nowhere in the blob the radio would carry.
      expect(JSON.stringify(outbound.messages)).not.toContain("carry me over the mesh");

      // The receiving node's courier POSTs the received blob to its inbound endpoint → delivered.
      expect(await inbound(nodeB, outbound.messages)).toBe(1);

      const contact = (await roster(nodeB, bob.cookie)).find((entry) => entry.id.startsWith("mesh."));
      expect(contact).toBeDefined();
      expect(await dmBodies(nodeB, bob.cookie, contact!.id)).toContain("carry me over the mesh");

      // Idempotent: re-delivering the same blob is a no-op (dedup by id + tombstone), not a dupe DM.
      expect(await inbound(nodeB, outbound.messages)).toBe(0);
      expect((await dmBodies(nodeB, bob.cookie, contact!.id)).filter((b) => b === "carry me over the mesh")).toHaveLength(1);
    });

    it("remembers a blob taken in over the radio even when it drops it, like one it delivered", async () => {
      // A sync peer offering the same id later must be skipped whatever became of the radio copy
      // (docs/16 §9): dropped ones may not be re-fetched while delivered ones stay tombstoned.
      const nodeA = await makeApp({ mesh: MESH });
      const nodeB = await makeApp({ mesh: { ...MESH, relay: false } });
      const nodeC = await makeApp({ mesh: MESH });
      const alice = await adminOf(nodeA);
      await adminOf(nodeB);
      const carol = await adminOf(nodeC);
      const carolCard = await meshCard(nodeC, carol.cookie);
      expect((await addContact(nodeA, alice.cookie, carolCard)).statusCode).toBe(200);
      await nodeA.server.inject({
        method: "POST",
        url: "/api/mesh/messages",
        headers: { cookie: alice.cookie },
        payload: { toMeshId: carolCard.meshId, body: "for carol, not bob" },
      });
      const { messages } = (await nodeA.server.inject({ method: "GET", url: "/api/mesh/outbound" })).json() as {
        messages: { id: string }[];
      };
      expect(await inbound(nodeB, messages)).toBe(0); // not ours, not relaying: dropped
      expect(nodeB.store.isSealedOfferSeen(messages[0]!.id, Date.now())).toBe(true);

      // Handed the same blob again once relaying is on (after a restart), it stays dropped (review 2026-09-25
      // #2): carrying it now would make "carried" vs "refused" depend on whether the first copy was delivered.
      writeFileSync(join(nodeB.dataDir, "config.json"), JSON.stringify({ mesh: MESH }));
      const relayB = await reopenApp(nodeB.app, nodeB.dataDir);
      expect(await inbound(relayB, messages)).toBe(0);
      expect(relayB.store.loadMessages().some((message) => message.type === "sealed")).toBe(false);
    });

    it("refuses the same ciphertext replayed under a new outer id — on the recipient and on a relay", async () => {
      // The outer message id is not covered by the seal, so a carrier can rename a valid blob at will.
      const nodeA = await makeApp({ mesh: MESH });
      const nodeB = await makeApp({ mesh: MESH });
      const nodeC = await makeApp({ mesh: MESH });
      const alice = await adminOf(nodeA);
      const bob = await adminOf(nodeB);
      const bobCard = await meshCard(nodeB, bob.cookie);
      expect((await addContact(nodeA, alice.cookie, bobCard)).statusCode).toBe(200);
      await nodeA.server.inject({
        method: "POST",
        url: "/api/mesh/messages",
        headers: { cookie: alice.cookie },
        payload: { toMeshId: bobCard.meshId, body: "only once" },
      });
      const [original] = ((await nodeA.server.inject({ method: "GET", url: "/api/mesh/outbound" })).json() as {
        messages: Record<string, unknown>[];
      }).messages;
      const deliver = (node: LoamApp, message: Record<string, unknown>) => inbound(node, [message]);

      // Relay C: one carried copy, however many ids it arrives under.
      expect(await deliver(nodeC, original)).toBe(1);
      expect(await deliver(nodeC, { ...original, id: "seal_renamed_on_relay" })).toBe(0);
      expect(nodeC.store.loadMessages().filter((message) => message.type === "sealed")).toHaveLength(1);

      // Recipient B: one delivered DM — including after a restart (the replay record is persisted).
      expect(await deliver(nodeB, original)).toBe(1);
      expect(await deliver(nodeB, { ...original, id: "seal_renamed_replay" })).toBe(0);
      const reopened = await reopenApp(nodeB.app, nodeB.dataDir);
      expect(await deliver(reopened, { ...original, id: "seal_renamed_after_restart" })).toBe(0);
      expect(reopened.store.loadMessages().filter((message) => message.type === "dm" && message.body === "only once")).toHaveLength(1);

      // Re-SPELLING the ciphertext doesn't help either: the base64url decoder tolerates `=` + trailing junk
      // and ignores the final character's unused bits, so these decode to the very same envelope.
      const sealed = original.sealed as string;
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      const lastFlipped = sealed.slice(0, -1) + alphabet[alphabet.indexOf(sealed.at(-1)!) ^ 1];
      for (const [index, respelled] of [`${sealed}=junk`, ...(sealed.length % 4 === 0 ? [] : [lastFlipped])].entries()) {
        expect(await deliver(reopened, { ...original, id: `seal_respelled_${index}`, sealed: respelled })).toBe(0);
        expect(await deliver(nodeC, { ...original, id: `seal_respelled_relay_${index}`, sealed: respelled })).toBe(0);
      }
      expect(reopened.store.loadMessages().filter((message) => message.type === "dm" && message.body === "only once")).toHaveLength(1);
      expect(nodeC.store.loadMessages().filter((message) => message.type === "sealed")).toHaveLength(1);

      // A lifetime no honest sender can request is refused outright.
      expect(await deliver(nodeC, { ...original, id: "seal_far_future", ttlExpiresAt: Date.now() + 30 * 24 * 3_600_000 })).toBe(0);
    });

    it("can't be censored by a carrier pre-offering the genuine blob with a fake TTL, or a planted replay-key id", async () => {
      const nodeA = await makeApp({ mesh: MESH });
      const nodeB = await makeApp({ mesh: MESH });
      const alice = await adminOf(nodeA);
      const bob = await adminOf(nodeB);
      const bobCard = await meshCard(nodeB, bob.cookie);
      expect((await addContact(nodeA, alice.cookie, bobCard)).statusCode).toBe(200);
      await nodeA.server.inject({
        method: "POST",
        url: "/api/mesh/messages",
        headers: { cookie: alice.cookie },
        payload: { toMeshId: bobCard.meshId, body: "must arrive" },
      });
      const [genuine] = ((await nodeA.server.inject({ method: "GET", url: "/api/mesh/outbound" })).json() as {
        messages: Record<string, unknown>[];
      }).messages;
      const deliver = (message: Record<string, unknown>) => inbound(nodeB, [message]);

      // The TTL is cleartext a relay can't verify: the forged copy fails to open (AAD mismatch) and is
      // merely carried. It must not shadow the genuine message that arrives afterwards.
      expect(await deliver({ ...genuine, id: "seal_fake_ttl", ttlExpiresAt: (genuine.ttlExpiresAt as number) + 1 })).toBe(1);
      // Ids inside the replay-key namespace are refused outright, so none can be planted as a tombstone.
      expect(await deliver({ ...genuine, id: `sealed.${"0".repeat(64)}` })).toBe(0);

      expect(await deliver(genuine)).toBe(1);
      const contact = (await roster(nodeB, bob.cookie)).find((entry) => entry.id.startsWith("mesh."));
      expect(await dmBodies(nodeB, bob.cookie, contact!.id)).toEqual(["must arrive"]);

      // On a RELAY the unauthenticated outer fields are the lever: a copy with a spent hop budget, or with
      // `meta.streaming` (which the export treats as "never offer"), must not park a dead row that shadows
      // the genuine mail.
      const nodeC = await makeApp({ mesh: MESH });
      const relay = (message: Record<string, unknown>) => inbound(nodeC, [message]);
      const offered = async () =>
        ((await nodeC.server.inject({ method: "GET", url: "/api/mesh/outbound" })).json() as { messages: { hopLimit: number; meta?: unknown }[] })
          .messages;

      expect(await relay({ ...genuine, id: "seal_spent", hopLimit: 1 })).toBe(0); // nothing left to carry
      expect(await relay({ ...genuine, id: "seal_low", hopLimit: 2, meta: { streaming: true } })).toBe(1);
      expect(await offered()).toMatchObject([{ hopLimit: 1 }]);
      expect((await offered())[0].meta).toBeUndefined();
      expect(await relay(genuine)).toBe(1); // the better-provisioned copy raises the held budget…
      expect(await offered()).toMatchObject([{ hopLimit: (genuine.hopLimit as number) - 1 }]);
      expect(await relay({ ...genuine, id: "seal_again" })).toBe(0); // …and nothing further is gained by replays
    });

    it("relays through a carrier that cannot read the blob (bridge A→C→B)", async () => {
      const nodeA = await makeApp({ mesh: MESH });
      const nodeB = await makeApp({ mesh: MESH });
      const nodeC = await makeApp({ mesh: MESH });
      const alice = await adminOf(nodeA);
      const bob = await adminOf(nodeB);
      const carol = await adminOf(nodeC);

      const bobCard = await meshCard(nodeB, bob.cookie);
      expect((await addContact(nodeA, alice.cookie, bobCard)).statusCode).toBe(200);
      expect(
        (
          await nodeA.server.inject({
            method: "POST",
            url: "/api/mesh/messages",
            headers: { cookie: alice.cookie },
            payload: { toMeshId: bobCard.meshId, body: "meet at the docks" },
          })
        ).statusCode,
      ).toBe(200);

      // A → C: the carrier takes it on (not for a local user → relayed, hop-decremented).
      const fromA = (await nodeA.server.inject({ method: "GET", url: "/api/mesh/outbound" })).json() as {
        messages: unknown[];
      };
      expect(await inbound(nodeC, fromA.messages)).toBe(1);
      // Carol cannot read it.
      const cSealed = nodeC.store.loadMessages().find((m) => m.type === "sealed");
      expect(cSealed).toBeDefined();
      expect(JSON.stringify(cSealed)).not.toContain("docks");

      // C → B: the carrier re-offers it (still on its outbound), B decrypts + delivers.
      const fromC = (await nodeC.server.inject({ method: "GET", url: "/api/mesh/outbound" })).json() as {
        messages: unknown[];
      };
      expect(fromC.messages).toHaveLength(1);
      expect(await inbound(nodeB, fromC.messages)).toBe(1);
      const contact = (await roster(nodeB, bob.cookie)).find((entry) => entry.id.startsWith("mesh."));
      expect(await dmBodies(nodeB, bob.cookie, contact!.id)).toContain("meet at the docks");
    });

    it("stays reachable over loopback when transport encryption is REQUIRED (courier must not wedge)", async () => {
      // The in-process courier polls these endpoints over plain 127.0.0.1 with no transport session. In
      // `required` mode the general content gate would 401 an unsealed direct hit; the mesh bridge is
      // exempted (loopback-only, blobs already sealed at the mesh crypto layer) so turning transport
      // encryption up can't silently stop the radio from moving mail (Fable review).
      const app = await makeApp({ mesh: MESH, security: { profile: "custom", transportEncryption: "required" } });
      const out = await app.server.inject({ method: "GET", url: "/api/mesh/outbound" });
      expect(out.statusCode).toBe(200);
      const inbound = await app.server.inject({
        method: "POST",
        url: "/api/mesh/inbound",
        payload: { messages: [] },
      });
      // Empty batch is a 400 (schema min(1)), NOT a 401 — proving the request passed the transport gate
      // and reached the handler rather than being refused for lacking a sealed session.
      expect(inbound.statusCode).toBe(400);
    });

    it("still refuses a NON-loopback caller under required mode (exemption never widens LAN reach)", async () => {
      const app = await makeApp({ mesh: MESH, security: { profile: "custom", transportEncryption: "required" } });
      const out = await app.server.inject({
        method: "GET",
        url: "/api/mesh/outbound",
        remoteAddress: "192.168.4.7",
      });
      // A LAN peer is REFUSED: the exemption is loopback-gated, so a non-loopback hit never qualifies and
      // falls through to the required-mode transport gate (401 — "needs an encrypted session"). It never
      // reaches the handler, so the exemption grants a LAN joiner nothing.
      expect(out.statusCode).toBe(401);
    });
  });

  describe("the radio bridge reveals and risks nothing about delivery (verifier round, 2026-09-25)", () => {
    /** One blob sealed on `sender` for the owner of `card` (added as a contact first). */
    async function sealedFor(sender: LoamApp, senderCookie: string, card: MeshIdentityCard): Promise<Record<string, unknown>> {
      expect((await addContact(sender, senderCookie, card)).statusCode).toBe(200);
      const before = new Set(
        ((await sender.server.inject({ method: "GET", url: "/api/mesh/outbound" })).json() as { messages: { id: string }[] }).messages.map(
          (message) => message.id,
        ),
      );
      const sent = await sender.server.inject({
        method: "POST",
        url: "/api/mesh/messages",
        headers: { cookie: senderCookie },
        payload: { toMeshId: card.meshId, body: `for ${card.meshId}` },
      });
      expect(sent.statusCode).toBe(200);
      const { messages } = (await sender.server.inject({ method: "GET", url: "/api/mesh/outbound" })).json() as {
        messages: (Record<string, unknown> & { id: string })[];
      };
      return messages.find((message) => !before.has(message.id))!;
    }

    function strangerBlob(id: string): Record<string, unknown> {
      const stranger = createMeshIdentity();
      const sender = createMeshIdentity();
      const now = Date.now();
      const ttlExpiresAt = now + 3_600_000;
      const toTag = mailboxTag(stranger.mailboxToken, currentEpoch(now, 24 * 3_600_000));
      const sealed = sealMailbox({
        recipientKxPublic: stranger.kxPublic,
        sender: { signPublic: sender.signPublic, signSecret: sender.signSecret, kxPublic: sender.kxPublic },
        plaintext: id,
        aad: `${toTag}|${ttlExpiresAt}`,
      });
      return { id, type: "sealed", authorId: "mesh.sealed", createdAt: now, toTag, sealed, ttlExpiresAt, hopLimit: 3 };
    }

    it("answers a delivered, a carried and a dropped blob identically", async () => {
      const sender = await makeApp({ mesh: MESH });
      const alice = await adminOf(sender);
      for (const relay of [false, true]) {
        const node = await makeApp({ mesh: { ...MESH, relay } });
        const bob = await adminOf(node);
        const forBob = await sealedFor(sender, alice.cookie, await meshCard(node, bob.cookie));
        const answers = new Set<string>();
        for (const message of [forBob, strangerBlob(`seal_stranger_${String(relay)}`)]) {
          const response = await node.server.inject({ method: "POST", url: "/api/mesh/inbound", payload: { messages: [message] } });
          expect(response.statusCode).toBe(200);
          answers.add(response.body);
        }
        expect([...answers]).toEqual([JSON.stringify({ ok: true })]);
      }
    });

    it("refuses new blobs once the radio's quota is spent — mail for a local user too — and never passes the global cap", async () => {
      const sender = await makeApp({ mesh: MESH });
      const alice = await adminOf(sender);
      const node = await makeApp({ mesh: { ...MESH, relay: false } });
      const bob = await adminOf(node);
      const forBob = await sealedFor(sender, alice.cookie, await meshCard(node, bob.cookie));
      const now = Date.now();
      node.store.transaction(() => {
        for (let index = 0; index < 50_000; index += 1) {
          node.store.markSealedOfferSeen(`seal_junk_${index}`, now + 86_400_000, "radio", now);
        }
      });
      // Refused before any mark or delivery: uniform, so it says nothing about the recipient.
      expect(await inbound(node, [forBob])).toBe(0);
      expect(node.store.isSealedOfferSeen(forBob.id as string, Date.now())).toBe(false);
      expect(node.store.countSealedOffersSeen(Date.now(), "radio")).toBe(50_000);

      // The global cap binds the radio too, however few marks it holds: one neighbour can't stop every sync
      // peer's sealed pulls by pushing the record past it.
      const relay = await makeApp({ mesh: MESH });
      relay.store.transaction(() => {
        for (const source of ["http://peer-0", "http://peer-1", "http://peer-2", "http://peer-3"]) {
          for (let index = 0; index < 50_000; index += 1) {
            relay.store.markSealedOfferSeen(`seal_${source.slice(-6)}_${index}`, now + 86_400_000, source, now);
          }
        }
      });
      expect(await inbound(relay, [strangerBlob("seal_radio_0"), strangerBlob("seal_radio_1")])).toBe(0);
      expect(relay.store.countSealedOffersSeen(Date.now())).toBe(200_000);
      expect(relay.store.countSealedOffersSeen(Date.now(), "radio")).toBe(0);
    });
  });

  describe("bridge authorization (review 2026-09-25 #12)", () => {
    it("404s on a host with NO launcher token even from loopback (desktop/Pi: a same-host proxy makes every LAN client loopback)", async () => {
      const app = await makeApp({ mesh: MESH }, { hostToken: undefined });
      for (const headers of [{}, { "x-loam-host-token": "" }, { "x-loam-host-token": HOST_TOKEN }]) {
        expect((await app.server.inject({ method: "GET", url: "/api/mesh/outbound", headers })).statusCode).toBe(404);
        expect(
          (await app.server.inject({ method: "POST", url: "/api/mesh/inbound", headers, payload: { messages: [] } })).statusCode,
        ).toBe(404);
      }
    });

    it("under REQUIRED transport mode, a tokenless loopback hit gets no bridge exemption (401, not the handler)", async () => {
      const app = await makeApp(
        { mesh: MESH, security: { profile: "custom", transportEncryption: "required" } },
        { hostToken: undefined },
      );
      const out = await app.server.inject({ method: "GET", url: "/api/mesh/outbound", headers: {} });
      expect(out.statusCode).toBe(401);
    });

    it("serves the launcher's courier (loopback + the right token) and nobody else", async () => {
      const app = await makeApp({ mesh: MESH });
      const outbound = (headers: Record<string, string>, remoteAddress?: string) =>
        app.server.inject({ method: "GET", url: "/api/mesh/outbound", headers, ...(remoteAddress ? { remoteAddress } : {}) });
      expect((await outbound({ "x-loam-host-token": HOST_TOKEN })).statusCode).toBe(200);
      expect((await outbound({ "x-loam-host-token": "wrong" })).statusCode).toBe(404);
      expect((await outbound({ "x-loam-host-token": HOST_TOKEN }, "192.168.4.7")).statusCode).toBe(404);
    });
  });
});
