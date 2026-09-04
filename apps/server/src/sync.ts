// Node-to-node sync (docs/11): the digest, the per-peer transport decision, defensive imports of peer
// users/messages/attachments, the missing-attachment retry, and the sync loop. Extracted verbatim from
// app.ts (2026-09-04 split) behind the shared `Runtime` view plus the mesh layer it hands sealed mail to.
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyKxBinding } from "@loam/crypto";
import { ChannelSchema, type Message, type MessageAttachment, MessageSchema, type SealedMessage, SyncAttachmentResponseSchema, type SyncDigest, SyncDigestSchema, SyncMessagesResponseSchema, type SyncPeer, type SyncStatusReport, type User, UserSchema } from "@loam/schema";
import { attachmentFileName, attachmentMaxBytes, isAcceptableAttachmentBytes, missingAttachmentBackoffMs, missingAttachmentMaxAgeMs, missingAttachmentMaxRecordsPerPass } from "./media.js";
import { type PeerTransportPosture, type PeerTransportSession, fetchPeerTransportPosture, handshakeWithPeer, sealedFetch } from "./sync-transport.js";
import type { MeshLayer } from "./mesh.js";
import type { Runtime } from "./runtime.js";

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

  // Generous digest/messages ceiling: a full 500-message batch of maximum-size bodies fits well
  // inside this; anything larger is not a LOAM peer talking in good faith.
  const maxPeerJsonBytes = 8 * 1024 * 1024;

  // Per-message body cap for SYNC IMPORT only (docs/25 SW2). The stored `MessageBodySchema` is deliberately
  // uncapped (a local LLM reply can be long, and locally-authored content must round-trip), but a hostile
  // *sync peer* could otherwise push bodies up to `maxPeerJsonBytes` (~8MB each) to amplify storage and
  // bandwidth against a syncing node. 256KB is far above any real message (including long LLM replies), so
  // an over-cap imported body is skipped, not fatal. Reactions/sealed carry no `body`.
  const maxSyncImportBodyBytes = 256 * 1024;

  /** The shared sync-token header (if configured), presented so a token-guarded peer will serve us and
   * harmless when the peer runs open. Under transport encryption this rides INSIDE the sealed session. */
  function peerSyncHeaders(): Record<string, string> {
    return rt.appConfig.sync.token ? { "x-loam-sync-token": rt.appConfig.sync.token } : {};
  }

  /** Handshake a fresh transport session against a peer (honouring any operator-pinned key) and cache
   * it. The pinned key comes from the peer's own sync-config entry (`SyncPeer.transportKey`). */
  async function handshakePeerAndCache(peerUrl: string): Promise<PeerTransportSession> {
    const pinnedKey = rt.appConfig.sync.peers.find((peer) => peer.url === peerUrl)?.transportKey;
    const session = await handshakeWithPeer(peerUrl, { expectedHostKey: pinnedKey });
    peerTransportSessions.set(peerUrl, { transport: session, expiresAt: Date.now() + PEER_TRANSPORT_SESSION_TTL_MS });
    return session;
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
   * at all (older peer, or `/api/bootstrap` unreachable/non-2xx) falls back to plaintext exactly as before
   * transport encryption existed — if it truly required transport the plaintext pull just 401s and the
   * round records a normal failure, never a silent wrong result.
   */
  async function resolvePeerTransport(peerUrl: string): Promise<PeerTransportSession | "plaintext"> {
    const cached = peerTransportSessions.get(peerUrl);
    if (cached && cached.expiresAt > Date.now()) {
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
      // `/api/bootstrap`) → preserve the legacy plaintext path.
      return cachePlaintext(peerUrl);
    }

    if (posture.mode === "off" || !posture.publicKey) {
      return cachePlaintext(peerUrl);
    }

    try {
      return await handshakePeerAndCache(peerUrl);
    } catch (error) {
      if (posture.mode === "required") {
        throw error;
      }
      return cachePlaintext(peerUrl);
    }
  }

  /**
   * GET/POST a peer endpoint with a timeout, a response-size cap, and schema validation. Transparently
   * routes through the peer's transport session when it advertises encryption (docs/08) — so the sync
   * digest/messages request+response DATA travels sealed (the `x-loam-sync-token` bearer header does NOT
   * — it rides plaintext, gating public-data-only reads; see docs/08) — and stays a plain HTTP request
   * against a peer running transport `off`.
   */
  async function fetchPeerJson<T>(
    peerUrl: string,
    path: string,
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
    body?: unknown,
  ): Promise<T> {
    const transport = await resolvePeerTransport(peerUrl);
    const raw =
      transport === "plaintext"
        ? await fetchPeerText(peerUrl, path, body)
        : await sealedFetchPeerText(transport, peerUrl, path, body);

    const parsed = schema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
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
      maxBytes: maxPeerJsonBytes,
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

  /**
   * Import a peer's user profiles for message authors we don't know yet. Authority and moderation
   * state are stripped — a peer's admin or moderator is a stranger here, and a peer must never be
   * able to ban/shadow-ban someone on this node.
   */
  function importPeerUsers(users: User[]): void {
    for (const user of users) {
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
        if (!existing.identityKey && importedKey) {
          const next = UserSchema.parse({ ...existing, identityKey: importedKey });
          rt.store.upsertUser(next);
          Object.assign(existing, next);
          rt.broadcast({ type: "userUpserted", user: existing });
        }
        continue;
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
      rt.store.upsertUser(sanitized);
      rt.data.users.push(sanitized);
      rt.broadcast({ type: "userUpserted", user: sanitized });
    }
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
        return await readPeerBody(response, attachmentMaxBytes);
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

        if (!isAcceptableAttachmentBytes(bytes, attachment.mimeType)) {
          // Fetched something, but it isn't usable — record it as missing too (docs/15 A6) rather
          // than silently dropping it: a peer mid-write or serving a truncated/corrupt copy today can
          // look fine on a later retry.
          rt.store.addMissingAttachment({ messageId: message.id, attachmentId: attachment.id, mimeType: attachment.mimeType, peerUrl });
          continue;
        }

        // A kill switch during the fetch just deleted the attachments dir — don't recreate it and
        // write an orphaned file the wipe was meant to destroy (docs/15 #2).
        if (rt.wipeGeneration !== generation) {
          return;
        }

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

  /**
   * Import a batch of peer messages: posts before replies before reactions (so parents/targets
   * land first), never into private/unknown channels (a malicious peer must not inject into a
   * local private channel id), never over a tombstone, and edits only when strictly newer.
   */
  async function importPeerMessages(peerUrl: string, messages: Message[], generation: number): Promise<number> {
    const order = { channelPost: 0, channelReply: 1, reaction: 2, dm: 3, sealed: 4 } as const;
    const sorted = [...messages].sort((a, b) => order[a.type] - order[b.type] || a.createdAt - b.createdAt);
    let imported = 0;

    for (const message of sorted) {
      if (message.type === "dm" || message.meta?.streaming || rt.tombstones.has(message.id)) {
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

      if (message.type === "reaction") {
        const target = rt.data.messages.find((candidate) => candidate.id === message.targetMessageId);

        // The reaction's target must exist locally and be public-audience (no DM/private targets).
        if (!target || rt.messageAudienceUserIds(message) !== undefined) {
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
        // and takes its replies with it, matching the local cascade semantics.
        if (message.type === "channelReply") {
          const parent = rt.data.messages.find((candidate) => candidate.id === message.parentMessageId);

          if (!parent || parent.type !== "channelPost" || parent.channelId !== message.channelId) {
            continue;
          }
        }

        await importPeerAttachments(peerUrl, message, generation);
        // A kill switch during the attachment fetch just wiped the store — stop before we insert
        // this (and any later) message back onto it (docs/15 #2).
        if (rt.wipeGeneration !== generation) {
          return imported;
        }
      }

      const existing = rt.data.messages.find((candidate) => candidate.id === message.id);

      if (existing) {
        if ((message.editedAt ?? 0) > (existing.editedAt ?? 0)) {
          const updated = MessageSchema.parse(message);
          rt.store.updateMessage(updated);
          Object.assign(existing, updated);
          rt.broadcast({ type: "messageUpdated", message: existing });
          imported += 1;
        }

        continue;
      }

      rt.store.insertMessage(message);
      rt.data.messages.push(message);
      rt.broadcast({ type: "messageCreated", message });
      imported += 1;
    }

    if (imported) {
      rt.data.messages.sort((a, b) => a.createdAt - b.createdAt);
    }

    return imported;
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
          if (rt.tombstones.has(channel.id)) {
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

      const localById = new Map(rt.data.messages.map((message) => [message.id, message]));
      const wanted = digest.messages
        .filter((entry) => {
          if (rt.tombstones.has(entry.id)) {
            return false;
          }

          const mine = localById.get(entry.id);
          return !mine || (entry.editedAt !== undefined && entry.editedAt > (mine.editedAt ?? 0));
        })
        .map((entry) => entry.id);

      // Sealed mailbox mail on offer: pull a blob only if it's addressed to a local identity (a tag
      // match) or this node relays and has room — never mail that's neither ours nor carriable.
      if (rt.appConfig.mesh.enabled && digest.sealed?.length) {
        const now = Date.now();
        const localTags = new Set<string>();
        for (const identity of mesh.meshIdentities.values()) {
          for (const tag of mesh.localTagsForWindow(identity, now)) {
            localTags.add(tag);
          }
        }
        const carried = rt.data.messages.reduce((count, message) => count + (message.type === "sealed" ? 1 : 0), 0);
        const canRelay = rt.appConfig.mesh.relay && carried < rt.appConfig.mesh.maxCarried;
        for (const entry of digest.sealed) {
          if (rt.tombstones.has(entry.id) || localById.has(entry.id) || entry.ttlExpiresAt <= now || entry.hopLimit <= 0) {
            continue;
          }
          if (localTags.has(entry.toTag) || canRelay) {
            wanted.push(entry.id);
          }
        }
      }

      let imported = 0;

      for (let start = 0; start < wanted.length; start += 200) {
        const payload = await fetchPeerJson(
          peer.url,
          "/api/sync/messages",
          SyncMessagesResponseSchema,
          { ids: wanted.slice(start, start + 200) },
        );
        if (rt.wipeGeneration !== generation) {
          return;
        }
        importPeerUsers(payload.users);
        imported += await importPeerMessages(peer.url, payload.messages, generation);
        if (rt.wipeGeneration !== generation) {
          return;
        }
      }

      status.lastSuccessAt = Date.now();
      status.lastError = undefined;
      status.imported += imported;

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
    importPeerUsers,
    retryMissingAttachments,
    syncWithPeer,
    runSyncLoop,
    syncStatusReport,
  };
}
