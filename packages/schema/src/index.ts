import { z } from "zod";

export const IdSchema = z.string().min(1);
export type Id = z.infer<typeof IdSchema>;

export const TimestampSchema = z.number().int().nonnegative();
export type Timestamp = z.infer<typeof TimestampSchema>;

export const AvatarModeSchema = z.enum(["face", "initial", "pattern"]);
export type AvatarMode = z.infer<typeof AvatarModeSchema>;

export const AvatarImageMimeTypeSchema = z.enum(["image/png", "image/jpeg", "image/webp"]);
export type AvatarImageMimeType = z.infer<typeof AvatarImageMimeTypeSchema>;

export const UserAvatarSchema = z.object({
  kind: z.enum(["generated", "image"]).optional(),
  seed: z.string().min(1).max(128).optional(),
  mode: AvatarModeSchema.optional(),
  imageId: IdSchema.optional(),
  mimeType: AvatarImageMimeTypeSchema.optional(),
  uploadedAt: TimestampSchema.optional(),
  palette: z.string().min(1).optional(),
  face: z.string().min(1).optional(),
  accessory: z.string().min(1).optional(),
});
export type UserAvatar = z.infer<typeof UserAvatarSchema>;

export const UserTypeSchema = z.enum(["human", "bot", "system"]);
export type UserType = z.infer<typeof UserTypeSchema>;

/** Extra capabilities an admin can grant. Admins (`isAdmin`) implicitly have all role powers. */
export const RoleSchema = z.enum(["moderator", "greeter"]);
export type Role = z.infer<typeof RoleSchema>;

export const UserSchema = z.object({
  id: IdSchema,
  displayName: z.string().min(1),
  avatar: UserAvatarSchema.optional(),
  type: UserTypeSchema,
  isAdmin: z.boolean(),
  /** Extra granted capabilities (moderator, greeter). Absent/empty = a plain member. */
  roles: z.array(RoleSchema).optional(),
  /** Barred from the node: cannot post, sessions are invalidated, hidden from non-moderators. */
  banned: z.boolean().optional(),
  /** Can still post, but their new messages are only broadcast back to themselves (shadow ban). */
  shadowBanned: z.boolean().optional(),
  /** Awaiting a greeter/admin's approval to participate (when the node's joinPolicy is "approval"). */
  pending: z.boolean().optional(),
  createdAt: TimestampSchema,
  ephemeral: z.boolean(),
});
export type User = z.infer<typeof UserSchema>;

/** How new people join: "open" (anyone participates immediately) or "approval" (a greeter/admin lets them in). */
export const JoinPolicySchema = z.enum(["open", "approval"]);
export type JoinPolicy = z.infer<typeof JoinPolicySchema>;

/** Named security posture (defined here so NetworkConfig can surface it to the client). */
export const SecurityProfileSchema = z.enum(["open", "standard", "hardened", "custom"]);
export type SecurityProfile = z.infer<typeof SecurityProfileSchema>;

/** The already-enforced security axes a non-`custom` profile applies as one coherent bundle. */
export type SecurityProfilePreset = {
  /** Who may join: everyone immediately (`open`) or a greeter/admin approves newcomers (`approval`). */
  joinPolicy: JoinPolicy;
  /** Ephemeral-message TTL in ms, or `null` to keep messages forever. */
  messageTtlMs: number | null;
  /** Whether the admin/panic kill switch is armed. */
  killSwitchEnabled: boolean;
};

/**
 * The single source of truth mapping each named profile → the concrete config axes it forces, so
 * "pick a profile" stays testable as 3 whole configurations instead of 2ⁿ toggles (docs/09). Only
 * axes LOAM actually enforces today appear here; the axes that would otherwise separate `open` from
 * `standard` (transport encryption, invite tokens — docs/08) are not built yet, so those two apply
 * the same enforced settings for now and differ only in intent. `hardened` tightens all three.
 */
export const SECURITY_PROFILE_PRESETS: Record<
  Exclude<SecurityProfile, "custom">,
  SecurityProfilePreset
> = {
  open: { joinPolicy: "open", messageTtlMs: null, killSwitchEnabled: false },
  standard: { joinPolicy: "open", messageTtlMs: null, killSwitchEnabled: false },
  hardened: { joinPolicy: "approval", messageTtlMs: 3_600_000, killSwitchEnabled: true },
};

