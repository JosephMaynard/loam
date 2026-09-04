// The opportunistic-mesh sealed-mail layer (docs/16): per-user mesh identities and contacts, sealing,
// deliver-or-relay, and the expiry reaper. Extracted verbatim from app.ts (2026-09-04 split) behind the
// shared `Runtime` view.
import { type MeshIdentity, createMeshIdentity, currentEpoch, mailboxTag, meshIdFromSignPublic, openMailbox, sealMailbox, verifyKxBinding } from "@loam/crypto";
import { type MeshIdentityCard, MeshIdentityCardSchema, MessageSchema, type SealedMessage, UserSchema } from "@loam/schema";
import { makeUser } from "./identity.js";
import { newMessageId } from "./ids.js";
import type { Runtime } from "./runtime.js";

export function createMeshLayer(rt: Runtime) {
  /**
   * Delete messages older than the configured retention TTL (ephemeral messages): remove them from
   * memory and the rt.store, and rt.broadcast `messageDeleted` so connected clients drop them from their
   * local caches too. In-flight streaming messages are spared until they finish. No-op when no TTL
   * is configured.
   */
  /** Drop sealed mailbox mail past its own `ttlExpiresAt` (independent of retention). Deleted +
   * tombstoned so a peer can't re-hand it; never rt.broadcast (clients never saw the blob). This, with
   * the hop limit and per-carrier cap, is what makes carried mail converge instead of flood. Runs
   * regardless of `mesh.enabled` so turning mesh off doesn't strand already-expired sealed rows. */
  function reapExpiredSealed(): void {
    const now = Date.now();
    const expired = rt.data.messages.filter(
      (message): message is SealedMessage => message.type === "sealed" && message.ttlExpiresAt <= now,
    );
    if (!expired.length) {
      return;
    }
    const ids = new Set(expired.map((message) => message.id));
    rt.store.transaction(() => {
      for (const id of ids) {
        rt.store.deleteMessage(id);
        rt.store.addTombstone(id);
      }
    });
    for (const id of ids) {
      rt.tombstones.add(id);
    }
    rt.data.messages = rt.data.messages.filter((message) => !ids.has(message.id));
    rt.log.info(`Mesh reaper dropped ${ids.size} expired sealed message(s)`);
  }

  const MESH_EPOCH_WINDOW_MS = 24 * 3_600_000; // daily routing-tag epoch
  const MESH_SENTINEL_AUTHOR = "mesh.sealed"; // opaque authorId on a sealed message (real sender is inside)
  // Local users' mesh keypairs (userId → identity), mirrored from the rt.store. Secret keys stay here.
  const meshIdentities = new Map<string, MeshIdentity>();

  function loadMeshIdentities(): void {
    for (const { userId, data: json } of rt.store.loadMeshIdentities()) {
      try {
        meshIdentities.set(userId, JSON.parse(json) as MeshIdentity);
      } catch {
        // Skip a corrupt row rather than crash boot.
      }
    }
  }

  // Per-local-user mesh address book (ownerUserId → recipient meshId → the recipient's card). A card
  // carries the contact's secret mailbox token, so it lives here (not on the public user record) and is
  // exchanged deliberately (QR/paste), never synced. Sealing to a contact is the ONLY send path: it
  // needs the token, and the card's self-certifying meshId defeats the key-substitution a synced
  // identityKey couldn't (docs/16).
  const meshContacts = new Map<string, Map<string, MeshIdentityCard>>();

  function loadMeshContacts(): void {
    for (const { ownerUserId, meshId, data: json } of rt.store.loadMeshContacts()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch {
        continue; // corrupt JSON — skip rather than crash boot
      }
      // Re-validate on the way in: a stored row could have been tampered with. The card must parse,
      // its row key must match the card's own id, and it must still be self-certifying + key-bound —
      // exactly the checks addMeshContact applied before it was ever stored.
      const result = MeshIdentityCardSchema.safeParse(parsed);
      if (
        !result.success ||
        result.data.meshId !== meshId ||
        meshIdFromSignPublic(result.data.sign) !== result.data.meshId ||
        !verifyKxBinding(result.data.sign, result.data.kx, result.data.kxSig)
      ) {
        continue;
      }
      let book = meshContacts.get(ownerUserId);
      if (!book) {
        book = new Map();
        meshContacts.set(ownerUserId, book);
      }
      book.set(meshId, result.data);
    }
  }

  /** Mint (if needed) and publish a local human user's mesh identity — the public keys land on the
   * user's `identityKey` so senders on other nodes can seal mail to them. No-op when mesh is off. */
  function ensureMeshIdentity(userId: string): MeshIdentity | undefined {
    if (!rt.appConfig.mesh.enabled) {
      return undefined;
    }

    const user = rt.data.users.find((candidate) => candidate.id === userId);
    if (!user || user.type !== "human" || user.banned) {
      return undefined;
    }

    let identity = meshIdentities.get(userId);
    if (!identity) {
      identity = createMeshIdentity();
      meshIdentities.set(userId, identity);
      rt.store.upsertMeshIdentity(userId, JSON.stringify(identity));
    }

    const identityKey = {
      alg: "ed25519" as const,
      sign: identity.signPublic,
      kx: identity.kxPublic,
      kxSig: identity.kxSig,
    };
    if (JSON.stringify(user.identityKey) !== JSON.stringify(identityKey)) {
      const next = UserSchema.parse({ ...user, identityKey });
      rt.store.upsertUser(next);
      Object.assign(user, next);
      rt.broadcast({ type: "userUpserted", user });
    }
    return identity;
  }

  /** Publish mesh identities for every eligible local user (boot + whenever mesh is enabled). */
  function ensureAllMeshIdentities(): void {
    if (!rt.appConfig.mesh.enabled) {
      return;
    }
    for (const user of rt.data.users) {
      if (user.type === "human" && !user.banned) {
        ensureMeshIdentity(user.id);
      }
    }
  }

  /** Immutable relay metadata authenticated by the envelope (AEAD AAD + inner signature): a carrier
   * can't extend the TTL or retarget the tag without breaking decryption. (v1 binds toTag+TTL; the
   * original hop budget is bounded by the schema max instead — docs/16.) */
  function sealedAad(toTag: string, ttlExpiresAt: number): string {
    return `${toTag}|${ttlExpiresAt}`;
  }

  /** Routing tags a local identity answers to across the live TTL window (+ one epoch clock-skew).
   * Derived from the identity's SECRET mailbox token, so only the recipient and the senders it handed
   * a card to can compute them — a passive carrier holding the sealed blob cannot correlate it to a
   * recipient (metadata-unlinkability; docs/16 §2). A sender computes the same tag from the contact's
   * `mailboxToken`, which it obtained out-of-band with the rest of the card. */
  function localTagsForWindow(identity: MeshIdentity, now: number): Set<string> {
    const tags = new Set<string>();
    const start = currentEpoch(now - rt.appConfig.mesh.ttlMs, MESH_EPOCH_WINDOW_MS);
    const end = currentEpoch(now + MESH_EPOCH_WINDOW_MS, MESH_EPOCH_WINDOW_MS);
    for (let epoch = start; epoch <= end; epoch += 1) {
      tags.add(mailboxTag(identity.mailboxToken, epoch));
    }
    return tags;
  }

  /** Ensure a display record exists for a remote mesh sender and make it resolvable to `recipientUserId`
   * ONLY — never via the shared roster or a global rt.broadcast. Putting a mesh sender on the public
   * roster would leak that some local user just received sealed mail (docs/16); `rt.visibleUsers` hides
   * these ids from everyone but the recipients they've mailed, and this notifies just the recipient. */
  function ensureMeshSenderUser(meshId: string, recipientUserId: string): void {
    let user = rt.data.users.find((candidate) => candidate.id === meshId);
    if (!user) {
      // Persist first, then mirror in memory — but no global rt.broadcast (unlike rt.ensureUser).
      user = makeUser(meshId);
      rt.store.upsertUser(user);
      rt.data.users.push(user);
    }
    // Idempotent on the recipient's client; sent every delivery so a second recipient of the same
    // sender still learns the record without it ever reaching a third party.
    rt.sendEventToUsers(new Set([recipientUserId]), { type: "userUpserted", user: rt.publicUser(user) });
  }

  /** Deliver an opened sealed message to a local user as an ordinary DM from the sender's mesh id. */
  function deliverSealedAsDm(recipientUserId: string, senderMeshId: string, plaintext: string, now: number): void {
    ensureMeshSenderUser(senderMeshId, recipientUserId); // display-only, recipient-scoped (not the shared roster)
    const dm = MessageSchema.parse({
      id: newMessageId("mesh"),
      type: "dm",
      authorId: senderMeshId,
      recipientUserId,
      body: plaintext,
      createdAt: now,
      meta: { source: "system" },
    });
    rt.store.insertMessage(dm);
    rt.data.messages.push(dm);
    rt.broadcast({ type: "messageCreated", message: dm });
  }

  /** Try to open a sealed blob for one of our local users and deliver it. Returns true when it was
   * ours (delivered + tombstoned so it isn't re-imported or carried further). */
  function tryDeliverSealed(message: SealedMessage): boolean {
    const now = Date.now();
    if (message.ttlExpiresAt <= now) {
      return false;
    }

    const aad = sealedAad(message.toTag, message.ttlExpiresAt);
    for (const [recipientUserId, identity] of meshIdentities) {
      if (!localTagsForWindow(identity, now).has(message.toTag)) {
        continue; // cheap tag pre-check before an ECDH decrypt attempt
      }
      const opened = openMailbox({ blob: message.sealed, recipientKxSecret: identity.kxSecret, aad });
      if (!opened) {
        continue; // not actually ours, or tampered
      }
      // Sealed mail lands as a DM, so it obeys the node's DM policy like every other DM
      // (`rt.createMessage` refuses DMs when the flag is off). With DMs disabled the mail is ours but
      // undeliverable: drop it — and tombstone it so it isn't carried/re-offered forever — rather than
      // materialise a DM the operator switched off (review 2026-09-04, mirrors the shadow-ban drop).
      if (rt.appConfig.features.enableDMs) {
        deliverSealedAsDm(recipientUserId, opened.senderMeshId, opened.plaintext, now);
      } else {
        rt.log.info({ messageId: message.id }, "Dropped sealed mesh mail: direct messages are disabled on this node");
      }
      rt.store.addTombstone(message.id);
      rt.tombstones.add(message.id);
      return true;
    }
    return false;
  }

  /** Handle a sealed message pulled from a peer: deliver locally, else relay onward (hop-decremented,
   * bounded), else drop. Never rt.broadcast to clients. Returns true when accepted (delivered or carried). */
  function acceptSealedFromPeer(message: SealedMessage): boolean {
    if (!rt.appConfig.mesh.enabled) {
      return false;
    }
    const now = Date.now();
    if (message.ttlExpiresAt <= now || message.hopLimit <= 0 || rt.tombstones.has(message.id)) {
      return false;
    }
    if (rt.data.messages.some((candidate) => candidate.id === message.id)) {
      return false; // already hold it
    }
    if (tryDeliverSealed(message)) {
      return true;
    }
    // Not for a local user → carry it onward, if this node relays and has room.
    if (!rt.appConfig.mesh.relay) {
      return false;
    }
    const carried = rt.data.messages.reduce((count, candidate) => count + (candidate.type === "sealed" ? 1 : 0), 0);
    if (carried >= rt.appConfig.mesh.maxCarried) {
      return false; // at capacity — refuse new mail (soonest-to-expire eviction is a v2 refinement)
    }
    const relayed = MessageSchema.parse({ ...message, hopLimit: message.hopLimit - 1 });
    rt.store.insertMessage(relayed);
    rt.data.messages.push(relayed);
    return true; // opaque — no client rt.broadcast
  }

  /** Verify and rt.store a mesh contact card in `ownerUserId`'s address book. Rejects a card whose
   * self-certifying `meshId` doesn't derive from its signing key, or whose `kxSig` doesn't bind its
   * agreement key — the two checks that make sealing to a contact immune to key substitution. The
   * card (name included) stays in the caller's private address book; it is NOT promoted to a shared
   * roster user, so one local user's contacts aren't exposed to the others. Returns an error string
   * on failure. */
  function addMeshContact(ownerUserId: string, card: MeshIdentityCard): string | undefined {
    if (meshIdFromSignPublic(card.sign) !== card.meshId) {
      return "This mesh card is invalid (id does not match its key).";
    }
    if (!verifyKxBinding(card.sign, card.kx, card.kxSig)) {
      return "This mesh card is invalid (key binding failed).";
    }
    let book = meshContacts.get(ownerUserId);
    if (!book) {
      book = new Map();
      meshContacts.set(ownerUserId, book);
    }
    // Bound the address book so an authenticated client can't grow mesh_contacts without limit.
    // Re-adding an existing contact (a key/name refresh) is always allowed — only NEW ids are capped.
    if (!book.has(card.meshId) && book.size >= rt.appConfig.mesh.maxContacts) {
      return "Your mesh contact list is full.";
    }
    // Persist first, then mirror in memory — if the rt.store write throws, the book doesn't diverge.
    rt.store.upsertMeshContact(ownerUserId, card.meshId, JSON.stringify(card));
    book.set(card.meshId, card);
    return undefined;
  }

  /** The current user's own shareable mesh identity card — public keys PLUS the secret mailbox token,
   * so a recipient can be sealed to. Returned only over the authenticated identity endpoint. */
  function meshIdentityCard(identity: MeshIdentity, displayName: string): MeshIdentityCard {
    return {
      meshId: identity.meshId,
      alg: "ed25519",
      sign: identity.signPublic,
      kx: identity.kxPublic,
      kxSig: identity.kxSig,
      mailboxToken: identity.mailboxToken,
      displayName,
    };
  }

  /** Seal a message to a contact (a card the sender previously added) and inject it into the mesh:
   * delivered immediately if the recipient is local, else stored for sync to carry. Returns an error
   * string on failure. */
  function sendSealed(sender: MeshIdentity, contact: MeshIdentityCard, body: string): string | undefined {
    // Bound self-originated mail by the same per-node storage cap as relayed mail, so a local
    // participant can't fill the rt.store with undeliverable sealed blobs (they persist until TTL).
    const carried = rt.data.messages.reduce((count, message) => count + (message.type === "sealed" ? 1 : 0), 0);
    if (carried >= rt.appConfig.mesh.maxCarried) {
      return "This node's sealed-mail queue is full; try again later.";
    }
    const now = Date.now();
    const ttlExpiresAt = now + rt.appConfig.mesh.ttlMs;
    const toTag = mailboxTag(contact.mailboxToken, currentEpoch(now, MESH_EPOCH_WINDOW_MS));
    const aad = sealedAad(toTag, ttlExpiresAt);
    const blob = sealMailbox({
      recipientKxPublic: contact.kx,
      sender: { signPublic: sender.signPublic, signSecret: sender.signSecret, kxPublic: sender.kxPublic },
      plaintext: body,
      aad,
    });
    const message = MessageSchema.parse({
      id: newMessageId("seal"),
      type: "sealed",
      authorId: MESH_SENTINEL_AUTHOR,
      toTag,
      sealed: blob,
      ttlExpiresAt,
      hopLimit: rt.appConfig.mesh.hopLimit,
      createdAt: now,
    }) as SealedMessage;

    // If the recipient is local, deliver now; otherwise rt.store it so the sync layer carries it.
    if (!tryDeliverSealed(message)) {
      rt.store.insertMessage(message);
      rt.data.messages.push(message);
    }
    return undefined;
  }

  return {
    MESH_SENTINEL_AUTHOR,
    meshIdentities,
    loadMeshIdentities,
    meshContacts,
    loadMeshContacts,
    ensureMeshIdentity,
    ensureAllMeshIdentities,
    localTagsForWindow,
    acceptSealedFromPeer,
    addMeshContact,
    meshIdentityCard,
    sendSealed,
    reapExpiredSealed,
  };
}

export type MeshLayer = ReturnType<typeof createMeshLayer>;
