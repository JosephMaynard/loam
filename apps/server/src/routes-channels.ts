// Channels: listing, history, members, join requests, ownership transfer, create/update/delete, and the
// admin channel view. Extracted verbatim from app.ts (2026-09-04 split) over the shared AppContext.

import { ChannelCreateRequestSchema, ChannelMemberAddRequestSchema, ChannelSchema, ChannelTransferRequestSchema, ChannelUpdateRequestSchema } from "@loam/schema";
import type { AppContext } from "./app-context.js";
import { errorBody } from "./errors.js";

export function registerChannelRoutes(ctx: AppContext): void {
  ctx.server.get("/api/channels", async (request, reply) => {
    const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));
    const accessError = ctx.participationError(currentUser);

    if (accessError) {
      return reply.code(403).send(errorBody(accessError));
    }

    // Archived channels ARE returned (to their normal audience): archive means read-only-but-
    // available — the mutation paths refuse writes, the client renders them read-only. Removing a
    // channel outright is `DELETE /api/channels/:id`. (Owner decision, 2026-08-15.)
    return ctx.data.channels.filter((channel) => ctx.canAccessChannel(channel, currentUser.id));
  });

  ctx.server.get<{ Params: { channelId: string } }>("/api/messages/:channelId", async (request, reply) => {
    const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));
    const accessError = ctx.participationError(currentUser);

    if (accessError) {
      return reply.code(403).send(errorBody(accessError));
    }

    const userId = currentUser.id;
    const channel = ctx.ensureChannel(request.params.channelId);

    // Unknown channels and inaccessible private channels answer identically, so probing this
    // endpoint can never confirm that a private channel exists.
    if (!channel || !ctx.canAccessChannel(channel, userId)) {
      return reply.code(404).send(errorBody("Channel does not exist"));
    }

    return ctx.channelMessages(channel.id, userId);
  });

  // The member roster of a private channel. Members only — like every private-channel endpoint,
  // outsiders get the same 404 as a channel that does not exist.
  ctx.server.get<{ Params: { channelId: string } }>("/api/channels/:channelId/members", async (request, reply) => {
    const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));
    const accessError = ctx.participationError(currentUser);

    if (accessError) {
      return reply.code(403).send(errorBody(accessError));
    }

    const channel = ctx.ensureChannel(request.params.channelId);

    if (!channel || (channel.visibility === "private" && !ctx.canAccessChannel(channel, currentUser.id) && !currentUser.isAdmin)) {
      return reply.code(404).send(errorBody("Channel does not exist"));
    }

    if (channel.visibility !== "private") {
      return reply.code(400).send(errorBody("Only private channels have a member list"));
    }

    const members = ctx.channelMemberIds(channel);
    // Sanitize like the roster: a non-moderator member must not learn another member's roles/shadowBan.
    return ctx.data.users.filter((user) => members.has(user.id)).map((user) => ctx.sanitizeUserFor(currentUser, user));
  });

  // Invite a user into a private channel. The channel owner or an admin only; adding an existing
  // member is a no-op. The member-only `channelUpserted` broadcast tells the invitee about the
  // channel the moment they are added.
  ctx.server.post<{ Params: { channelId: string } }>("/api/channels/:channelId/members", async (request, reply) => {
    const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));
    const accessError = ctx.participationError(currentUser);

    if (accessError) {
      return reply.code(403).send(errorBody(accessError));
    }

    const channel = ctx.ensureChannel(request.params.channelId);

    if (!channel || (channel.visibility === "private" && !ctx.canAccessChannel(channel, currentUser.id) && !currentUser.isAdmin)) {
      return reply.code(404).send(errorBody("Channel does not exist"));
    }

    if (channel.visibility !== "private") {
      return reply.code(400).send(errorBody("Only private channels have a member list"));
    }

    if (!currentUser.isAdmin && channel.ownerUserId !== currentUser.id) {
      return reply.code(403).send(errorBody("Only the channel owner or an admin can invite members"));
    }

    // A moderator timeout is a write block: creating channels, rewriting channel metadata, and
    // growing rosters are all publishing/coordination surfaces (Sol round 2, P1). Access-REDUCING
    // actions (leave, remove) stay available; admins are never timeout-able in practice.
    const channelTimeoutError = ctx.timeoutError(currentUser);

    if (channelTimeoutError) {
      return reply.code(403).send(errorBody(channelTimeoutError));
    }

    // Membership growth is a mutation too: inviting someone into an archived private channel would
    // grant a NEW reader its whole history while the channel is supposedly frozen (review finding).
    // Removal/leave stays allowed — shrinking access is always safe.
    if (channel.archived) {
      return reply.code(403).send(errorBody("Channel is archived"));
    }

    const body = ChannelMemberAddRequestSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send(errorBody("Invalid member request"));
    }

    const target = ctx.data.users.find((user) => user.id === body.data.userId);

    if (!target || target.type !== "human") {
      return reply.code(400).send(errorBody("User does not exist"));
    }

    if (target.banned) {
      return reply.code(400).send(errorBody("That user has been removed from this node"));
    }

    const members = ctx.channelMemberIds(channel);

    if (members.has(target.id)) {
      return channel;
    }

    return ctx.applyChannelMembers(channel, [...members, target.id]);
  });

  // Remove a member from a private channel. The owner or an admin may remove anyone but the owner;
  // any member may remove themselves (leave). The removed user gets a targeted `channelRemoved`
  // notice so their client drops the channel immediately.
  ctx.server.delete<{ Params: { channelId: string; userId: string } }>(
    "/api/channels/:channelId/members/:userId",
    async (request, reply) => {
      const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));
      const accessError = ctx.participationError(currentUser);

      if (accessError) {
        return reply.code(403).send(errorBody(accessError));
      }

      const channel = ctx.ensureChannel(request.params.channelId);

      if (!channel || (channel.visibility === "private" && !ctx.canAccessChannel(channel, currentUser.id) && !currentUser.isAdmin)) {
        return reply.code(404).send(errorBody("Channel does not exist"));
      }

      if (channel.visibility !== "private") {
        return reply.code(400).send(errorBody("Only private channels have a member list"));
      }

      const targetId = request.params.userId;

      if (targetId !== currentUser.id && !currentUser.isAdmin && channel.ownerUserId !== currentUser.id) {
        return reply.code(403).send(errorBody("Only the channel owner or an admin can remove members"));
      }

      if (targetId === channel.ownerUserId) {
        return reply.code(400).send(errorBody("The channel owner cannot be removed from their own channel"));
      }

      const members = ctx.channelMemberIds(channel);

      if (!members.has(targetId)) {
        return reply.code(400).send(errorBody("That user is not a member of this channel"));
      }

      members.delete(targetId);
      ctx.applyChannelMembers(channel, [...members]);
      ctx.sendEventToUsers(new Set([targetId]), { type: "channelRemoved", channelId: channel.id });
      return { ok: true };
    },
  );

  // Request to join a private channel that opted into join requests (P10). The requester must already know
  // the channel id (shared out-of-band). A channel that doesn't exist, isn't private, or hasn't opted in
  // 404s identically, so this never reveals a channel's existence — no discoverability change.
  ctx.server.post<{ Params: { channelId: string } }>(
    "/api/channels/:channelId/join-requests",
    ctx.semanticRateLimit(30),
    async (request, reply) => {
      const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));
      const accessError = ctx.participationError(currentUser);

      if (accessError) {
        return reply.code(403).send(errorBody(accessError));
      }

      // DELIBERATE (Sol round 4): a moderator timeout does NOT block join requests. A request
      // carries no free-form text, is idempotent, and grants nothing without the owner's explicit
      // approval — it's asking for access, not publishing. Blocking it would extend a write-block
      // into a participation penalty. Pinned by a regression test.

      const channel = ctx.ensureChannel(request.params.channelId);

      // 404-parity: unknown / public / archived / not-opted-in are all indistinguishable.
      if (!channel || channel.visibility !== "private" || channel.archived || !channel.allowJoinRequests) {
        return reply.code(404).send(errorBody("Channel does not exist"));
      }

      // Already a member (or the owner): nothing to request.
      if (ctx.channelMemberIds(channel).has(currentUser.id)) {
        return reply.code(204).send();
      }

      ctx.store.addJoinRequest(channel.id, currentUser.id);
      return reply.code(201).send({ ok: true });
    },
  );

  // List pending join requesters for a private channel (owner/admin) — sanitised user records.
  ctx.server.get<{ Params: { channelId: string } }>("/api/channels/:channelId/join-requests", async (request, reply) => {
    const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));
    const accessError = ctx.participationError(currentUser);

    if (accessError) {
      return reply.code(403).send(errorBody(accessError));
    }

    const channel = ctx.ensureChannel(request.params.channelId);

    if (!channel || (channel.visibility === "private" && !ctx.canAccessChannel(channel, currentUser.id) && !currentUser.isAdmin)) {
      return reply.code(404).send(errorBody("Channel does not exist"));
    }

    if (!currentUser.isAdmin && channel.ownerUserId !== currentUser.id) {
      return reply.code(403).send(errorBody("Only the channel owner or an admin can review join requests"));
    }

    const requesterIds = new Set(ctx.store.loadJoinRequests(channel.id));
    return ctx.data.users
      .filter((user) => requesterIds.has(user.id) && user.type === "human" && !user.banned && !user.pending)
      .map((user) => ctx.sanitizeUserFor(currentUser, user));
  });

  // Approve a pending join request → add the user to the private channel's roster (owner/admin).
  ctx.server.post<{ Params: { channelId: string; userId: string } }>(
    "/api/channels/:channelId/join-requests/:userId/approve",
    async (request, reply) => {
      const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));
      const accessError = ctx.participationError(currentUser);

      if (accessError) {
        return reply.code(403).send(errorBody(accessError));
      }

      const channel = ctx.ensureChannel(request.params.channelId);

      if (!channel || (channel.visibility === "private" && !ctx.canAccessChannel(channel, currentUser.id) && !currentUser.isAdmin)) {
        return reply.code(404).send(errorBody("Channel does not exist"));
      }

      if (!currentUser.isAdmin && channel.ownerUserId !== currentUser.id) {
        return reply.code(403).send(errorBody("Only the channel owner or an admin can approve join requests"));
      }

      // A moderator timeout is a write block: creating channels, rewriting channel metadata, and
      // growing rosters are all publishing/coordination surfaces (Sol round 2, P1). Access-REDUCING
      // actions (leave, remove) stay available; admins are never timeout-able in practice.
      const channelTimeoutError = ctx.timeoutError(currentUser);

      if (channelTimeoutError) {
        return reply.code(403).send(errorBody(channelTimeoutError));
      }

      // Approving a pre-archive request would grow the roster of a frozen channel — same rule as
      // member add/transfer: restore the channel first.
      if (channel.archived) {
        return reply.code(403).send(errorBody("Channel is archived"));
      }

      if (!new Set(ctx.store.loadJoinRequests(channel.id)).has(request.params.userId)) {
        return reply.code(404).send(errorBody("No such join request"));
      }

      const target = ctx.data.users.find((user) => user.id === request.params.userId);
      ctx.store.removeJoinRequest(channel.id, request.params.userId);

      if (!target || target.type !== "human" || target.banned) {
        return reply.code(400).send(errorBody("That user cannot be added"));
      }

      const members = ctx.channelMemberIds(channel);
      return members.has(target.id) ? channel : ctx.applyChannelMembers(channel, [...members, target.id]);
    },
  );

  // Deny (or cancel) a pending join request (owner/admin).
  ctx.server.delete<{ Params: { channelId: string; userId: string } }>(
    "/api/channels/:channelId/join-requests/:userId",
    async (request, reply) => {
      const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));
      const accessError = ctx.participationError(currentUser);

      if (accessError) {
        return reply.code(403).send(errorBody(accessError));
      }

      const channel = ctx.ensureChannel(request.params.channelId);

      if (!channel || (channel.visibility === "private" && !ctx.canAccessChannel(channel, currentUser.id) && !currentUser.isAdmin)) {
        return reply.code(404).send(errorBody("Channel does not exist"));
      }

      if (!currentUser.isAdmin && channel.ownerUserId !== currentUser.id) {
        return reply.code(403).send(errorBody("Only the channel owner or an admin can deny join requests"));
      }

      ctx.store.removeJoinRequest(channel.id, request.params.userId);
      return reply.code(204).send();
    },
  );

  // Transfer a channel's ownership to another user. The current owner or an admin may do this; for a
  // private channel the new owner is added to the roster if absent (so they can actually reach it).
  // Ownership drives the `owner`-only posting policy and who may manage the channel, so it's a
  // deliberate, audited hand-off — the previous owner stays a member but loses owner powers.
  ctx.server.post<{ Params: { channelId: string } }>("/api/channels/:channelId/transfer", async (request, reply) => {
    const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));
    const accessError = ctx.participationError(currentUser);

    if (accessError) {
      return reply.code(403).send(errorBody(accessError));
    }

    const channel = ctx.ensureChannel(request.params.channelId);

    if (!channel || (channel.visibility === "private" && !ctx.canAccessChannel(channel, currentUser.id) && !currentUser.isAdmin)) {
      return reply.code(404).send(errorBody("Channel does not exist"));
    }

    if (!currentUser.isAdmin && channel.ownerUserId !== currentUser.id) {
      return reply.code(403).send(errorBody("Only the channel owner or an admin can transfer ownership"));
    }

    // A moderator timeout is a write block: creating channels, rewriting channel metadata, and
    // growing rosters are all publishing/coordination surfaces (Sol round 2, P1). Access-REDUCING
    // actions (leave, remove) stay available; admins are never timeout-able in practice.
    const channelTimeoutError = ctx.timeoutError(currentUser);

    if (channelTimeoutError) {
      return reply.code(403).send(errorBody(channelTimeoutError));
    }

    // No ownership hand-offs while archived: a transfer can grow a private roster (the new owner
    // joins it → reads the frozen history), and archive means nothing about this channel changes.
    // Restore it first — an explicit, visible step.
    if (channel.archived) {
      return reply.code(403).send(errorBody("Channel is archived"));
    }

    const body = ChannelTransferRequestSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send(errorBody("Invalid transfer request"));
    }

    const target = ctx.data.users.find((user) => user.id === body.data.userId);

    if (!target || target.type !== "human") {
      return reply.code(400).send(errorBody("User does not exist"));
    }

    if (target.banned) {
      return reply.code(400).send(errorBody("That user has been removed from this node"));
    }

    if (channel.ownerUserId === target.id) {
      return channel;
    }

    // For a private channel, materialise the full roster (channelMemberIds folds in the *current*
    // owner, who may only be an implicit member) and add the new owner. Doing this unconditionally —
    // not just when the target is absent — keeps the previous owner an explicit member after they
    // stop being the implicit one, so they don't silently lose access on a legacy channel whose
    // stored memberUserIds omitted the owner.
    const members = ctx.channelMemberIds(channel);
    members.add(target.id);
    const memberUserIds = channel.visibility === "private" ? [...members] : channel.memberUserIds;

    const next = ChannelSchema.parse({ ...channel, ownerUserId: target.id, memberUserIds });
    ctx.store.upsertChannel(next);
    Object.assign(channel, next);
    ctx.broadcast({ type: "channelUpserted", channel });
    return channel;
  });

  // Unlike GET /api/channels (which returns only the channels the caller can ACCESS — archived
  // included, private-member-scoped), the admin list returns every channel, so an admin can manage
  // (rename / restore / delete) private channels without being in their audience.
  ctx.server.get("/api/admin/channels", async (request, reply) => {
    const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));

    if (!currentUser.isAdmin) {
      return reply.code(403).send(errorBody("Admin access required"));
    }

    return ctx.data.channels;
  });

  // Create a channel. Admins always may; ordinary users may when `enableUserChannels` is on. The
  // creator becomes the owner.
  ctx.server.post("/api/channels", async (request, reply) => {
    const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));
    const accessError = ctx.participationError(currentUser);

    if (accessError) {
      return reply.code(403).send(errorBody(accessError));
    }

    // A moderator timeout is a write block: creating channels, rewriting channel metadata, and
    // growing rosters are all publishing/coordination surfaces (Sol round 2, P1). Access-REDUCING
    // actions (leave, remove) stay available; admins are never timeout-able in practice.
    const channelTimeoutError = ctx.timeoutError(currentUser);

    if (channelTimeoutError) {
      return reply.code(403).send(errorBody(channelTimeoutError));
    }

    if (!currentUser.isAdmin && !ctx.appConfig.features.enableUserChannels) {
      return reply.code(403).send(errorBody("Creating channels is disabled on this LOAM node"));
    }

    const body = ChannelCreateRequestSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send(errorBody("Invalid channel create request"));
    }

    if (body.data.visibility === "private" && !ctx.appConfig.features.enablePrivateChannels) {
      return reply.code(403).send(errorBody("Private channels are disabled on this LOAM node"));
    }

    return reply.code(201).send(ctx.createChannelFromRequest(body.data, currentUser.id));
  });

  // Rename / re-configure / archive a channel. Allowed for an admin or the channel's owner.
  ctx.server.patch<{ Params: { channelId: string } }>("/api/channels/:channelId", async (request, reply) => {
    const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));
    const accessError = ctx.participationError(currentUser);

    if (accessError) {
      return reply.code(403).send(errorBody(accessError));
    }

    const channel = ctx.ensureChannel(request.params.channelId);

    // 404-parity (review 2026-09-04): a private channel an outsider can't see answers exactly like a
    // missing one. Channel ids are name slugs, so a 403 here confirmed a guessed private channel existed.
    if (!channel || (!currentUser.isAdmin && !ctx.canAccessChannel(channel, currentUser.id))) {
      return reply.code(404).send(errorBody("Channel does not exist"));
    }

    if (!currentUser.isAdmin && channel.ownerUserId !== currentUser.id) {
      return reply.code(403).send(errorBody("Only the channel owner or an admin can change this channel"));
    }

    // A moderator timeout is a write block: creating channels, rewriting channel metadata, and
    // growing rosters are all publishing/coordination surfaces (Sol round 2, P1). Access-REDUCING
    // actions (leave, remove) stay available; admins are never timeout-able in practice.
    const channelTimeoutError = ctx.timeoutError(currentUser);

    if (channelTimeoutError) {
      return reply.code(403).send(errorBody(channelTimeoutError));
    }

    const body = ChannelUpdateRequestSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send(errorBody("Invalid channel update request"));
    }

    return ctx.applyChannelUpdate(channel, body.data);
  });

  // Permanently delete a channel (owner or admin). Archive means read-only-but-available; DELETE
  // means gone and not coming back (owner decision, 2026-08-15): the channel, every message in it
  // (and reactions on those messages), and their attachment files are removed; every id — including
  // the channel's own — is tombstoned so a sync peer that still holds the content can never hand it
  // back; the audience gets a targeted `channelRemoved` (clients purge caches and navigate away).
  ctx.server.delete<{ Params: { channelId: string } }>("/api/channels/:channelId", async (request, reply) => {
    const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));
    const accessError = ctx.participationError(currentUser);

    if (accessError) {
      return reply.code(403).send(errorBody(accessError));
    }

    const channel = ctx.ensureChannel(request.params.channelId);

    // 404-parity: a private channel an outsider can't see answers exactly like a missing one.
    if (!channel || (!currentUser.isAdmin && !ctx.canAccessChannel(channel, currentUser.id))) {
      return reply.code(404).send(errorBody("Channel does not exist"));
    }

    if (!currentUser.isAdmin && channel.ownerUserId !== currentUser.id) {
      return reply.code(403).send(errorBody("Only the channel owner or an admin can delete this channel"));
    }

    // A moderator timeout is a write block: creating channels, rewriting channel metadata, and
    // growing rosters are all publishing/coordination surfaces (Sol round 2, P1). Access-REDUCING
    // actions (leave, remove) stay available; admins are never timeout-able in practice.
    const channelTimeoutError = ctx.timeoutError(currentUser);

    if (channelTimeoutError) {
      return reply.code(403).send(errorBody(channelTimeoutError));
    }

    // Refuse while any message in the channel is mid-stream — its in-flight writer would re-persist.
    const channelScoped = ctx.data.messages.filter(
      (message) => (message.type === "channelPost" || message.type === "channelReply") && message.channelId === channel.id,
    );

    if (channelScoped.some((message) => message.meta?.streaming)) {
      return reply.code(409).send(errorBody("A message in this channel is still being written"));
    }

    // Mirror the message-delete policy at channel scale (review finding): a NON-ADMIN owner may not
    // cascade away other people's words — otherwise "you can only delete your own messages" is
    // defeated by deleting (or being transferred) the whole channel. Admins moderate; owners of a
    // channel that only holds their own content (or none) may still remove it themselves.
    if (!currentUser.isAdmin && channelScoped.some((message) => message.authorId !== currentUser.id)) {
      return reply
        .code(403)
        .send(errorBody("This channel has messages from other people — only an admin can delete it"));
    }

    // Cascade: the channel's posts/replies plus every reaction targeting them. deleteMessages
    // handles per-id tombstones, attachment-file removal, and messageDeleted broadcasts.
    const channelMessageIds = new Set(channelScoped.map((message) => message.id));
    const reactions = ctx.data.messages.filter(
      (message) => message.type === "reaction" && channelMessageIds.has(message.targetMessageId),
    );
    ctx.deleteMessages([...channelScoped, ...reactions]);

    // Audience computed BEFORE removal: private → roster + owner + the ACTING admin (a non-member
    // admin who managed this channel has it in their own client state via the admin panel's
    // upserts — without the event their sidebar/IndexedDB keeps a dead channel until reload,
    // Sol round 2 P2); public → every user who can currently receive events (banned/pending
    // sockets are excluded — the one other `sendEventToUsers` call site is naturally member-scoped).
    const audience =
      channel.visibility === "private"
        ? new Set(
            [...(channel.memberUserIds ?? []), channel.ownerUserId, currentUser.id].filter(
              (id): id is string => typeof id === "string",
            ),
          )
        : new Set(ctx.data.users.filter((user) => !user.banned && !user.pending).map((user) => user.id));

    ctx.store.transaction(() => {
      ctx.store.deleteChannel(channel.id);
      // Tombstone the channel id itself: the sync channel-import path refuses to (re)create a
      // tombstoned channel, so a peer that still lists it can't resurrect it here (docs/11).
      ctx.store.addTombstone(channel.id);
      // Pending join requests die with the channel — left behind, a recreated same-slug channel
      // would inherit strangers' stale requests as one-click members (review finding).
      ctx.store.removeJoinRequestsForChannel(channel.id);
      // And forget the synced-origin mark, or a restart re-hydrates it and a later same-slug LOCAL
      // channel would falsely count as peer-owned for the C1 metadata merge (review finding).
      ctx.store.unmarkChannelSynced(channel.id);
    });
    ctx.tombstones.add(channel.id);
    ctx.syncedChannelIds.delete(channel.id);
    ctx.data.channels = ctx.data.channels.filter((candidate) => candidate.id !== channel.id);

    ctx.sendEventToUsers(audience, { type: "channelRemoved", channelId: channel.id });
    return reply.send({ deletedChannelId: channel.id });
  });
}