/**
 * The bundle a profile applies, or `null` for `custom` (the raw configured axes are used as-is).
 * Callers force the returned axes onto the effective config; `custom` opts out of any forcing.
 */
export function securityProfilePreset(profile: SecurityProfile): SecurityProfilePreset | null {
  return profile === "custom" ? null : SECURITY_PROFILE_PRESETS[profile];
}

export const ChannelVisibilitySchema = z.enum(["public", "private", "adminInbox"]);
export type ChannelVisibility = z.infer<typeof ChannelVisibilitySchema>;

export const ChannelPostingPolicySchema = z.enum(["everyone", "owner", "admins"]);
export type ChannelPostingPolicy = z.infer<typeof ChannelPostingPolicySchema>;

export const ChannelSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  ownerUserId: IdSchema.optional(),
  visibility: ChannelVisibilitySchema,
  allowPosting: ChannelPostingPolicySchema,
  allowReplies: z.boolean(),
  discoverable: z.boolean(),
  createdAt: TimestampSchema,
  archived: z.boolean().optional(),
  /**
   * Private-channel roster: the user ids who may see, read, and post in the channel (the owner is
   * always treated as a member even if absent here). Present only on private channels — the server
   * never sends a private channel (or its member list) to anyone outside this roster.
   */
  memberUserIds: z.array(IdSchema).optional(),
});
export type Channel = z.infer<typeof ChannelSchema>;

/**
 * Request to create a channel. The server assigns `id`, `createdAt`, and `ownerUserId`.
 * `visibility` may be `public` (default; discoverable by everyone) or `private` (invite-only —
 * requires the `enablePrivateChannels` feature flag; the creator becomes the first member).
 */
export const ChannelCreateRequestSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(280).optional(),
  visibility: z.enum(["public", "private"]).optional(),
  allowPosting: ChannelPostingPolicySchema.optional(),
  allowReplies: z.boolean().optional(),
});
export type ChannelCreateRequest = z.infer<typeof ChannelCreateRequestSchema>;

/** Request to add a member to a private channel (channel owner or an admin only). */
export const ChannelMemberAddRequestSchema = z.object({
  userId: IdSchema,
});
export type ChannelMemberAddRequest = z.infer<typeof ChannelMemberAddRequestSchema>;

/** Admin request to update an existing channel. Every field is optional; omitted fields are left as-is. */
export const ChannelUpdateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(280),
    allowPosting: ChannelPostingPolicySchema,
    allowReplies: z.boolean(),
    archived: z.boolean(),
  })
  .partial();
export type ChannelUpdateRequest = z.infer<typeof ChannelUpdateRequestSchema>;

export const NetworkConfigSchema = z.object({
  enablePublicChannels: z.boolean(),
  enablePrivateChannels: z.boolean(),
  enableUserChannels: z.boolean(),
  enableReplies: z.boolean(),
  enableDMs: z.boolean(),
  enableReactions: z.boolean(),
  enableMarkdown: z.boolean(),
  enableAttachments: z.boolean(),
  enableLLMChat: z.boolean(),
  enableLLMStreaming: z.boolean(),
  allowUserDisplayNameEdit: z.boolean(),
  allowUserAvatarEdit: z.boolean(),
  allowUserAvatarUpload: z.boolean(),
  allowAdminClaim: z.boolean(),
  /** How new people join, surfaced so the client can show a "waiting for approval" flow. */
  joinPolicy: JoinPolicySchema,
  /** The node's active security posture, surfaced so the client can gate secure-only affordances. */
  securityProfile: SecurityProfileSchema,
});
export type NetworkConfig = z.infer<typeof NetworkConfigSchema>;

export const FeatureFlagsSchema = z.object({
  enablePublicChannels: z.boolean(),
  enablePrivateChannels: z.boolean(),
  enableUserChannels: z.boolean(),
  enableReplies: z.boolean(),
  enableDMs: z.boolean(),
  enableReactions: z.boolean(),
  enableMarkdown: z.boolean(),
  enableAttachments: z.boolean(),
});
export type FeatureFlags = z.infer<typeof FeatureFlagsSchema>;

export const IdentityConfigSchema = z.object({
  allowUserDisplayNameEdit: z.boolean(),
  allowUserAvatarEdit: z.boolean(),
  allowUserAvatarUpload: z.boolean(),
  allowAdminUserEdit: z.boolean(),
});
export type IdentityConfig = z.infer<typeof IdentityConfigSchema>;

