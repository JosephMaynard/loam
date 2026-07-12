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
  // Short palette/feature keys — bounded so a PATCH to /api/users/me can't persist and broadcast
  // megabyte strings (the message body is capped for the same reason).
  palette: z.string().min(1).max(64).optional(),
  face: z.string().min(1).max(64).optional(),
  accessory: z.string().min(1).max(64).optional(),
});
export type UserAvatar = z.infer<typeof UserAvatarSchema>;

export const UserTypeSchema = z.enum(["human", "bot", "system"]);
export type UserType = z.infer<typeof UserTypeSchema>;

/** Extra capabilities an admin can grant. Admins (`isAdmin`) implicitly have all role powers. */
export const RoleSchema = z.enum(["moderator", "greeter"]);
export type Role = z.infer<typeof RoleSchema>;

export const UserSchema = z.object({
  id: IdSchema,
  // Bounded to the same 80 chars as the edit request (UserUpdateRequestSchema) so a hostile sync
  // peer can't import a user with a giant displayName past the request boundary.
  displayName: z.string().min(1).max(80),
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
  /**
   * Public mesh identity keys (opportunistic-mesh — docs/16), present when the node has `mesh.enabled`
   * and has minted a keypair for this local user. Published so senders on other nodes can seal mail to
   * them: `sign` is the Ed25519 public key (the `mesh.` id derives from it), `kx` the X25519 agreement
   * public key, `kxSig` binds `kx` to `sign`. The private keys and the secret mailbox token never
   * leave the home node. Absent for legacy / non-mesh users, who are unaffected.
   */
  identityKey: z
    .object({
      alg: z.literal("ed25519"),
      sign: z.string().min(1).max(64),
      kx: z.string().min(1).max(64),
      kxSig: z.string().min(1).max(128),
    })
    .optional(),
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

/**
 * The UI languages LOAM ships. The admin selects one for the whole node (`node.locale`), applied to
 * every user — there is no per-user picker. `en` is the source of truth and the guaranteed fallback.
 * Five are right-to-left scripts: `ar`, `fa`, `ur`, `prs` (Dari), `ps` (Pashto). Dari uses the ISO
 * 639-3 tag `prs`; the client maps it to `fa-AF` where `Intl` needs a CLDR locale.
 */
export const LocaleSchema = z.enum([
  "en",
  "es",
  "fr",
  "ar",
  "fa",
  "pt",
  "uk",
  "ru",
  "tr",
  "my",
  "ur",
  "prs",
  "ps",
  "sw",
  "bn",
]);
export type Locale = z.infer<typeof LocaleSchema>;

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
  // Bounded to the same limits as ChannelCreateRequest (80 / 280) so a hostile sync peer can't
  // import a channel with a giant name/description that bypassed the request boundary.
  name: z.string().min(1).max(80),
  description: z.string().max(280).optional(),
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

/**
 * Request to transfer a channel's ownership to another user (current owner or an admin only). For a
 * private channel the new owner must already be — or is automatically added as — a member.
 */
export const ChannelTransferRequestSchema = z.object({
  userId: IdSchema,
});
export type ChannelTransferRequest = z.infer<typeof ChannelTransferRequestSchema>;

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
  /** The operator-chosen name of this network, shown in the client (sidebar, join screen). */
  nodeName: z.string().min(1).max(80),
  enablePublicChannels: z.boolean(),
  enablePrivateChannels: z.boolean(),
  enableUserChannels: z.boolean(),
  enableReplies: z.boolean(),
  enableDMs: z.boolean(),
  enableReactions: z.boolean(),
  enableMarkdown: z.boolean(),
  enableAttachments: z.boolean(),
  /** Share a place/coordinates on a message (docs/10). When on, the client shows the share affordance. */
  enableLocationSharing: z.boolean(),
  enablePresence: z.boolean(),
  /** Opportunistic sealed-mailbox mesh (docs/16). When on, the client shows the mesh contacts + card UI. */
  enableMesh: z.boolean(),
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
  /** Admin-selected UI language for the whole node; the client renders every label in it. */
  locale: LocaleSchema,
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
  /** Share a place/coordinates on a message (docs/10). Default off; deliberate + ephemeral. */
  enableLocationSharing: z.boolean(),
  /**
   * Broadcast who is currently connected (online dots). Default on; worth disabling on
   * high-risk deployments — presence reveals exactly who is reachable right now.
   */
  enablePresence: z.boolean(),
});
export type FeatureFlags = z.infer<typeof FeatureFlagsSchema>;

