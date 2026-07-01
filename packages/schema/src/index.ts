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

export const UserSchema = z.object({
  id: IdSchema,
  displayName: z.string().min(1),
  avatar: UserAvatarSchema.optional(),
  type: UserTypeSchema,
  isAdmin: z.boolean(),
  createdAt: TimestampSchema,
  ephemeral: z.boolean(),
});
export type User = z.infer<typeof UserSchema>;

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
});
export type Channel = z.infer<typeof ChannelSchema>;

export const NetworkConfigSchema = z.object({
  enablePublicChannels: z.boolean(),
  enablePrivateChannels: z.boolean(),
  enableUserChannels: z.boolean(),
  enableReplies: z.boolean(),
  enableDMs: z.boolean(),
  enableReactions: z.boolean(),
  enableMarkdown: z.boolean(),
  enableLLMChat: z.boolean(),
  enableLLMStreaming: z.boolean(),
  allowUserDisplayNameEdit: z.boolean(),
  allowUserAvatarEdit: z.boolean(),
  allowUserAvatarUpload: z.boolean(),
  allowAdminClaim: z.boolean(),
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
  baseUrl: z.string().min(1),
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

export const SecurityProfileSchema = z.enum(["open", "standard", "hardened", "custom"]);
export type SecurityProfile = z.infer<typeof SecurityProfileSchema>;

export const SecurityConfigSchema = z.object({
  profile: SecurityProfileSchema,
});
export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;

export const LoamConfigSchema = z.object({
  identity: IdentityConfigSchema,
  features: FeatureFlagsSchema,
  llm: z.object({ ollama: OllamaConfigSchema }),
  admin: AdminConfigSchema,
  killSwitch: KillSwitchConfigSchema,
  retention: RetentionConfigSchema,
  security: SecurityConfigSchema,
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

export const AvatarImageUploadRequestSchema = z.object({
  mimeType: AvatarImageMimeTypeSchema,
  data: z.string().min(1).max(256_000),
});
export type AvatarImageUploadRequest = z.infer<typeof AvatarImageUploadRequestSchema>;

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
const MessageCreateBodySchema = MessageBodySchema.refine((body) => body.trim().length > 0, {
  message: "Message body cannot be empty",
});

export const MessageCreateRequestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("channelPost"),
    channelId: IdSchema,
    body: MessageCreateBodySchema,
  }),
  z.object({
    type: z.literal("channelReply"),
    channelId: IdSchema,
    parentMessageId: IdSchema,
    body: MessageCreateBodySchema,
  }),
  z.object({
    type: z.literal("dm"),
    recipientUserId: IdSchema,
    body: MessageCreateBodySchema,
  }),
  z.object({
    type: z.literal("reaction"),
    targetMessageId: IdSchema,
    reaction: z.string().min(1),
  }),
]);
export type MessageCreateRequest = z.infer<typeof MessageCreateRequestSchema>;

export const ChannelPostMessageSchema = BaseMessageSchema.extend({
  type: z.literal("channelPost"),
  channelId: IdSchema,
  body: MessageBodySchema,
});
export type ChannelPostMessage = z.infer<typeof ChannelPostMessageSchema>;

export const ChannelReplyMessageSchema = BaseMessageSchema.extend({
  type: z.literal("channelReply"),
  channelId: IdSchema,
  parentMessageId: IdSchema,
  body: MessageBodySchema,
});
export type ChannelReplyMessage = z.infer<typeof ChannelReplyMessageSchema>;

export const DirectMessageSchema = BaseMessageSchema.extend({
  type: z.literal("dm"),
  recipientUserId: IdSchema,
  body: MessageBodySchema,
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
