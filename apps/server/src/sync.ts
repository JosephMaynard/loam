// Node-to-node sync (docs/11): the digest, the per-peer transport decision, defensive imports of peer
// users/messages/attachments, the missing-attachment retry, and the sync loop. Extracted verbatim from
// app.ts (2026-09-04 split) behind the shared `Runtime` view plus the mesh layer it hands sealed mail to.
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyKxBinding } from "@loam/crypto";
import { ChannelSchema, type Message, type MessageAttachment, MessageSchema, type SealedMessage, SyncAttachmentResponseSchema, type SyncDigest, SyncDigestSchema, SyncMessagesResponseSchema, type SyncPeer, type SyncStatusReport, type User, UserSchema } from "@loam/schema";
import { attachmentFileMaxBytes, attachmentFileName, attachmentMaxBytes, isAcceptableAttachmentBytes, isImageAttachmentMime, missingAttachmentBackoffMs, missingAttachmentMaxAgeMs, missingAttachmentMaxRecordsPerPass } from "./media.js";
import { type PeerTransportPosture, type PeerTransportSession, fetchPeerTransportPosture, handshakeWithPeer, sealedFetch } from "./sync-transport.js";
import type { MeshLayer } from "./mesh.js";
import type { Runtime } from "./runtime.js";

/** Build the node-to-node sync engine over the runtime view and the mesh layer it hands sealed mail to. */
export function createSyncEngine(rt: Runtime, mesh: MeshLayer) {
  // Per-peer sync bookkeeping for the admin UI (RAM-only).
  type PeerSyncStatus = {
    lastAttemptAt?: number;
    lastSuccessAt?: number;
    lastError?: string;
    imported: number;
  };
  const peerSyncStatus = new Map<string, PeerSyncStatus>();
  // Cached per-peer transport decision (docs/08), keyed by peer URL, so the 5s sync tick reuses one
  // encrypted session (or a settled "this peer runs plaintext" verdict) instead of re-probing every
  // round. A live session is held ~just under the peer's 12h server-side TTL (and re-established on a
  // 401 / decrypt failure); a plaintext verdict is held only briefly so a peer that *enables* transport
  // is picked up within minutes. RAM-only; a restart re-probes lazily.
  const peerTransportSessions = new Map<
    string,
    { transport: PeerTransportSession | "plaintext"; expiresAt: number }
  >();
  const PEER_TRANSPORT_SESSION_TTL_MS = 11 * 3_600_000;
  const PEER_PLAINTEXT_RECHECK_MS = 5 * 60_000;
  let syncRunning = false;
  let lastSyncLoopAt = 0;

  // SF3: single-flight guard for `retryMissingAttachments` — each work item's fetch can consume the
  // full 10s peer timeout, so without this an overlapping 30s reaper tick (a handful of unreachable
  // records outlasting the tick) would stack unbounded concurrent passes/requests.
  let retryMissingAttachmentsRunning = false;

  /**
   * Whether a message may leave this node over node-to-node sync: only content that is public
   * here — posts/replies in public, non-archived channels and reactions on them. DMs, private
   * channels, in-flight streaming messages, and shadow-banned authors' messages never sync.
   */
  function isSyncableMessage(message: Message): boolean {
    if (message.type === "dm" || message.meta?.streaming) {
      return false;
    }

    // Sealed mailbox mail (opportunistic-mesh, docs/16): syncable only when mesh is enabled, still
    // within its TTL, and with hop budget left. No channel/shadow-ban checks — it carries no channel
    // and its real author is sealed inside the ciphertext.
    if (message.type === "sealed") {
      return rt.appConfig.mesh.enabled && message.ttlExpiresAt > Date.now() && message.hopLimit > 0;
    }

    // The author check applies to every type — a shadow-banned user's *reactions* are withheld
    // from local broadcasts too, so they must not leak out through the sync export either.
    const author = rt.data.users.find((candidate) => candidate.id === message.authorId);

    if (author?.shadowBanned) {
      return false;
    }

    if (message.type === "reaction") {
      const target = rt.data.messages.find((candidate) => candidate.id === message.targetMessageId);
      return !!target && isSyncableMessage(target);
    }

    const channel = rt.ensureChannel(message.channelId);
    return !!channel && channel.visibility === "public" && !channel.archived;
  }

  /** What this node advertises to pulling peers (see SyncDigestSchema). */
  function buildSyncDigest(): SyncDigest {
    return {
      // Public channels INCLUDING archived ones (C1) — a peer that imported this channel must see the
      // archived flag to converge. Archived is public metadata (no members leak); their messages are still
      // withheld by `isSyncableMessage` below, so this carries channel metadata only. Strip the LOCAL-only
      // `pinned`/`messageTtlMs` (a peer's retention/pin policy is its own business; import ignores them too).
      channels: rt.data.channels
        .filter((channel) => channel.visibility === "public")
        .map((channel) => {
          const exported = { ...channel };
          delete exported.pinned;
          delete exported.messageTtlMs;
          return exported;
        }),
      messages: rt.data.messages
        .filter((message) => message.type !== "sealed" && isSyncableMessage(message))
        .map((message) => ({
          id: message.id,
          ...(message.editedAt !== undefined ? { editedAt: message.editedAt } : {}),
        })),
      // Sealed mailbox mail on offer — only when mesh is enabled (else the array is omitted and the
      // digest is byte-identical to today). Tag/TTL/hop up front so a puller decides before fetching.
      ...(rt.appConfig.mesh.enabled
        ? {
            sealed: rt.data.messages
              .filter((message): message is SealedMessage => message.type === "sealed" && isSyncableMessage(message))
              .map((message) => ({
                id: message.id,
                toTag: message.toTag,
                ttlExpiresAt: message.ttlExpiresAt,
                hopLimit: message.hopLimit,
              })),
          }
        : {}),
    };
  }

  /**
   * Read a peer response body with a hard byte cap, so a misbehaving or malicious peer can't make
   * this node buffer an arbitrarily large payload.
   */
  async function readPeerBody(response: Response, maxBytes: number): Promise<Buffer> {
    if (!response.body) {
      return Buffer.alloc(0);
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      total += value.byteLength;

      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new Error("Peer response too large");
      }

      chunks.push(value);
    }

    return Buffer.concat(chunks);
  }

  // Digest/messages ceiling on the PLAINTEXT JSON. A batch that would exceed it (200 long CJK posts, dozens
  // of 90KB sealed blobs) is split and re-requested (see `syncWithPeer`), so the cap bounds memory without
  // ever wedging a round.
  const maxPeerJsonBytes = 8 * 1024 * 1024;
  // The same ceiling measured on the wire for a SEALED response (review 2026-09-25 #2): `{"enc":"<base64url of
  // nonce ‖ ciphertext ‖ tag>"}` inflates the plaintext by 4/3 plus a few bytes, so capping the raw body at
  // `maxPeerJsonBytes` silently shrank the real budget to ~6 MB on every encrypted peer.
  const maxSealedPeerJsonBytes = Math.ceil((maxPeerJsonBytes * 4) / 3) + 64 * 1024;

  // Ids per `/api/sync/messages` request. Sealed blobs (≤ 90KB each) get their own, smaller batches so one
  // request stays a few MB; public messages keep the historical 200. A peer whose batch comes back over the
  // size cap gets smaller batches from then on (`peerBatchSizes`), doubling back after a clean round.
  const PUBLIC_BATCH_IDS = 200;
  const SEALED_BATCH_IDS = 40;
  const MIN_PUBLIC_BATCH_IDS = 10;
  const MIN_SEALED_BATCH_IDS = 5;
  const peerBatchSizes = new Map<string, { public: number; sealed: number }>();
  // Per-round fetch budgets. Bounded so a peer advertising a huge backlog can't make one round unbounded;
  // what doesn't fit is picked up next round. The sealed budget (`mesh.maxSealedPullPerRound`) is spent in a
  // tag-INDEPENDENT order (soonest expiry first), so what we fetch never depends on which mail is ours (#4).
  const MAX_PUBLIC_IDS_PER_ROUND = 4_000;
  const DEFAULT_SEALED_IDS_PER_ROUND = 80;
  // Bisection limits (review 2026-09-25 follow-up): a peer answering EVERY batch with junk used to cost
  // 2n − 1 requests per n-id batch (~8 000 a round), each reading up to the 8 MiB cap. A round may spend at
  // most `2 × batches + SPLIT_SLACK` extra requests and `MAX_WASTED_BYTES_PER_ROUND` bytes on unusable
  // responses; past either, the peer is treated as failing for this round (`lastError`). One bad record in a
  // full batch costs ~2·log2(200) ≈ 16 extra requests, so honest peers stay far inside both limits.
  const SPLIT_SLACK = 16;
  const MAX_WASTED_BYTES_PER_ROUND = 4 * maxPeerJsonBytes;

  // Per-peer memory of PUBLIC offers this node fetched and REFUSED (review 2026-09-25 #6), keyed by id +
  // version, so a refused NEW message (a reply to a deleted post, a post into an archived channel, an over-cap
  // body…) isn't re-downloaded every round forever — the digest keeps advertising it and "not held locally"
  // alone would always want it. Entries expire (a refusal can stop applying — a channel un-archived), the map
  // is bounded, and it is RAM-only (a restart re-fetches each refused offer once). Cleared by the kill switch,
  // an admin config save, and a channel policy change (forgetRefusedOffers). Sealed offers are NOT kept here:
  // they go in the durable, node-wide seen-offer record (`mesh.rememberSealedOffer`), which none of those
  // events clears — see the sealed pull below.
  const REFUSED_TTL_MS = 3_600_000;
  const REFUSED_MAX_PER_PEER = 20_000;
  const refusedOffers = new Map<string, Map<string, number>>();

  /** True while `peerUrl`'s offer `key` is remembered as refused (expired entries are dropped lazily). */
  function isRefusedOffer(peerUrl: string, key: string, now: number): boolean {
    const book = refusedOffers.get(peerUrl);
    const expiresAt = book?.get(key);
    if (expiresAt === undefined) {
      return false;
    }
    if (expiresAt <= now) {
      book?.delete(key);
      return false;
    }
    return true;
  }

  /** Remember that `peerUrl`'s offer `key` was refused until `expiresAt` (oldest entry evicted at the cap). */
  function rememberRefusedOffer(peerUrl: string, key: string, expiresAt: number): void {
    let book = refusedOffers.get(peerUrl);
    if (!book) {
      book = new Map();
      refusedOffers.set(peerUrl, book);
    }
    book.delete(key); // re-insert at the back so eviction order follows recency
    while (book.size >= REFUSED_MAX_PER_PEER) {
      const oldest = book.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      book.delete(oldest);
    }
    book.set(key, expiresAt);
  }

  /** The refused-offer key of a public message at a given edit version. */
  function publicOfferKey(id: string, editedAt: number | undefined): string {
    return `p\u0000${id}\u0000${editedAt ?? 0}`;
  }

  // Peers that completed a transport handshake this boot. A later plaintext fallback for one of them is a
  // downgrade (an attacker blocking `/api/bootstrap` or forging `off`), refused rather than silently taken
  // (review 2026-09-25 #13). RAM-only; cleared by the kill switch.
  const peersSeenEncrypted = new Set<string>();

  /**
   * Forget every remembered PUBLIC refusal, keeping the rest of the per-peer state (transport sessions,
   * downgrade history). Called when a local policy that decides refusals changes (an admin config save, a
   * channel un-archived or reopened for posts/replies), so those offers are fetched again at the next round
   * instead of waiting out REFUSED_TTL_MS. Never touches the sealed seen-offer record: re-fetching the sealed
   * offers this node dropped, but not the ones it delivered, would tell the serving peer which were which.
   */
  function forgetRefusedOffers(): void {
    refusedOffers.clear();
  }

  /** Drop every piece of per-peer memory (transport sessions, refusals, downgrade history) — kill switch. */
  function forgetPeerState(): void {
    peerTransportSessions.clear();
    refusedOffers.clear();
    peersSeenEncrypted.clear();
    peerBatchSizes.clear();
  }

  /** Errors that mean "this BATCH's content is unusable" (too big, not JSON, fails the schema) rather than
   *  "the peer is unreachable" — the batch is split to isolate the offender instead of failing the round. */
  function isPeerContentError(error: unknown): boolean {
    return (
      error instanceof SyntaxError ||
      (error instanceof Error && (error.message === "Peer response too large" || error.message === "Peer sent an invalid payload"))
    );
  }

  // Per-message body cap for SYNC IMPORT only (docs/25 SW2). The stored `MessageBodySchema` is deliberately
  // uncapped (a local LLM reply can be long, and locally-authored content must round-trip), but a hostile
  // *sync peer* could otherwise push bodies up to `maxPeerJsonBytes` (~8MB each) to amplify storage and
  // bandwidth against a syncing node. 256KB is far above any real message (including long LLM replies), so
  // an over-cap imported body is skipped, not fatal. Reactions/sealed carry no `body`.
  const maxSyncImportBodyBytes = 256 * 1024;

  /** The shared sync-token header for a PLAINTEXT pull — only ever sent when this node itself runs transport
   * `off` (Developer Mode), where the operator has deliberately put everything on the wire in the clear.
   * Otherwise a plaintext pull goes WITHOUT the token (review 2026-09-25 #13): an unreadable/blocked
   * `/api/bootstrap` or a forged `off` advertisement must not be able to make this node read its
   * node-membership bearer secret onto the wire. (On an encrypted session the token rides INSIDE the sealed
   * envelope instead — see `sealedFetchPeerText`.) A token-guarded peer then 404s the tokenless pull, which
   * the round records as an ordinary failure. */
  function peerSyncHeaders(): Record<string, string> {
    return rt.appConfig.sync.token && rt.effectiveTransportEncryption() === "off"
      ? { "x-loam-sync-token": rt.appConfig.sync.token }
      : {};
  }

  /** Handshake a fresh transport session against a peer (honouring any operator-pinned key) and cache
   * it. The pinned key comes from the peer's own sync-config entry (`SyncPeer.transportKey`). */
  async function handshakePeerAndCache(peerUrl: string): Promise<PeerTransportSession> {
    const pinnedKey = rt.appConfig.sync.peers.find((peer) => peer.url === peerUrl)?.transportKey;
    const session = await handshakeWithPeer(peerUrl, { expectedHostKey: pinnedKey });
    peerTransportSessions.set(peerUrl, { transport: session, expiresAt: Date.now() + PEER_TRANSPORT_SESSION_TTL_MS });
    peersSeenEncrypted.add(peerUrl);
    return session;
  }

  /** Fall back to talking to `peerUrl` in the clear — unless that would be a downgrade this node refuses
   * (review 2026-09-25 #13): never when this node REQUIRES transport encryption (its whole posture is "no
   * plaintext"), and never for a peer that already negotiated encryption with us this boot (a sudden
   * plaintext verdict for it is what an attacker blocking `/api/bootstrap` or forging `off` looks like).
   * The throw lands in the peer's sync status as `lastError`. */
  function plaintextFallback(peerUrl: string, reason: string): "plaintext" {
    if (rt.effectiveTransportEncryption() === "required") {
      throw new Error(`Refusing a plaintext sync (${reason}): this node requires transport encryption`);
    }
    if (peersSeenEncrypted.has(peerUrl)) {
      throw new Error(`Refusing a plaintext sync (${reason}): this peer negotiated encryption earlier`);
    }
    return cachePlaintext(peerUrl);
  }

  /** Re-handshake and fold the fresh session INTO the caller's existing `session` object (then re-cache
   * that same object), so a request holding it and the cache share ONE object + ONE monotonic replay
   * sequence. Crucially it mutates the SPECIFIC object passed in — not one rediscovered via the mutable
   * cache map, which a concurrent config PATCH / kill switch could have cleared, leaving a re-handshake to
   * cache a fresh object while the in-flight request advanced a detached one → the sequence-split 409
   * (docs/08 / Sol round-2 #3). */
  async function rehandshakePeerInto(
    session: PeerTransportSession,
    peerUrl: string,
  ): Promise<PeerTransportSession> {
    const pinnedKey = rt.appConfig.sync.peers.find((peer) => peer.url === peerUrl)?.transportKey;
    const fresh = await handshakeWithPeer(peerUrl, { expectedHostKey: pinnedKey });
    session.sessionId = fresh.sessionId;
    session.key = fresh.key;
    session.hostPublicKey = fresh.hostPublicKey;
    session.seq = 0;
    peerTransportSessions.set(peerUrl, { transport: session, expiresAt: Date.now() + PEER_TRANSPORT_SESSION_TTL_MS });
    return session;
  }

  /** Record (briefly) that a peer is talked to in the clear, so an off-mode peer isn't re-probed via
   * `/api/bootstrap` on every 5s tick — but is re-checked often enough to notice it enabling transport. */
  function cachePlaintext(peerUrl: string): "plaintext" {
    peerTransportSessions.set(peerUrl, { transport: "plaintext", expiresAt: Date.now() + PEER_PLAINTEXT_RECHECK_MS });
    return "plaintext";
  }

  /**
   * Resolve how to talk to a peer (docs/08): reuse a cached decision, else read the peer's advertised
   * posture from its `/api/bootstrap` and handshake if it wants encryption. Returns a live transport
   * session, or `"plaintext"` for the unchanged clear path.
   *
   * A peer's own sync-config entry may **pin** its transport key (`SyncPeer.transportKey`), which both
   * upgrades the channel to active-MITM resistance and means we go encrypted regardless of what the
   * (plain-HTTP, attacker-mutable) `/api/bootstrap` claims — a pinned peer that fails the handshake **fails
   * closed** (the error propagates, so the sync round records it, rather than a silent plaintext pull).
   * Unpinned: a peer advertising `required` also fails closed on a handshake failure; an `optional`
   * peer degrades to plaintext (it still serves the clear path); and a peer we can't read a posture from
   * at all (older peer, or `/api/bootstrap` unreachable/non-2xx) falls back to plaintext — if it truly
   * required transport the plaintext pull just 401s and the round records a normal failure. Every plaintext
   * fallback goes through {@link plaintextFallback}: refused outright when THIS node is `required` or the
   * peer already negotiated encryption this boot, and never carrying the sync token (`peerSyncHeaders`).
   */
  async function resolvePeerTransport(peerUrl: string): Promise<PeerTransportSession | "plaintext"> {
    const cached = peerTransportSessions.get(peerUrl);
    // (A cached plaintext verdict is re-judged if this node has since been switched to `required`.)
    if (cached && cached.expiresAt > Date.now() && !(cached.transport === "plaintext" && rt.effectiveTransportEncryption() === "required")) {
      return cached.transport;
    }
    peerTransportSessions.delete(peerUrl);

    const pinnedKey = rt.appConfig.sync.peers.find((peer) => peer.url === peerUrl)?.transportKey;

    // A pinned key is held out-of-band, so we can (and must) go encrypted without trusting `/api/config`.
    if (pinnedKey) {
      return await handshakePeerAndCache(peerUrl);
    }

    let posture: PeerTransportPosture;
    try {
      posture = await fetchPeerTransportPosture(peerUrl);
    } catch {
      // Couldn't learn the posture (older peer without the field, or an unreachable/erroring
      // `/api/bootstrap`) → the legacy plaintext path, if this node allows one (never with the token).
      return plaintextFallback(peerUrl, "the peer's transport posture is unreadable");
    }

    if (posture.mode === "off" || !posture.publicKey) {
      return plaintextFallback(peerUrl, "the peer advertises no transport encryption");
    }

    try {
      return await handshakePeerAndCache(peerUrl);
    } catch (error) {
      if (posture.mode === "required") {
        throw error;
      }
      return plaintextFallback(peerUrl, "the transport handshake failed");
    }
  }

  /**
   * GET/POST a peer endpoint with a timeout, a response-size cap, and schema validation. Transparently
   * routes through the peer's transport session when it advertises encryption (docs/08) — so the sync
   * digest/messages request AND response travel sealed, the `sync.token` included (it rides inside the
   * sealed `{ s, b, tok }` envelope, never as a wire header) — and stays a plain HTTP request against a
   * peer running transport `off` (where the token is withheld unless this node is in Developer Mode too;
   * see `peerSyncHeaders`).
   */
  async function fetchPeerJson<T>(
    peerUrl: string,
    path: string,
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
    body?: unknown,
    meter?: { wastedBytes: number },
  ): Promise<T> {
    const transport = await resolvePeerTransport(peerUrl);
    let raw: string;
    try {
      raw =
        transport === "plaintext"
          ? await fetchPeerText(peerUrl, path, body)
          : await sealedFetchPeerText(transport, peerUrl, path, body);
    } catch (error) {
      // An over-cap body was read up to the cap before it was abandoned — bytes spent for nothing.
      if (meter && error instanceof Error && error.message === "Peer response too large") {
        meter.wastedBytes += maxPeerJsonBytes;
      }
      throw error;
    }

    let parsed: { success: true; data: T } | { success: false };
    try {
      parsed = schema.safeParse(JSON.parse(raw));
    } catch (error) {
      if (meter) {
        meter.wastedBytes += Buffer.byteLength(raw, "utf8");
      }
      throw error;
    }
    if (!parsed.success) {
      if (meter) {
        meter.wastedBytes += Buffer.byteLength(raw, "utf8");
      }
      throw new Error("Peer sent an invalid payload");
    }
    return parsed.data;
  }

  /** Plain-HTTP peer request (transport `off`): the pre-encryption path, unchanged. */
  async function fetchPeerText(peerUrl: string, path: string, body?: unknown): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const headers: Record<string, string> = { ...peerSyncHeaders() };
      if (body !== undefined) {
        headers["content-type"] = "application/json";
      }

      const response = await fetch(`${peerUrl.replace(/\/+$/, "")}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Peer answered ${response.status}`);
      }

      return (await readPeerBody(response, maxPeerJsonBytes)).toString("utf8");
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Sealed peer request over a live transport session, with a one-shot re-handshake on expiry. */
  async function sealedFetchPeerText(
    session: PeerTransportSession,
    peerUrl: string,
    path: string,
    body?: unknown,
  ): Promise<string> {
    const response = await sealedFetch(session, peerUrl, path, {
      body,
      // Seal the sync token INSIDE the envelope rather than presenting it as a wire header (docs/08) — so a
      // node-membership bearer credential is never readable on the wire and the request proves key
      // possession. A present token also makes a bodyless digest a sealed POST.
      syncToken: rt.appConfig.sync.token,
      maxBytes: maxSealedPeerJsonBytes,
      reHandshake: async () => {
        try {
          // Fold the fresh session into THIS request's `session` object (and re-cache it) so the cache and
          // the in-flight request never diverge into two replay counters, even if the map was cleared.
          return await rehandshakePeerInto(session, peerUrl);
        } catch {
          peerTransportSessions.delete(peerUrl);
          return undefined;
        }
      },
    });

    if (!response.ok) {
      throw new Error(`Peer answered ${response.status}`);
    }
    return response.text;
  }

  /** Ids a peer may never name — as a user record OR a message author (review 2026-09-25 #3/#8): a `mesh.*`
   *  id is a self-certifying mesh sender's display record (pre-naming one would let a peer choose what a
   *  real sender's mail later renders as), and the whole `llm.*` namespace is reserved for assistant bots —
   *  not just the configured bot id, since a later config change could point `botId` at a record a peer
   *  planted, which `ensureBotUser` would then adopt as this node's assistant. */
  function isReservedPeerIdentity(id: string): boolean {
    return id.startsWith("mesh.") || id.startsWith("llm.") || id === rt.appConfig.llm.ollama.botId;
  }

  /** Whether a peer message's author may be imported here: not a reserved id, and — when the payload carries
   *  the author's record — a human one. A peer's bot or system account is its own; imported as-is it would
   *  render here as a bot/system voice, and forcing it to "human" would misrepresent it instead. */
  function isAcceptablePeerAuthor(authorId: string, usersById: ReadonlyMap<string, User>): boolean {
    if (isReservedPeerIdentity(authorId)) {
      return false;
    }
    const record = usersById.get(authorId);
    return !record || record.type === "human";
  }

  /**
   * Import the author record of a message this node has just ACCEPTED (review 2026-09-25 #3): only the
   * authors of accepted messages, never every user in a peer's payload — a peer could otherwise push tens of
   * thousands of arbitrary user records per batch. Authority and moderation state are stripped — a peer's
   * admin or moderator is a stranger here, and a peer must never be able to ban/shadow-ban someone on this
   * node. Reserved ids (`isReservedPeerIdentity`) are refused.
   */
  function importPeerAuthor(authorId: string, usersById: Map<string, User>): void {
    const user = usersById.get(authorId);
    if (!user || isReservedPeerIdentity(user.id) || user.type !== "human") {
      return;
    }
    // Accept a published mesh key only if its kx is cryptographically bound to its sign (kxSig);
    // otherwise strip it — the user is still imported as a display contact, just not sealable-to via
    // this record. (v1 ids aren't key-derived, so this proves kx↔sign but NOT key↔identity — the
    // TOFU below and docs/16's limitation cover the residual active-substitution risk.)
    const importedKey =
      user.identityKey && verifyKxBinding(user.identityKey.sign, user.identityKey.kx, user.identityKey.kxSig)
        ? user.identityKey
        : undefined;

    const existing = rt.data.users.find((candidate) => candidate.id === user.id);
    if (existing) {
      // Trust-on-first-use: adopt a valid key the FIRST time we see one for a known user, but never
      // overwrite an existing key from a later (possibly hostile) sync — a peer can't silently rebind
      // a user we already hold a key for.
      // ...and only onto a record a sync import CREATED, never one of our own users: a local user with
      // no key yet (mesh off, or not minted) would otherwise be bound to a peer-chosen key, and
      // `ensureMeshIdentity` would then never publish their real one. Provenance is durable — a
      // live-session test isn't (a logged-out or restarted local user has no session).
      if (!existing.identityKey && importedKey && rt.store.isUserSynced(existing.id)) {
        const next = UserSchema.parse({ ...existing, identityKey: importedKey });
        rt.store.upsertUser(next);
        Object.assign(existing, next);
        rt.broadcast({ type: "userUpserted", user: existing });
      }
      return;
    }

    const sanitized = UserSchema.parse({
      ...user,
      isAdmin: false,
      roles: undefined,
      banned: undefined,
      shadowBanned: undefined,
      pending: undefined,
      identityKey: importedKey,
    });
    rt.store.transaction(() => {
      rt.store.upsertUser(sanitized);
      rt.store.markUserSynced(sanitized.id);
    });
    rt.data.users.push(sanitized);
    rt.broadcast({ type: "userUpserted", user: sanitized });
  }

  /**
   * Fetch a peer's attachment bytes over the channel that peer actually supports (Sol round-2 #4):
   *  - an ENCRYPTED peer (`optional`/`required`) serves them sealed as base64 JSON from
   *    `/api/sync/attachment` — the tunnel-only binary `/api/attachments/:fileName` would 401 without a
   *    session, which is why a plain-fetch copy silently dropped every attachment on a required peer;
   *  - a PLAINTEXT (`off`-mode) peer uses the **legacy public binary GET** `/api/attachments/:fileName`,
   *    preserving back-compat with older / off-mode peers that predate the sync-attachment route (whose
   *    attachments would otherwise disappear permanently). An older *encrypted* peer without the new route
   *    can't be served this way (documented: it must be upgraded).
   * Throws on any failure; the caller treats a throw as "image absent, message still imports".
   */
  async function fetchPeerAttachmentBytes(peerUrl: string, attachment: MessageAttachment): Promise<Buffer> {
    const fileName = attachmentFileName(attachment);
    const transport = await resolvePeerTransport(peerUrl);

    if (transport === "plaintext") {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetch(`${peerUrl.replace(/\/+$/, "")}/api/attachments/${fileName}`, {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Peer answered ${response.status}`);
        }
        // Read up to the cap for THIS attachment's type — non-image files may be larger than images.
        const maxBytes = isImageAttachmentMime(attachment.mimeType) ? attachmentMaxBytes : attachmentFileMaxBytes;
        return await readPeerBody(response, maxBytes);
      } finally {
        clearTimeout(timeout);
      }
    }

    const result = await fetchPeerJson(peerUrl, "/api/sync/attachment", SyncAttachmentResponseSchema, { fileName });
    return Buffer.from(result.data, "base64");
  }

  /** Best-effort copy of an imported message's attachment files from the peer that has them. */
  async function importPeerAttachments(peerUrl: string, message: Message, generation: number): Promise<void> {
    if (message.type === "reaction" || message.type === "sealed" || !message.attachments?.length) {
      return;
    }

    for (const attachment of message.attachments) {
      const filePath = join(rt.attachmentsDir, attachmentFileName(attachment));

      try {
        await stat(filePath);
        continue; // already have it
      } catch {
        // fall through to fetch
      }

      try {
        const bytes = await fetchPeerAttachmentBytes(peerUrl, attachment);

        // The fetch awaited: a kill switch meanwhile wiped the store, so a work item recorded now would land
        // a pre-wipe message id in the fresh post-wipe DB (review 2026-09-25 #9).
        if (rt.wipeGeneration !== generation) {
          return;
        }

        if (!isAcceptableAttachmentBytes(bytes, attachment.mimeType)) {
          // Fetched something, but it isn't usable — record it as missing too (docs/15 A6) rather
          // than silently dropping it: a peer mid-write or serving a truncated/corrupt copy today can
          // look fine on a later retry.
          rt.store.addMissingAttachment({ messageId: message.id, attachmentId: attachment.id, mimeType: attachment.mimeType, peerUrl });
          continue;
        }

        // (The generation check above also covers this: a kill switch during the fetch deleted the attachments
        // dir, so nothing may recreate it and write an orphaned file the wipe was meant to destroy — docs/15 #2.)
        await mkdir(rt.attachmentsDir, { recursive: true });
        await writeFile(filePath, bytes);

        // ...and if the wipe landed *during* the write, remove the file we just orphaned.
        if (rt.wipeGeneration !== generation) {
          await rm(filePath, { force: true });
          return;
        }
      } catch {
        // Best-effort at import time: the fetch genuinely failed (peer unreachable, attachment gone, or a
        // transient error). The message still imports — the text is the payload that matters off-grid —
        // but a plain digest pull never re-offers an already-known message id, so without a work item the
        // image would stay absent forever (docs/15 A6). `retryMissingAttachments` is the independent pass
        // that re-fetches just this file from this peer, without re-importing the message. The
        // required-mode 401 that dropped EVERY attachment is the case this path originally fixed.
        // ...unless a kill switch landed while the fetch was in flight: then the store is the fresh post-wipe
        // one and this pre-wipe work item must not reach it (review 2026-09-25 #9).
        if (rt.wipeGeneration !== generation) {
          return;
        }
        rt.store.addMissingAttachment({ messageId: message.id, attachmentId: attachment.id, mimeType: attachment.mimeType, peerUrl });
      }
    }
  }

  /**
   * Independent retry pass for attachments that failed to copy during a sync import (docs/15 A6).
   * `importPeerAttachments` is best-effort and, on failure, leaves the message imported but
   * image-less; a later digest round sees the message id as already-known and never re-offers it, so
   * without this the image stays missing forever. This re-fetches just the missing file(s) from the
   * peer that had them (reusing `fetchPeerAttachmentBytes`, the same peer-fetch path the initial
   * import used) — it never re-imports or otherwise touches the message. Runs on the reaper timer, but
   * (F1) only actually contacts a peer once per record's backoff interval, and (F2) never contacts a
   * peer sync is currently off, or one the operator has since removed from `sync.peers` — dropping
   * that record instead. Gives up (drops the work item) past `missingAttachmentMaxAgeMs` so a
   * permanently-gone file can't grow the work-item table forever. (SF3) Single-flight: a tick that
   * lands while a pass is still in flight no-ops rather than starting a second concurrent pass, and no
   * new pass starts while a kill-switch wipe is in progress.
   *
   * (P2-2, docs/15 A6/F1, Sol round 3) The per-pass cap (`missingAttachmentMaxRecordsPerPass`) is
   * applied by `store.loadDueMissingAttachments` at the SQL level — `WHERE next_attempt_at <= now
   * ORDER BY next_attempt_at ASC LIMIT`, so it selects from the records actually ELIGIBLE for a retry
   * right now, fairly ordered by how overdue they are. The old code loaded EVERY record in creation
   * (rowid) order and sliced the first `missingAttachmentMaxRecordsPerPass` BEFORE checking each one's
   * own backoff — so if the oldest 25 records all happened to still be in backoff (e.g. a peer flapped
   * and bumped them all around the same time), records 26+ were never even looked at, no matter how
   * overdue they were: permanent starvation for anything added after the first
   * `missingAttachmentMaxRecordsPerPass` records went into backoff together.
   */
  async function retryMissingAttachments(): Promise<void> {
    // SF3: single-flight guard — an overlapping reaper tick (or a manual /api/admin/sync/run-triggered
    // call landing mid-pass) must no-op, not stack a second concurrent pass of peer fetches.
    if (retryMissingAttachmentsRunning) {
      return;
    }

    // SF3: never START a new pass while a kill-switch wipe is in flight — `wipeGeneration` alone only
    // catches a pass that was ALREADY RUNNING when the wipe began (see the comment on `wipeInProgress`).
    if (rt.wipeInProgress) {
      return;
    }

    // F2a: no live sync means no peer to fetch from at all — don't touch the table (and don't wake a
    // node that has sync switched off just to no-op every record in it).
    if (!rt.appConfig.sync.enabled) {
      return;
    }

    const now = Date.now();
    // P2-2: only the DUE records, fairly ordered and already capped at the DB level — see the doc
    // comment above for why this replaced a full-table load + slice.
    const records = rt.store.loadDueMissingAttachments(now, missingAttachmentMaxRecordsPerPass);

    if (!records.length) {
      return;
    }

    retryMissingAttachmentsRunning = true;

    try {
      // Snapshot the wipe generation, same defense as importPeerAttachments/syncWithPeer: if a kill
      // switch fires mid-pass, stop touching the store/disk it just wiped (docs/15 #2).
      const generation = rt.wipeGeneration;
      const activePeerUrls = new Set(rt.appConfig.sync.peers.map((peer) => peer.url));

      for (const record of records) {
        if (rt.wipeGeneration !== generation) {
          return;
        }

        // F2b: the peer was removed from sync.peers since this work item was recorded — never contact a
        // peer the operator explicitly dropped. (The PATCH /api/admin/config handler also prunes these
        // eagerly on removal; this is the belt-and-suspenders check for the config.json / boot-time path.)
        if (!activePeerUrls.has(record.peerUrl)) {
          rt.store.clearMissingAttachment(record.messageId, record.attachmentId);
          continue;
        }

        // The message this attachment belonged to is gone locally (deleted/tombstoned/expired since) —
        // nothing left to attach it to.
        if (!rt.data.messages.some((message) => message.id === record.messageId)) {
          rt.store.clearMissingAttachment(record.messageId, record.attachmentId);
          continue;
        }

        const filePath = join(rt.attachmentsDir, attachmentFileName({ id: record.attachmentId, mimeType: record.mimeType }));

        try {
          await stat(filePath);
          rt.store.clearMissingAttachment(record.messageId, record.attachmentId); // another path already got it
          continue;
        } catch {
          // still missing — fall through to retry
        }

        if (record.createdAt < now - missingAttachmentMaxAgeMs) {
          rt.store.clearMissingAttachment(record.messageId, record.attachmentId);
          rt.log.warn(
            `Giving up on missing attachment ${record.attachmentId} for message ${record.messageId} (peer ${record.peerUrl})`,
          );
          continue;
        }

        // The SQL WHERE clause already guaranteed this record is due (next_attempt_at <= now) — no
        // per-record backoff check needed here any more (P2-2).

        try {
          const bytes = await fetchPeerAttachmentBytes(record.peerUrl, { id: record.attachmentId, mimeType: record.mimeType });

          if (rt.wipeGeneration !== generation) {
            return;
          }

          if (!isAcceptableAttachmentBytes(bytes, record.mimeType)) {
            rt.store.bumpMissingAttachmentAttempts(
              record.messageId,
              record.attachmentId,
              now + missingAttachmentBackoffMs(record.attempts + 1),
            );
            continue;
          }

          await mkdir(rt.attachmentsDir, { recursive: true });
          await writeFile(filePath, bytes);

          if (rt.wipeGeneration !== generation) {
            await rm(filePath, { force: true });
            return;
          }

          rt.store.clearMissingAttachment(record.messageId, record.attachmentId);
        } catch {
          // F6: match the wipeGeneration re-check every other write site in this function has — a kill
          // switch that lands while `fetchPeerAttachmentBytes` was in flight must not re-persist a bumped
          // attempt count onto the store it just wiped.
          if (rt.wipeGeneration !== generation) {
            return;
          }

          rt.store.bumpMissingAttachmentAttempts(
            record.messageId,
            record.attachmentId,
            now + missingAttachmentBackoffMs(record.attempts + 1),
          );
        }
      }
    } finally {
      retryMissingAttachmentsRunning = false;
    }
  }

  // ---- Opportunistic mesh: sealed mailbox (docs/16) ----------------------------------------------
  // Sealed mail is end-to-end encrypted to a single recipient's key: intermediaries carry opaque
  // bytes, only the recipient's home node can open it. All of this is gated on `mesh.enabled`; with
  // it off nothing below runs and the public-data flow is byte-identical to today.

  /** True when `message` names an attachment this node already holds for someone else: an id owned by
   *  another local message or a pending upload, or — because pending-upload ownership is in-memory only
   *  and lost on restart — ANY file already on disk that the identity-verified record being edited
   *  (`existing`, the only legitimate co-owner) doesn't reference. Binding a public import to such a file
   *  would make it anonymously downloadable. (A file left by an import interrupted between write and
   *  insert is refused too, until the orphan sweep reaps it and the next round re-fetches it.) */
  async function claimsForeignAttachment(message: Message, existing: Message | undefined): Promise<boolean> {
    if (message.type === "reaction" || message.type === "sealed" || !message.attachments?.length) {
      return false;
    }

    const ids = new Set(message.attachments.map((attachment) => attachment.id));

    for (const id of ids) {
      if (rt.attachmentOwners.has(id)) {
        return true;
      }
    }

    const ownedElsewhere = rt.data.messages.some(
      (candidate) =>
        candidate !== existing &&
        candidate.type !== "reaction" &&
        candidate.type !== "sealed" &&
        !!candidate.attachments?.some((attachment) => ids.has(attachment.id)),
    );

    if (ownedElsewhere) {
      return true;
    }

    const alreadyReferenced = new Set(
      existing && existing.type !== "reaction" && existing.type !== "sealed"
        ? (existing.attachments ?? []).map((attachment) => attachment.id)
        : [],
    );

    for (const attachment of message.attachments) {
      if (alreadyReferenced.has(attachment.id)) {
        continue;
      }

      // Id-keyed like every other ownership check (the download gate and the orphan sweep resolve a file
      // by id), so declaring a different MIME class can't dodge it via a different file name.
      for (const extension of ["png", "jpg", "webp", "bin"]) {
        try {
          await stat(join(rt.attachmentsDir, `${attachment.id}.${extension}`));
          return true;
        } catch {
          // not on disk under this name
        }
      }
    }

    return false;
  }

  /** True when a later import may edit `existing`: it must be a record this node imported (provenance),
   *  and local moderation is sticky — a moderator removal is an in-place edit (body blanked, files
   *  deleted, `meta.removedByModerator`), which the origin's next ordinary edit would otherwise win
   *  newer-wins against, restoring the content and re-downloading the removed attachment. */
  function isPeerEditable(existing: Message): boolean {
    return !existing.meta?.removedByModerator && rt.store.isMessageSynced(existing.id);
  }

  /** True when `incoming` is an edit of `existing` — same arm, author, timestamp and routing — rather
   *  than a different message reusing its id. */
  function isSameMessageIdentity(existing: Message, incoming: Message): boolean {
    if (existing.type !== incoming.type || existing.authorId !== incoming.authorId || existing.createdAt !== incoming.createdAt) {
      return false;
    }

    if (existing.type === "channelPost" && incoming.type === "channelPost") {
      return existing.channelId === incoming.channelId;
    }

    if (existing.type === "channelReply" && incoming.type === "channelReply") {
      return existing.channelId === incoming.channelId && existing.parentMessageId === incoming.parentMessageId;
    }

    if (existing.type === "reaction" && incoming.type === "reaction") {
      return existing.targetMessageId === incoming.targetMessageId;
    }

    return false;
  }

  /**
   * Import a batch of peer messages: posts before replies before reactions (so parents/targets
   * land first), never into private/unknown channels (a malicious peer must not inject into a
   * local private channel id), never over a tombstone, and edits only when strictly newer — and only of
   * the same message (see {@link isSameMessageIdentity}). The author record of each ACCEPTED message is
   * imported from `users` just before it lands (never the rest of the payload's users).
   *
   * Returns the number imported plus the ids refused only because their reply parent / reaction target
   * hasn't arrived YET but is still on offer this round (`pendingIds`) — the caller must not remember those
   * as refused; everything else this batch asked for and didn't end up holding is a real refusal.
   */
  async function importPeerMessages(
    peerUrl: string,
    messages: Message[],
    users: User[],
    generation: number,
    pendingIds: ReadonlySet<string>,
  ): Promise<{ imported: number; deferred: Set<string> }> {
    const order = { channelPost: 0, channelReply: 1, reaction: 2, dm: 3, sealed: 4 } as const;
    const sorted = [...messages].sort((a, b) => order[a.type] - order[b.type] || a.createdAt - b.createdAt);
    const usersById = new Map(users.map((user) => [user.id, user]));
    const deferred = new Set<string>();
    let imported = 0;

    for (const message of sorted) {
      if (message.type === "dm" || message.meta?.streaming || rt.tombstones.has(message.id)) {
        continue;
      }

      // Ids are peer-chosen. One inside the mesh replay-key namespace would, once deleted or expired
      // here, leave a tombstone that makes this node refuse a genuine sealed message.
      if (mesh.isReservedReplayId(message.id)) {
        continue;
      }

      // Skip an over-cap imported body (docs/25 SW2) — a hostile peer amplification guard. Only the
      // body-bearing public arms have a `body`; reactions/sealed are unaffected.
      if (
        (message.type === "channelPost" || message.type === "channelReply") &&
        Buffer.byteLength(message.body, "utf8") > maxSyncImportBodyBytes
      ) {
        continue;
      }

      // Never import content attributed to one of *our* admins/moderators/greeters — a compromised or
      // hostile peer could otherwise inject a message that renders as authored by this node's admin
      // (local ids are discoverable; they're exported as message authorIds in the sync digest).
      if (rt.isLocallyAuthoritative(message.authorId)) {
        continue;
      }

      // Sealed mailbox mail (opportunistic-mesh, docs/16) is handled entirely apart from the public
      // flow: it's never broadcast to clients — it's decrypted-and-delivered to a local recipient, or
      // relayed onward (hop-decremented, bounded), or dropped. Never falls through to store+broadcast.
      if (message.type === "sealed") {
        if (mesh.acceptSealedFromPeer(message)) {
          imported += 1;
        }
        continue;
      }

      // A public message may not claim a reserved author (a `mesh.*` sender record or an `llm.*` bot) or a
      // non-human one — it would render as that identity here (review 2026-09-25 #8).
      if (!isAcceptablePeerAuthor(message.authorId, usersById)) {
        continue;
      }

      // Node-wide feature flags govern what content may EXIST on this node, not just what local users may
      // create (review 2026-09-04): a node that has switched channel posting, replies, or reactions off
      // must not acquire that content from a peer either — `createMessage` refuses the same three.
      if (
        ((message.type === "channelPost" || message.type === "channelReply") && !rt.appConfig.features.enablePublicChannels) ||
        (message.type === "channelReply" && !rt.appConfig.features.enableReplies) ||
        (message.type === "reaction" && !rt.appConfig.features.enableReactions)
      ) {
        continue;
      }

      // An import may only EDIT the record it names, never turn it into a different one: the checks
      // below vet the INCOMING message, so without this a peer that knows a private message's id could
      // re-offer it as a public arm — reclassifying a DM into the public export (leaking its body via
      // `Object.assign`-preserved fields, and its attachments via the download gate). Checked BEFORE any
      // attachment fetch, so a refused import can't write bytes or queue retry work under a local id.
      const existing = rt.data.messages.find((candidate) => candidate.id === message.id);

      // ...and only a record this node itself IMPORTED. Sync is unsigned and the export hands a peer every
      // field the identity check compares, so without provenance any configured peer could rewrite a
      // message a LOCAL user wrote. (Messages imported before this mark existed are unmarked, so their
      // later peer edits are ignored — fail closed.)
      if (existing && (!isSameMessageIdentity(existing, message) || !isPeerEditable(existing))) {
        continue;
      }

      if (message.type === "reaction") {
        const target = rt.data.messages.find((candidate) => candidate.id === message.targetMessageId);

        // The reaction's target must exist locally and be public-audience (no DM/private targets). A target
        // still on offer this round may simply not have landed yet — retry next round, don't remember it.
        if (!target) {
          if (pendingIds.has(message.targetMessageId) && !rt.tombstones.has(message.targetMessageId)) {
            deferred.add(message.id);
          }
          continue;
        }
        if (rt.messageAudienceUserIds(message) !== undefined) {
          continue;
        }
        // Like `createMessage`: no NEW reactions on a moderator-removed message (local moderation is sticky).
        if (!existing && target.meta?.removedByModerator) {
          continue;
        }

        // ...and its channel must still accept new content here — `createMessage` refuses a reaction in an
        // archived channel, so an import must too (round-2 review): a peer that hasn't archived the channel
        // must not keep landing reactions into one this node has.
        if (target.type === "channelPost" || target.type === "channelReply") {
          const targetChannel = rt.ensureChannel(target.channelId);

          if (!targetChannel || targetChannel.archived) {
            continue;
          }
        }
      } else {
        const channel = rt.ensureChannel(message.channelId);

        if (!channel || channel.visibility !== "public" || channel.archived) {
          continue;
        }

        // The channel's posting policy (owner-only / admins-only / replies off) applies to imports too —
        // otherwise a peer could land posts in a read-only announcements channel under any ordinary author
        // id, bypassing the lockdown (review 2026-09-04) — including a PEER-ORIGIN channel, whose policy
        // the peer's metadata merge or a local admin may have tightened since. The one rule that can't be
        // evaluated for a peer-origin channel is `owner`: imports strip `ownerUserId` (a peer must never
        // name a local authority), so for those the origin's owner check is trusted and only the
        // evaluable rules (archived, replies off) apply here (round-2 review).
        const isReply = message.type === "channelReply";
        const ownerRuleUnavailable = rt.syncedChannelIds.has(channel.id) && channel.allowPosting === "owner";
        if (ownerRuleUnavailable) {
          if (channel.archived || (isReply && !channel.allowReplies)) {
            continue;
          }
        } else if (rt.channelPostingError(channel, message.authorId, isReply) !== undefined) {
          continue;
        }

        // A reply needs a valid local parent in the same channel (posts sort first, so a parent
        // in the same batch already landed). A parent we tombstoned or never had stays deleted —
        // and takes its replies with it, matching the local cascade semantics. (The refused reply is
        // remembered per peer by the caller rather than tombstoned: a tombstone is node-wide and durable,
        // and a peer choosing the reply's id could use one to pre-block a genuine id arriving elsewhere.)
        // A parent still on offer this round may just be in a later batch — retry next round instead.
        if (message.type === "channelReply") {
          const parent = rt.data.messages.find((candidate) => candidate.id === message.parentMessageId);

          if (!parent) {
            if (pendingIds.has(message.parentMessageId) && !rt.tombstones.has(message.parentMessageId)) {
              deferred.add(message.id);
            }
            continue;
          }
          if (parent.type !== "channelPost" || parent.channelId !== message.channelId) {
            continue;
          }
          // Like `createMessage`: a moderator-removed post takes no NEW replies from a peer either.
          if (!existing && parent.meta?.removedByModerator) {
            continue;
          }
        }

        // An attachment id belongs to exactly one message (uploads are consumed on first use). A peer
        // message naming an id that a DIFFERENT local message — or a still-pending local upload — already
        // owns would alias that file: the download gate resolves a file to its owning message, so a public
        // import could make a DM / private-channel attachment anonymously fetchable. Refuse it outright.
        if (await claimsForeignAttachment(message, existing)) {
          continue;
        }

        // The check above awaited — a kill switch may have landed (docs/15 #2).
        if (rt.wipeGeneration !== generation) {
          return { imported, deferred };
        }

        await importPeerAttachments(peerUrl, message, generation);
        // A kill switch during the attachment fetch just wiped the store — stop before we insert
        // this (and any later) message back onto it (docs/15 #2).
        if (rt.wipeGeneration !== generation) {
          return { imported, deferred };
        }
      }

      // The attachment work above awaited: if the record was deleted (or appeared) locally meanwhile,
      // drop this import rather than update a detached object and broadcast a deleted message back.
      if (rt.data.messages.find((candidate) => candidate.id === message.id) !== existing) {
        continue;
      }

      if (existing) {
        if ((message.editedAt ?? 0) > (existing.editedAt ?? 0)) {
          importPeerAuthor(message.authorId, usersById);
          const updated = MessageSchema.parse(message);
          rt.store.updateMessage(updated);
          // Mirror the row exactly: drop optional fields the edit removed (e.g. `attachments`) before
          // merging, or the in-memory record keeps what the database no longer has until a restart.
          for (const key of Object.keys(existing)) {
            if (!(key in updated)) {
              delete (existing as Record<string, unknown>)[key];
            }
          }
          Object.assign(existing, updated);
          rt.broadcast({ type: "messageUpdated", message: existing });
          imported += 1;
        }

        continue;
      }

      importPeerAuthor(message.authorId, usersById);
      rt.store.transaction(() => {
        rt.store.insertMessage(message);
        rt.store.markMessageSynced(message.id);
      });
      rt.data.messages.push(message);
      rt.broadcast({ type: "messageCreated", message });
      imported += 1;
    }

    if (imported) {
      rt.data.messages.sort((a, b) => a.createdAt - b.createdAt);
    }

    return { imported, deferred };
  }

  /** One pull round against one peer: digest → diff (skipping tombstones) → fetch → import. */
  async function syncWithPeer(peer: SyncPeer): Promise<void> {
    // Snapshot the wipe generation: if a kill switch fires mid-round, every post-await check below
    // abandons the round rather than writing peer data back onto the wiped store (docs/15 #2).
    const generation = rt.wipeGeneration;
    const status = peerSyncStatus.get(peer.url) ?? { imported: 0 };
    peerSyncStatus.set(peer.url, status);
    status.lastAttemptAt = Date.now();

    try {
      const digest = await fetchPeerJson(peer.url, "/api/sync/digest", SyncDigestSchema);
      if (rt.wipeGeneration !== generation) {
        return;
      }

      for (const channel of digest.channels) {
        if (channel.visibility !== "public") {
          continue;
        }

        const existing = rt.ensureChannel(channel.id);

        if (!existing) {
          // A locally deleted channel is tombstoned by its id — a peer that still lists it must
          // never resurrect it here (delete is permanent; archive is the recoverable state).
          if (rt.tombstones.has(channel.id) || mesh.isReservedReplayId(channel.id)) {
            continue;
          }

          // Never seen it: import it and RECORD it as synced-origin (so its later metadata edits can
          // re-sync — C1). Skip a fresh channel that arrives already-archived: no messages sync for an
          // archived channel, so we'd only materialise an empty dead channel.
          if (channel.archived) {
            continue;
          }
          // Strip the peer's LOCAL-only choices: private roster (never public here anyway), pin, and the
          // per-channel retention TTL — retention is a local policy, so an importer must not inherit the
          // source's TTL and silently expire its own copy.
          const created = ChannelSchema.parse({
            ...channel,
            // Clamp the imported stamp to now, exactly like the merge path — otherwise a future/
            // clock-skewed peer stamp would freeze the channel on import and block every later correction.
            updatedAt: Math.min(channel.updatedAt ?? channel.createdAt, Date.now()),
            // Never trust the peer's `ownerUserId` — it could name a LOCAL authoritative user (making the
            // imported channel appear owned by this node's admin) or a foreign id. Imported channels are
            // ownerless here; the local admin manages them via /api/admin/channels.
            ownerUserId: undefined,
            memberUserIds: undefined,
            pinned: undefined,
            messageTtlMs: undefined,
          });
          rt.store.upsertChannel(created);
          rt.store.markChannelSynced(created.id);
          rt.syncedChannelIds.add(created.id);
          rt.data.channels.push(created);
          rt.broadcast({ type: "channelUpserted", channel: created });
          continue;
        }

        // C1 provenance gate: only re-sync metadata for a channel THIS node imported from a peer. A
        // locally-created channel — including the fixed-id default `general`/`announcements` every node
        // ships — is never in `syncedChannelIds`, so a same-slug collision on a peer can never clobber it.
        // (A private local channel colliding with a peer's public id is also excluded — never public here.)
        if (existing.visibility !== "public" || !rt.syncedChannelIds.has(existing.id)) {
          continue;
        }

        // Newer-wins on the metadata-change stamp, with the peer stamp CLAMPED to now so a future/
        // clock-skewed peer timestamp (off-grid nodes have no NTP) can't win permanently and lock out a
        // legitimate local correction. Only a strictly-newer peer copy applies.
        const peerStamp = Math.min(channel.updatedAt ?? channel.createdAt, Date.now());
        const localStamp = existing.updatedAt ?? existing.createdAt;

        if (peerStamp <= localStamp) {
          continue;
        }

        // Merge ONLY the public metadata a peer is authoritative-enough to carry; never let sync rewrite
        // local ownership, visibility, membership, or creation time.
        const merged = ChannelSchema.parse({
          ...existing,
          name: channel.name,
          description: channel.description,
          allowPosting: channel.allowPosting,
          allowReplies: channel.allowReplies,
          discoverable: channel.discoverable,
          archived: channel.archived,
          updatedAt: peerStamp,
        });
        rt.store.upsertChannel(merged);
        Object.assign(existing, merged);
        rt.broadcast({ type: "channelUpserted", channel: existing });
      }

      const now = Date.now();
      const localById = new Map(rt.data.messages.map((message) => [message.id, message]));
      // What each requested id was asked for, so a batch can tell afterwards which offers it REFUSED.
      const offers = new Map<string, { kind: "public"; editedAt?: number } | { kind: "sealed"; ttlExpiresAt: number; hopLimit: number }>();

      const publicWanted: string[] = [];
      for (const entry of digest.messages) {
        if (publicWanted.length >= MAX_PUBLIC_IDS_PER_ROUND) {
          break;
        }
        if (rt.tombstones.has(entry.id) || isRefusedOffer(peer.url, publicOfferKey(entry.id, entry.editedAt), now)) {
          continue;
        }

        const mine = localById.get(entry.id);

        // Don't even ask for an edit the import would refuse (a local-origin or moderator-removed
        // record) — the peer's newer stamp never goes away, so it would be re-fetched every round.
        if (mine && !(entry.editedAt !== undefined && entry.editedAt > (mine.editedAt ?? 0) && isPeerEditable(mine))) {
          continue;
        }
        publicWanted.push(entry.id);
        offers.set(entry.id, { kind: "public", editedAt: entry.editedAt });
      }

      // Sealed mailbox mail on offer. Which blobs we pull must NOT depend on which of them are addressed to
      // a local identity (review 2026-09-25 #4): pulling only "ours" whenever this node isn't relaying (relay
      // off — the default — or at `maxCarried`, or a hop-1 blob) told the serving peer exactly which node the
      // recipient of a tag lives on, while docs/16 promises carriers learn the path, never the endpoints. So
      // pull every offer acceptance could take at all (`sealedOfferAdmissible` — the same outer-field checks
      // `acceptSealedFromPeer` applies, #1), soonest-expiring first, within a per-round budget; the import
      // delivers what's ours, carries what it can, and drops the rest. The cost is that a non-relaying node
      // downloads each blob its peer carries once, like a relay would.
      //
      // "Once" must hold for every outcome alike (review 2026-09-25 follow-up). Every sealed id this node has
      // fetched or received is in the durable, node-wide seen-offer record until the offer's own TTL, and is
      // never fetched again — delivered, carried or dropped. (Delivered ids used to be skipped for good via
      // their tombstone while dropped ones sat in a RAM cache that a restart, any admin config save or a relay
      // toggle cleared; the next round then re-fetched exactly the foreign blobs, and a peer diffing the two
      // fetch sets learned which blobs were delivered here.) A node that later starts relaying therefore
      // doesn't go back for blobs it dropped earlier; other carriers still can.
      //
      // Skipped entirely when there is nothing to do with a blob: relaying is off and no local user holds a
      // mesh identity (nothing to deliver, nothing to carry). That decision doesn't look at tags either.
      const sealedWanted: string[] = [];
      const sealedBudget = rt.appConfig.mesh.maxSealedPullPerRound ?? DEFAULT_SEALED_IDS_PER_ROUND;
      if (
        rt.appConfig.mesh.enabled &&
        digest.sealed?.length &&
        sealedBudget > 0 &&
        (rt.appConfig.mesh.relay || mesh.meshIdentities.size > 0)
      ) {
        if (mesh.sealedSeenAtCapacity()) {
          rt.log.warn("Sync: the sealed seen-offer record is full; pulling no new sealed mail until entries expire");
        } else {
          const candidates = digest.sealed
            .filter(
              (entry) =>
                !localById.has(entry.id) &&
                !offers.has(entry.id) &&
                mesh.sealedOfferAdmissible(entry, now) &&
                !mesh.isSealedOfferSeen(entry.id, now),
            )
            .sort((a, b) => a.ttlExpiresAt - b.ttlExpiresAt)
            .slice(0, sealedBudget);
          for (const entry of candidates) {
            sealedWanted.push(entry.id);
            offers.set(entry.id, { kind: "sealed", ttlExpiresAt: entry.ttlExpiresAt, hopLimit: entry.hopLimit });
          }
        }
      }

      const pendingIds: ReadonlySet<string> = new Set(offers.keys());

      /** After a batch: remember, per peer, every PUBLIC offer it asked for and didn't end up holding (unless it
       *  was only deferred for a parent/target still on offer), so the next round doesn't fetch it again — and
       *  record every SEALED offer it asked for as seen, whatever its outcome (see the sealed pull above). */
      const settleBatch = (ids: string[], deferred: ReadonlySet<string>) => {
        const settledAt = Date.now();
        const held = new Map(rt.data.messages.map((message) => [message.id, message]));
        for (const id of ids) {
          const offer = offers.get(id);
          if (!offer) {
            continue;
          }
          if (offer.kind === "sealed") {
            mesh.rememberSealedOffer(id, offer.ttlExpiresAt);
            continue;
          }
          if (deferred.has(id) || rt.tombstones.has(id)) {
            continue;
          }
          const mine = held.get(id);
          if (!mine || (mine.editedAt ?? 0) < (offer.editedAt ?? 0)) {
            rememberRefusedOffer(peer.url, publicOfferKey(id, offer.editedAt), settledAt + REFUSED_TTL_MS);
          }
        }
      };

      // Bisection accounting for this round (see SPLIT_SLACK / MAX_WASTED_BYTES_PER_ROUND).
      const sizes = peerBatchSizes.get(peer.url) ?? { public: PUBLIC_BATCH_IDS, sealed: SEALED_BATCH_IDS };
      peerBatchSizes.set(peer.url, sizes);
      let splitsLeft =
        2 * (Math.ceil(publicWanted.length / sizes.public) + Math.ceil(sealedWanted.length / sizes.sealed)) + SPLIT_SLACK;
      const meter = { wastedBytes: 0 };
      let sawTooLarge = false;

      /** Fetch + import one batch. A batch whose CONTENT is unusable (over the size cap, not JSON, fails the
       *  schema) is split in half and retried, down to single ids, so one oversized or malformed message
       *  can't sink the rest (#2) — and a single unusable id is remembered as refused. A too-large answer
       *  also shrinks this peer's later batches of that kind. Splitting stops, and the peer counts as failing
       *  for the round, once the round's split or wasted-byte budget is spent. Any other failure (peer
       *  unreachable, 4xx/5xx) ends the round's fetching too: it is returned, not thrown, so what earlier
       *  batches imported stands. */
      const pullBatch = async (ids: string[], kind: "public" | "sealed"): Promise<{ imported: number; error?: string } | "wiped"> => {
        let payload: { messages: Message[]; users: User[] };
        try {
          payload = await fetchPeerJson(peer.url, "/api/sync/messages", SyncMessagesResponseSchema, { ids }, meter);
        } catch (error) {
          if (rt.wipeGeneration !== generation) {
            return "wiped";
          }
          if (!isPeerContentError(error)) {
            return { imported: 0, error: error instanceof Error ? error.message : "Sync failed" };
          }
          if (error instanceof Error && error.message === "Peer response too large") {
            sawTooLarge = true;
            const floor = kind === "public" ? MIN_PUBLIC_BATCH_IDS : MIN_SEALED_BATCH_IDS;
            sizes[kind] = Math.max(floor, Math.min(sizes[kind], Math.ceil(ids.length / 2)));
          }
          if (meter.wastedBytes > MAX_WASTED_BYTES_PER_ROUND) {
            return { imported: 0, error: "Peer kept serving unusable batches (byte budget spent); retrying next round" };
          }
          if (ids.length === 1) {
            rt.log.warn(`Sync: peer ${peer.url} served an unusable record for one message; skipping it`);
            settleBatch(ids, new Set());
            return { imported: 0 };
          }
          if (splitsLeft < 2) {
            return { imported: 0, error: "Peer kept serving unusable batches (split budget spent); retrying next round" };
          }
          splitsLeft -= 2;
          const half = Math.ceil(ids.length / 2);
          let total = 0;
          for (const part of [ids.slice(0, half), ids.slice(half)]) {
            const result = await pullBatch(part, kind);
            if (result === "wiped" || result.error) {
              return result === "wiped" ? result : { imported: total + result.imported, error: result.error };
            }
            total += result.imported;
          }
          return { imported: total };
        }
        if (rt.wipeGeneration !== generation) {
          return "wiped";
        }
        const result = await importPeerMessages(peer.url, payload.messages, payload.users, generation, pendingIds);
        if (rt.wipeGeneration !== generation) {
          return "wiped";
        }
        settleBatch(ids, result.deferred);
        return { imported: result.imported };
      };

      let imported = 0;
      let failure: string | undefined;
      pulling: for (const [kind, wanted] of [
        ["public", publicWanted],
        ["sealed", sealedWanted],
      ] as const) {
        // Batches are cut as we go, so a size shrunk by a too-large answer applies to the rest of the round.
        for (let start = 0; start < wanted.length; ) {
          const ids = wanted.slice(start, start + sizes[kind]);
          start += ids.length;
          const result = await pullBatch(ids, kind);
          if (result === "wiped") {
            return;
          }
          imported += result.imported;
          if (result.error) {
            failure = result.error;
            break pulling;
          }
        }
      }

      // A round without a too-large answer lets a shrunk batch size grow back toward the default.
      if (!sawTooLarge && !failure) {
        sizes.public = Math.min(PUBLIC_BATCH_IDS, sizes.public * 2);
        sizes.sealed = Math.min(SEALED_BATCH_IDS, sizes.sealed * 2);
      }

      status.imported += imported;
      if (failure) {
        status.lastError = failure;
        rt.log.warn(`Sync with peer ${peer.url} stopped part-way: ${failure}`);
      } else {
        status.lastSuccessAt = Date.now();
        status.lastError = undefined;
      }

      if (imported) {
        rt.log.info(`Synced ${imported} message(s) from peer ${peer.url}`);
      }
    } catch (error) {
      status.lastError = error instanceof Error ? error.message : "Sync failed";
      rt.log.warn(`Sync with peer ${peer.url} failed: ${status.lastError}`);
    }
  }

  /** The pull loop: one round across all peers, at most once per configured interval. */
  async function runSyncLoop(force = false): Promise<void> {
    if (!rt.appConfig.sync.enabled || syncRunning || !rt.appConfig.sync.peers.length) {
      return;
    }

    if (!force && Date.now() - lastSyncLoopAt < rt.appConfig.sync.intervalMs) {
      return;
    }

    syncRunning = true;
    lastSyncLoopAt = Date.now();

    try {
      // Peers sync concurrently — syncWithPeer never rejects (it records failures in its own
      // status entry), and the import path re-checks message existence after its last await, so
      // interleaved rounds can't double-insert.
      await Promise.all(rt.appConfig.sync.peers.map((peer) => syncWithPeer(peer)));
    } finally {
      syncRunning = false;
    }
  }

  /** Peer list with live status, as shown in the admin UI (SyncStatusReportSchema is the contract). */
  function syncStatusReport(): SyncStatusReport {
    return {
      enabled: rt.appConfig.sync.enabled,
      intervalMs: rt.appConfig.sync.intervalMs,
      peers: rt.appConfig.sync.peers.map((peer) => ({
        ...peer,
        status: peerSyncStatus.get(peer.url),
      })),
    };
  }

  return {
    peerSyncStatus,
    peerTransportSessions,
    isSyncableMessage,
    buildSyncDigest,
    forgetPeerState,
    forgetRefusedOffers,
    retryMissingAttachments,
    syncWithPeer,
    runSyncLoop,
    syncStatusReport,
  };
}