export const OllamaConfigSchema = z.object({
  enabled: z.boolean(),
  baseUrl: z.url({ protocol: /^https?$/ }),
  model: z.string().min(1),
  botId: IdSchema,
  botDisplayName: z.string().min(1),
  systemPrompt: z.string().min(1).optional(),
});
export type OllamaConfig = z.infer<typeof OllamaConfigSchema>;

export const AdminBootstrapStrategySchema = z.enum([
  "none",
  "firstUser",
  "setupCode",
  "passphrase",
  "hostDevice",
]);
export type AdminBootstrapStrategy = z.infer<typeof AdminBootstrapStrategySchema>;

export const AdminConfigSchema = z.object({
  bootstrap: AdminBootstrapStrategySchema,
  passphrase: z.string().min(8).max(256).optional(),
});
export type AdminConfig = z.infer<typeof AdminConfigSchema>;

export const RetentionConfigSchema = z.object({
  /** Delete messages older than this many milliseconds; unset = keep forever. */
  messageTtlMs: z.number().int().positive().optional(),
});
export type RetentionConfig = z.infer<typeof RetentionConfigSchema>;

export const KillSwitchConfigSchema = z.object({
  enabled: z.boolean(),
  requireConfirmation: z.boolean(),
  panicToken: z.string().min(16).max(256).optional(),
});
export type KillSwitchConfig = z.infer<typeof KillSwitchConfigSchema>;

export const SecurityConfigSchema = z.object({
  profile: SecurityProfileSchema,
});
export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;

/** Access control for who may join and participate. */
export const AccessConfigSchema = z.object({
  joinPolicy: JoinPolicySchema,
});
export type AccessConfig = z.infer<typeof AccessConfigSchema>;

/** One node this node pulls from. The peer's join URL (from its join QR) is exactly its sync URL. */
export const SyncPeerSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  label: z.string().trim().min(1).max(80).optional(),
});
export type SyncPeer = z.infer<typeof SyncPeerSchema>;

/**
 * Node-to-node sync (docs/11): pull-based gossip of **public** data only — public channels, their
 * messages/reactions, and referenced user profiles. DMs and private channels never leave a node.
 */
export const SyncConfigSchema = z.object({
  enabled: z.boolean(),
  peers: z.array(SyncPeerSchema).max(16),
  /** How often the pull loop runs against each peer. */
  intervalMs: z.number().int().min(5_000).max(3_600_000),
});
export type SyncConfig = z.infer<typeof SyncConfigSchema>;

export const LoamConfigSchema = z.object({
  identity: IdentityConfigSchema,
  features: FeatureFlagsSchema,
  llm: z.object({ ollama: OllamaConfigSchema }),
  admin: AdminConfigSchema,
  killSwitch: KillSwitchConfigSchema,
  retention: RetentionConfigSchema,
  security: SecurityConfigSchema,
  access: AccessConfigSchema,
  sync: SyncConfigSchema,
});
export type LoamConfig = z.infer<typeof LoamConfigSchema>;

export const LoamConfigUpdateSchema = z.object({
  identity: IdentityConfigSchema.partial().optional(),
  features: FeatureFlagsSchema.partial().optional(),
  llm: z
    .object({
      ollama: OllamaConfigSchema.partial().extend({
        systemPrompt: z.string().max(4000).optional(),
      }),
    })
    .optional(),
  admin: AdminConfigSchema.partial()
    .extend({
      // Empty string clears the stored value; non-empty must meet the same minimum as AdminConfigSchema.
      passphrase: z.literal("").or(z.string().min(8).max(256)).optional(),
    })
    .optional(),
  killSwitch: KillSwitchConfigSchema.partial()
    .extend({
      // Empty string clears the stored value; non-empty must meet the same minimum as KillSwitchConfigSchema.
      panicToken: z.literal("").or(z.string().min(16).max(256)).optional(),
    })
    .optional(),
  retention: z
    .object({
      // null clears the TTL back to keep-forever.
      messageTtlMs: z.number().int().positive().nullable().optional(),
    })
    .optional(),
  security: SecurityConfigSchema.partial().optional(),
  access: AccessConfigSchema.partial().optional(),
  // `peers` replaces the whole list when present.
  sync: SyncConfigSchema.partial().optional(),
});
export type LoamConfigUpdate = z.infer<typeof LoamConfigUpdateSchema>;