/** Operator-facing identity of the node itself (not of any user). */
export const NodeIdentityConfigSchema = z.object({
  /** Network name shown to everyone in the client. */
  name: z.string().trim().min(1).max(80),
  /** UI language for the whole node, chosen by the admin and applied to every user. */
  locale: LocaleSchema,
});
export type NodeIdentityConfig = z.infer<typeof NodeIdentityConfigSchema>;

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

/**
 * On-device LLM backend (the Android host running a small model itself, e.g. Gemma via llama.cpp),
 * as an alternative to reaching a laptop's Ollama. The bot's *identity* (botId / botDisplayName /
 * systemPrompt) is shared from `llm.ollama`; this block only carries the on-device backend settings.
 * The model weights are **never shipped** — the operator adds a GGUF file on-device and its
 * app-private path lands in `modelPath`. Absent on non-Android hosts; enabling it there is a no-op
 * (the server has no on-device inference hook, so it reports a graceful error). Off by default.
 */
export const OnDeviceLlmConfigSchema = z.object({
  enabled: z.boolean(),
  /** Display label for the loaded model (e.g. "gemma-2-2b-it-Q4_K_M"); cosmetic. */
  model: z.string().min(1).max(120).optional(),
  /** App-private path to the user-provided GGUF file (Android host only). */
  modelPath: z.string().min(1).max(1024).optional(),
  /** Context window to load the model with; defaults are chosen on-device. */
  contextSize: z.number().int().positive().max(32_768).optional(),
});
export type OnDeviceLlmConfig = z.infer<typeof OnDeviceLlmConfigSchema>;

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

/**
 * Opportunistic-mesh / sealed-mailbox delivery (docs/16). The whole sealed-mail surface is gated on
 * `enabled` (default off) — with it off, public-data sync is byte-identical to today. `relay` (a
 * narrower gate) governs whether this node carries *other people's* sealed mail; a node can have
 * `enabled: true, relay: false` to send/receive its own mail without being a courier. `ttlMs` /
 * `hopLimit` bound how long/far a sent message propagates; `maxCarried` caps carried blobs.
 */
export const MeshConfigSchema = z.object({
  enabled: z.boolean(),
  relay: z.boolean(),
  ttlMs: z.number().int().min(60_000).max(7 * 24 * 3_600_000),
  hopLimit: z.number().int().min(1).max(16),
  maxCarried: z.number().int().min(0).max(100_000),
  /** Cap on a single local user's mesh address book, so an authenticated client can't grow the
   * `mesh_contacts` store without bound (mirrors `maxCarried` for sealed blobs). */
  maxContacts: z.number().int().min(0).max(100_000),
});
export type MeshConfig = z.infer<typeof MeshConfigSchema>;

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
  /**
   * Shared mesh secret. When set, this node **requires** every peer to present it (header
   * `x-loam-sync-token`) before serving the sync digest/messages, and presents it when pulling from
   * its own peers — so only nodes that know the token can join the mesh. Unlike the admin passphrase
   * or panic token this is stored in the clear (the node must transmit it to peers, exactly like an
   * outbound API key), so protect it via encryption-at-rest, not hashing. Unset = open (any node on
   * the LAN that can reach the endpoints may sync public data, the pre-token behaviour).
   */
  token: z.string().min(16).max(256).optional(),
});
export type SyncConfig = z.infer<typeof SyncConfigSchema>;

export const LoamConfigSchema = z.object({
  node: NodeIdentityConfigSchema,
  identity: IdentityConfigSchema,
  features: FeatureFlagsSchema,
  llm: z.object({ ollama: OllamaConfigSchema, onDevice: OnDeviceLlmConfigSchema }),
  admin: AdminConfigSchema,
  killSwitch: KillSwitchConfigSchema,
  retention: RetentionConfigSchema,
  security: SecurityConfigSchema,
  access: AccessConfigSchema,
  sync: SyncConfigSchema,
  mesh: MeshConfigSchema,
});
export type LoamConfig = z.infer<typeof LoamConfigSchema>;

