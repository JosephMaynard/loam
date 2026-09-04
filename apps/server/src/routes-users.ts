// Users, profiles + avatars, roles, moderation + reports, join approval, typing, and attachment
// upload/serve. Extracted verbatim from app.ts (2026-09-04 split) over the shared AppContext.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AttachmentUploadRequestSchema, AvatarImageUploadRequestSchema, type MessageAttachment, MessageRemoveRequestSchema, MessageSchema, ModerationUpdateRequestSchema, type Report, ReportCreateRequestSchema, ReportResolveRequestSchema, ReportSchema, RolesUpdateRequestSchema, TypingRequestSchema, type User, UserSchema, UserUpdateRequestSchema } from "@loam/schema";
import type { AppContext } from "./app-context.js";
import { errorBody } from "./errors.js";
import { newMessageId } from "./ids.js";
import { attachmentFileMaxBytes, attachmentFileName, attachmentMaxBytes, avatarImageHasExpectedSignature, isImageAttachmentMime, newAttachmentId, newAvatarImageId, parseAttachmentFileName, parseAvatarImageId, sanitizeAttachmentName } from "./media.js";

/** Register user, profile/avatar, roles, moderation/report, join-approval, typing, and attachment routes. */
export function registerUserRoutes(ctx: AppContext): void {
  ctx.server.get("/api/users", async (request, reply) => {
    const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));
    const accessError = ctx.participationError(currentUser);

    if (accessError) {
      return reply.code(403).send(errorBody(accessError));
    }

    return ctx.visibleUsers(currentUser);
  });

  ctx.server.patch("/api/users/me", async (request, reply) => {
    const body = UserUpdateRequestSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send(errorBody("Invalid user update request"));
    }

    if (
      (body.data.displayName !== undefined && !ctx.appConfig.identity.allowUserDisplayNameEdit) ||
      (body.data.avatar !== undefined && !ctx.appConfig.identity.allowUserAvatarEdit)
    ) {
      return reply.code(403).send(errorBody("User profile editing is disabled on this LOAM node"));
    }

    const user = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));
    const accessError = ctx.participationError(user);

    if (accessError) {
      return reply.code(403).send(errorBody(accessError));
    }

    // A profile edit broadcasts to the whole roster (`userUpserted`), so a moderator timeout blocks
    // it like every other content-publishing surface — matching avatar-image uploads (Sol round 4).
    const profileTimeoutError = ctx.timeoutError(user);

    if (profileTimeoutError) {
      return reply.code(403).send(errorBody(profileTimeoutError));
    }

    return ctx.applyUserUpdate(user, body.data);
  });

  ctx.server.put(
    "/api/users/me/avatar-image",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute", allowList: () => false } } },
    async (request, reply) => {
    if (!ctx.appConfig.identity.allowUserAvatarEdit || !ctx.appConfig.identity.allowUserAvatarUpload) {
      return reply.code(403).send(errorBody("User avatar uploads are disabled on this LOAM node"));
    }

    const uploader = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));
    const accessError = ctx.participationError(uploader);

    if (accessError) {
      return reply.code(403).send(errorBody(accessError));
    }

    // Same policy as attachment uploads: a timed-out user can't push new content — including a new
    // avatar image (it broadcasts to everyone) — so the file never lands on disk.
    const uploaderTimeoutError = ctx.timeoutError(uploader);

    if (uploaderTimeoutError) {
      return reply.code(403).send(errorBody(uploaderTimeoutError));
    }

    const body = AvatarImageUploadRequestSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send(errorBody("Invalid avatar image upload request"));
    }

    const image = Buffer.from(body.data.data, "base64");

    if (image.length === 0 || image.length > 128 * 1024) {
      return reply.code(400).send(errorBody("Avatar image must be 128KB or smaller"));
    }

    if (!avatarImageHasExpectedSignature(image, body.data.mimeType)) {
      return reply.code(400).send(errorBody("Avatar image type does not match the uploaded data"));
    }

    const user = uploader;
    const previousAvatar = user.avatar;
    const imageId = newAvatarImageId();
    await mkdir(ctx.avatarsDir, { recursive: true });
    await writeFile(ctx.avatarImagePath(imageId, body.data.mimeType), image);

    const updated = ctx.applyUserUpdate(user, {
      avatar: {
        kind: "image",
        imageId,
        mimeType: body.data.mimeType,
        uploadedAt: Date.now(),
      },
    });

    // Keep only the latest image per user — remove the replaced file (best effort).
    if (previousAvatar?.kind === "image" && previousAvatar.imageId && previousAvatar.mimeType) {
      await rm(ctx.avatarImagePath(previousAvatar.imageId, previousAvatar.mimeType), { force: true }).catch(
        (error: unknown) => ctx.server.log.warn(error),
      );
    }

    return updated;
  });

  ctx.server.patch<{ Params: { userId: string } }>("/api/users/:userId", async (request, reply) => {
    const body = UserUpdateRequestSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send(errorBody("Invalid user update request"));
    }

    const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));

    if (!currentUser.isAdmin || !ctx.appConfig.identity.allowAdminUserEdit) {
      return reply.code(403).send(errorBody("Admin user editing is disabled on this LOAM node"));
    }

    const user = ctx.data.users.find((candidate) => candidate.id === request.params.userId);

    if (!user) {
      return reply.code(404).send(errorBody("User does not exist"));
    }

    return ctx.applyUserUpdate(user, body.data);
  });

  // Set a user's granted roles (replaces the whole set). Admin-only — roles confer moderation and
  // greeter powers, so only an admin may hand them out. An admin's roles are never changed here.
  ctx.server.patch<{ Params: { userId: string } }>("/api/admin/users/:userId/roles", async (request, reply) => {
    const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));

    if (!currentUser.isAdmin) {
      return reply.code(403).send(errorBody("Admin access required"));
    }

    const body = RolesUpdateRequestSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send(errorBody("Invalid roles update request"));
    }

    const user = ctx.data.users.find((candidate) => candidate.id === request.params.userId);

    if (!user) {
      return reply.code(404).send(errorBody("User does not exist"));
    }

    if (user.isAdmin) {
      return reply.code(400).send(errorBody("Cannot change the roles of an admin"));
    }

    return ctx.applyUserModeration(user, { roles: body.data.roles });
  });

  // Promote a member to admin — host handover and co-admins. Deliberately no demote counterpart:
  // admin removal happens by re-bootstrapping the node (or the kill switch), never by another
  // admin, so a contested node can't descend into a mutual-demotion fight over governance.
  ctx.server.post<{ Params: { userId: string } }>("/api/admin/users/:userId/promote", async (request, reply) => {
    const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));

    if (!currentUser.isAdmin) {
      return reply.code(403).send(errorBody("Admin access required"));
    }

    const user = ctx.data.users.find((candidate) => candidate.id === request.params.userId);

    if (!user) {
      return reply.code(404).send(errorBody("User does not exist"));
    }

    if (user.type !== "human") {
      return reply.code(400).send(errorBody("Only people can be admins"));
    }

    if (user.banned || user.pending) {
      return reply.code(400).send(errorBody("Approve or unban this user before promoting them"));
    }

    if (user.isAdmin) {
      return user;
    }

    const next = UserSchema.parse({ ...user, isAdmin: true });
    ctx.store.upsertUser(next);
    Object.assign(user, next);
    ctx.broadcast({ type: "userUpserted", user });
    return user;
  });

  // Ban / shadow-ban / unban a user. Open to admins and moderators; never usable against an admin
  // or oneself. Banning a user also tears down their live sessions (see invalidateUserSessions).
  ctx.server.patch<{ Params: { userId: string } }>("/api/moderation/users/:userId", async (request, reply) => {
    const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));

    if (!ctx.canModerate(currentUser)) {
      return reply.code(403).send(errorBody("Moderator access required"));
    }

    const body = ModerationUpdateRequestSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send(errorBody("Invalid moderation request"));
    }

    const user = ctx.data.users.find((candidate) => candidate.id === request.params.userId);

    if (!user) {
      return reply.code(404).send(errorBody("User does not exist"));
    }

    if (user.isAdmin || user.id === currentUser.id) {
      return reply.code(403).send(errorBody("You cannot moderate an admin or yourself"));
    }

    const changes: Partial<Pick<User, "banned" | "shadowBanned" | "timeoutUntil">> = {};

    if (body.data.banned !== undefined) {
      changes.banned = body.data.banned;
    }

    if (body.data.shadowBanned !== undefined) {
      changes.shadowBanned = body.data.shadowBanned;
    }

    if (body.data.timeoutUntil !== undefined) {
      // `null` lifts the timeout (cleared to undefined); a number sets it. A past value is harmless (the
      // posting gate treats only a future `timeoutUntil` as active).
      changes.timeoutUntil = body.data.timeoutUntil ?? undefined;
    }

    // Broadcast the userUpserted first (so the target's own client learns it is banned), then tear
    // down their sessions and sockets.
    const updated = ctx.applyUserModeration(user, changes);

    if (changes.banned === true) {
      ctx.invalidateUserSessions(user.id);
    }

    return updated;
  });

  // The full human roster including banned and shadow-banned users, so the moderation UI can review
  // and unban them (visibleUsers hides banned/pending from everyone else). Admins and moderators.
  ctx.server.get("/api/moderation/users", async (request, reply) => {
    const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));

    if (!ctx.canModerate(currentUser)) {
      return reply.code(403).send(errorBody("Moderator access required"));
    }

    return ctx.data.users.filter((user) => user.type === "human");
  });

  // File a member abuse report (docs/26). Private by design: never broadcast, never in the message stream,
  // and the reporter id never leaves the moderator queue below. Any participating member may report a
  // message they can SEE or any human user. Rate-limited to blunt report spam.
  ctx.server.post(
    "/api/reports",
    ctx.semanticRateLimit(20),
    async (request, reply) => {
      const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));
      const accessError = ctx.participationError(currentUser);

      if (accessError) {
        return reply.code(403).send(errorBody(accessError));
      }

      const body = ReportCreateRequestSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send(errorBody("Invalid report"));
      }

      const { targetType, targetId, reason, note } = body.data;

      if (targetType === "user") {
        const target = ctx.data.users.find((candidate) => candidate.id === targetId);

        if (!target || target.type !== "human") {
          return reply.code(404).send(errorBody("Report target does not exist"));
        }
      } else {
        const target = ctx.data.messages.find((candidate) => candidate.id === targetId);
        // The reporter must be able to SEE the message: a restricted audience (DM / private channel) must
        // include them; a public message (undefined audience) is reportable by anyone. 404 identically for
        // "no such message" and "not visible to you" so report can't be used to probe for hidden content.
        const audience = target ? ctx.messageAudienceUserIds(target) : undefined;

        if (!target || (audience !== undefined && !audience.has(currentUser.id))) {
          return reply.code(404).send(errorBody("Report target does not exist"));
        }
      }

      const report = ReportSchema.parse({
        id: newMessageId("rpt"),
        targetType,
        targetId,
        reporterUserId: currentUser.id,
        reason,
        ...(note ? { note } : {}),
        createdAt: Date.now(),
        status: "open",
      });
      ctx.store.upsertReport(report);
      // Intentionally no broadcast and no reporter detail in the response — reports are moderator-private.
      return reply.code(201).send({ ok: true });
    },
  );

  // The open-report queue for moderators/admins, newest first. Reporter ids are included here (mod-only) —
  // this endpoint is the ONLY place a report or its reporter is ever exposed.
  ctx.server.get("/api/moderation/reports", async (request, reply) => {
    const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));

    if (!ctx.canModerate(currentUser)) {
      return reply.code(403).send(errorBody("Moderator access required"));
    }

    return ctx.store.loadOpenReports();
  });

  // Resolve a report: record the action taken and close it. The enforcement itself (remove message /
  // timeout / ban) is done via its own endpoint; this closes the loop so the queue clears. Mods/admins.
  ctx.server.post<{ Params: { reportId: string } }>(
    "/api/moderation/reports/:reportId/resolve",
    async (request, reply) => {
      const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));

      if (!ctx.canModerate(currentUser)) {
        return reply.code(403).send(errorBody("Moderator access required"));
      }

      const body = ReportResolveRequestSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send(errorBody("Invalid resolution"));
      }

      const existing = ctx.store.getReport(request.params.reportId);

      if (!existing) {
        return reply.code(404).send(errorBody("Report does not exist"));
      }

      const resolved: Report = ReportSchema.parse({
        ...existing,
        status: "resolved",
        resolution: body.data.resolution,
        // The moderator's note goes in `resolutionNote` — never overwrite the reporter's original `note`.
        ...(body.data.note ? { resolutionNote: body.data.note } : {}),
        resolvedByUserId: currentUser.id,
        resolvedAt: Date.now(),
      });
      ctx.store.upsertReport(resolved);
      return resolved;
    },
  );

  // Moderator removal of a message — the "honest tombstone": blank the body + attachments and mark it
  // removed with an optional sanitized public reason, rather than a silent delete. Broadcast so readers
  // see "removed by a moderator" (a private-channel tombstone still reaches only its members). Mods/admins.
  ctx.server.post<{ Params: { messageId: string } }>(
    "/api/moderation/messages/:messageId/remove",
    // Per-route rate limit: this handler touches the filesystem (deletes attachment files), and CodeQL
    // (js/missing-rate-limiting) only credits the per-route config, not the global limiter.
    { config: { rateLimit: { max: 60, timeWindow: "1 minute", allowList: () => false } } },
    async (request, reply) => {
      const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));

      if (!ctx.canModerate(currentUser)) {
        return reply.code(403).send(errorBody("Moderator access required"));
      }

      const body = MessageRemoveRequestSchema.safeParse(request.body ?? {});

      if (!body.success) {
        return reply.code(400).send(errorBody("Invalid removal request"));
      }

      const message = ctx.data.messages.find((candidate) => candidate.id === request.params.messageId);

      if (!message || !("body" in message)) {
        return reply.code(404).send(errorBody("Message does not exist"));
      }

      // Actually destroy the removed content's attachment files — blanking the record alone would leave
      // the images fetchable by id from GET /api/attachments/:fileName, exactly the wrong outcome for
      // removing abuse imagery (mirrors the author-delete path in deleteMessages). `message` is already
      // narrowed to a body-bearing type (post/reply/dm) by the `"body" in message` guard above. Best-effort.
      for (const attachment of message.attachments ?? []) {
        rm(join(ctx.attachmentsDir, attachmentFileName(attachment)), { force: true }).catch((error: unknown) =>
          ctx.server.log.warn(error),
        );
      }

      const removed = MessageSchema.parse({
        ...message,
        body: "",
        attachments: [],
        // Drop a shared location too — the tombstone must carry no residual content on the wire.
        location: undefined,
        editedAt: Date.now(),
        meta: {
          ...message.meta,
          removedByModerator: true,
          ...(body.data.reason ? { removalReason: body.data.reason } : {}),
          streaming: false,
        },
      });
      ctx.store.updateMessage(removed);
      // `removed.location` is `undefined`; Object.assign copies that onto the live record and JSON omits it
      // on the wire, so no residual location egresses.
      Object.assign(message, removed);
      ctx.broadcast({ type: "messageUpdated", message });
      return message;
    },
  );

  // Ephemeral typing ping (P14): broadcast "userId is typing" to the conversation audience (minus the
  // typist). Never persisted. Silently no-ops (204) for a banned/pending/timed-out sender, a channel the
  // sender can't access, or an unknown DM recipient — so a stale "typing…" can't be spoofed at someone who
  // can't see the conversation. The client throttles these; the per-route cap is the server-side backstop.
  ctx.server.post(
    "/api/typing",
    ctx.semanticRateLimit(120),
    async (request, reply) => {
      const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));

      if (ctx.participationError(currentUser) || ctx.timeoutError(currentUser)) {
        return reply.code(204).send();
      }

      const body = TypingRequestSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send(errorBody("Invalid typing request"));
      }

      if (body.data.channelId) {
        const channel = ctx.ensureChannel(body.data.channelId);
        // A typing signal is only meaningful where the user could actually post: not in an archived
        // channel (read-only), and not for a member the channel's posting policy excludes (owner-only /
        // admins-only) — otherwise a non-poster broadcasts "X is typing…" to every reader at 120/min
        // (review 2026-09-04). `channelPostingError` is the same gate `createMessage` applies.
        if (
          channel &&
          ctx.canAccessChannel(channel, currentUser.id) &&
          ctx.channelPostingError(channel, currentUser.id, false) === undefined
        ) {
          ctx.broadcast({ type: "typing", userId: currentUser.id, channelId: channel.id });
        }
      } else if (
        ctx.appConfig.features.enableDMs &&
        body.data.recipientUserId &&
        ctx.data.users.some((user) => user.id === body.data.recipientUserId)
      ) {
        ctx.broadcast({ type: "typing", userId: currentUser.id, dmUserId: body.data.recipientUserId });
      }

      return reply.code(204).send();
    },
  );

  // Users awaiting approval under the `approval` join policy. Admins and greeters.
  ctx.server.get("/api/access/pending", async (request, reply) => {
    const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));

    if (!ctx.canGreet(currentUser)) {
      return reply.code(403).send(errorBody("Greeter access required"));
    }

    return ctx.data.users
      .filter((user) => user.type === "human" && user.pending === true)
      .map((user) => ctx.sanitizeUserFor(currentUser, user));
  });

  // Approve a pending user so they can participate. Admins and greeters.
  ctx.server.post<{ Params: { userId: string } }>("/api/access/users/:userId/approve", async (request, reply) => {
    const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));

    if (!ctx.canGreet(currentUser)) {
      return reply.code(403).send(errorBody("Greeter access required"));
    }

    const user = ctx.data.users.find((candidate) => candidate.id === request.params.userId);

    if (!user) {
      return reply.code(404).send(errorBody("User does not exist"));
    }

    return ctx.sanitizeUserFor(currentUser, ctx.applyUserModeration(user, { pending: false }));
  });

  // Deny a pending user: bans them (clearing pending) and tears down their sessions. Admins and
  // greeters — but, like moderation, never usable against an admin or oneself.
  ctx.server.post<{ Params: { userId: string } }>("/api/access/users/:userId/deny", async (request, reply) => {
    const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));

    if (!ctx.canGreet(currentUser)) {
      return reply.code(403).send(errorBody("Greeter access required"));
    }

    const user = ctx.data.users.find((candidate) => candidate.id === request.params.userId);

    if (!user) {
      return reply.code(404).send(errorBody("User does not exist"));
    }

    if (user.isAdmin || user.id === currentUser.id) {
      return reply.code(403).send(errorBody("You cannot deny an admin or yourself"));
    }

    // Deny is an onboarding action, scoped to pending newcomers. Banning an established member is a
    // moderation action that requires the moderator role (PATCH /api/moderation/users/:id) — without
    // this guard, a greeter could ban any approved member (privilege escalation).
    if (!user.pending) {
      return reply.code(400).send(errorBody("Only pending users can be denied"));
    }

    const updated = ctx.applyUserModeration(user, { banned: true, pending: false });
    ctx.invalidateUserSessions(user.id);
    return ctx.sanitizeUserFor(currentUser, updated);
  });

  ctx.server.get<{ Params: { fileName: string } }>(
    "/api/avatars/:fileName",
    // Read cap set well above the write caps: in `required` mode EVERY image load is a tunnelled
    // dispatch, and a crowded People page fetches a hundred-plus avatars in one render — throttling
    // reads paints sticky blank images client-side.
    { config: { rateLimit: { max: 300, timeWindow: "1 minute", allowList: () => false } } },
    async (request, reply) => {
    const avatar = parseAvatarImageId(request.params.fileName);

    if (!avatar) {
      return reply.code(404).send(errorBody("Avatar image does not exist"));
    }

    try {
      const image = await readFile(ctx.avatarImagePath(avatar.imageId, avatar.mimeType));
      return reply.type(avatar.mimeType).header("cache-control", "private, max-age=3600").header("x-content-type-options", "nosniff").send(image);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return reply.code(404).send(errorBody("Avatar image does not exist"));
      }

      throw error;
    }
  });

  // Upload one message-attachment image. Like avatars: base64 JSON body, magic-byte signature
  // checked against the declared MIME, strict size cap (clients downscale first). The returned id
  // is bound to this uploader and consumed by the message that references it (see createMessage).
  ctx.server.post(
    "/api/attachments",
    { bodyLimit: ctx.LARGE_BODY_LIMIT, config: { rateLimit: { max: 20, timeWindow: "1 minute", allowList: () => false } } },
    async (request, reply) => {
      const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));
      const accessError = ctx.participationError(currentUser);

      if (accessError) {
        return reply.code(403).send(errorBody(accessError));
      }

      // A timed-out user can't post, so they can't stage uploads either — same policy as
      // createMessage, checked here so the file never lands on disk.
      const uploadTimeoutError = ctx.timeoutError(currentUser);

      if (uploadTimeoutError) {
        return reply.code(403).send(errorBody(uploadTimeoutError));
      }

      if (!ctx.appConfig.features.enableAttachments) {
        return reply.code(403).send(errorBody("Attachments are disabled on this LOAM node"));
      }

      const body = AttachmentUploadRequestSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send(errorBody("Invalid attachment upload request"));
      }

      const bytes = Buffer.from(body.data.data, "base64");
      const isImage = isImageAttachmentMime(body.data.mimeType);
      const cap = isImage ? attachmentMaxBytes : attachmentFileMaxBytes;

      if (bytes.length === 0 || bytes.length > cap) {
        return reply.code(400).send(errorBody("Attachment is empty or too large"));
      }

      // Images must actually be the image they claim (magic bytes) since they're served INLINE. Non-image
      // files carry an allowlisted MIME (schema-enforced) and are served octet-stream + attachment, so a
      // mislabelled file can never be rendered — a magic-byte check per arbitrary type isn't needed.
      if (isImageAttachmentMime(body.data.mimeType) && !avatarImageHasExpectedSignature(bytes, body.data.mimeType)) {
        return reply.code(400).send(errorBody("Attachment image type does not match the uploaded data"));
      }

      const attachment: MessageAttachment = {
        id: newAttachmentId(),
        mimeType: body.data.mimeType,
        ...(isImage && body.data.width !== undefined ? { width: body.data.width } : {}),
        ...(isImage && body.data.height !== undefined ? { height: body.data.height } : {}),
        ...(isImage ? {} : { name: sanitizeAttachmentName(body.data.name) }),
      };
      await mkdir(ctx.attachmentsDir, { recursive: true });
      await writeFile(join(ctx.attachmentsDir, attachmentFileName(attachment)), bytes);
      ctx.attachmentOwners.set(attachment.id, { userId: currentUser.id, uploadedAt: Date.now() });
      return reply.code(201).send(attachment);
    },
  );

  ctx.server.get<{ Params: { fileName: string } }>(
    "/api/attachments/:fileName",
    // Read cap set well above the write caps: a media-heavy channel history fetches every image
    // through the tunnel in `required` mode (see the avatars note above).
    { config: { rateLimit: { max: 600, timeWindow: "1 minute", allowList: () => false } } },
    async (request, reply) => {
      const attachment = parseAttachmentFileName(request.params.fileName);

      if (!attachment) {
        return reply.code(404).send(errorBody("Attachment does not exist"));
      }

      // Audience-gate the file exactly like its owning message: attachments on public messages
      // are anonymously fetchable (peer nodes copy them without a session); DM / private-channel
      // attachments are only served to the people who may read the message. A pending upload
      // (no owning message yet) is visible only to its uploader.
      const owningMessage = ctx.data.messages.find(
        (message) =>
          message.type !== "reaction" &&
          message.type !== "sealed" &&
          !!message.attachments?.some((entry) => entry.id === attachment.id),
      );
      const sessionUserId = ctx.getSessionUserIdFromRequest(request);

      if (!owningMessage) {
        if (!sessionUserId || ctx.attachmentOwners.get(attachment.id)?.userId !== sessionUserId) {
          return reply.code(404).send(errorBody("Attachment does not exist"));
        }
      } else if (!ctx.sync.isSyncableMessage(owningMessage)) {
        const user = sessionUserId
          ? ctx.data.users.find((candidate) => candidate.id === sessionUserId)
          : undefined;

        if (!user || ctx.participationError(user)) {
          return reply.code(404).send(errorBody("Attachment does not exist"));
        }

        const audience = ctx.messageAudienceUserIds(owningMessage);

        if (audience && !audience.has(user.id)) {
          return reply.code(404).send(errorBody("Attachment does not exist"));
        }

        // Defense-in-depth: a shadow-banned author's message is hidden from everyone but the author on
        // every other path (`withoutShadowBanned`, `socketCanReceiveEvent`), yet `messageAudienceUserIds`
        // returns undefined (unrestricted) for a PUBLIC channel — so a participant who somehow learned the
        // (unguessable) attachment id could still fetch the file. Apply the shadow-ban rule explicitly here
        // too, matching how the message body itself is filtered.
        const owningAuthor = ctx.data.users.find((candidate) => candidate.id === owningMessage.authorId);

        if (owningAuthor?.shadowBanned && owningMessage.authorId !== user.id) {
          return reply.code(404).send(errorBody("Attachment does not exist"));
        }
      }

      try {
        // Rebuild the filename from the parsed id + kind (like the avatar route) rather than joining the
        // raw request param — the served path is then provably derived from the whitelisted pattern, never
        // from user input.
        const fileBytes = await readFile(join(ctx.attachmentsDir, attachmentFileName(attachment)));
        reply.header("cache-control", "private, max-age=3600").header("x-content-type-options", "nosniff");

        // Images render inline with their real type (safe — images aren't executable). A NON-image file is
        // ALWAYS served as `application/octet-stream` + `Content-Disposition: attachment`, so the browser
        // downloads it and never renders it — an uploaded HTML/SVG/etc. can't execute. The download name
        // comes from the owning message's (sanitised) attachment record.
        if (attachment.isImage && attachment.mimeType) {
          return reply.type(attachment.mimeType).send(fileBytes);
        }

        const record =
          owningMessage && "attachments" in owningMessage
            ? owningMessage.attachments?.find((entry) => entry.id === attachment.id)
            : undefined;
        const downloadName = sanitizeAttachmentName(record?.name);
        // RFC 6266: an ASCII-folded `filename=` (a header value may not carry a byte > 0xFF, which would
        // make Node throw ERR_INVALID_CHAR → 500 for any CJK/emoji/Cyrillic name) PLUS a `filename*` that
        // percent-encodes the real UTF-8 name, so modern browsers still get the correct international name.
        const asciiName = downloadName.replace(/[^\x20-\x7e]/g, "_");
        return reply
          .type("application/octet-stream")
          .header(
            "content-disposition",
            `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
          )
          .send(fileBytes);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return reply.code(404).send(errorBody("Attachment does not exist"));
        }

        throw error;
      }
    },
  );
}