export const AdminClaimRequestSchema = z.object({
  secret: z.string().min(1).max(256),
});
export type AdminClaimRequest = z.infer<typeof AdminClaimRequestSchema>;

export const PanicRequestSchema = z.object({
  token: z.string().min(1).max(256),
});
export type PanicRequest = z.infer<typeof PanicRequestSchema>;

export const KillSwitchRequestSchema = z.object({
  /** Must be the literal "wipe" when the node's killSwitch.requireConfirmation is enabled. */
  confirm: z.string().max(64).optional(),
});
export type KillSwitchRequest = z.infer<typeof KillSwitchRequestSchema>;

export const UserUpdateRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  avatar: UserAvatarSchema.optional(),
});
export type UserUpdateRequest = z.infer<typeof UserUpdateRequestSchema>;

/** Admin request to set a user's granted roles (replaces the whole set). */
export const RolesUpdateRequestSchema = z.object({
  roles: z.array(RoleSchema),
});
export type RolesUpdateRequest = z.infer<typeof RolesUpdateRequestSchema>;

/** Admin/moderator request to set a user's moderation state (omitted fields are left unchanged). */
export const ModerationUpdateRequestSchema = z
  .object({
    banned: z.boolean().optional(),
    shadowBanned: z.boolean().optional(),
  })
  .refine((value) => value.banned !== undefined || value.shadowBanned !== undefined, {
    message: "Provide at least one of banned or shadowBanned",
  });
export type ModerationUpdateRequest = z.infer<typeof ModerationUpdateRequestSchema>;

export const AvatarImageUploadRequestSchema = z.object({
  mimeType: AvatarImageMimeTypeSchema,
  data: z.string().min(1).max(256_000),
});
export type AvatarImageUploadRequest = z.infer<typeof AvatarImageUploadRequestSchema>;

/** An image attached to a message. The file itself is uploaded first via `POST /api/attachments`. */
export const MessageAttachmentSchema = z.object({
  id: z.string().regex(/^att_[a-f0-9]{16}$/),
  mimeType: AvatarImageMimeTypeSchema,
  /** Pixel dimensions of the stored image (client-reported, cosmetic — used to reserve layout). */
  width: z.number().int().positive().max(10_000).optional(),
  height: z.number().int().positive().max(10_000).optional(),
});
export type MessageAttachment = z.infer<typeof MessageAttachmentSchema>;

/**
 * Upload one message-attachment image (base64 body, like avatars). Clients downscale before
 * uploading — the server enforces a 256KB binary cap and magic-byte/MIME agreement.
 */
export const AttachmentUploadRequestSchema = z.object({
  mimeType: AvatarImageMimeTypeSchema,
  data: z.string().min(1).max(400_000),
  width: z.number().int().positive().max(10_000).optional(),
  height: z.number().int().positive().max(10_000).optional(),
});
export type AttachmentUploadRequest = z.infer<typeof AttachmentUploadRequestSchema>;

export const MessageTypeSchema = z.enum([
  "channelPost",
  "channelReply",
  "dm",
  "reaction",
]);
export type MessageType = z.infer<typeof MessageTypeSchema>;

export const MessageSourceSchema = z.enum(["human", "llm", "system"]);
export type MessageSource = z.infer<typeof MessageSourceSchema>;

export const MessageMetaSchema = z.object({
  source: MessageSourceSchema.optional(),
  model: z.string().min(1).optional(),
  markdown: z.boolean().optional(),
  streaming: z.boolean().optional(),
});
export type MessageMeta = z.infer<typeof MessageMetaSchema>;

export const BaseMessageSchema = z.object({
  id: IdSchema,
  type: MessageTypeSchema,
  authorId: IdSchema,
  createdAt: TimestampSchema,
  editedAt: TimestampSchema.optional(),
  meta: MessageMetaSchema.optional(),
});
export type BaseMessage = z.infer<typeof BaseMessageSchema>;

const MessageBodySchema = z.string();
const MessageAttachmentsSchema = z.array(MessageAttachmentSchema).max(4);