export const LoamConfigUpdateSchema = z.object({
  node: NodeIdentityConfigSchema.partial().optional(),
  identity: IdentityConfigSchema.partial().optional(),
  features: FeatureFlagsSchema.partial().optional(),
  llm: z
    .object({
      ollama: OllamaConfigSchema.partial().extend({
        systemPrompt: z.string().max(4000).optional(),
      }),
      onDevice: OnDeviceLlmConfigSchema.partial(),
    })
    .partial()
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
  // `peers` replaces the whole list when present. An empty-string `token` clears the shared secret
  // (back to open sync); a non-empty one must meet the same minimum as SyncConfigSchema.
  sync: SyncConfigSchema.partial()
    .extend({
      token: z.literal("").or(z.string().min(16).max(256)).optional(),
    })
    .optional(),
  mesh: MeshConfigSchema.partial().optional(),
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
  "sealed",
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

// Stored bodies are unbounded: LLM replies can be long, and synced messages must round-trip
// whatever a peer legitimately stored.
const MessageBodySchema = z.string();
// Human-submitted bodies ARE capped — unbounded, one hostile joiner could flood ~1MB messages up
// to the per-IP rate limit. 8000 chars is generous for a LAN chat message. (The bot writes its
// replies server-side via the unbounded stored schema, so this never truncates an LLM answer.)
const MessageCreateBodySchema = z.string().max(8000);
const MessageAttachmentsSchema = z.array(MessageAttachmentSchema).max(4);

/**
 * A shared location (docs/10): a human-readable place `label` ("the north gate", "camp 3") and/or
 * coordinates. Carried on an ordinary message so it rides the existing channel/DM/sync flow — no new
 * message type. Sharing is deliberate + ephemeral (retention TTL) and gated by `enableLocationSharing`;
 * there is no continuous/background tracking. `lat`/`lng` are optional because off-grid clients have no
 * secure-context GPS — a named label alone is a valid share.
 */
export const MessageLocationSchema = z
  .object({
    label: z.string().min(1).max(120).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
  })
  .refine((location) => !!location.label || (location.lat !== undefined && location.lng !== undefined), {
    message: "A shared location needs a label or coordinates",
  });
export type MessageLocation = z.infer<typeof MessageLocationSchema>;

export const MessageCreateRequestSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("channelPost"),
      channelId: IdSchema,
      body: MessageCreateBodySchema,
      attachments: MessageAttachmentsSchema.optional(),
      location: MessageLocationSchema.optional(),
    }),
    z.object({
      type: z.literal("channelReply"),
      channelId: IdSchema,
      parentMessageId: IdSchema,
      body: MessageCreateBodySchema,
      attachments: MessageAttachmentsSchema.optional(),
      location: MessageLocationSchema.optional(),
    }),
    z.object({
      type: z.literal("dm"),
      recipientUserId: IdSchema,
      body: MessageCreateBodySchema,
      attachments: MessageAttachmentsSchema.optional(),
      location: MessageLocationSchema.optional(),
    }),
    z.object({
      type: z.literal("reaction"),
      targetMessageId: IdSchema,
      reaction: z.string().min(1).max(64),
    }),
  ])
  // A message needs text, at least one attachment, or a shared location (any one alone is valid).
  .superRefine((value, ctx) => {
    if (value.type !== "reaction" && !value.body.trim() && !value.attachments?.length && !value.location) {
      ctx.addIssue({ code: "custom", message: "Message body cannot be empty", path: ["body"] });
    }
  });
export type MessageCreateRequest = z.infer<typeof MessageCreateRequestSchema>;

/** Author request to edit a body-bearing message (channel post/reply or DM). */
export const MessageEditRequestSchema = z.object({
  body: MessageCreateBodySchema.refine((body) => body.trim().length > 0, {
    message: "Message body cannot be empty",
  }),
});
export type MessageEditRequest = z.infer<typeof MessageEditRequestSchema>;

export const ChannelPostMessageSchema = BaseMessageSchema.extend({
  type: z.literal("channelPost"),
  channelId: IdSchema,
  body: MessageBodySchema,
  attachments: MessageAttachmentsSchema.optional(),
  location: MessageLocationSchema.optional(),
});
export type ChannelPostMessage = z.infer<typeof ChannelPostMessageSchema>;

export const ChannelReplyMessageSchema = BaseMessageSchema.extend({
  type: z.literal("channelReply"),
  channelId: IdSchema,
  parentMessageId: IdSchema,
  body: MessageBodySchema,
  attachments: MessageAttachmentsSchema.optional(),
  location: MessageLocationSchema.optional(),
});
export type ChannelReplyMessage = z.infer<typeof ChannelReplyMessageSchema>;

export const DirectMessageSchema = BaseMessageSchema.extend({
  type: z.literal("dm"),
  recipientUserId: IdSchema,
  body: MessageBodySchema,
  attachments: MessageAttachmentsSchema.optional(),
  location: MessageLocationSchema.optional(),
});
export type DirectMessage = z.infer<typeof DirectMessageSchema>;

