// Node-to-node sync endpoints (token-authed public data) and the opportunistic-mesh endpoints (identity
// cards, contacts, sealed send/broadcast, the loopback transport bridge, admin sync). Extracted verbatim
// from app.ts (2026-09-04 split) over the shared AppContext.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MeshBroadcastRequestSchema, type MeshContact, MeshIdentityCardSchema, MeshInboundRequestSchema, MeshSendRequestSchema, type SealedMessage, SyncAttachmentRequestSchema, SyncMessagesRequestSchema } from "@loam/schema";
import type { AppContext } from "./app-context.js";
import { errorBody } from "./errors.js";
import { attachmentFileName, parseAttachmentFileName } from "./media.js";
import type { FastifyReply, FastifyRequest } from "fastify";

export function registerSyncMeshRoutes(ctx: AppContext): void {
  // GET for a plaintext (`off`-mode) peer; POST for a sealed peer, which carries the `{ s, b, tok }`
  // envelope so the sync token is sealed and the request proves session-key possession (docs/08). The
  // handler ignores the (empty) POST body — it's the sealed envelope that matters. Registered as two
  // POSITIONAL routes rather than one `server.route({ config })` so CodeQL's missing-rate-limiting query
  // credits the per-route limit (it only recognises the `server.<method>(url, { config }, handler)` form).
  const syncDigestHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.appConfig.sync.enabled || !ctx.syncPeerAuthorized(request)) {
      return reply.code(404).send(errorBody("Not found"));
    }
    return ctx.sync.buildSyncDigest();
  };

  // INLINE config literals (not `semanticRateLimit(60)`): CodeQL's js/missing-rate-limiting query
  // can't resolve the helper call and reports these authorization-performing routes as unlimited.
  // The object is the exact expansion of `semanticRateLimit(60)` — keep them in lockstep.
  ctx.server.get(
    "/api/sync/digest",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute", allowList: () => false } } },
    syncDigestHandler,
  );

  ctx.server.post(
    "/api/sync/digest",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute", allowList: () => false } } },
    syncDigestHandler,
  );

  ctx.server.post(
    "/api/sync/messages",
    ctx.semanticRateLimit(120),
    async (request, reply) => {
      if (!ctx.appConfig.sync.enabled || !ctx.syncPeerAuthorized(request)) {
        return reply.code(404).send(errorBody("Not found"));
      }

      const body = SyncMessagesRequestSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send(errorBody("Invalid sync request"));
      }

      const wanted = new Set(body.data.ids);
      const messages = ctx.data.messages.filter((message) => wanted.has(message.id) && ctx.sync.isSyncableMessage(message));
      const authorIds = new Set(messages.map((message) => message.authorId));
      // Sanitize author records before they cross to a peer: a peer operator has no more business
      // enumerating who holds authority here than a joiner does (`publicUser` strips roles +
      // shadowBanned), and an import strips authority regardless.
      const users = ctx.data.users.filter((user) => authorIds.has(user.id)).map(ctx.publicUser);
      return { messages, users };
    },
  );

  // A peer fetches a public-message attachment's bytes as base64 JSON here (docs/08) rather than the
  // tunnel-only binary `/api/attachments/:fileName`, so it rides the sealed transport channel (`onSend`
  // seals string payloads; a raw binary GET can't be app-sealed and is 401'd in required mode). Only
  // attachments on SYNCABLE (public, non-shadow-banned) messages are served — the same scope as the
  // messages export — so DM / private-channel attachments never cross.
  ctx.server.post(
    "/api/sync/attachment",
    ctx.semanticRateLimit(240),
    async (request, reply) => {
      if (!ctx.appConfig.sync.enabled || !ctx.syncPeerAuthorized(request)) {
        return reply.code(404).send(errorBody("Not found"));
      }

      const body = SyncAttachmentRequestSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send(errorBody("Invalid sync request"));
      }

      const attachment = parseAttachmentFileName(body.data.fileName);
      if (!attachment) {
        return reply.code(404).send(errorBody("Attachment does not exist"));
      }

      // Serve only if a SYNCABLE (public) message actually references it — mirrors the messages export
      // scope so a peer can't pull a DM / private-channel attachment by guessing its file name.
      const owningMessage = ctx.data.messages.find(
        (message) =>
          ctx.sync.isSyncableMessage(message) &&
          message.type !== "reaction" &&
          message.type !== "sealed" &&
          !!message.attachments?.some((entry) => entry.id === attachment.id),
      );
      if (!owningMessage) {
        return reply.code(404).send(errorBody("Attachment does not exist"));
      }

      try {
        const bytes = await readFile(join(ctx.attachmentsDir, attachmentFileName(attachment)));
        return { data: bytes.toString("base64"), mimeType: attachment.mimeType };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return reply.code(404).send(errorBody("Attachment does not exist"));
        }
        throw error;
      }
    },
  );

  // The current user's own shareable mesh identity card (opportunistic-mesh — docs/16): public keys
  // PLUS the secret mailbox token, so a peer can add it as a contact and seal mail to them. Returned
  // only over this authenticated endpoint — the token never rides sync. 404 unless mesh is enabled.
  ctx.server.get("/api/mesh/identity", async (request, reply) => {
    const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));
    const accessError = ctx.participationError(currentUser);

    if (accessError) {
      return reply.code(403).send(errorBody(accessError));
    }
    if (!ctx.appConfig.mesh.enabled) {
      return reply.code(404).send(errorBody("Not found"));
    }

    const identity = ctx.mesh.ensureMeshIdentity(currentUser.id);
    if (!identity) {
      return reply.code(400).send(errorBody("This user has no mesh identity"));
    }
    return ctx.mesh.meshIdentityCard(identity, currentUser.displayName);
  });

  // Add a mesh contact from a scanned/pasted identity card (docs/16). The card is re-verified
  // server-side (self-certifying id + kx binding) before storing, so a forged or substituted card
  // can't be added and later sealed to. 404 unless mesh is enabled (indistinguishable from absent).
  ctx.server.post(
    "/api/mesh/contacts",
    ctx.semanticRateLimit(60),
    async (request, reply) => {
      const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));
      const accessError = ctx.participationError(currentUser);

      if (accessError) {
        return reply.code(403).send(errorBody(accessError));
      }
      if (!ctx.appConfig.mesh.enabled) {
        return reply.code(404).send(errorBody("Not found"));
      }

      const card = MeshIdentityCardSchema.safeParse(request.body);
      if (!card.success) {
        return reply.code(400).send(errorBody("Invalid mesh card"));
      }

      const addError = ctx.mesh.addMeshContact(currentUser.id, card.data);
      if (addError) {
        return reply.code(400).send(errorBody(addError));
      }
      return { ok: true, meshId: card.data.meshId };
    },
  );

  // The current user's mesh address book (docs/16) — meshId + display name only, never any secret.
  ctx.server.get("/api/mesh/contacts", async (request, reply) => {
    const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));
    const accessError = ctx.participationError(currentUser);

    if (accessError) {
      return reply.code(403).send(errorBody(accessError));
    }
    if (!ctx.appConfig.mesh.enabled) {
      return reply.code(404).send(errorBody("Not found"));
    }

    const book = ctx.mesh.meshContacts.get(currentUser.id);
    const contacts: MeshContact[] = book
      ? [...book.values()].map((card) => ({ meshId: card.meshId, displayName: card.displayName }))
      : [];
    return contacts;
  });

  // Send a sealed mailbox message (opportunistic-mesh — docs/16) to a contact the sender has already
  // added (by their self-certifying mesh id). The server seals it to that contact's key and lets the
  // sync layer carry it; only the recipient's home node can open it. 404 unless mesh is enabled.
  ctx.server.post(
    "/api/mesh/messages",
    // Sealing runs public-key crypto and consumes relay/storage capacity across the mesh, so cap it
    // well below the global limit (like avatar/attachment uploads).
    ctx.semanticRateLimit(20),
    async (request, reply) => {
    const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));
    const accessError = ctx.participationError(currentUser);

    if (accessError) {
      return reply.code(403).send(errorBody(accessError));
    }

    // A moderator timeout blocks mesh sends like any other content creation.
    const meshTimeoutError = ctx.timeoutError(currentUser);

    if (meshTimeoutError) {
      return reply.code(403).send(errorBody(meshTimeoutError));
    }

    if (!ctx.appConfig.mesh.enabled) {
      return reply.code(404).send(errorBody("Not found"));
    }

    const body = MeshSendRequestSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send(errorBody("Invalid mesh send request"));
    }

    const sender = ctx.mesh.ensureMeshIdentity(currentUser.id);

    if (!sender) {
      return reply.code(400).send(errorBody("This user has no mesh identity"));
    }

    const contact = ctx.mesh.meshContacts.get(currentUser.id)?.get(body.data.toMeshId);

    if (!contact) {
      return reply.code(404).send(errorBody("No such mesh contact"));
    }

    // A shadow-banned sender gets a normal-looking success, but the mail is silently dropped — never
    // sealed or propagated — mirroring how their public posts go nowhere without revealing the ban.
    if (currentUser.shadowBanned) {
      return { ok: true };
    }

    const sendError = ctx.mesh.sendSealed(sender, contact, body.data.body);

    if (sendError) {
      return reply.code(400).send(errorBody(sendError));
    }

    return { ok: true };
  });

  // Broadcast a sealed mailbox message (opportunistic-mesh group/broadcast fan-out — docs/16) to
  // MULTIPLE contacts in one call. Each recipient is sealed independently via `mesh.sendSealed` — there is
  // no shared key, so per-recipient confidentiality/unlinkability is identical to the single-send path
  // above; this is purely a client-convenience batch. Same gating as `/api/mesh/messages`: 404 unless
  // mesh is enabled, a shadow-banned sender's mail silently drops, and a `toMeshId` that isn't an
  // already-added contact is reported back rather than 404ing the whole request (unlike the single-send
  // route, since a mix of valid/invalid recipients in one call shouldn't fail the valid ones).
  ctx.server.post(
    "/api/mesh/broadcast",
    // Same per-route cap as the single-send route — a broadcast still costs one request, but seals up
    // to `MeshBroadcastRequestSchema`'s cap (50) worth of public-key crypto, so keep it tightly limited.
    ctx.semanticRateLimit(20),
    async (request, reply) => {
      const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));
      const accessError = ctx.participationError(currentUser);

      if (accessError) {
        return reply.code(403).send(errorBody(accessError));
      }

      // A moderator timeout blocks mesh sends like any other content creation.
      const broadcastTimeoutError = ctx.timeoutError(currentUser);

      if (broadcastTimeoutError) {
        return reply.code(403).send(errorBody(broadcastTimeoutError));
      }

      if (!ctx.appConfig.mesh.enabled) {
        return reply.code(404).send(errorBody("Not found"));
      }

      const body = MeshBroadcastRequestSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send(errorBody("Invalid mesh broadcast request"));
      }

      const sender = ctx.mesh.ensureMeshIdentity(currentUser.id);

      if (!sender) {
        return reply.code(400).send(errorBody("This user has no mesh identity"));
      }

      // A shadow-banned sender gets a normal-looking success, but nothing is sealed or sent — same
      // silent-drop behaviour as the single-send route.
      if (currentUser.shadowBanned) {
        return { ok: true, sent: 0, skipped: [] };
      }

      const book = ctx.mesh.meshContacts.get(currentUser.id);
      const toMeshIds = [...new Set(body.data.toMeshIds)]; // de-duplicate: never mail a contact twice

      let sent = 0;
      const skipped: string[] = [];
      for (const toMeshId of toMeshIds) {
        const contact = book?.get(toMeshId);
        if (!contact) {
          skipped.push(toMeshId);
          continue;
        }
        // `mesh.sendSealed` enforces the same `mesh.maxCarried` storage bound as the single-send path; if
        // the queue fills partway through, stop here and report what actually went out rather than
        // silently dropping the remainder or throwing away the count of what succeeded.
        const sendError = ctx.mesh.sendSealed(sender, contact, body.data.body);
        if (sendError) {
          break;
        }
        sent += 1;
      }

      return { ok: true, sent, skipped };
    },
  );

  // ---- Opportunistic-mesh transport bridge (Phase 3 — docs/16 §5, docs/17) -----------------------
  // Two loopback-only endpoints that let the in-process Android launcher (nodejs-project-template/
  // main.js) shuttle sealed blobs between the native BLE/Wi-Fi-Aware transport and the existing sealed
  // relay, WITHOUT teaching the native layer anything about crypto/relay rules. They are a thin,
  // radio-fed mirror of the `/api/sync/*` sealed path: `outbound` is the same set the sync digest
  // offers (full records, so the courier ships bytes without a second round trip); `inbound` runs each
  // blob through the same defensive `mesh.acceptSealedFromPeer` used by sync imports. Both 404 (identical to
  // absent) unless `mesh.enabled`, and both refuse non-loopback callers so only this device's launcher
  // can reach them. Public-data sync is completely untouched.

  ctx.server.get(
    "/api/mesh/outbound",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!ctx.appConfig.mesh.enabled || !ctx.meshBridgeCallerAuthorized(request)) {
        return reply.code(404).send(errorBody("Not found"));
      }

      // Exactly what the sync digest would advertise as `sealed`, but as full records ready to hand to
      // the radio. Bounded so one transfer window can't try to push the whole store at once.
      const messages = ctx.data.messages
        .filter((message): message is SealedMessage => message.type === "sealed" && ctx.sync.isSyncableMessage(message))
        .slice(0, 200);
      return { messages };
    },
  );

  ctx.server.post(
    "/api/mesh/inbound",
    { config: { rateLimit: { max: 240, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!ctx.appConfig.mesh.enabled || !ctx.meshBridgeCallerAuthorized(request)) {
        return reply.code(404).send(errorBody("Not found"));
      }

      const body = MeshInboundRequestSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send(errorBody("Invalid mesh inbound request"));
      }

      // `mesh.acceptSealedFromPeer` is the single trust boundary: it re-checks TTL/hop/tombstone/dedup and
      // the per-node storage cap, then delivers-if-ours or relays-onward (hop-decremented). A blob that
      // fails any check is silently ignored, exactly as an inbound sync copy would be.
      let accepted = 0;
      for (const message of body.data.messages) {
        if (ctx.mesh.acceptSealedFromPeer(message)) {
          accepted += 1;
        }
      }
      return { accepted };
    },
  );

  ctx.server.get("/api/admin/sync", async (request, reply) => {
    const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));

    if (!currentUser.isAdmin) {
      return reply.code(403).send(errorBody("Admin access required"));
    }

    return ctx.sync.syncStatusReport();
  });

  // Run a sync round right now (ignoring the interval) — the admin UI's "Sync now" button.
  ctx.server.post("/api/admin/sync/run", async (request, reply) => {
    const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));

    if (!currentUser.isAdmin) {
      return reply.code(403).send(errorBody("Admin access required"));
    }

    if (!ctx.appConfig.sync.enabled || !ctx.appConfig.sync.peers.length) {
      return reply.code(400).send(errorBody("Enable sync and add at least one peer first"));
    }

    await ctx.sync.runSyncLoop(true);
    return ctx.sync.syncStatusReport();
  });
}