export const MessageCreateRequestSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("channelPost"),
      channelId: IdSchema,
      body: MessageBodySchema,
      attachments: MessageAttachmentsSchema.optional(),
    }),
    z.object({
      type: z.literal("channelReply"),
      channelId: IdSchema,
      parentMessageId: IdSchema,
      body: MessageBodySchema,
      attachments: MessageAttachmentsSchema.optional(),
    }),
    z.object({
      type: z.literal("dm"),
      recipientUserId: IdSchema,
      body: MessageBodySchema,
      attachments: MessageAttachmentsSchema.optional(),
    }),
    z.object({
      type: z.literal("reaction"),
      targetMessageId: IdSchema,
      reaction: z.string().min(1),
    }),
  ])
  // A message needs text or at least one attachment (an image alone is a valid message).
  .superRefine((value, ctx) => {
    if (value.type !== "reaction" && !value.body.trim() && !value.attachments?.length) {
      ctx.addIssue({ code: "custom", message: "Message body cannot be empty", path: ["body"] });
    }
  });
export type MessageCreateRequest = z.infer<typeof MessageCreateRequestSchema>;

/** Author request to edit a body-bearing message (channel post/reply or DM). */
export const MessageEditRequestSchema = z.object({
  body: MessageBodySchema.refine((body) => body.trim().length > 0, {
    message: "Message body cannot be empty",
  }),
});
export type MessageEditRequest = z.infer<typeof MessageEditRequestSchema>;

export const ChannelPostMessageSchema = BaseMessageSchema.extend({
  type: z.literal("channelPost"),
  channelId: IdSchema,
  body: MessageBodySchema,
  attachments: MessageAttachmentsSchema.optional(),
});
export type ChannelPostMessage = z.infer<typeof ChannelPostMessageSchema>;

export const ChannelReplyMessageSchema = BaseMessageSchema.extend({
  type: z.literal("channelReply"),
  channelId: IdSchema,
  parentMessageId: IdSchema,
  body: MessageBodySchema,
  attachments: MessageAttachmentsSchema.optional(),
});
export type ChannelReplyMessage = z.infer<typeof ChannelReplyMessageSchema>;

export const DirectMessageSchema = BaseMessageSchema.extend({
  type: z.literal("dm"),
  recipientUserId: IdSchema,
  body: MessageBodySchema,
  attachments: MessageAttachmentsSchema.optional(),
});
export type DirectMessage = z.infer<typeof DirectMessageSchema>;

export const ReactionMessageSchema = BaseMessageSchema.extend({
  type: z.literal("reaction"),
  targetMessageId: IdSchema,
  reaction: z.string().min(1),
});
export type ReactionMessage = z.infer<typeof ReactionMessageSchema>;

export const MessageSchema = z.discriminatedUnion("type", [
  ChannelPostMessageSchema,
  ChannelReplyMessageSchema,
  DirectMessageSchema,
  ReactionMessageSchema,
]);
export type Message = z.infer<typeof MessageSchema>;

/**
 * `GET /api/sync/digest` — what a peer advertises: its public non-archived channels and the
 * id/editedAt of every syncable message (public-channel posts/replies/reactions, shadow-banned
 * authors excluded). Pullers diff this against what they hold and fetch the missing ids.
 */
export const SyncDigestSchema = z.object({
  channels: z.array(ChannelSchema),
  messages: z.array(
    z.object({
      id: IdSchema,
      editedAt: TimestampSchema.optional(),
    }),
  ),
});
export type SyncDigest = z.infer<typeof SyncDigestSchema>;

/** `POST /api/sync/messages` — fetch full records for up to 500 advertised ids. */
export const SyncMessagesRequestSchema = z.object({
  ids: z.array(IdSchema).min(1).max(500),
});
export type SyncMessagesRequest = z.infer<typeof SyncMessagesRequestSchema>;

export const SyncMessagesResponseSchema = z.object({
  messages: z.array(MessageSchema),
  /** Profiles for the message authors, so names/avatars resolve on the pulling node. */
  users: z.array(UserSchema),
});
export type SyncMessagesResponse = z.infer<typeof SyncMessagesResponseSchema>;

export const StreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("start"),
    messageId: IdSchema,
  }),
  z.object({
    type: z.literal("delta"),
    messageId: IdSchema,
    text: z.string(),
  }),
  z.object({
    type: z.literal("end"),
    messageId: IdSchema,
  }),
  z.object({
    type: z.literal("error"),
    messageId: IdSchema,
    error: z.string(),
  }),
]);
export type StreamEvent = z.infer<typeof StreamEventSchema>;
