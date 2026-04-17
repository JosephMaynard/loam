import { z } from "zod";

export const IdSchema = z.string().min(1);
export type Id = z.infer<typeof IdSchema>;

export const TimestampSchema = z.number().int().nonnegative();
export type Timestamp = z.infer<typeof TimestampSchema>;

export const UserAvatarSchema = z.object({
  palette: z.string().min(1),
  face: z.string().min(1),
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
  enableLLMStreaming: z.boolean(),
});
export type NetworkConfig = z.infer<typeof NetworkConfigSchema>;

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

const MessageBodySchema = z.string().refine((body) => body.trim().length > 0, {
  message: "Message body cannot be empty",
});

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
