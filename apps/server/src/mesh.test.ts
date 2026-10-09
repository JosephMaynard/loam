import { afterEach, describe, expect, it } from "vitest";

import { currentEpoch, mailboxTag } from "@loam/crypto";
import { MeshIdentityCardSchema, type MeshIdentityCard } from "@loam/schema";

import type { LoamApp } from "./app.js";
import { type InjectResponse, makeApp, newSession, teardownApps } from "./test-support/app-harness.js";

afterEach(teardownApps);

describe("opportunistic mesh: sealed mailbox", () => {
  const MESH = { enabled: true, relay: true, ttlMs: 3_600_000, hopLimit: 6, maxCarried: 1000, maxContacts: 1000 };

  function listen(app: LoamApp): Promise<string> {
    return app.server.listen({ host: "127.0.0.1", port: 0 });
  }
  async function adminOf(app: LoamApp): Promise<{ cookie: string; userId: string }> {
    const session = await newSession(app);
    return { cookie: session.cookie, userId: session.userId };
  }
  function setPeers(app: LoamApp, cookie: string, urls: string[]): Promise<InjectResponse> {
    return app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie },
      payload: { sync: { peers: urls.map((url) => ({ url })) } },
    });
  }
  function syncNow(app: LoamApp, cookie: string): Promise<InjectResponse> {
    return app.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie } });
  }
  async function roster(app: LoamApp, cookie: string): Promise<{ id: string }[]> {
    return (await app.server.inject({ method: "GET", url: "/api/users", headers: { cookie } })).json() as {
      id: string;
    }[];
  }
  async function dmBodies(app: LoamApp, cookie: string, peerId: string): Promise<string[]> {
    return (
      (
        await app.server.inject({ method: "GET", url: `/api/dms/${peerId}`, headers: { cookie } })
      ).json() as { body?: string }[]
    ).map((message) => message.body ?? "");
  }
  /** Fetch a user's shareable mesh identity card (the out-of-band contact exchange). */
  async function meshCard(app: LoamApp, cookie: string): Promise<MeshIdentityCard> {
    const res = await app.server.inject({ method: "GET", url: "/api/mesh/identity", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    return MeshIdentityCardSchema.parse(res.json());
  }
  /** Add a mesh card to the caller's address book (POST /api/mesh/contacts). */
  function addContact(app: LoamApp, cookie: string, card: MeshIdentityCard): Promise<InjectResponse> {
    return app.server.inject({ method: "POST", url: "/api/mesh/contacts", headers: { cookie }, payload: card });
  }

  it("404s /api/mesh/messages when mesh is disabled", async () => {
    const app = await makeApp();
    const user = await newSession(app);
    const res = await app.server.inject({
      method: "POST",
      url: "/api/mesh/messages",
      headers: { cookie: user.cookie },
      payload: { toMeshId: "mesh.absent", body: "hi" },
    });
    expect(res.statusCode).toBe(404);
    // The whole mesh surface is absent when disabled — identity + contacts too.
    expect((await app.server.inject({ method: "GET", url: "/api/mesh/identity", headers: { cookie: user.cookie } })).statusCode).toBe(404);
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: "/api/mesh/contacts",
          headers: { cookie: user.cookie },
          payload: { meshId: "mesh.absent", alg: "ed25519", sign: "AA", kx: "AA", kxSig: "AA", mailboxToken: "AA" },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("delivers sealed mail to a contact as a DM (card exchange + seal + open on one node)", async () => {
    const app = await makeApp({ mesh: MESH });
    const alice = await newSession(app);
    const bob = await newSession(app); // both get mesh identities via the session hook

    // Alice adds Bob out-of-band (his card), then seals to his self-certifying mesh id.
    const bobCard = await meshCard(app, bob.cookie);
    expect((await addContact(app, alice.cookie, bobCard)).statusCode).toBe(200);

    const send = await app.server.inject({
      method: "POST",
      url: "/api/mesh/messages",
      headers: { cookie: alice.cookie },
      payload: { toMeshId: bobCard.meshId, body: "meet at the old bridge" },
    });
    expect(send.statusCode).toBe(200);

    // Delivery creates a "mesh.<sender>" contact and a DM to Bob from it.
    const contact = (await roster(app, bob.cookie)).find((entry) => entry.id.startsWith("mesh."));
    expect(contact).toBeDefined();
    expect(await dmBodies(app, bob.cookie, contact!.id)).toContain("meet at the old bridge");
  });

  it("keeps a mesh sender off the shared roster — visible only to the recipient it mailed", async () => {
    const app = await makeApp({ mesh: MESH });
    const alice = await newSession(app);
    const bob = await newSession(app);
    const carol = await newSession(app); // uninvolved third party on the same node

    const bobCard = await meshCard(app, bob.cookie);
    expect((await addContact(app, alice.cookie, bobCard)).statusCode).toBe(200);
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: "/api/mesh/messages",
          headers: { cookie: alice.cookie },
          payload: { toMeshId: bobCard.meshId, body: "quiet word" },
        })
      ).statusCode,
    ).toBe(200);

    // Bob (the recipient) resolves the mesh sender in his roster...
    expect((await roster(app, bob.cookie)).some((entry) => entry.id.startsWith("mesh."))).toBe(true);
    // ...but Carol never learns a mesh sender appeared (no leak that Bob received sealed mail).
    expect((await roster(app, carol.cookie)).some((entry) => entry.id.startsWith("mesh."))).toBe(false);
  });

  it("404s a send to a mesh id that isn't a contact (sealing requires an added card)", async () => {
    const app = await makeApp({ mesh: MESH });
    const alice = await newSession(app);
    const bob = await newSession(app);
    const bobCard = await meshCard(app, bob.cookie);
    // Alice never added Bob → cannot seal to him even though his id self-certifies.
    const send = await app.server.inject({
      method: "POST",
      url: "/api/mesh/messages",
      headers: { cookie: alice.cookie },
      payload: { toMeshId: bobCard.meshId, body: "hi" },
    });
    expect(send.statusCode).toBe(404);
  });

  it("rejects a forged mesh card (id/key mismatch and bad kx binding) so it can't be sealed to", async () => {
    const app = await makeApp({ mesh: MESH });
    const alice = await newSession(app);
    const bob = await newSession(app);
    const mallory = await newSession(app);
    const bobCard = await meshCard(app, bob.cookie);
    const malloryCard = await meshCard(app, mallory.cookie);

    // Substitution attempt: Bob's id but Mallory's keys — meshId no longer derives from `sign`.
    const forgedId = { ...malloryCard, meshId: bobCard.meshId };
    expect((await addContact(app, alice.cookie, forgedId)).statusCode).toBe(400);

    // Tampered binding: valid id/sign, but kx swapped for Mallory's (kxSig no longer binds).
    const forgedKx = { ...bobCard, kx: malloryCard.kx };
    expect((await addContact(app, alice.cookie, forgedKx)).statusCode).toBe(400);

    // Neither forgery was stored, so a send to Bob's id 404s (no contact).
    const send = await app.server.inject({
      method: "POST",
      url: "/api/mesh/messages",
      headers: { cookie: alice.cookie },
      payload: { toMeshId: bobCard.meshId, body: "hijack" },
    });
    expect(send.statusCode).toBe(404);
  });

  it("rejects a malformed mesh card (non-base64url key field) with 400, never a 500", async () => {
    const app = await makeApp({ mesh: MESH });
    const alice = await newSession(app);
    const bob = await newSession(app);
    const bobCard = await meshCard(app, bob.cookie);

    // A garbage `sign`/`mailboxToken` would otherwise reach the crypto's base64url decoder (which
    // throws) — the schema must reject it at the boundary as a clean 400.
    for (const bad of [
      { ...bobCard, sign: "!!!not-base64!!!" },
      { ...bobCard, mailboxToken: "has spaces" },
    ]) {
      expect((await addContact(app, alice.cookie, bad)).statusCode).toBe(400);
    }
    // And no forged card was stored, so a later send to Bob's id still 404s (no 500 anywhere).
    const send = await app.server.inject({
      method: "POST",
      url: "/api/mesh/messages",
      headers: { cookie: alice.cookie },
      payload: { toMeshId: bobCard.meshId, body: "hi" },
    });
    expect(send.statusCode).toBe(404);
  });

  it("caps the mesh address book at mesh.maxContacts (new ids blocked, refreshes allowed)", async () => {
    const app = await makeApp({ mesh: { ...MESH, maxContacts: 1 } });
    const alice = await newSession(app);
    const bob = await newSession(app);
    const mallory = await newSession(app);
    const bobCard = await meshCard(app, bob.cookie);
    const malloryCard = await meshCard(app, mallory.cookie);

    expect((await addContact(app, alice.cookie, bobCard)).statusCode).toBe(200);
    // A second DISTINCT contact exceeds the cap of 1.
    expect((await addContact(app, alice.cookie, malloryCard)).statusCode).toBe(400);
    // Re-adding an existing contact (a key/name refresh) is still allowed at the cap.
    expect((await addContact(app, alice.cookie, bobCard)).statusCode).toBe(200);
  });

  it("silently drops a shadow-banned sender's sealed mail (200, but nothing delivered)", async () => {
    const app = await makeApp({ mesh: MESH });
    const admin = await newSession(app); // firstUser → admin (can moderate)
    const spammer = await newSession(app);
    const bob = await newSession(app);

    const bobCard = await meshCard(app, bob.cookie);
    expect((await addContact(app, spammer.cookie, bobCard)).statusCode).toBe(200);

    await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${spammer.userId}`,
      headers: { cookie: admin.cookie },
      payload: { shadowBanned: true },
    });

    // The send looks successful to the shadow-banned sender...
    const send = await app.server.inject({
      method: "POST",
      url: "/api/mesh/messages",
      headers: { cookie: spammer.cookie },
      payload: { toMeshId: bobCard.meshId, body: "spam spam spam" },
    });
    expect(send.statusCode).toBe(200);

    // ...but nothing was sealed or delivered — Bob has no mesh contact / DM.
    expect((await roster(app, bob.cookie)).some((entry) => entry.id.startsWith("mesh."))).toBe(false);
  });

  it("carries A→C→B: an intermediary relays sealed mail it cannot read", async () => {
    const nodeA = await makeApp({ sync: { enabled: true }, mesh: MESH });
    const nodeB = await makeApp({ sync: { enabled: true }, mesh: MESH });
    const nodeC = await makeApp({ sync: { enabled: true }, mesh: MESH });
    const aAdmin = await adminOf(nodeA);
    const bob = await adminOf(nodeB); // Bob is node B's real (admin) session user, not a seed
    const cAdmin = await adminOf(nodeC);

    const [aUrl, bUrl, cUrl] = await Promise.all([listen(nodeA), listen(nodeB), listen(nodeC)]);
    // Pull topology: C carries from A; B receives from C — A and B never meet directly.
    expect((await setPeers(nodeA, aAdmin.cookie, [bUrl])).statusCode).toBe(200);
    expect((await setPeers(nodeC, cAdmin.cookie, [aUrl])).statusCode).toBe(200);
    expect((await setPeers(nodeB, bob.cookie, [cUrl])).statusCode).toBe(200);

    // Alice and Bob exchange cards out-of-band (no reliance on public-post sync); Alice adds Bob.
    const bobCard = await meshCard(nodeB, bob.cookie);
    expect((await addContact(nodeA, aAdmin.cookie, bobCard)).statusCode).toBe(200);

    // Alice (node A) seals a message to Bob's mesh id.
    const send = await nodeA.server.inject({
      method: "POST",
      url: "/api/mesh/messages",
      headers: { cookie: aAdmin.cookie },
      payload: { toMeshId: bobCard.meshId, body: "the rendezvous is at dawn" },
    });
    expect(send.statusCode).toBe(200);

    await syncNow(nodeC, cAdmin.cookie); // C carries the sealed blob from A (cannot open it)
    await syncNow(nodeB, bob.cookie); // B pulls from C, recognises the tag, decrypts, delivers

    // Bob received the plaintext.
    const contact = (await roster(nodeB, bob.cookie)).find((entry) => entry.id.startsWith("mesh."));
    expect(contact).toBeDefined();
    expect(await dmBodies(nodeB, bob.cookie, contact!.id)).toContain("the rendezvous is at dawn");

    // The carrier C holds the sealed blob but never learned the plaintext — no DM anywhere on C
    // contains the secret, and its stored copy is opaque ciphertext.
    const cMessages = (
      await nodeC.server.inject({ method: "GET", url: "/api/messages/general", headers: { cookie: cAdmin.cookie } })
    ).json() as { body?: string }[];
    expect(cMessages.some((m) => (m.body ?? "").includes("dawn"))).toBe(false);
    // C carried it: its store holds a sealed-type message whose serialized form doesn't contain the plaintext.
    const cStored = nodeC.store.loadMessages();
    const sealed = cStored.find((m) => m.type === "sealed");
    expect(sealed).toBeDefined();
    expect(JSON.stringify(sealed)).not.toContain("dawn");

    // Metadata privacy: the routing tag is derived from Bob's SECRET mailbox token, not his public kx —
    // so a carrier holding only public key material (as v1 leaked) cannot recompute it. The sealer
    // stamped `ttlExpiresAt = sendTime + ttlMs`, so we recover the exact send-time epoch.
    const sealedMsg = sealed as { ttlExpiresAt: number; toTag: string };
    const epoch = currentEpoch(sealedMsg.ttlExpiresAt - MESH.ttlMs, 24 * 3_600_000);
    expect(sealedMsg.toTag).toBe(mailboxTag(bobCard.mailboxToken, epoch));
    expect(sealedMsg.toTag).not.toBe(mailboxTag(bobCard.kx, epoch));
  });

  describe("group/broadcast fan-out (POST /api/mesh/broadcast)", () => {
    /** Broadcast one sealed message to several contacts in one call. */
    function broadcast(app: LoamApp, cookie: string, toMeshIds: string[], body: string): Promise<InjectResponse> {
      return app.server.inject({
        method: "POST",
        url: "/api/mesh/broadcast",
        headers: { cookie },
        payload: { toMeshIds, body },
      });
    }

    it("404s /api/mesh/broadcast when mesh is disabled", async () => {
      const app = await makeApp();
      const user = await newSession(app);
      const res = await broadcast(app, user.cookie, ["mesh.absent"], "hi");
      expect(res.statusCode).toBe(404);
    });

    it("seals an independent copy to each of 3 contacts, with distinct tags/ciphertext, and delivers to all", async () => {
      // Bob, Carol, and Dave live on node B; Alice (the sender) is on node A, so their sealed copies
      // are stored (not delivered in-process) until sync carries them — letting us inspect the
      // per-recipient blobs before they're opened.
      const nodeA = await makeApp({ sync: { enabled: true }, mesh: MESH });
      const nodeB = await makeApp({ sync: { enabled: true }, mesh: MESH });
      const alice = await adminOf(nodeA);
      const bob = await adminOf(nodeB);
      const carol = await newSession(nodeB);
      const dave = await newSession(nodeB);

      const [aUrl] = await Promise.all([listen(nodeA), listen(nodeB)]);
      // B pulls from A (the courier direction: A holds the sealed blobs after sending).
      expect((await setPeers(nodeB, bob.cookie, [aUrl])).statusCode).toBe(200);

      const bobCard = await meshCard(nodeB, bob.cookie);
      const carolCard = await meshCard(nodeB, carol.cookie);
      const daveCard = await meshCard(nodeB, dave.cookie);
      for (const card of [bobCard, carolCard, daveCard]) {
        expect((await addContact(nodeA, alice.cookie, card)).statusCode).toBe(200);
      }

      const res = await broadcast(
        nodeA,
        alice.cookie,
        [bobCard.meshId, carolCard.meshId, daveCard.meshId],
        "assemble at noon",
      );
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, sent: 3, skipped: [] });

      // Node A stored 3 independently-sealed copies — one per recipient, each with its own routing
      // tag (derived from that recipient's secret mailbox token) and its own ciphertext (fresh
      // ephemeral key per seal), never a shared key across recipients.
      const sealedRows = nodeA.store.loadMessages().filter((message) => message.type === "sealed") as {
        toTag: string;
        sealed: string;
      }[];
      expect(sealedRows).toHaveLength(3);
      expect(new Set(sealedRows.map((row) => row.toTag)).size).toBe(3);
      expect(new Set(sealedRows.map((row) => row.sealed)).size).toBe(3);

      // Sync carries all 3 blobs to node B, which recognises each tag against its local recipient and
      // decrypts+delivers independently.
      await syncNow(nodeB, bob.cookie);

      for (const recipient of [
        { session: bob, card: bobCard },
        { session: carol, card: carolCard },
        { session: dave, card: daveCard },
      ]) {
        const contact = (await roster(nodeB, recipient.session.cookie)).find((entry) => entry.id.startsWith("mesh."));
        expect(contact).toBeDefined();
        expect(await dmBodies(nodeB, recipient.session.cookie, contact!.id)).toContain("assemble at noon");
      }
    });

    it("reports a toMeshId that isn't a contact in `skipped`, without sending to it", async () => {
      const app = await makeApp({ mesh: MESH });
      const alice = await newSession(app);
      const bob = await newSession(app);
      const carol = await newSession(app);
      const bobCard = await meshCard(app, bob.cookie);
      const carolCard = await meshCard(app, carol.cookie);
      // Alice adds Bob but never adds Carol.
      expect((await addContact(app, alice.cookie, bobCard)).statusCode).toBe(200);

      const res = await broadcast(app, alice.cookie, [bobCard.meshId, carolCard.meshId], "hi");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, sent: 1, skipped: [carolCard.meshId] });

      expect((await roster(app, bob.cookie)).some((entry) => entry.id.startsWith("mesh."))).toBe(true);
      expect((await roster(app, carol.cookie)).some((entry) => entry.id.startsWith("mesh."))).toBe(false);
    });

    it("silently drops a shadow-banned sender's broadcast (200, nothing delivered)", async () => {
      const app = await makeApp({ mesh: MESH });
      const admin = await newSession(app); // firstUser → admin (can moderate)
      const spammer = await newSession(app);
      const bob = await newSession(app);
      const carol = await newSession(app);

      const bobCard = await meshCard(app, bob.cookie);
      const carolCard = await meshCard(app, carol.cookie);
      expect((await addContact(app, spammer.cookie, bobCard)).statusCode).toBe(200);
      expect((await addContact(app, spammer.cookie, carolCard)).statusCode).toBe(200);

      await app.server.inject({
        method: "PATCH",
        url: `/api/moderation/users/${spammer.userId}`,
        headers: { cookie: admin.cookie },
        payload: { shadowBanned: true },
      });

      const res = await broadcast(app, spammer.cookie, [bobCard.meshId, carolCard.meshId], "spam spam spam");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, sent: 0, skipped: [] });

      expect((await roster(app, bob.cookie)).some((entry) => entry.id.startsWith("mesh."))).toBe(false);
      expect((await roster(app, carol.cookie)).some((entry) => entry.id.startsWith("mesh."))).toBe(false);
    });

    it("de-duplicates repeated toMeshIds so a contact is mailed only once", async () => {
      const app = await makeApp({ mesh: MESH });
      const alice = await newSession(app);
      const bob = await newSession(app);
      const bobCard = await meshCard(app, bob.cookie);
      expect((await addContact(app, alice.cookie, bobCard)).statusCode).toBe(200);

      const res = await broadcast(app, alice.cookie, [bobCard.meshId, bobCard.meshId, bobCard.meshId], "hi bob");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, sent: 1, skipped: [] });

      const contact = (await roster(app, bob.cookie)).find((entry) => entry.id.startsWith("mesh."));
      expect(contact).toBeDefined();
      const bodies = await dmBodies(app, bob.cookie, contact!.id);
      expect(bodies.filter((entry) => entry === "hi bob")).toHaveLength(1);
    });
  });
  // The transport-bridge tests (/api/mesh/outbound + inbound) live in mesh-bridge.test.ts: they need the launcher host token.
});

describe("mesh mail gating", () => {
  const MESH = { enabled: true, relay: true, ttlMs: 3_600_000, hopLimit: 6, maxCarried: 1000, maxContacts: 1000 };
  const HOST_TOKEN = "host-token-for-tests-0123456789abcdefghijklmn";

  it("drops sealed mesh mail on a node with direct messages disabled instead of materialising a DM", async () => {
    const app = await makeApp({ mesh: MESH, features: { enableDMs: false } });
    const alice = await newSession(app);
    const bob = await newSession(app);
    const card = await app.server.inject({ method: "GET", url: "/api/mesh/identity", headers: { cookie: bob.cookie } });
    expect(card.statusCode).toBe(200);
    expect(
      (await app.server.inject({ method: "POST", url: "/api/mesh/contacts", headers: { cookie: alice.cookie }, payload: card.json() }))
        .statusCode,
    ).toBe(200);

    const send = await app.server.inject({
      method: "POST",
      url: "/api/mesh/messages",
      headers: { cookie: alice.cookie },
      payload: { toMeshId: (card.json() as { meshId: string }).meshId, body: "not deliverable here" },
    });
    expect(send.statusCode).toBe(200);

    const stored = app.store.loadMessages();
    expect(stored.some((message) => message.type === "dm")).toBe(false);
    // Tombstoned and dropped — not left in the carried queue either.
    expect(stored.some((message) => message.type === "sealed")).toBe(false);
    const dms = await app.server.inject({ method: "GET", url: "/api/users", headers: { cookie: bob.cookie } });
    expect((dms.json() as { id: string }[]).some((user) => user.id.startsWith("mesh."))).toBe(false);
  });

  it("requires the host token on the loopback mesh bridge when the launcher configured one", async () => {
    const app = await makeApp({ mesh: MESH }, { hostToken: HOST_TOKEN });
    const outbound = (headers?: Record<string, string>) =>
      app.server.inject({ method: "GET", url: "/api/mesh/outbound", headers });
    expect((await outbound()).statusCode).toBe(404);
    expect((await outbound({ "x-loam-host-token": "wrong" })).statusCode).toBe(404);
    expect((await outbound({ "x-loam-host-token": HOST_TOKEN })).statusCode).toBe(200);
    // Still loopback-only even with the token.
    expect(
      (
        await app.server.inject({
          method: "GET",
          url: "/api/mesh/outbound",
          headers: { "x-loam-host-token": HOST_TOKEN },
          remoteAddress: "192.168.4.7",
        })
      ).statusCode,
    ).toBe(404);
  });
});
