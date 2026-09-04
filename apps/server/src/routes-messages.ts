// Messages: DMs, search, create, edit, delete. Extracted verbatim from app.ts (2026-09-04 split) over the
// shared AppContext.
import { type Message, MessageCreateRequestSchema, MessageEditRequestSchema, MessageSchema } from "@loam/schema";
import type { AppContext } from "./app-context.js";
import { errorBody } from "./errors.js";

/** Register the message routes: DMs, search, create, edit, delete. */
export function registerMessageRoutes(ctx: AppContext): void {
  ctx.server.get<{ Params: { userId: string } }>("/api/dms/:userId", async (request, reply) => {
    const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));
    const accessError = ctx.participationError(currentUser);

    if (accessError) {
      return reply.code(403).send(errorBody(accessError));
    }

    return ctx.dmMessages(request.params.userId, currentUser.id);
  });

  // Case-insensitive substring search over message bodies, scoped strictly to what the caller may
  // read: channel messages in channels they can access (including archived — read-only), and their own DMs.
  // Shadow-banned authors' messages stay visible only to themselves, matching the broadcast filter.
  // Substring search scans the whole message mirror per call, so it gets its own semantic cap
  // (counted through the tunnel too — see semanticRateLimit) on top of the global limiter.
  ctx.server.get<{ Querystring: { q?: string; limit?: string } }>(
    "/api/search",
    ctx.semanticRateLimit(60),
    async (request, reply) => {
    const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));
    const accessError = ctx.participationError(currentUser);

    if (accessError) {
      return reply.code(403).send(errorBody(accessError));
    }

    const query = (request.query.q ?? "").trim();

    if (!query) {
      return reply.code(400).send(errorBody("Provide a search query (?q=)"));
    }

    const needle = query.toLowerCase();
    const parsedLimit = Number.parseInt(request.query.limit ?? "", 10);
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 100) : 25;
    const channelsById = new Map(ctx.data.channels.map((channel) => [channel.id, channel]));
    const results: Message[] = [];

    // Walk newest-first (data.messages is kept in createdAt order) and stop at the limit.
    for (let index = ctx.data.messages.length - 1; index >= 0 && results.length < limit; index -= 1) {
      const message = ctx.data.messages[index];

      if (!message || !("body" in message) || !message.body.toLowerCase().includes(needle)) {
        continue;
      }

      const author = ctx.data.users.find((user) => user.id === message.authorId);

      if (author?.shadowBanned && message.authorId !== currentUser.id) {
        continue;
      }

      if (message.type === "dm") {
        if (message.authorId !== currentUser.id && message.recipientUserId !== currentUser.id) {
          continue;
        }
      } else {
        const channel = channelsById.get(message.channelId);

        // Archived channels stay searchable — archive is read-only-but-available, and search is a read.
        if (!channel || !ctx.canAccessChannel(channel, currentUser.id)) {
          continue;
        }
      }

      results.push(message);
    }

    return { query, results };
  });

  // ---- Node-to-node sync (docs/11) ----------------------------------------------------------
  // Peer-facing endpoints. Both answer 404 unless sync is enabled, so a node that never opted in
  // is indistinguishable from one without the feature. They expose **public data only** — the
  // same content any open session on the LAN could read; enabling sync is the operator's explicit
  // decision to share it with peer nodes.

  ctx.server.post("/api/messages", async (request, reply) => {
    const body = MessageCreateRequestSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send(errorBody("Invalid message request"));
    }

    const result = ctx.createMessage(body.data, ctx.getSessionUserId(request, reply));

    if (result.error) {
      // Moderation rejections (banned/pending author) are 403; everything else is a bad request.
      return reply.code(result.forbidden ? 403 : 400).send(errorBody(result.error));
    }

    if (result.deletedMessageId && result.deletedMessage) {
      ctx.broadcast({
        type: "messageDeleted",
        messageId: result.deletedMessageId,
        message: result.deletedMessage,
      });
      return reply.send(result);
    }

    if (!result.message) {
      return reply.code(400).send(errorBody("Unable to create message"));
    }

    ctx.broadcast({ type: "messageCreated", message: result.message });
    void ctx.llm.createAssistantResponse(result.message);
    return reply.code(201).send(result);
  });

  ctx.server.delete<{ Params: { messageId: string } }>("/api/messages/:messageId", async (request, reply) => {
    const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));
    const accessError = ctx.participationError(currentUser);

    if (accessError) {
      return reply.code(403).send(errorBody(accessError));
    }

    const target = ctx.data.messages.find((message) => message.id === request.params.messageId);

    if (!target) {
      return reply.code(404).send(errorBody("Message does not exist"));
    }

    // Don't delete a message that's still streaming: its in-flight writer would re-persist it.
    if (target.meta?.streaming) {
      return reply.code(409).send(errorBody("This message is still being written"));
    }

    // Non-admins must still be allowed to write in the target's conversation *now* (not timed out,
    // still in the audience, not archived); admins keep the trusted-host moderation override.
    // `isDelete` relaxes only the feature-SHUTDOWN checks — removing content is cleanup.
    const mutationError = ctx.messageMutationError(currentUser, target, {
      adminOverride: currentUser.isAdmin,
      isDelete: true,
    });

    if (mutationError) {
      return reply.code(mutationError.code).send(errorBody(mutationError.error));
    }

    const deletionSet = ctx.collectDeletionSet(target);

    if (!currentUser.isAdmin) {
      // A non-admin may delete only their own message, and only when the cascade won't remove
      // another user's reply (clearing others' reactions on it is fine). Admins can delete anything
      // — moderation is part of the trusted-host model.
      if (target.authorId !== currentUser.id) {
        return reply.code(403).send(errorBody("You can only delete your own messages"));
      }

      const removesOthersContent = deletionSet.some(
        (message) => message.type !== "reaction" && message.authorId !== currentUser.id,
      );

      if (removesOthersContent) {
        return reply
          .code(403)
          .send(errorBody("This thread has replies from other people — only an admin can delete it"));
      }
    }

    ctx.deleteMessages(deletionSet);
    return reply.send({ deletedIds: deletionSet.map((message) => message.id) });
  });

  ctx.server.patch<{ Params: { messageId: string } }>("/api/messages/:messageId", async (request, reply) => {
    const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));
    const accessError = ctx.participationError(currentUser);

    if (accessError) {
      return reply.code(403).send(errorBody(accessError));
    }

    const target = ctx.data.messages.find((message) => message.id === request.params.messageId);

    if (!target) {
      return reply.code(404).send(errorBody("Message does not exist"));
    }

    // Only the author may edit — rewriting someone else's words is impersonation, so not even an
    // admin can (admins moderate by deleting instead).
    if (target.authorId !== currentUser.id) {
      return reply.code(403).send(errorBody("You can only edit your own messages"));
    }

    // Authorship is not enough: the author must still be allowed to write *here, now* — not timed
    // out, still in the channel's audience, channel not archived (see messageMutationError).
    const mutationError = ctx.messageMutationError(currentUser, target);

    if (mutationError) {
      return reply.code(mutationError.code).send(errorBody(mutationError.error));
    }

    if (target.type === "reaction") {
      return reply.code(400).send(errorBody("Reactions cannot be edited"));
    }

    if (target.meta?.streaming) {
      return reply.code(409).send(errorBody("This message is still being written"));
    }

    const body = MessageEditRequestSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send(errorBody("Invalid message edit request"));
    }

    // Persist first, then mirror in memory — matching every other mutator, so a failed store write
    // never leaves in-memory state (or a broadcast) ahead of what is stored.
    const updated = MessageSchema.parse({ ...target, body: body.data.body, editedAt: Date.now() });
    ctx.store.updateMessage(updated);
    Object.assign(target, updated);
    ctx.broadcast({ type: "messageUpdated", message: target });
    return target;
  });
}
