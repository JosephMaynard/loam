// The opportunistic-mesh sealed-mail layer (docs/16): per-user mesh identities and contacts, sealing,
// deliver-or-relay, and the expiry reaper. Extracted verbatim from app.ts (2026-09-04 split) behind the
// shared `Runtime` view.
import { createHash } from "node:crypto";

import { type MeshIdentity, createMeshIdentity, currentEpoch, isCanonicalSealedBlob, mailboxTag, meshIdFromSignPublic, openMailbox, sealMailbox, verifyKxBinding } from "@loam/crypto";
import { MESH_TTL_MAX_MS, type MeshIdentityCard, MeshIdentityCardSchema, MessageSchema, type SealedMessage, UserSchema } from "@loam/schema";
import { makeUser } from "./identity.js";
import { defaultTombstoneHorizonMs } from "./defaults.js";
import { newMessageId } from "./ids.js";
import type { Runtime } from "./runtime.js";

/** Build the sealed-mail mesh layer over the runtime view (identities, contacts, seal/deliver/relay, expiry). */
export function createMeshLayer(rt: Runtime) {
  /**
   * Delete messages older than the configured retention TTL (ephemeral messages): remove them from
   * memory and the store, and broadcast `messageDeleted` so connected clients drop them from their
   * local caches too. In-flight streaming messages are spared until they finish. No-op when no TTL
   * is configured.
   */
  /** Drop sealed mailbox mail past its own `ttlExpiresAt` (independent of retention). Deleted +
   * tombstoned so a peer can't re-hand it; never broadcast (clients never saw the blob). This, with
   * the hop limit and per-carrier cap, is what makes carried mail converge instead of flood. Runs
   * regardless of `mesh.enabled` so turning mesh off doesn't strand already-expired sealed rows. */
  function reapExpiredSealed(): void {
    const now = Date.now();
    // Seen-offer marks past their retention (`sealedSeenRetentionMs`, which outlives every tombstone the
    // offer could have produced): from here on the id is fetchable again whatever became of it.
    rt.store.pruneSealedOffersSeen(now);
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
  // Local users' mesh keypairs (userId → identity), mirrored from the store. Secret keys stay here.
  const meshIdentities = new Map<string, MeshIdentity>();

  /**
   * Whether `user` is a LOCAL person who may hold a mesh identity on this node: a non-banned human that
   * this node did not import from a sync peer, and not a mesh-sender display record (`mesh.*`). Minting
   * for anyone else (review 2026-09-25 #3) gave every peer-imported user a secret keypair HERE, overwrote
   * the key they published at home (then re-exported that forgery), and let a peer that pushes thousands
   * of users grow `mesh_identities` — and the per-message decrypt loop — without bound.
   */
  function isLocalMeshUser(user: { id: string; type: string; banned?: boolean }): boolean {
    return user.type === "human" && !user.banned && !user.id.startsWith("mesh.") && !rt.store.isUserSynced(user.id);
  }

  // Config-table key marking the one-time legacy provenance backfill below as done.
  const LEGACY_SYNCED_USERS_BACKFILL_KEY = "migration.syncedUsersBackfill.v1";

  /**
   * One-time repair of a database written before sync provenance existed (v0.4.0 and earlier; review
   * 2026-09-25 follow-up). That build imported EVERY user a peer's payload listed, recorded none of them in
   * `synced_users`, and minted a mesh keypair for every human — peer-imported users and `mesh.*` sender
   * records included — publishing it as their `identityKey`. Without provenance, `isLocalMeshUser` can't
   * tell those users from local ones, so the boot purge in {@link loadMeshIdentities} kept the forged keys.
   *
   * A user is marked synced only when ALL of these hold (no single signal is trusted on its own):
   *  - a plain human record (not `mesh.*`/`llm.*`, not already marked);
   *  - NO session row and NO transport identity token — nobody can act as this user on this node any more.
   *    This is the condition the rule's safety rests on: a false positive (a local user wrongly marked)
   *    costs a mesh identity nobody can use, since nobody can sign in as that user. A reachable local user
   *    always has one of the two (a cookie session or a bound identity token);
   *  - no authority or moderation state (admin, roles, pending, banned, shadow-banned, timed out) — imports
   *    always stripped these, so their presence means the record is local;
   *  - no local-only footprint: owns no mesh contacts, blocks, open reports or channel; isn't on a private
   *    roster or join queue; authored or received no DM and wrote nothing in a private channel (none of
   *    that ever syncs).
   * The old build's public posts carry no provenance (`synced_messages` didn't exist), so authorship of
   * public content can't count either way; the reachability test above is what keeps local users safe.
   *
   * `mesh.*` user records are sender display records: one no local DM references was imported from a peer
   * (or is an orphan) and is deleted; one that does is reset to the generated default, dropping any
   * peer-chosen name, avatar or key. The mesh identity rows of every marked user are then purged by the
   * normal loop in {@link loadMeshIdentities}. Guarded by a config-table flag so it runs once per database.
   */
  function backfillLegacySyncedUsers(): void {
    if (rt.store.getConfigValue(LEGACY_SYNCED_USERS_BACKFILL_KEY) !== undefined) {
      return;
    }

    const localFootprint = new Set<string>();
    for (const { userId } of rt.store.loadSessions()) {
      localFootprint.add(userId);
    }
    for (const { userId } of rt.store.loadIdentityTokens()) {
      localFootprint.add(userId);
    }
    for (const { ownerUserId } of rt.store.loadMeshContacts()) {
      localFootprint.add(ownerUserId);
    }
    for (const report of rt.store.loadOpenReports()) {
      localFootprint.add(report.reporterUserId);
    }
    for (const channel of rt.data.channels) {
      if (channel.ownerUserId) {
        localFootprint.add(channel.ownerUserId);
      }
      for (const memberId of channel.memberUserIds ?? []) {
        localFootprint.add(memberId);
      }
      for (const requesterId of rt.store.loadJoinRequests(channel.id)) {
        localFootprint.add(requesterId);
      }
    }
    const dmParticipants = new Set<string>();
    for (const message of rt.data.messages) {
      if (message.type === "sealed") {
        continue; // authored by the opaque sentinel
      }
      if (message.type === "dm") {
        dmParticipants.add(message.authorId);
        dmParticipants.add(message.recipientUserId);
      }
      // A restricted audience means a DM, a private-channel message, or a reaction on one — never synced.
      if (rt.messageAudienceUserIds(message) !== undefined) {
        localFootprint.add(message.authorId);
      }
    }
    for (const id of dmParticipants) {
      localFootprint.add(id);
    }

    rt.store.transaction(() => {
      for (const user of rt.data.users) {
        if (
          user.type !== "human" ||
          user.id.startsWith("mesh.") ||
          user.id.startsWith("llm.") ||
          rt.store.isUserSynced(user.id) ||
          localFootprint.has(user.id) ||
          user.isAdmin ||
          user.roles?.length ||
          user.pending ||
          user.banned ||
          user.shadowBanned ||
          user.timeoutUntil !== undefined ||
          rt.store.loadUserBlocks(user.id).length
        ) {
          continue;
        }
        rt.store.markUserSynced(user.id);
      }

      for (const user of rt.data.users.filter((candidate) => candidate.id.startsWith("mesh."))) {
        if (!dmParticipants.has(user.id)) {
          rt.store.deleteMeshIdentity(user.id);
          rt.store.deleteUser(user.id);
          continue;
        }
        const reset = UserSchema.parse({ ...makeUser(user.id), createdAt: user.createdAt });
        if (JSON.stringify(reset) !== JSON.stringify(user)) {
          rt.store.upsertUser(reset);
        }
      }

      rt.store.setConfigValue(LEGACY_SYNCED_USERS_BACKFILL_KEY, String(Date.now()));
    });

    // Mirror the committed changes in memory.
    const resets = new Map(
      rt.data.users
        .filter((user) => user.id.startsWith("mesh.") && dmParticipants.has(user.id))
        .map((user) => [user.id, UserSchema.parse({ ...makeUser(user.id), createdAt: user.createdAt })]),
    );
    rt.data.users = rt.data.users.filter((user) => !user.id.startsWith("mesh.") || dmParticipants.has(user.id));
    for (const user of rt.data.users) {
      const reset = resets.get(user.id);
      if (reset) {
        for (const key of Object.keys(user)) {
          delete (user as Record<string, unknown>)[key];
        }
        Object.assign(user, reset);
      }
    }
  }

  /**
   * Load every persisted per-user mesh identity into the in-memory map — only for local users. A row minted
   * for a peer-imported user or a mesh sender by an older build is a useless secret for someone else's
   * identity: its row is deleted (so the secret key no longer sits in the DB) and, if that
   * user's record still publishes the key we minted, the forged `identityKey` is stripped so it stops being
   * re-exported (a later genuine key from the user's home node may then be adopted by the sync TOFU rule).
   */
  function loadMeshIdentities(): void {
    meshIdentities.clear();
    localTagCache.clear(); // keyed by secret mailbox tokens — never outlive the identities they came from
    backfillLegacySyncedUsers();
    for (const { userId, data: json } of rt.store.loadMeshIdentities()) {
      let identity: MeshIdentity;
      try {
        identity = JSON.parse(json) as MeshIdentity;
      } catch {
        continue; // Skip a corrupt row rather than crash boot.
      }
      if (identity === null) {
        // A `null` placeholder an earlier build wrote in place of a purged row (below) — remove it.
        rt.store.deleteMeshIdentity(userId);
        continue;
      }
      if (typeof identity !== "object" || typeof identity.mailboxToken !== "string") {
        continue; // a malformed row
      }
      const user = rt.data.users.find((candidate) => candidate.id === userId);
      // (A BANNED local user keeps theirs — a ban is reversible; they just can't mint a new one meanwhile.)
      if (user && !isLocalMeshUser({ ...user, banned: false })) {
        rt.store.deleteMeshIdentity(userId);
        if (user.identityKey?.sign === identity.signPublic) {
          const next = UserSchema.parse({ ...user, identityKey: undefined });
          rt.store.upsertUser(next);
          Object.assign(user, next);
          delete (user as { identityKey?: unknown }).identityKey;
        }
        continue;
      }
      meshIdentities.set(userId, identity);
    }
  }

  // Per-local-user mesh address book (ownerUserId → recipient meshId → the recipient's card). A card
  // carries the contact's secret mailbox token, so it lives here (not on the public user record) and is
  // exchanged deliberately (QR/paste), never synced. Sealing to a contact is the ONLY send path: it
  // needs the token, and the card's self-certifying meshId defeats the key-substitution a synced
  // identityKey couldn't (docs/16).
  const meshContacts = new Map<string, Map<string, MeshIdentityCard>>();

  /** Load every persisted mesh contact (per local user) into the in-memory map. */
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
    if (!user || !isLocalMeshUser(user)) {
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

  /** Publish mesh identities for every eligible LOCAL user (boot + whenever mesh is enabled). */
  function ensureAllMeshIdentities(): void {
    if (!rt.appConfig.mesh.enabled) {
      return;
    }
    for (const user of rt.data.users) {
      if (isLocalMeshUser(user)) {
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

  // Per-identity memo of `localTagsForWindow` for the current epoch (the set only changes on rollover).
  const localTagCache = new Map<string, { epoch: number; tags: Set<string> }>();

  /** Routing tags a local identity answers to across the longest possible live window (+ one epoch
   * clock-skew). Derived from the identity's SECRET mailbox token, so only the recipient and the senders
   * it handed a card to can compute them — a passive carrier holding the sealed blob cannot correlate it
   * to a recipient (metadata-unlinkability; docs/16 §2). A sender computes the same tag from the
   * contact's `mailboxToken`, which it obtained out-of-band with the rest of the card.
   *
   * The window starts at now − MESH_TTL_MAX_MS, NOT now − this node's own `mesh.ttlMs` (review 2026-09-25
   * #5): the lifetime is the SENDER's choice (anything up to the schema max), so a recipient configured
   * with a shorter TTL must still recognise mail a default-TTL sender sealed days ago. */
  function localTagsForWindow(identity: MeshIdentity, now: number): Set<string> {
    const nowEpoch = currentEpoch(now, MESH_EPOCH_WINDOW_MS);
    const cached = localTagCache.get(identity.mailboxToken);
    if (cached && cached.epoch === nowEpoch) {
      return cached.tags;
    }
    const tags = new Set<string>();
    const start = currentEpoch(now - MESH_TTL_MAX_MS, MESH_EPOCH_WINDOW_MS);
    const end = currentEpoch(now + MESH_EPOCH_WINDOW_MS, MESH_EPOCH_WINDOW_MS);
    for (let epoch = start; epoch <= end; epoch += 1) {
      tags.add(mailboxTag(identity.mailboxToken, epoch));
    }
    if (localTagCache.size > 10_000) {
      localTagCache.clear(); // bounded; identities are local users only, so this never churns in practice
    }
    localTagCache.set(identity.mailboxToken, { epoch: nowEpoch, tags });
    return tags;
  }

  /** Ensure a display record exists for a remote mesh sender and make it resolvable to `recipientUserId`
   * ONLY — never via the shared roster or a global broadcast. Putting a mesh sender on the public
   * roster would leak that some local user just received sealed mail (docs/16); `visibleUsers` hides
   * these ids from everyone but the recipients they've mailed, and this notifies just the recipient. */
  function ensureMeshSenderUser(meshId: string, recipientUserId: string): void {
    let user = rt.data.users.find((candidate) => candidate.id === meshId);
    if (!user) {
      // Persist first, then mirror in memory — but no global broadcast (unlike ensureUser).
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

  const SEALED_REPLAY_PREFIX = "sealed.";
  // Hash once per held message object (a sealed row is immutable while carried).
  const replayKeyCache = new WeakMap<SealedMessage, string>();

  /** Replay key for a sealed message: a hash of the ciphertext AND the two outer fields the seal
   * authenticates as AAD (`toTag`, `ttlExpiresAt`). The outer `id` is NOT covered by the seal, so a carrier
   * can re-offer identical mail under a fresh id; this key identifies the one authentic message instead.
   * The AAD fields must be in it: they're cleartext a relay can't verify, so keying on the blob alone would
   * let a carrier offer the genuine blob with a FAKE ttl/tag first (it fails to open, gets carried) and
   * thereby block the genuine copy arriving by another path. A variant forging those gets its own key and
   * can never open, so it costs a relay slot at most (as any junk blob already can); a variant that keeps
   * them and forges the UNauthenticated `hopLimit`/`meta` shares the key — `acceptSealedFromPeer` handles
   * that (hop budget is raised by a better copy; extras are dropped on relay). Stored beside the id
   * tombstones under the reserved `sealed.` prefix — peer-supplied ids in that namespace are refused
   * (`isReservedReplayId`) so nobody can pre-plant one. Survives restarts; GC'd by the same horizon. */
  function sealedReplayKey(message: SealedMessage): string {
    let key = replayKeyCache.get(message);
    if (!key) {
      const digest = createHash("sha256")
        .update(message.sealed)
        .update(`|${message.toTag}|${message.ttlExpiresAt}`)
        .digest("hex");
      key = `${SEALED_REPLAY_PREFIX}${digest}`;
      replayKeyCache.set(message, key);
    }
    return key;
  }

  /** True for an id inside the namespace reserved for replay keys — never valid on a peer-supplied record. */
  function isReservedReplayId(id: string): boolean {
    return id.startsWith(SEALED_REPLAY_PREFIX);
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
      // (`createMessage` refuses DMs when the flag is off). With DMs disabled the mail is ours but
      // undeliverable: drop it — and tombstone it so it isn't carried/re-offered forever — rather than
      // materialise a DM the operator switched off (review 2026-09-04, mirrors the shadow-ban drop).
      if (rt.appConfig.features.enableDMs) {
        deliverSealedAsDm(recipientUserId, opened.senderMeshId, opened.plaintext, now);
      } else {
        rt.log.info({ messageId: message.id }, "Dropped sealed mesh mail: direct messages are disabled on this node");
      }
      for (const id of [message.id, sealedReplayKey(message)]) {
        rt.store.addTombstone(id);
        rt.tombstones.add(id);
      }
      return true;
    }
    return false;
  }

  /**
   * Every check {@link acceptSealedFromPeer} makes on a sealed offer's OUTER fields alone — the fields a sync
   * digest advertises — so a puller can skip exactly the offers acceptance would refuse without downloading
   * them (review 2026-09-25 #1). One predicate for both, so they can't drift apart again.
   */
  function sealedOfferAdmissible(offer: Pick<SealedMessage, "id" | "ttlExpiresAt" | "hopLimit">, now: number): boolean {
    // A peer may not name a record inside the replay-key namespace.
    if (isReservedReplayId(offer.id) || rt.tombstones.has(offer.id)) {
      return false;
    }
    if (offer.ttlExpiresAt <= now || offer.hopLimit <= 0) {
      return false;
    }
    // No honest sender can ask for more than the schema's max lifetime (+ one epoch of clock skew).
    // Refusing it keeps every replay record below well inside the tombstone GC horizon.
    return offer.ttlExpiresAt <= now + MESH_TTL_MAX_MS + MESH_EPOCH_WINDOW_MS;
  }

  // Bounds on the durable seen-offer record (docs/16 §9). At a bound the puller stops fetching NEW sealed offers
  // rather than evicting marks: an evicted mark would let a dropped offer be fetched again while a delivered
  // one stays tombstoned — the very difference the record exists to hide. Stopping is fail-closed (it treats
  // every offer alike), but it is also a denial of service, and with marks now kept for ~39 days a single
  // hostile peer advertising junk ids could otherwise switch sealed pulls off for everyone for that long. So
  // each source (a sync peer URL, or the radio bridge) has its own quota: a peer that fills its quota stops
  // only its own sealed pulls, and the global cap (four quotas' worth, ~20–60 MB of ids) is the backstop that
  // bounds the table on disk. An honest peer holds at most `maxCarried` blobs at a time, so it reaches the
  // quota only by offering ~1 300 distinct sealed messages a day for the whole retention window.
  const SEALED_SEEN_MAX = 200_000;
  const SEALED_SEEN_MAX_PER_SOURCE = 50_000;
  /** The seen-record `source` of blobs handed in over the loopback radio bridge (`/api/mesh/inbound`). */
  const RADIO_SOURCE = "radio";

  /**
   * How long a seen mark lives, from the moment the offer was taken in (docs/16 §9). It must outlive EVERY
   * tombstone the offer can leave behind, so that for its whole life the id is suppressed no matter what
   * became of it, and afterwards nothing distinguishes the outcomes either: a delivery tombstones the id at
   * delivery (lives `tombstoneHorizonMs`), and a carried copy is tombstoned when it expires — at most
   * MESH_TTL_MAX_MS + one epoch after it was taken in — and that tombstone lives the horizon too. One more
   * epoch of slack covers a slow round and the reaper's tick. Derived from when the node TOOK the offer in,
   * never from its advertised `ttlExpiresAt`: a peer can re-advertise the same id with any TTL it likes.
   */
  function sealedSeenRetentionMs(): number {
    return (rt.options.tombstoneHorizonMs ?? defaultTombstoneHorizonMs) + MESH_TTL_MAX_MS + 2 * MESH_EPOCH_WINDOW_MS;
  }

  /**
   * Remember that this node has fetched or received sealed offer `id` — delivered, carried or dropped alike
   * — for {@link sealedSeenRetentionMs} from `seenAt` (docs/16 §9). The puller never fetches a remembered id
   * again, on any digest list, so a restart, a config save, a relay toggle, a re-advertised TTL or listing the
   * id among public messages changes nothing about WHICH offers it re-downloads: a peer diffing fetch sets
   * can't tell the recipient's node from a node that dropped the blob. `seenAt` is the sync round's clock (one
   * value for every offer in the round), so even the expiry instant can't reflect how long each offer took to
   * process. A live mark is never extended.
   */
  function rememberSealedOffer(id: string, seenAt: number, source: string): void {
    rt.store.markSealedOfferSeen(id, seenAt + sealedSeenRetentionMs(), source, Date.now());
  }

  /** True when sealed offer `id` was already fetched or received here and its mark hasn't lapsed. */
  function isSealedOfferSeen(id: string, now: number): boolean {
    return rt.store.isSealedOfferSeen(id, now);
  }

  /** True when the seen-offer record can take no more marks from `source` (its quota) or from anyone (the
   *  global cap): pull no new sealed offers from that source this round (see SEALED_SEEN_MAX). */
  function sealedSeenAtCapacity(source: string, now: number): boolean {
    return (
      rt.store.countSealedOffersSeen(now) >= SEALED_SEEN_MAX ||
      rt.store.countSealedOffersSeen(now, source) >= SEALED_SEEN_MAX_PER_SOURCE
    );
  }

  /** Drop every in-memory secret-derived cache: identities, contacts and the tag memo (Emergency Reset lockdown). */
  function forget(): void {
    meshIdentities.clear();
    meshContacts.clear();
    localTagCache.clear();
  }

  /** Whether this node would CARRY an admissible offer that isn't for a local user: relaying is on and a hop
   * is left after the decrement (a copy stored at hop 0 is never advertised again). Capacity is separate. */
  function sealedOfferCarriable(offer: Pick<SealedMessage, "hopLimit">): boolean {
    return rt.appConfig.mesh.relay && offer.hopLimit - 1 > 0;
  }

  /** How many sealed blobs this node currently holds (carried or self-originated) — the `maxCarried` count. */
  function sealedHeldCount(): number {
    return rt.data.messages.reduce((count, message) => count + (message.type === "sealed" ? 1 : 0), 0);
  }

  /** Handle a sealed message pulled from a peer: deliver locally, else relay onward (hop-decremented,
   * bounded), else drop. Never broadcast to clients. Returns true when accepted (delivered or carried).
   * `source` / `seenAt` stamp the seen-offer mark: the sync puller passes the peer URL and its round clock;
   * the radio bridge takes the defaults. */
  function acceptSealedFromPeer(message: SealedMessage, source: string = RADIO_SOURCE, seenAt: number = Date.now()): boolean {
    if (!rt.appConfig.mesh.enabled) {
      return false;
    }
    const now = Date.now();
    if (!sealedOfferAdmissible(message, now)) {
      return false;
    }
    // Every admissible offer this node takes in is remembered, whatever happens to it below — so a later
    // sync offer of the same id is skipped the same way whether it was delivered, carried or dropped.
    const seenBefore = isSealedOfferSeen(message.id, now);
    rememberSealedOffer(message.id, seenAt, source);
    // `sealMailbox` only ever emits the canonical spelling; any other string that decodes to the same
    // envelope is a carrier's attempt to slip one message past the string-keyed replay checks below.
    if (!isCanonicalSealedBlob(message.sealed)) {
      return false;
    }
    const replayKey = sealedReplayKey(message);
    if (rt.tombstones.has(replayKey)) {
      return false; // this exact mail was already delivered here — a replay under a new outer id
    }
    // Already hold it — by id, or the same mail re-offered under another id (which would otherwise take a
    // second `maxCarried` slot on a relay). Compared by cached hash, never blob-to-blob: a peer picks the
    // blob length, and thousands of equal-length 90KB string compares per inbound message would stall
    // the event loop.
    const held = rt.data.messages.find(
      (candidate) => candidate.id === message.id || (candidate.type === "sealed" && sealedReplayKey(candidate) === replayKey),
    );
    if (held) {
      // `hopLimit` is NOT authenticated, so a carrier can pre-offer genuine mail with a nearly spent hop
      // budget to park a copy here that goes nowhere. Let a better-provisioned copy of the SAME mail
      // raise the held budget instead of being shadowed by it (monotonic: never lowered).
      if (held.type === "sealed" && sealedReplayKey(held) === replayKey && message.hopLimit - 1 > held.hopLimit) {
        const raised = MessageSchema.parse({ ...held, hopLimit: message.hopLimit - 1 }) as SealedMessage;
        rt.store.updateMessage(raised);
        held.hopLimit = raised.hopLimit;
        return true;
      }
      return false;
    }
    // An id taken in before and not held now was delivered (then it's tombstoned and refused above) or
    // dropped. A dropped one stays dropped — taking it now (say relaying was switched on since) would make
    // "carried" versus "refused" depend on whether it was delivered here the first time.
    if (seenBefore) {
      return false;
    }
    if (tryDeliverSealed(message)) {
      return true;
    }
    // Not for a local user → carry it onward, if this node relays and a hop is left (a copy stored at hop 0
    // is never advertised again — it would only hold a slot, and before the raise above, shadow the real
    // copy) and there is room.
    if (!sealedOfferCarriable(message)) {
      return false;
    }
    if (sealedHeldCount() >= rt.appConfig.mesh.maxCarried) {
      return false; // at capacity — refuse new mail (soonest-to-expire eviction is a v2 refinement)
    }
    // Rebuild the carried row from the fields that matter rather than spreading the peer's object:
    // unauthenticated extras ride along otherwise — `meta.streaming`, say, which `isSyncableMessage`
    // treats as "never export", turning a carried copy into a dead one that blocks the genuine mail.
    const relayed = MessageSchema.parse({
      id: message.id,
      type: "sealed",
      authorId: MESH_SENTINEL_AUTHOR,
      createdAt: message.createdAt,
      toTag: message.toTag,
      sealed: message.sealed,
      ttlExpiresAt: message.ttlExpiresAt,
      hopLimit: message.hopLimit - 1,
    });
    rt.store.insertMessage(relayed);
    rt.data.messages.push(relayed);
    return true; // opaque — no client broadcast
  }

  /** Verify and store a mesh contact card in `ownerUserId`'s address book. Rejects a card whose
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
    // Persist first, then mirror in memory — if the store write throws, the book doesn't diverge.
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
    // participant can't fill the store with undeliverable sealed blobs (they persist until TTL).
    if (sealedHeldCount() >= rt.appConfig.mesh.maxCarried) {
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

    // If the recipient is local, deliver now; otherwise store it so the sync layer carries it.
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
    sealedOfferAdmissible,
    sealedOfferCarriable,
    rememberSealedOffer,
    isSealedOfferSeen,
    sealedSeenAtCapacity,
    forget,
    sealedHeldCount,
    acceptSealedFromPeer,
    isReservedReplayId,
    addMeshContact,
    meshIdentityCard,
    sendSealed,
    reapExpiredSealed,
  };
}

export type MeshLayer = ReturnType<typeof createMeshLayer>;