export const ReactionMessageSchema = BaseMessageSchema.extend({
  type: z.literal("reaction"),
  targetMessageId: IdSchema,
  reaction: z.string().min(1).max(64),
});
export type ReactionMessage = z.infer<typeof ReactionMessageSchema>;

/**
 * A **sealed mailbox** message (opportunistic-mesh / DTN — docs/16). End-to-end encrypted to a single
 * recipient's key so intermediaries carry it as opaque bytes: `authorId` is the neutral sentinel
 * `"mesh.sealed"` (the real sender is authenticated *inside* the ciphertext), `toTag` is the routing
 * tag a recipient recognises, `sealed` is the base64url AEAD blob, and `ttlExpiresAt` / `hopLimit`
 * bound how far and how long it propagates. Only the recipient node can open it; the whole surface is
 * gated on `mesh.enabled`.
 */
export const SealedMessageSchema = BaseMessageSchema.extend({
  type: z.literal("sealed"),
  toTag: z.string().min(1).max(64),
  sealed: z.string().min(1).max(90_000),
  ttlExpiresAt: TimestampSchema,
  hopLimit: z.number().int().min(0).max(16),
});
export type SealedMessage = z.infer<typeof SealedMessageSchema>;

export const MessageSchema = z.discriminatedUnion("type", [
  ChannelPostMessageSchema,
  ChannelReplyMessageSchema,
  DirectMessageSchema,
  ReactionMessageSchema,
  SealedMessageSchema,
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
  /**
   * Sealed mailbox mail on offer (opportunistic-mesh — docs/16). Present only when the node has
   * `mesh.enabled`; omitted otherwise, so a mixed-version / mesh-off peer's digest is unchanged and
   * the public-data flow is byte-identical to today. Sealed blobs are never edited, so no `editedAt`;
   * the tag/TTL/hop are advertised up front so a puller decides relevance + relay-worthiness before
   * fetching the bytes.
   */
  sealed: z
    .array(
      z.object({
        id: IdSchema,
        toTag: z.string().min(1).max(64),
        ttlExpiresAt: TimestampSchema,
        hopLimit: z.number().int().min(0).max(16),
      }),
    )
    .optional(),
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

/**
 * A shareable **mesh identity card** (opportunistic-mesh — docs/16): everything a peer needs to seal
 * mail to this identity. Unlike the public `identityKey` synced on a user record, the card ALSO carries
 * the secret `mailboxToken` (used to derive the recipient's rotating routing tag), so it must be
 * exchanged deliberately — shown as a QR / copied string and added by the recipient — never broadcast.
 * `GET /api/mesh/identity` returns your own card; `POST /api/mesh/contacts` accepts one. `meshId`
 * self-certifies `sign` (`meshId = base32(hash(sign))`) and `kxSig` binds `kx` to `sign`, so a forged
 * card can't impersonate an identity: both are re-verified server-side before a contact is stored.
 */
const Base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/, "must be base64url");
export const MeshIdentityCardSchema = z.object({
  meshId: z.string().min(1).max(64),
  alg: z.literal("ed25519"),
  // The key fields must be well-formed base64url: the server feeds them straight to the crypto
  // (`meshIdFromSignPublic`, `mailboxTag`), whose base64url decoder throws on any other character —
  // so rejecting malformed input here keeps a garbage card a clean 400, never a 500 down the line.
  sign: Base64Url.min(1).max(64),
  kx: Base64Url.min(1).max(64),
  kxSig: Base64Url.min(1).max(128),
  mailboxToken: Base64Url.min(1).max(64),
  displayName: z.string().min(1).max(80).optional(),
});
export type MeshIdentityCard = z.infer<typeof MeshIdentityCardSchema>;

/** One entry in a local user's mesh address book (`GET /api/mesh/contacts`) — never exposes secrets. */
export const MeshContactSchema = z.object({
  meshId: z.string().min(1).max(64),
  displayName: z.string().min(1).max(80).optional(),
});
export type MeshContact = z.infer<typeof MeshContactSchema>;

/**
 * Client request to send a sealed mailbox message (opportunistic-mesh — docs/16) to a **contact** the
 * sender has already added (via a mesh identity card). Addressed by the recipient's self-certifying
 * `mesh.` id, the server seals it to that contact's key and lets the sync layer carry it; only the
 * recipient's home node can open it. The recipient reads it as an ordinary DM once delivered.
 */
export const MeshSendRequestSchema = z.object({
  toMeshId: z.string().min(1).max(64),
  body: z.string().min(1).max(8000),
});
export type MeshSendRequest = z.infer<typeof MeshSendRequestSchema>;

/**
 * Client request to broadcast ONE sealed mailbox message to MULTIPLE contacts (group/broadcast
 * fan-out, opportunistic-mesh — docs/16) in a single call. Each recipient gets an independently
 * sealed copy (no shared key), so per-recipient confidentiality/unlinkability is identical to
 * `MeshSendRequestSchema` — this is purely a client-convenience batch over the same one-to-one send.
 */
export const MeshBroadcastRequestSchema = z.object({
  toMeshIds: z.array(z.string().min(1).max(64)).min(1).max(50),
  body: z.string().min(1).max(8000),
});
export type MeshBroadcastRequest = z.infer<typeof MeshBroadcastRequestSchema>;

/** Live per-peer sync bookkeeping, as reported by `GET /api/admin/sync`. */
export const SyncPeerStatusSchema = z.object({
  lastAttemptAt: TimestampSchema.optional(),
  lastSuccessAt: TimestampSchema.optional(),
  lastError: z.string().optional(),
  imported: z.number().int().nonnegative(),
});
export type SyncPeerStatus = z.infer<typeof SyncPeerStatusSchema>;

export const SyncStatusReportSchema = z.object({
  enabled: z.boolean(),
  intervalMs: z.number().int().positive(),
  peers: z.array(SyncPeerSchema.extend({ status: SyncPeerStatusSchema.optional() })),
});
export type SyncStatusReport = z.infer<typeof SyncStatusReportSchema>;

/**
 * Stable snake_case code for every error message the server can return (`apps/server/src/app.ts`
 * `ERROR_CODES`). This is the canonical list: the server's `ERROR_CODES` map is typed against
 * `ServerErrorCode` (so a value that doesn't appear here fails to compile), and the client i18n
 * completeness test (`apps/client/src/i18n/i18n.test.ts`) asserts every catalog covers exactly
 * this set — so a new code can't ship untranslated without also failing the client build.
 */
export const SERVER_ERROR_CODES = [
  "admin_required",
  "admin_claim_disabled",
  "admin_user_edit_disabled",
  "promote_requires_active",
  "attachment_not_found",
  "attachment_too_large",
  "attachment_type_mismatch",
  "attachments_disabled",
  "avatar_not_found",
  "avatar_too_large",
  "avatar_type_mismatch",
  "roles_admin_immutable",
  "reaction_not_allowed",
  "channel_not_found",
  "channel_posting_disabled",
  "channel_create_disabled",
  "confirmation_required",
  "dms_disabled",
  "sync_requires_peer",
  "greeter_required",
  "invalid_admin_claim",
  "invalid_admin_secret",
  "invalid_attachment_upload",
  "invalid_avatar_upload",
  "invalid_channel_create",
  "invalid_channel_update",
  "invalid_config_update",
  "invalid_config_values",
  "invalid_kill_switch",
  "invalid_member_request",
  "invalid_transfer_request",
  "invalid_message_edit",
  "invalid_message_request",
  "invalid_moderation_request",
  "invalid_request",
  "invalid_roles_update",
  "invalid_sync_request",
  "invalid_token",
  "invalid_user_update",
  "message_not_found",
  "moderator_required",
  "not_found",
  "deny_requires_pending",
  "admin_humans_only",
  "member_list_private_only",
  "channel_change_forbidden",
  "member_invite_forbidden",
  "member_remove_forbidden",
  "channel_transfer_forbidden",
  "parent_wrong_channel",
  "parent_not_found",
  "private_channels_disabled",
  "search_query_required",
  "reactions_disabled",
  "reaction_not_editable",
  "recipient_not_found",
  "replies_disabled",
  "target_not_found",
  "user_removed",
  "not_channel_member",
  "owner_not_removable",
  "kill_switch_disabled",
  "passphrase_required",
  "message_streaming",
  "session_invalid",
  "thread_has_replies",
  "too_many_attempts",
  "too_many_claim_attempts",
  "message_create_failed",
  "websocket_unauthenticated",
  "unknown_attachment",
  "user_avatar_upload_disabled",
  "user_not_found",
  "user_profile_edit_disabled",
  "delete_own_only",
  "edit_own_only",
  "deny_forbidden",
  "moderate_forbidden",
  "removed_from_node",
  "awaiting_approval",
  "channel_archived",
  "channel_replies_disabled",
  "channel_owner_post_only",
  "channel_admins_post_only",
] as const;
export type ServerErrorCode = (typeof SERVER_ERROR_CODES)[number];

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
