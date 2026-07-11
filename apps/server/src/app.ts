import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { generateDisplayName } from "@loam/display-name";
import {
  AdminClaimRequestSchema,
  AttachmentUploadRequestSchema,
  AvatarImageUploadRequestSchema,
  ChannelCreateRequestSchema,
  ChannelMemberAddRequestSchema,
  ChannelTransferRequestSchema,
  ChannelSchema,
  ChannelUpdateRequestSchema,
  KillSwitchRequestSchema,
  LoamConfigSchema,
  LoamConfigUpdateSchema,
  MessageCreateRequestSchema,
  MessageEditRequestSchema,
  MessageSchema,
  ModerationUpdateRequestSchema,
  PanicRequestSchema,
  RolesUpdateRequestSchema,
  securityProfilePreset,
  SyncDigestSchema,
  SyncMessagesRequestSchema,
  SyncMessagesResponseSchema,
  UserSchema,
  UserUpdateRequestSchema,
  type AvatarImageMimeType,
  type Channel,
  type ChannelCreateRequest,
  type ChannelUpdateRequest,
  type LoamConfig,
  type LoamConfigUpdate,
  type Message,
  type MessageAttachment,
  type MessageCreateRequest,
  type NetworkConfig,
  type OllamaConfig,
  type StreamEvent,
  type SyncDigest,
  type SyncPeer,
  type SyncStatusReport,
  type User,
  type UserUpdateRequest,
} from "@loam/schema";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import { importLegacyJsonData, openStore, type LoamStore, type StoreDriver } from "./db.js";

type SocketClient = {
  OPEN: number;
  readyState: number;
  send: (payload: string) => void;
  close: () => void;
  on: (event: "close", listener: () => void) => void;
};
type SocketSession = {
  socket: SocketClient;
  userId: string;
};

type AppData = {
  users: User[];
  channels: Channel[];
  messages: Message[];
};

type ClientEvent =
  | {
      type: "messageCreated";
      message: Message;
    }
  | {
      type: "messageUpdated";
      message: Message;
    }
  | {
      type: "messageDeleted";
      messageId: string;
      message: Message;
    }
  | {
      type: "userUpserted";
      user: User;
    }
  | {
      type: "channelUpserted";
      channel: Channel;
    }
  | {
      type: "channelRemoved";
      channelId: string;
    }
  | {
      type: "presence";
      onlineUserIds: string[];
    }
  | {
      type: "configUpdated";
      networkConfig: NetworkConfig;
    }
  | {
      type: "wipe";
    };

export type AppOptions = {
  /** Directory holding the SQLite DB, avatars, and (by default) config.json. */
  dataDir: string;
  /** Config file path; defaults to `<dataDir>/config.json`. */
  configPath?: string;
  /** Built client directory to serve statically; skipped when absent. */
  clientDistDir?: string;
  /** Host used in the join URL returned by /api/config. */
  joinHost?: string;
  /** Port used in the join URL returned by /api/config. */
  clientPort?: number;
  /** When set, encrypt the database at rest (SQLCipher). Requires a real data dir, not in-memory. */
  dbEncryptionKey?: string;
  /**
   * Encrypt at rest with a **random, RAM-only key** generated at startup and never written to disk
   * (takes precedence over `dbEncryptionKey`). Data is readable only while this process runs — a
   * reboot loses the key permanently — and the kill switch rotates to a fresh key so any
   * flash-recoverable ciphertext becomes unreadable. See `docs/02-kill-switch.md`.
   */
  ephemeralDbKey?: boolean;
  /**
   * Plaintext SQLite backend to use when no encryption key is set. Defaults to `node:sqlite`; the
   * Android host passes `"better-sqlite3"` because its embedded Node 18 lacks `node:sqlite`
   * (see `apps/server/src/db.ts` and docs/04). Ignored when a DB key is set (SQLCipher is used).
   */
  dbDriver?: StoreDriver;
  /** Node version string shown to clients (via `/api/config`). Defaults to `"dev"`. */
  version?: string;
  /**
   * Cap on how many *new* anonymous identities a single client IP may mint within
   * `identityWindowMs`, bounding the user-row/session growth an attacker can force by discarding its
   * session cookie and re-requesting. A device that keeps its cookie mints once and is unaffected; on
   * a LAN each device has its own IP, so this is effectively per-device. Defaults to 60.
   */
  maxNewIdentitiesPerWindow?: number;
  /** Sliding window (ms) for `maxNewIdentitiesPerWindow`. Defaults to 10 minutes. */
  identityWindowMs?: number;
  logger?: boolean;
};

/**
 * Thrown by `getSessionUserId` when a client IP exceeds its new-identity budget. The `statusCode`
 * makes Fastify's default error handler answer `429 Too Many Requests` without a custom handler.
 */
class IdentityLimitError extends Error {
  readonly statusCode = 429;
  constructor() {
    super("Too many new identities from this address");
    this.name = "IdentityLimitError";
  }
}

export type LoamApp = {
  server: FastifyInstance;
  store: LoamStore;
  /** One-time admin claim code, present when bootstrap is `setupCode` and no admin exists yet. */
  adminSetupCode?: string;
  /** Delete messages older than the configured retention TTL now (also runs on a timer). */
  reapExpiredMessages(): void;
  /** Delete unreferenced/abandoned attachment files now (also runs on the reaper timer). */
  reapOrphanedAttachments(): Promise<void>;
  close(): Promise<void>;
};

const sessionCookieName = "loam_session";
const sessionCookieMaxAge = 60 * 60 * 24 * 365;
const defaultChannelCreatedAt = 1_704_067_200_000;
const claimAttemptLimit = 5;
const claimAttemptWindowMs = 5 * 60_000;

const defaultChannels: Channel[] = [
  {
    id: "announcements",
    name: "Announcements",
    description: "Local broadcast notes and coordination updates.",
    visibility: "public",
    allowPosting: "everyone",
    allowReplies: true,
    discoverable: true,
    createdAt: defaultChannelCreatedAt,
  },
  {
    id: "general",
    name: "General",
    description: "Open room for everyone on this local LOAM node.",
    visibility: "public",
    allowPosting: "everyone",
    allowReplies: true,
    discoverable: true,
    createdAt: defaultChannelCreatedAt,
  },
];

const seedUsers = ["user.1234", "user.5678"];

/**
 * Stable snake_case code for every error message the server can return, so clients can localize the
 * message from a catalog while the English `error` string stays as the fallback (unknown codes → the
 * client shows `error` verbatim). Keep these codes stable across releases — they are a wire contract
 * with a mixed-version mesh. Every value must have a matching `error.<code>` key in the client i18n
 * catalogs (enforced by `apps/client/src/i18n/i18n.test.ts`).
 */
const ERROR_CODES: Record<string, string> = {
  "Admin access required": "admin_required",
  "Admin claiming is not enabled on this LOAM node": "admin_claim_disabled",
  "Admin user editing is disabled on this LOAM node": "admin_user_edit_disabled",
  "Approve or unban this user before promoting them": "promote_requires_active",
  "Attachment does not exist": "attachment_not_found",
  "Attachment image must be 256KB or smaller": "attachment_too_large",
  "Attachment image type does not match the uploaded data": "attachment_type_mismatch",
  "Attachments are disabled on this LOAM node": "attachments_disabled",
  "Avatar image does not exist": "avatar_not_found",
  "Avatar image must be 128KB or smaller": "avatar_too_large",
  "Avatar image type does not match the uploaded data": "avatar_type_mismatch",
  "Cannot change the roles of an admin": "roles_admin_immutable",
  "Cannot react to this message": "reaction_not_allowed",
  "Channel does not exist": "channel_not_found",
  "Channel posting is disabled on this LOAM node": "channel_posting_disabled",
  "Creating channels is disabled on this LOAM node": "channel_create_disabled",
  'Confirmation required: send { "confirm": "wipe" }': "confirmation_required",
  "Direct messages are disabled on this LOAM node": "dms_disabled",
  "Enable sync and add at least one peer first": "sync_requires_peer",
  "Greeter access required": "greeter_required",
  "Invalid admin claim request": "invalid_admin_claim",
  "Invalid admin secret": "invalid_admin_secret",
  "Invalid attachment upload request": "invalid_attachment_upload",
  "Invalid avatar image upload request": "invalid_avatar_upload",
  "Invalid channel create request": "invalid_channel_create",
  "Invalid channel update request": "invalid_channel_update",
  "Invalid config update request": "invalid_config_update",
  "Invalid config values": "invalid_config_values",
  "Invalid kill-switch request": "invalid_kill_switch",
  "Invalid member request": "invalid_member_request",
  "Invalid message edit request": "invalid_message_edit",
  "Invalid message request": "invalid_message_request",
  "Invalid moderation request": "invalid_moderation_request",
  "Invalid request": "invalid_request",
  "Invalid roles update request": "invalid_roles_update",
  "Invalid sync request": "invalid_sync_request",
  "Invalid token": "invalid_token",
  "Invalid user update request": "invalid_user_update",
  "Message does not exist": "message_not_found",
  "Moderator access required": "moderator_required",
  "Not found": "not_found",
  "Only pending users can be denied": "deny_requires_pending",
  "Only people can be admins": "admin_humans_only",
  "Only private channels have a member list": "member_list_private_only",
  "Only the channel owner or an admin can change this channel": "channel_change_forbidden",
  "Only the channel owner or an admin can invite members": "member_invite_forbidden",
  "Only the channel owner or an admin can remove members": "member_remove_forbidden",
  "Only the channel owner or an admin can transfer ownership": "channel_transfer_forbidden",
  "Parent message belongs to a different channel": "parent_wrong_channel",
  "Parent message does not exist": "parent_not_found",
  "Private channels are disabled on this LOAM node": "private_channels_disabled",
  "Provide a search query (?q=)": "search_query_required",
  "Reactions are disabled on this LOAM node": "reactions_disabled",
  "Reactions cannot be edited": "reaction_not_editable",
  "Recipient user does not exist": "recipient_not_found",
  "Replies are disabled on this LOAM node": "replies_disabled",
  "Target message does not exist": "target_not_found",
  "That user has been removed from this node": "user_removed",
  "That user is not a member of this channel": "not_channel_member",
  "The channel owner cannot be removed from their own channel": "owner_not_removable",
  "The kill switch is not enabled on this LOAM node": "kill_switch_disabled",
  "The passphrase bootstrap strategy requires a passphrase": "passphrase_required",
  "This message is still being written": "message_streaming",
  "This session is no longer valid": "session_invalid",
  "This thread has replies from other people — only an admin can delete it": "thread_has_replies",
  "Too many attempts": "too_many_attempts",
  "Too many claim attempts; try again later": "too_many_claim_attempts",
  "Unable to create message": "message_create_failed",
  "Unauthenticated websocket": "websocket_unauthenticated",
  "Unknown attachment": "unknown_attachment",
  "User avatar uploads are disabled on this LOAM node": "user_avatar_upload_disabled",
  "User does not exist": "user_not_found",
  "User profile editing is disabled on this LOAM node": "user_profile_edit_disabled",
  "You can only delete your own messages": "delete_own_only",
  "You can only edit your own messages": "edit_own_only",
  "You cannot deny an admin or yourself": "deny_forbidden",
  "You cannot moderate an admin or yourself": "moderate_forbidden",
  // Participation gate (banned/pending) and channel-posting policy — these are returned via
  // participationError()/channelPostingError() and must localize like every other error.
  "You have been removed from this node": "removed_from_node",
  "Your join is awaiting approval": "awaiting_approval",
  "Channel is archived": "channel_archived",
  "Replies are disabled in this channel": "channel_replies_disabled",
  "Only the channel owner can post in this channel": "channel_owner_post_only",
  "Only admins can post in this channel": "channel_admins_post_only",
};

/** All stable error codes, exported so tests can assert client-catalog coverage. */
export const ALL_ERROR_CODES: readonly string[] = Object.values(ERROR_CODES);

/**
 * Build an error response envelope, attaching the stable `code` for known messages. Unknown messages
 * carry no code, so the client falls back to the English `error` string. The `error` field is always
 * present and unchanged, so existing clients keep working.
 */
function errorBody(message: string | undefined): { error: string; code?: string } {
  const text = message ?? "Unknown error";
  const code = ERROR_CODES[text];
  return code ? { error: text, code } : { error: text };
}

/**
 * Create the default LOAM configuration: conservative identity permissions, all core messaging
 * features on, Ollama disabled, `firstUser` admin bootstrap, and the `standard` security profile.
 */
export function defaultLoamConfig(): LoamConfig {
  return {
    node: {
      name: "LOAM local",
      locale: "en",
    },
    identity: {
      allowUserDisplayNameEdit: false,
      allowUserAvatarEdit: false,
      allowUserAvatarUpload: false,
      allowAdminUserEdit: true,
    },
    features: {
      enablePublicChannels: true,
      enablePrivateChannels: true,
      enableUserChannels: true,
      enableReplies: true,
      enableDMs: true,
      enableReactions: true,
      enableMarkdown: true,
      enableAttachments: true,
      enablePresence: true,
    },
    llm: {
      ollama: {
        enabled: false,
        baseUrl: "http://localhost:11434",
        model: "gemma4",
        botId: "llm.ollama.gemma4",
        botDisplayName: "Gemma",
      },
    },
    admin: {
      bootstrap: "firstUser",
    },
    killSwitch: {
      enabled: false,
      requireConfirmation: true,
    },
    retention: {},
    security: {
      // Default to `custom` (individual axes, no forcing) so a fresh node behaves exactly as its raw
      // defaults and an operator can set join/retention/kill-switch directly without a named profile
      // silently overriding them. Selecting open/standard/hardened opts into the coherent bundle.
      profile: "custom",
    },
    access: {
      joinPolicy: "open",
    },
    sync: {
      enabled: false,
      peers: [],
      intervalMs: 30_000,
    },
  };
}

/**
 * Checks whether a value is a non-null object that is not an array.
 *
 * @param value - The value to test
 * @returns `true` if `value` is a non-null object and not an array, `false` otherwise.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Merge a partial config update onto a base config, normalising clearable string fields
 * (empty `systemPrompt`/`passphrase` become unset) and validating the result.
 *
 * @param base - The current full configuration
 * @param update - A validated partial update
 * @returns The merged, schema-validated configuration
 */
function mergeConfig(base: LoamConfig, update: LoamConfigUpdate): LoamConfig {
  const merged = {
    node: { ...base.node, ...update.node },
    identity: { ...base.identity, ...update.identity },
    features: { ...base.features, ...update.features },
    llm: { ollama: { ...base.llm.ollama, ...update.llm?.ollama } },
    admin: { ...base.admin, ...update.admin },
    killSwitch: { ...base.killSwitch, ...update.killSwitch },
    retention: { ...base.retention, ...update.retention },
    security: { ...base.security, ...update.security },
    access: { ...base.access, ...update.access },
    sync: { ...base.sync, ...update.sync },
  };
  const systemPrompt = merged.llm.ollama.systemPrompt?.trim();
  merged.llm.ollama.systemPrompt = systemPrompt || undefined;

  // Secrets are stored scrypt-hashed, never in the clear; plaintext arriving from a config file or
  // an admin update is hashed here (already-hashed values pass through unchanged).
  const passphrase = merged.admin.passphrase?.trim();
  merged.admin.passphrase = passphrase ? (isHashedSecret(passphrase) ? passphrase : hashSecret(passphrase)) : undefined;
  const panicToken = merged.killSwitch.panicToken?.trim();
  merged.killSwitch.panicToken = panicToken
    ? isHashedSecret(panicToken)
      ? panicToken
      : hashSecret(panicToken)
    : undefined;

  merged.retention.messageTtlMs = merged.retention.messageTtlMs ?? undefined;

  // The sync token is a bearer secret the node must transmit to peers, so it's stored in the clear
  // (not hashed like the passphrase/panic token). An empty string clears it back to open sync.
  const syncToken = merged.sync.token?.trim();
  merged.sync.token = syncToken || undefined;

  // A named security profile (anything but `custom`) is authoritative for the axes it bundles: force
  // them onto the effective config so the profile actually drives behaviour and can't be silently
  // contradicted by a stale or hand-edited individual axis. `custom` leaves the raw axes untouched.
  const preset = securityProfilePreset(merged.security.profile);
  if (preset) {
    merged.access.joinPolicy = preset.joinPolicy;
    merged.retention.messageTtlMs = preset.messageTtlMs ?? undefined;
    merged.killSwitch.enabled = preset.killSwitchEnabled;
  }

  return LoamConfigSchema.parse(merged);
}

/**
 * One-time migration for configs written before the security profile became authoritative. Back then
 * the profile was inert, so an operator could arm the kill switch, set a message TTL, or require
 * approval while the profile sat at its `standard` default. Now a named profile *forces* those axes,
 * which could silently undo such settings — including disarming a kill switch. If a persisted update
 * pins a non-`custom` profile yet also carries a bundled axis that diverges from what the profile
 * would force, we preserve the operator's explicit intent by switching the profile to `custom`.
 *
 * @returns the (possibly rewritten) update and whether it was changed, so the caller can re-persist.
 */
function reconcileLegacyProfile(update: LoamConfigUpdate): { update: LoamConfigUpdate; changed: boolean } {
  const preset = update.security?.profile ? securityProfilePreset(update.security.profile) : null;
  if (!preset) {
    return { update, changed: false };
  }
  const killSwitchDiverges =
    update.killSwitch?.enabled !== undefined && update.killSwitch.enabled !== preset.killSwitchEnabled;
  const joinDiverges =
    update.access?.joinPolicy !== undefined && update.access.joinPolicy !== preset.joinPolicy;
  const ttl = update.retention?.messageTtlMs;
  const ttlDiverges = ttl !== undefined && (ttl ?? null) !== preset.messageTtlMs;

  if (killSwitchDiverges || joinDiverges || ttlDiverges) {
    return { update: { ...update, security: { ...update.security, profile: "custom" } }, changed: true };
  }
  return { update, changed: false };
}

const secretHashPrefix = "scrypt:";
const secretHashPattern = /^scrypt:[0-9a-f]{32}:[0-9a-f]{64}$/;
const secretCompareLength = 256;

/**
 * Compare two short secrets in constant time by padding both to a fixed length. Suitable only for
 * high-entropy, memory-only values (the one-time setup code) — stored secrets use scrypt instead.
 */
function timingSafeEqualStrings(left: string, right: string): boolean {
  const leftPadded = Buffer.alloc(secretCompareLength);
  const rightPadded = Buffer.alloc(secretCompareLength);
  Buffer.from(left).copy(leftPadded);
  Buffer.from(right).copy(rightPadded);
  return timingSafeEqual(leftPadded, rightPadded) && left.length === right.length;
}

/**
 * Hash a user-chosen secret (admin passphrase / panic token) for storage, so a seized node's
 * config never reveals the secret itself.
 *
 * @returns A self-describing `scrypt:<salt-hex>:<hash-hex>` string
 */
function hashSecret(secret: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(secret, salt, 32);
  return `${secretHashPrefix}${salt.toString("hex")}:${hash.toString("hex")}`;
}

function isHashedSecret(value: string): boolean {
  // Match the full format, not just the prefix — a malformed "scrypt:…" value is treated as a
  // plaintext secret and hashed, rather than stored unverifiable.
  return secretHashPattern.test(value);
}

/**
 * Verify a candidate secret against a stored `scrypt:` hash in constant time.
 */
function verifySecret(candidate: string, stored: string): boolean {
  if (!isHashedSecret(stored)) {
    return timingSafeEqualStrings(candidate, stored);
  }

  const [saltHex = "", hashHex = ""] = stored.slice(secretHashPrefix.length).split(":");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(candidate, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

/**
 * Create a human user record with a generated display name and creation timestamp.
 *
 * @param id - The unique user identifier
 * @param isAdmin - Whether the user has administrative privileges
 * @param pending - Whether the user is awaiting approval (approval join policy); omitted when false
 * @returns A validated `User` object constructed from the provided values
 */
function makeUser(id: string, isAdmin = false, pending = false): User {
  return UserSchema.parse({
    id,
    displayName: generateDisplayName(id),
    type: "human",
    isAdmin,
    createdAt: Date.now(),
    ephemeral: false,
    ...(pending ? { pending: true } : {}),
  });
}

/**
 * Create a User record representing the configured Ollama bot.
 *
 * @param config - Ollama integration config containing the bot identifiers and display name
 * @returns A `User` object for the bot with `type: "bot"`, `isAdmin: false`, a patterned avatar seeded from the bot ID, and the current timestamp as `createdAt`
 */
function makeBotUser(config: OllamaConfig): User {
  return UserSchema.parse({
    id: config.botId,
    displayName: config.botDisplayName,
    avatar: {
      seed: config.botId,
      mode: "pattern",
    },
    type: "bot",
    isAdmin: false,
    createdAt: Date.now(),
    ephemeral: false,
  });
}

/**
 * Create a new user identifier for an anonymous session.
 *
 * @returns A string of the form `user.<8hex>` where the suffix is the first 8 hexadecimal characters of a UUID with dashes removed.
 */
function makeSessionUserId(): string {
  return `user.${randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

function makeSessionToken(): string {
  return randomUUID();
}

function makeAdminSetupCode(): string {
  return randomUUID().replaceAll("-", "").slice(0, 12);
}

function encodeCookieValue(value: string): string {
  return encodeURIComponent(value);
}

function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  for (const cookie of cookieHeader?.split(";") ?? []) {
    const [rawName, ...rawValue] = cookie.trim().split("=");

    if (rawName !== name) {
      continue;
    }

    try {
      return decodeURIComponent(rawValue.join("="));
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/**
 * Generates a new unique avatar image identifier.
 *
 * @returns A string in the form `avt_<16-hex-chars>` suitable for use as an avatar image filename base
 */
function newAvatarImageId(): string {
  return `avt_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function newAttachmentId(): string {
  return `att_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

/** Filename an attachment is stored (and served) under: `att_<16hex>.<ext>`. */
function attachmentFileName(attachment: Pick<MessageAttachment, "id" | "mimeType">): string {
  return `${attachment.id}.${avatarImageExtension(attachment.mimeType)}`;
}

/** Parses an attachment filename (`att_<16hex>.<ext>`) into its id and MIME type. */
function parseAttachmentFileName(value: string): { id: string; mimeType: AvatarImageMimeType } | undefined {
  const match = value.match(/^(att_[a-f0-9]{16})\.(png|jpg|webp)$/);

  if (!match) {
    return undefined;
  }

  const extension = match[2];
  const mimeType =
    extension === "png" ? "image/png" : extension === "jpg" ? "image/jpeg" : "image/webp";

  return { id: match[1] ?? "", mimeType };
}

const attachmentMaxBytes = 256 * 1024;

/**
 * Map an avatar image MIME type to its canonical file extension.
 *
 * @param mimeType - The avatar image MIME type
 * @returns The corresponding file extension: `png` for `image/png`, `jpg` for `image/jpeg`, otherwise `webp`
 */
function avatarImageExtension(mimeType: AvatarImageMimeType): string {
  if (mimeType === "image/png") {
    return "png";
  }

  if (mimeType === "image/jpeg") {
    return "jpg";
  }

  return "webp";
}

/**
 * Parses an avatar filename into its image ID and MIME type.
 *
 * @param value - Avatar filename expected in the form `avt_<16-hex>.<ext>` where `<ext>` is `png`, `jpg`, or `webp`
 * @returns An object with `imageId` and `mimeType` when `value` matches the expected pattern, `undefined` otherwise
 */
function parseAvatarImageId(value: string): { imageId: string; mimeType: AvatarImageMimeType } | undefined {
  const match = value.match(/^(avt_[a-f0-9]{16})\.(png|jpg|webp)$/);

  if (!match) {
    return undefined;
  }

  const extension = match[2];
  const mimeType =
    extension === "png" ? "image/png" : extension === "jpg" ? "image/jpeg" : "image/webp";

  return {
    imageId: match[1] ?? "",
    mimeType,
  };
}

/**
 * Checks that a binary image buffer matches the expected file signature for the provided MIME type.
 *
 * Supports `image/png`, `image/jpeg`, and `image/webp`.
 *
 * @param buffer - The image file data to inspect
 * @param mimeType - The expected MIME type of the image
 * @returns `true` if the buffer's file signature matches the expected MIME type, `false` otherwise
 */
function avatarImageHasExpectedSignature(buffer: Buffer, mimeType: AvatarImageMimeType): boolean {
  if (mimeType === "image/png") {
    return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }

  if (mimeType === "image/jpeg") {
    return (
      buffer.length >= 4 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[buffer.length - 2] === 0xff &&
      buffer[buffer.length - 1] === 0xd9
    );
  }

  return buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
}

function isChannelMessage(message: Message, channelId: string): boolean {
  return (
    (message.type === "channelPost" || message.type === "channelReply") &&
    message.channelId === channelId
  );
}

function newMessageId(prefix = "msg"): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

/**
 * Build the LOAM Fastify application: opens the SQLite store, loads config (defaults ← config
 * file ← DB-persisted admin edits) and data, and registers every route. The caller owns
 * listening and shutdown (`close()`).
 *
 * @param options - Paths and join-URL settings; only `dataDir` is required
 * @returns The app handle with the Fastify instance, the store, and the one-time admin setup code when applicable
 */
export async function buildApp(options: AppOptions): Promise<LoamApp> {
  const dataDir = options.dataDir;
  const avatarsDir = join(dataDir, "avatars");
  const attachmentsDir = join(dataDir, "attachments");
  const configPath = options.configPath ?? join(dataDir, "config.json");
  const joinHost = options.joinHost ?? "localhost";
  const clientPort = options.clientPort ?? 3000;

  const server = Fastify({
    logger: options.logger ?? true,
    serverFactory: (handler) => createServer(handler),
  });
  const sockets = new Set<SocketSession>();
  const sessions = new Map<string, string>();
  const claimAttempts = new Map<string, { count: number; resetAt: number }>();
  const panicAttempts = new Map<string, { count: number; resetAt: number }>();
  // Per-IP new-identity budget (RAM-only): bounds how many fresh anonymous users one address can mint
  // per window, so a client discarding its cookie can't grow the user table without limit. Pruned on
  // the reaper timer. On a LAN each device gets its own IP, so this reads as per-device.
  const identityMintCounters = new Map<string, { count: number; resetAt: number }>();
  const maxNewIdentitiesPerWindow = options.maxNewIdentitiesPerWindow ?? 60;
  const identityWindowMs = options.identityWindowMs ?? 10 * 60_000;
  // Uploaded-but-unattached attachment ids → uploader + upload time. A message may only reference
  // the uploader's own pending uploads; each id is consumed on first use. RAM-only: entries a
  // restart loses (and uploads abandoned past the grace period) are swept by
  // reapOrphanedAttachments, so unclaimed files never accumulate on disk.
  const attachmentOwners = new Map<string, { userId: string; uploadedAt: number }>();
  const attachmentPendingGraceMs = 15 * 60_000;
  // Message ids deliberately deleted on this node — node-to-node sync never re-imports these.
  const tombstones = new Set<string>();
  // Per-peer sync bookkeeping for the admin UI (RAM-only).
  type PeerSyncStatus = {
    lastAttemptAt?: number;
    lastSuccessAt?: number;
    lastError?: string;
    imported: number;
  };
  const peerSyncStatus = new Map<string, PeerSyncStatus>();
  let syncRunning = false;
  let lastSyncLoopAt = 0;
  let staticFilesRegistered = false;
  let appConfig: LoamConfig = defaultLoamConfig();
  let adminSetupCode: string | undefined;

  let data: AppData = {
    users: [],
    channels: [],
    messages: [],
  };

  await mkdir(dataDir, { recursive: true });

  const dbPath = join(dataDir, "loam.db");
  const ephemeralDbKey = options.ephemeralDbKey ?? false;
  // The active encryption key. Ephemeral mode generates a random RAM-only key (never persisted);
  // the kill switch rotates it (see executeKillSwitch). A provided key is reused across wipes.
  let dbKey: string | undefined = ephemeralDbKey
    ? randomBytes(32).toString("hex")
    : options.dbEncryptionKey;
  const encryptionEnabled = dbKey !== undefined;

  const openLoamStore = (): LoamStore =>
    openStore(dbPath, { encryptionKey: dbKey, driver: options.dbDriver });
  let store = openLoamStore();

  /**
   * Parse one config layer, tolerating malformed JSON and invalid shapes: both are logged and
   * ignored rather than aborting startup.
   */
  function parseConfigUpdate(raw: string, source: string): LoamConfigUpdate | undefined {
    try {
      const parsed = LoamConfigUpdateSchema.safeParse(JSON.parse(raw));

      if (parsed.success) {
        return parsed.data;
      }
    } catch {
      // Malformed JSON — fall through to the shared warning below.
    }

    server.log.warn(`Ignoring invalid config from ${source}`);
    return undefined;
  }

  /**
   * Load the effective configuration: defaults, overlaid by the config file (when present and
   * valid), overlaid by admin edits persisted in the DB `config` table.
   */
  async function loadAppConfig(): Promise<void> {
    let config = defaultLoamConfig();

    try {
      const raw = await readFile(configPath, "utf8");
      const fileUpdate = parseConfigUpdate(raw, configPath);

      if (fileUpdate) {
        // Same reconciliation as the persisted path: a hand-authored config.json that pins a preset
        // profile *and* sets an explicit kill switch / approval / TTL keeps those explicit settings
        // (effective profile → custom) rather than letting the preset silently override them. The
        // file is the operator's own source, so we don't rewrite it — just resolve it in memory.
        const { update: reconciled, changed } = reconcileLegacyProfile(fileUpdate);
        if (changed) {
          server.log.warn(
            `${configPath} pins a security profile but also sets explicit access/retention/kill-switch values; keeping the explicit settings (effective profile: custom).`,
          );
        }
        config = mergeConfig(config, reconciled);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    const stored = store.getConfigValue("config");

    if (stored) {
      const storedUpdate = parseConfigUpdate(stored, "the persisted config table");

      if (storedUpdate) {
        // Heal configs saved before the profile became authoritative (see reconcileLegacyProfile):
        // preserve an explicitly-armed kill switch / approval / TTL by demoting the profile to custom.
        const { update: reconciled, changed } = reconcileLegacyProfile(storedUpdate);
        config = mergeConfig(config, reconciled);
        if (changed) {
          server.log.warn(
            "Security profile is now authoritative; kept explicit access/retention/kill-switch settings by switching this node's profile to 'custom'.",
          );
          store.setConfigValue("config", JSON.stringify(config));
        }
      }
    }

    appConfig = config;
  }

  function anyAdminExists(): boolean {
    return data.users.some((user) => user.isAdmin);
  }

  /**
   * Consume one unit of a client IP's new-identity budget (fixed window). Returns false once the IP
   * has minted `maxNewIdentitiesPerWindow` identities within `identityWindowMs`; the window then
   * resets on its next expiry. Only reached on a genuine mint (requests with a valid session cookie
   * return earlier), so a well-behaved client that keeps its cookie never touches this.
   */
  function consumeIdentityBudget(ip: string): boolean {
    const now = Date.now();
    const entry = identityMintCounters.get(ip);

    if (!entry || entry.resetAt <= now) {
      identityMintCounters.set(ip, { count: 1, resetAt: now + identityWindowMs });
      return true;
    }

    entry.count += 1;
    return entry.count <= maxNewIdentitiesPerWindow;
  }

  function getSessionUserId(request: FastifyRequest, reply: FastifyReply): string {
    const cookieToken = readCookie(request.headers.cookie, sessionCookieName);
    const cookieUserId = cookieToken ? sessions.get(cookieToken) : undefined;

    if (cookieUserId) {
      return cookieUserId;
    }

    // No valid session — this request will mint a brand-new identity. Bound how fast one address can
    // do that (429) so an attacker can't flood the user table by discarding cookies.
    if (!consumeIdentityBudget(request.ip)) {
      throw new IdentityLimitError();
    }

    const userId = makeSessionUserId();
    const token = makeSessionToken();
    sessions.set(token, userId);
    store.putSession(token, userId);
    // Mark the cookie Secure only when the request actually arrived over TLS. Keying this on
    // NODE_ENV=production instead (as before) breaks sessions on LOAM's documented plain-http LAN
    // deployment: a Secure cookie is dropped by the browser, so every request mints a fresh session
    // and identity never persists. We read `request.protocol` (the real socket protocol) rather
    // than a client-supplied `x-forwarded-proto` header: LOAM runs without `trustProxy` on purpose
    // (so the per-IP rate limiter can't be evaded by a spoofed `x-forwarded-for`), which means a
    // self-hoster terminating TLS at a proxy must enable trustProxy themselves for this to flip.
    const secure = request.protocol === "https";
    const cookie = `${sessionCookieName}=${encodeCookieValue(
      token,
    )}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionCookieMaxAge}${secure ? "; Secure" : ""}`;
    reply.header("set-cookie", cookie);
    return userId;
  }

  function getSessionUserIdFromRequest(request: FastifyRequest): string | undefined {
    const cookieToken = readCookie(request.headers.cookie, sessionCookieName);
    return cookieToken ? sessions.get(cookieToken) : undefined;
  }

  /**
   * Ensures a user with the specified id exists, creating, persisting, and broadcasting a new
   * user when absent.
   *
   * @param id - The unique user id to ensure exists
   * @param isAdmin - If a new user is created, whether they should be marked as an administrator
   * @param pending - If a new user is created, whether they start awaiting approval
   * @returns The existing or newly created User
   */
  function ensureUser(id: string, isAdmin = false, pending = false): User {
    const existing = data.users.find((user) => user.id === id);

    if (existing) {
      return existing;
    }

    // Persist first, then mirror in memory — if the store write throws, nothing diverges.
    const user = makeUser(id, isAdmin, pending);
    store.upsertUser(user);
    data.users.push(user);
    broadcast({ type: "userUpserted", user });
    return user;
  }

  /**
   * Ensure a session-originated user exists, applying the `firstUser` admin bootstrap and the join
   * policy: when `firstUser` is active and no admin exists yet, the first session user created
   * becomes admin; and under the `approval` join policy a newly created non-admin starts `pending`,
   * awaiting a greeter/admin's approval before they can participate. Admins are never pending.
   */
  function ensureSessionUser(id: string): User {
    const isAdmin = appConfig.admin.bootstrap === "firstUser" && !anyAdminExists();
    const pending = !isAdmin && appConfig.access.joinPolicy === "approval";
    return ensureUser(id, isAdmin, pending);
  }

  /**
   * Ensures the configured Ollama bot user exists in the in-memory user store and is up to date.
   *
   * If Ollama is disabled in the current configuration, no changes are made.
   *
   * @returns The bot `User` after creation or update, or `undefined` if Ollama is disabled.
   */
  function ensureOllamaBotUser(): User | undefined {
    if (!appConfig.llm.ollama.enabled) {
      return undefined;
    }

    const existing = data.users.find((user) => user.id === appConfig.llm.ollama.botId);

    if (existing) {
      const parsedExisting = UserSchema.parse(existing);
      const next = UserSchema.parse({
        ...parsedExisting,
        displayName: appConfig.llm.ollama.botDisplayName,
        type: "bot" as const,
        isAdmin: false,
        avatar: parsedExisting.avatar ?? {
          seed: appConfig.llm.ollama.botId,
          mode: "pattern" as const,
        },
      });

      if (JSON.stringify(parsedExisting) !== JSON.stringify(next)) {
        store.upsertUser(next);
        Object.assign(existing, next);
        broadcast({ type: "userUpserted", user: existing });
      }

      return existing;
    }

    const user = makeBotUser(appConfig.llm.ollama);
    store.upsertUser(user);
    data.users.push(user);
    broadcast({ type: "userUpserted", user });
    return user;
  }

  /**
   * Provides the current network configuration reflecting enabled features and identity permissions.
   */
  function currentNetworkConfig(): NetworkConfig {
    return {
      nodeName: appConfig.node.name,
      ...appConfig.features,
      enableLLMChat: appConfig.llm.ollama.enabled,
      enableLLMStreaming: appConfig.llm.ollama.enabled,
      allowUserDisplayNameEdit: appConfig.identity.allowUserDisplayNameEdit,
      allowUserAvatarEdit: appConfig.identity.allowUserAvatarEdit,
      allowUserAvatarUpload: appConfig.identity.allowUserAvatarUpload,
      // Only advertise claiming when a usable secret actually exists (the setup code is
      // single-use, and passphrase mode may have no passphrase configured).
      allowAdminClaim:
        (appConfig.admin.bootstrap === "setupCode" && adminSetupCode !== undefined) ||
        (appConfig.admin.bootstrap === "passphrase" && !!appConfig.admin.passphrase),
      joinPolicy: appConfig.access.joinPolicy,
      securityProfile: appConfig.security.profile,
      locale: appConfig.node.locale,
    };
  }

  /** The effective config as exposed to admins — secret values are never returned. */
  function redactedConfig(): LoamConfig {
    return {
      ...appConfig,
      admin: { ...appConfig.admin, passphrase: undefined },
      killSwitch: { ...appConfig.killSwitch, panicToken: undefined },
    };
  }

  /**
   * Apply validated user update fields to an existing user object.
   *
   * @param user - The existing user object to update (mutated in-place)
   * @param update - Partial update fields for the user; `undefined` avatar preserves existing avatar
   * @returns The mutated and validated `User` object
   */
  function applyUserUpdate(user: User, update: UserUpdateRequest): User {
    const next = UserSchema.parse({
      ...user,
      displayName: update.displayName ?? user.displayName,
      avatar: update.avatar === undefined ? user.avatar : update.avatar,
    });
    store.upsertUser(next);
    Object.assign(user, next);
    broadcast({ type: "userUpserted", user });
    return user;
  }

  /**
   * Whether a user may moderate others (ban / shadow-ban / unban non-admins): admins always can,
   * as can anyone granted the `moderator` role — unless they are themselves banned or pending
   * (a banned moderator's lingering session must not keep its powers).
   */
  function canModerate(user: User): boolean {
    return !user.banned && !user.pending && (user.isAdmin || !!user.roles?.includes("moderator"));
  }

  /**
   * Whether a user may greet newcomers (approve / deny pending users, see the in-client join QR):
   * admins always can, as can anyone granted the `greeter` role. Banned/pending users never can.
   */
  function canGreet(user: User): boolean {
    return !user.banned && !user.pending && (user.isAdmin || !!user.roles?.includes("greeter"));
  }

  /**
   * Why a user may not read or create content on this node: banned users are fully locked out, and
   * under the `approval` join policy a pending user gets nothing until a greeter lets them in
   * (previously only *posting* was gated, so an unapproved or banned session could still read every
   * channel and DM feed over REST). `/api/config` stays open — it is how the client learns it is
   * banned/pending and shows the right screen.
   */
  function participationError(user: User): string | undefined {
    if (user.banned) {
      return "You have been removed from this node";
    }

    if (user.pending) {
      return "Your join is awaiting approval";
    }

    return undefined;
  }

  /**
   * Apply moderation / role state to a user (roles, banned, shadowBanned, pending), re-validating
   * the whole record against the schema, persisting, then broadcasting `userUpserted`. Mirrors
   * `applyUserUpdate`: persist first, then mutate the live object and broadcast, so a failed write
   * never leaves in-memory state or a broadcast ahead of what is stored. Only the provided fields
   * change.
   */
  function applyUserModeration(
    user: User,
    changes: Partial<Pick<User, "roles" | "banned" | "shadowBanned" | "pending">>,
  ): User {
    const next = UserSchema.parse({ ...user, ...changes });
    store.upsertUser(next);
    Object.assign(user, next);
    broadcast({ type: "userUpserted", user });
    return user;
  }

  /**
   * Tear down a user's sessions when they are banned/denied: delete their session tokens from the
   * store and close any live sockets they hold (mirrors how the kill switch tears sessions down,
   * scoped to one user). The in-memory session→user mapping is deliberately kept so the ban stays
   * enforced against that identity — dropping it would re-mint the banned user a fresh, clean id on
   * their next request, silently undoing the ban. The store deletion still invalidates the session
   * durably (it is gone after a restart).
   */
  function invalidateUserSessions(userId: string): void {
    for (const [token, sessionUserId] of sessions) {
      if (sessionUserId === userId) {
        store.deleteSession(token);
      }
    }

    for (const socketSession of [...sockets]) {
      if (socketSession.userId === userId) {
        socketSession.socket.close();
        sockets.delete(socketSession);
      }
    }
  }

  /**
   * Applies an admin channel update, re-validating the whole channel against the schema. Mirrors
   * `applyUserUpdate`: persist first, then mutate the live object and broadcast, so a failed write
   * never leaves in-memory state or a broadcast ahead of what is stored. Only fields present on
   * `update` change.
   */
  function applyChannelUpdate(channel: Channel, update: ChannelUpdateRequest): Channel {
    const next = ChannelSchema.parse({
      ...channel,
      name: update.name ?? channel.name,
      description: update.description === undefined ? channel.description : update.description,
      allowPosting: update.allowPosting ?? channel.allowPosting,
      allowReplies: update.allowReplies ?? channel.allowReplies,
      archived: update.archived === undefined ? channel.archived : update.archived,
    });
    store.upsertChannel(next);
    Object.assign(channel, next);
    broadcast({ type: "channelUpserted", channel });
    return channel;
  }

  /**
   * Determine which users should be exposed to clients: active participants only. Bots are hidden
   * unless the LLM is enabled, and banned/pending users are always hidden (they are not active
   * participants — moderators and greeters reach them via the dedicated moderation/access
   * endpoints). Shadow-banned users stay visible; only their messages are withheld.
   */
  /**
   * A user record safe to expose to ordinary clients: the `shadowBanned` flag is stripped, so a
   * *shadow*-banned user can't discover their own status (which would defeat the feature) and no one
   * can enumerate who is shadow-banned. Moderators still see it via the gated `/api/moderation/users`
   * endpoint, which returns the raw records. Applied at every public egress: the REST roster,
   * `/api/config`'s `currentUser`, and the `userUpserted` broadcast.
   */
  function publicUser(user: User): User {
    return user.shadowBanned ? { ...user, shadowBanned: undefined } : user;
  }

  function visibleUsers(): User[] {
    const base = appConfig.llm.ollama.enabled
      ? data.users
      : data.users.filter((user) => user.type !== "bot");
    return base.filter((user) => !user.banned && !user.pending).map(publicUser);
  }

  function avatarImagePath(imageId: string, mimeType: AvatarImageMimeType): string {
    return join(avatarsDir, `${imageId}.${avatarImageExtension(mimeType)}`);
  }

  /**
   * Finds the in-memory channel matching the provided id.
   */
  function ensureChannel(id: string): Channel | undefined {
    return data.channels.find((channel) => channel.id === id);
  }

  /**
   * Derives a stable, collision-free channel id from a display name: a URL-friendly slug (so routes
   * read `/channel/general`), with a short random suffix appended only when the slug is already
   * taken or empty (e.g. a name made entirely of emoji or punctuation).
   */
  function uniqueChannelId(name: string): string {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);

    if (slug && !ensureChannel(slug)) {
      return slug;
    }

    let candidate: string;
    do {
      candidate = `${slug || "channel"}-${randomBytes(3).toString("hex")}`;
    } while (ensureChannel(candidate));

    return candidate;
  }

  /**
   * The full member roster of a channel as a set of user ids. The owner is always a member, even if
   * the stored `memberUserIds` predates an ownership change or omits them.
   */
  function channelMemberIds(channel: Channel): Set<string> {
    const members = new Set(channel.memberUserIds ?? []);

    if (channel.ownerUserId) {
      members.add(channel.ownerUserId);
    }

    return members;
  }

  /**
   * Whether a user may see, read, and post in a channel: public channels are open to everyone;
   * private channels are members-only. Deliberately, node admins get no implicit read access —
   * they manage private channels (archive, rename) through the admin endpoints without joining
   * their audience.
   */
  function canAccessChannel(channel: Channel, userId: string): boolean {
    return channel.visibility !== "private" || channelMemberIds(channel).has(userId);
  }

  /**
   * Builds a channel from a create request, persists it, and broadcasts it. Shared by admin
   * creation and (when `enableUserChannels` is on) user creation. Owner = the creator. Public
   * channels are discoverable by everyone; private channels start with the creator as the only
   * member and are only ever sent to their members (see socketCanReceiveEvent).
   */
  function createChannelFromRequest(input: ChannelCreateRequest, ownerId: string): Channel {
    const visibility = input.visibility ?? "public";
    const channel: Channel = {
      id: uniqueChannelId(input.name),
      name: input.name,
      description: input.description,
      ownerUserId: ownerId,
      visibility,
      allowPosting: input.allowPosting ?? "everyone",
      allowReplies: input.allowReplies ?? true,
      discoverable: visibility === "public",
      createdAt: Date.now(),
      ...(visibility === "private" ? { memberUserIds: [ownerId] } : {}),
    };

    // Persist before exposing in memory / broadcasting, so a failed write never surfaces a channel
    // that was not stored (mirrors applyUserUpdate).
    store.upsertChannel(channel);
    data.channels.push(channel);
    broadcast({ type: "channelUpserted", channel });
    return channel;
  }

  /**
   * Replace a private channel's member roster. Mirrors `applyChannelUpdate`: persist first, then
   * mutate the live object and broadcast — the `channelUpserted` reaches members only, so a newly
   * added member learns of the channel through it while outsiders never see it.
   */
  function applyChannelMembers(channel: Channel, memberUserIds: string[]): Channel {
    const next = ChannelSchema.parse({ ...channel, memberUserIds });
    store.upsertChannel(next);
    Object.assign(channel, next);
    broadcast({ type: "channelUpserted", channel });
    return channel;
  }

  /**
   * Enforce a channel's posting policy server-side.
   *
   * @param channel - The target channel
   * @param authorId - The user attempting to post
   * @param isReply - Whether the message is a thread reply
   * @returns A human-readable rejection reason, or `undefined` when posting is allowed
   */
  function channelPostingError(channel: Channel, authorId: string, isReply: boolean): string | undefined {
    if (channel.archived) {
      return "Channel is archived";
    }

    if (isReply && !channel.allowReplies) {
      return "Replies are disabled in this channel";
    }

    if (channel.allowPosting === "owner" && channel.ownerUserId !== authorId) {
      return "Only the channel owner can post in this channel";
    }

    if (channel.allowPosting === "admins") {
      const author = data.users.find((user) => user.id === authorId);

      if (!author?.isAdmin) {
        return "Only admins can post in this channel";
      }
    }

    return undefined;
  }

  /**
   * Hide messages (and reactions) authored by a shadow-banned user from everyone but that author —
   * the same rule `socketCanReceiveEvent` and search apply. Without this, the REST read paths (which
   * the client refetches on every channel open and reconnect) would return a shadow-banned author's
   * content to the whole network, making the WS-level concealment cosmetic.
   */
  function withoutShadowBanned(messages: Message[], viewerId: string): Message[] {
    return messages.filter((message) => {
      const author = data.users.find((candidate) => candidate.id === message.authorId);
      return !author?.shadowBanned || message.authorId === viewerId;
    });
  }

  function channelMessages(channelId: string, viewerId: string): Message[] {
    const directMessages = data.messages.filter((message) => isChannelMessage(message, channelId));
    const ids = new Set(directMessages.map((message) => message.id));
    const reactions = data.messages.filter(
      (message) => message.type === "reaction" && ids.has(message.targetMessageId),
    );
    return withoutShadowBanned([...directMessages, ...reactions], viewerId).sort((a, b) => a.createdAt - b.createdAt);
  }

  function dmMessages(peerId: string, currentUserId: string): Message[] {
    const directMessages = data.messages.filter(
      (message) =>
        message.type === "dm" &&
        ((message.authorId === currentUserId && message.recipientUserId === peerId) ||
          (message.authorId === peerId && message.recipientUserId === currentUserId)),
    );
    const ids = new Set(directMessages.map((message) => message.id));
    const reactions = data.messages.filter(
      (message) => message.type === "reaction" && ids.has(message.targetMessageId),
    );
    return withoutShadowBanned([...directMessages, ...reactions], currentUserId).sort(
      (a, b) => a.createdAt - b.createdAt,
    );
  }

  function messageAudienceUserIds(message: Message): Set<string> | undefined {
    if (message.type === "dm") {
      return new Set([message.authorId, message.recipientUserId]);
    }

    if (message.type === "reaction") {
      const target = data.messages.find((candidate) => candidate.id === message.targetMessageId);
      return target ? messageAudienceUserIds(target) : new Set([message.authorId]);
    }

    // Channel messages: a private channel's messages (and, via the reaction recursion above, the
    // reactions on them) are only ever for its members. Public channels have no audience limit.
    const channel = ensureChannel(message.channelId);
    return channel?.visibility === "private" ? channelMemberIds(channel) : undefined;
  }

  function socketCanReceiveEvent(userId: string, event: ClientEvent): boolean {
    const recipient = data.users.find((candidate) => candidate.id === userId);

    // A banned recipient hears nothing (their sockets are closed on ban; this also covers a racing
    // reconnect). A pending (unapproved) recipient only hears about their own approval and
    // node-level notices — no content until a greeter lets them in, matching the REST gates.
    if (recipient?.banned) {
      return false;
    }

    if (recipient?.pending) {
      return (
        event.type === "wipe" ||
        event.type === "configUpdated" ||
        (event.type === "userUpserted" && event.user.id === userId)
      );
    }

    if (event.type === "configUpdated" || event.type === "wipe") {
      return true;
    }

    if (event.type === "userUpserted") {
      // Banned and pending identities are hidden from the REST roster (visibleUsers), so their
      // upserts are only announced to themselves and to the people who can act on them.
      const subject = event.user;

      if (!subject.banned && !subject.pending) {
        return true;
      }

      return userId === subject.id || (!!recipient && (canModerate(recipient) || canGreet(recipient)));
    }

    if (event.type === "channelUpserted") {
      // Public channel upserts go to all sockets (`GET /api/channels` returns them to everyone);
      // a private channel — including its member list — is only ever sent to its members.
      return canAccessChannel(event.channel, userId);
    }

    if (event.type === "channelRemoved") {
      // Targeted notice (a member losing access) — delivered via sendEventToUsers, never broadcast.
      return false;
    }

    if (event.type === "presence") {
      // Contains only visible users' ids; the banned/pending recipient gates above already ran.
      return true;
    }

    const message = event.message;

    // Shadow ban: a message whose author is currently shadow-banned is delivered only back to the
    // author, so their own UI still shows it while nobody else ever sees it. Layered on top of the
    // DM-audience filtering below (a shadow-banned DM is only ever seen by its author). This must
    // cover messageDeleted too — those events carry the full message body, so an unfiltered delete
    // (author, admin, or the retention reaper) would hand the hidden text to the whole audience.
    if (event.type === "messageCreated" || event.type === "messageUpdated" || event.type === "messageDeleted") {
      const author = data.users.find((candidate) => candidate.id === message.authorId);

      if (author?.shadowBanned && userId !== message.authorId) {
        return false;
      }
    }

    const audience = messageAudienceUserIds(message);
    return !audience || audience.has(userId);
  }

  function broadcast(event: ClientEvent): void {
    // Never put a user's shadow-ban state on the wire — not even to themselves (the point of a
    // *shadow* ban) or moderators (who read it via /api/moderation/users). The ban still takes full
    // effect server-side; this only hides the flag. Serialize the sanitized copy once for all sockets.
    const outbound = event.type === "userUpserted" ? { ...event, user: publicUser(event.user) } : event;
    const payload = JSON.stringify(outbound);

    for (const { socket, userId } of sockets) {
      if (socket.readyState === socket.OPEN && socketCanReceiveEvent(userId, event)) {
        socket.send(payload);
      }
    }
  }

  /** User ids with at least one open socket, restricted to visible (non-banned/-pending) users. */
  function onlineUserIds(): string[] {
    const online = new Set<string>();

    for (const { socket, userId } of sockets) {
      if (socket.readyState === socket.OPEN) {
        online.add(userId);
      }
    }

    return [...online].filter((id) => {
      const user = data.users.find((candidate) => candidate.id === id);
      return !!user && !user.banned && !user.pending;
    });
  }

  /**
   * Tell everyone who is connected right now (online dots). No-op when `enablePresence` is off —
   * high-risk deployments disable it, since presence reveals exactly who is reachable at this
   * moment. Sent on every connect/disconnect; at LAN scale that needs no debouncing.
   */
  function broadcastPresence(): void {
    if (!appConfig.features.enablePresence) {
      return;
    }

    broadcast({ type: "presence", onlineUserIds: onlineUserIds() });
  }

  /**
   * Send an event to the sockets of the given users only, bypassing the broadcast audience filter.
   * Used for targeted notices such as `channelRemoved`, whose recipient is by definition no longer
   * in the event's natural audience.
   */
  function sendEventToUsers(audience: Set<string>, event: ClientEvent): void {
    const payload = JSON.stringify(event);

    for (const { socket, userId } of sockets) {
      if (socket.readyState === socket.OPEN && audience.has(userId)) {
        socket.send(payload);
      }
    }
  }

  /**
   * Send a streaming event to the sockets of the given users only.
   *
   * @param audience - User ids allowed to receive the event (e.g. the two DM participants)
   * @param event - The stream event to deliver
   */
  function broadcastStreamEvent(audience: Set<string>, event: StreamEvent): void {
    const payload = JSON.stringify(event);

    for (const { socket, userId } of sockets) {
      if (socket.readyState === socket.OPEN && audience.has(userId)) {
        socket.send(payload);
      }
    }
  }

  /**
   * Validate input and create a new message record, or remove an existing reaction when toggled.
   *
   * Enforces the feature flags server-side: message types whose feature is disabled are rejected.
   *
   * @param input - The message creation payload specifying type-specific fields
   * @param authorId - The ID of the user creating the message
   * @returns An object containing either `message`, `deletedMessageId`/`deletedMessage` for a toggled reaction, or `error`
   */
  function createMessage(
    input: MessageCreateRequest,
    authorId: string,
  ): { message?: Message; deletedMessage?: Message; deletedMessageId?: string; error?: string; forbidden?: boolean } {
    const author = ensureSessionUser(authorId);

    // Moderation gates run before any feature-flag checks. A banned author is fully blocked; a
    // pending author is blocked until approved (both are `forbidden`, so the endpoint answers 403).
    // A shadow-banned author is allowed through here — the message is created and returned to them
    // normally, and the broadcast filter withholds it from everyone else (see socketCanReceiveEvent).
    const authorAccessError = participationError(author);

    if (authorAccessError) {
      return { error: authorAccessError, forbidden: true };
    }

    if (
      (input.type === "channelPost" || input.type === "channelReply") &&
      !appConfig.features.enablePublicChannels
    ) {
      return { error: "Channel posting is disabled on this LOAM node" };
    }

    if (input.type === "channelReply" && !appConfig.features.enableReplies) {
      return { error: "Replies are disabled on this LOAM node" };
    }

    if (input.type === "dm" && !appConfig.features.enableDMs) {
      return { error: "Direct messages are disabled on this LOAM node" };
    }

    if (input.type === "reaction" && !appConfig.features.enableReactions) {
      return { error: "Reactions are disabled on this LOAM node" };
    }

    if (input.type !== "reaction" && input.attachments?.length) {
      if (!appConfig.features.enableAttachments) {
        return { error: "Attachments are disabled on this LOAM node" };
      }

      // Only the uploader's own pending uploads may be attached, and each exactly once — so a
      // guessed/leaked id can't attach someone else's image or double-reference a file whose
      // deletion would break another message.
      for (const attachment of input.attachments) {
        if (attachmentOwners.get(attachment.id)?.userId !== authorId) {
          return { error: "Unknown attachment" };
        }
      }
    }

    if (input.type === "channelPost" || input.type === "channelReply") {
      const channel = ensureChannel(input.channelId);

      if (!channel) {
        return { error: "Channel does not exist" };
      }

      // Non-members get the same answer as a missing channel, so a private channel's existence is
      // never leaked by probing the message endpoint.
      if (!canAccessChannel(channel, authorId)) {
        return { error: "Channel does not exist" };
      }

      const policyError = channelPostingError(channel, authorId, input.type === "channelReply");

      if (policyError) {
        return { error: policyError };
      }
    }

    if (input.type === "channelReply") {
      const parent = data.messages.find((message) => message.id === input.parentMessageId);

      if (!parent || !("channelId" in parent)) {
        return { error: "Parent message does not exist" };
      }

      if (parent.channelId !== input.channelId) {
        return { error: "Parent message belongs to a different channel" };
      }
    }

    if (input.type === "reaction") {
      const target = data.messages.find((message) => message.id === input.targetMessageId);

      if (!target) {
        return { error: "Target message does not exist" };
      }

      // DM (and DM-reaction) targets are only reactable by their participants.
      const audience = messageAudienceUserIds(target);

      if (audience && !audience.has(authorId)) {
        return { error: "Cannot react to this message" };
      }

      const existingIndex = data.messages.findIndex(
        (message) =>
          message.type === "reaction" &&
          message.authorId === authorId &&
          message.targetMessageId === input.targetMessageId &&
          message.reaction === input.reaction,
      );

      if (existingIndex >= 0) {
        const deleted = data.messages[existingIndex];

        if (deleted) {
          // Tombstone the toggled-off reaction so sync peers don't hand it straight back.
          store.transaction(() => {
            store.deleteMessage(deleted.id);
            store.addTombstone(deleted.id);
          });
          tombstones.add(deleted.id);
          data.messages.splice(existingIndex, 1);
        }

        return { deletedMessageId: deleted?.id, deletedMessage: deleted };
      }
    }

    if (input.type === "dm") {
      const recipient = data.users.find((user) => user.id === input.recipientUserId);

      if (!recipient) {
        return { error: "Recipient user does not exist" };
      }
    }

    const base = {
      id: newMessageId(input.type === "reaction" ? "react" : "msg"),
      authorId,
      createdAt: Date.now(),
      meta:
        input.type === "reaction"
          ? undefined
          : { markdown: appConfig.features.enableMarkdown, source: "human" as const },
    };
    const message = MessageSchema.parse({ ...input, ...base });
    store.insertMessage(message);
    data.messages.push(message);

    if (input.type !== "reaction") {
      for (const attachment of input.attachments ?? []) {
        attachmentOwners.delete(attachment.id);
      }
    }

    return { message };
  }

  /**
   * Update a message's body and edited metadata in-place, persist it, and broadcast the update.
   *
   * @param message - The message object to update
   * @param nextBody - The new body content to set on the message
   * @param streaming - Whether the message is currently streaming (sets `meta.streaming`)
   * @returns The updated message instance
   */
  function updateMessage(message: Message, nextBody: string, streaming: boolean): Message {
    if (!("body" in message)) {
      return message;
    }

    const updated = MessageSchema.parse({
      ...message,
      body: nextBody,
      editedAt: Date.now(),
      meta: {
        ...message.meta,
        streaming,
      },
    });
    store.updateMessage(updated);
    Object.assign(message, updated);
    broadcast({ type: "messageUpdated", message });
    return message;
  }

  /**
   * Build a sequence of chat messages for the configured Ollama model from the DM history between a bot and a user.
   */
  function llmMessagesForUser(
    botId: string,
    currentUserId: string,
  ): { role: "system" | "user" | "assistant"; content: string }[] {
    const messages = dmMessages(botId, currentUserId).flatMap((message) => {
      if (message.type !== "dm" || !message.body.trim()) {
        return [];
      }

      return [
        {
          role: message.authorId === botId ? ("assistant" as const) : ("user" as const),
          content: message.body,
        },
      ];
    });

    return appConfig.llm.ollama.systemPrompt
      ? [{ role: "system" as const, content: appConfig.llm.ollama.systemPrompt }, ...messages]
      : messages;
  }

  function ollamaUrl(path: string): string {
    return `${appConfig.llm.ollama.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  async function* streamOllamaChat(
    messages: { role: "system" | "user" | "assistant"; content: string }[],
  ): AsyncGenerator<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000);

    try {
      const response = await fetch(ollamaUrl("/api/chat"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: appConfig.llm.ollama.model,
          stream: true,
          messages,
        }),
      });

      if (!response.ok || !response.body) {
        throw new Error(`Ollama request failed: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();

            if (!trimmed) {
              continue;
            }

            const parsed: unknown = JSON.parse(trimmed);

            if (!isRecord(parsed)) {
              continue;
            }

            if (typeof parsed.error === "string") {
              throw new Error(parsed.error);
            }

            const message = isRecord(parsed.message) ? parsed.message : undefined;
            const content = message && typeof message.content === "string" ? message.content : "";

            if (content) {
              yield content;
            }

            if (parsed.done === true) {
              return;
            }
          }
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error("Ollama request timed out while streaming.");
        }

        throw error;
      } finally {
        clearTimeout(timeout);
        void reader.cancel().catch(() => undefined);
      }
    } catch (error) {
      clearTimeout(timeout);

      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Ollama request timed out before streaming started.");
      }

      throw error;
    }
  }

  /**
   * Triggers an Ollama LLM assistant reply to a direct message and streams the assistant's
   * content into a new DM message via StreamEvent deltas, persisting the final body once.
   *
   * @param userMessage - The incoming DM message that may trigger the bot response
   */
  async function createOllamaResponse(userMessage: Message): Promise<void> {
    if (!appConfig.llm.ollama.enabled || userMessage.type !== "dm") {
      return;
    }

    const bot = data.users.find((user) => user.id === appConfig.llm.ollama.botId);

    if (!bot || userMessage.recipientUserId !== bot.id || userMessage.authorId === bot.id) {
      return;
    }

    const assistantMessage = MessageSchema.parse({
      id: newMessageId("llm"),
      type: "dm",
      authorId: bot.id,
      recipientUserId: userMessage.authorId,
      body: "",
      createdAt: Date.now(),
      meta: {
        source: "llm",
        model: appConfig.llm.ollama.model,
        markdown: true,
        streaming: true,
      },
    });
    store.insertMessage(assistantMessage);
    data.messages.push(assistantMessage);
    broadcast({ type: "messageCreated", message: assistantMessage });

    const audience = new Set([bot.id, userMessage.authorId]);
    let body = "";
    broadcastStreamEvent(audience, { type: "start", messageId: assistantMessage.id });

    try {
      for await (const delta of streamOllamaChat(llmMessagesForUser(bot.id, userMessage.authorId))) {
        body += delta;

        // Keep the in-memory copy current for mid-stream REST reads, but defer persistence and the
        // full-message broadcast to the end — clients follow the incremental delta events instead.
        if ("body" in assistantMessage) {
          assistantMessage.body = body;
        }

        broadcastStreamEvent(audience, { type: "delta", messageId: assistantMessage.id, text: delta });
      }

      updateMessage(assistantMessage, body.trim() || "(No response.)", false);
      broadcastStreamEvent(audience, { type: "end", messageId: assistantMessage.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Ollama error.";
      updateMessage(assistantMessage, `${body}\n\nLLM error: ${message}`.trim(), false);
      broadcastStreamEvent(audience, { type: "error", messageId: assistantMessage.id, error: message });
      server.log.error(error);
    }
  }

  /**
   * Loads persisted application data into memory: runs the one-time legacy JSON import, loads all
   * tables, seeds default channels on first boot, ensures (non-admin) seed users — demoting any
   * legacy admin seed, since admin now comes only from the bootstrap strategies — and ensures the
   * Ollama bot user if configured.
   */
  function loadData(): void {
    if (importLegacyJsonData(store, dataDir)) {
      server.log.info("Imported legacy .loam JSON data into SQLite (originals renamed to *.json.bak)");
    }

    data = {
      users: store.loadUsers(),
      channels: store.loadChannels(),
      messages: store.loadMessages(),
    };
    tombstones.clear();

    for (const id of store.loadTombstones()) {
      tombstones.add(id);
    }

    sessions.clear();

    for (const session of store.loadSessions()) {
      sessions.set(session.token, session.userId);
    }

    if (!data.channels.length) {
      data.channels = defaultChannels.map((channel) => ({ ...channel }));
      store.transaction(() => {
        for (const channel of data.channels) {
          store.upsertChannel(channel);
        }
      });
    }

    for (const id of seedUsers) {
      const seed = ensureUser(id);

      if (seed.isAdmin) {
        seed.isAdmin = false;
        store.upsertUser(seed);
      }
    }

    ensureOllamaBotUser();
  }

  /**
   * Track a secret-guess attempt under the given key (session user id or IP) and report whether
   * that key is over the limit for the current window.
   */
  function attemptRateLimited(attempts: Map<string, { count: number; resetAt: number }>, key: string): boolean {
    const now = Date.now();

    // Opportunistic pruning so a long-lived node doesn't accumulate one entry per source IP forever.
    if (attempts.size > 1000) {
      for (const [staleKey, entry] of attempts) {
        if (entry.resetAt <= now) {
          attempts.delete(staleKey);
        }
      }
    }

    const entry = attempts.get(key);

    if (!entry || entry.resetAt <= now) {
      attempts.set(key, { count: 1, resetAt: now + claimAttemptWindowMs });
      return false;
    }

    entry.count += 1;
    return entry.count > claimAttemptLimit;
  }

  /**
   * Execute the kill switch: wipe all persisted and in-memory data (messages, users, channels,
   * sessions, avatar files), signal connected clients to purge their local caches, close their
   * sockets, and re-seed the node's defaults so it comes back factory-fresh. Config (including the
   * kill-switch settings themselves) survives — the wipe destroys data, not settings.
   */
  async function executeKillSwitch(): Promise<void> {
    if (encryptionEnabled) {
      // Cryptographic wipe: destroy the ciphertext file AND (in ephemeral mode) rotate to a fresh
      // key, so any bytes a forensic tool recovers from flash are unreadable — stronger than a
      // logical DELETE, which leaves recoverable pages behind. See docs/02-kill-switch.md.
      store.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        await rm(`${dbPath}${suffix}`, { force: true });
      }

      if (ephemeralDbKey) {
        // Drop the old key by overwriting the reference; a fresh random key encrypts the new DB.
        // (Node strings can't be reliably zeroed in RAM — documented as a known limitation.)
        dbKey = randomBytes(32).toString("hex");
      }

      store = openLoamStore();
      // The wipe destroys data, not settings — but the fresh encrypted DB starts with an empty
      // config table, unlike wipeAll() below which preserves it. Re-persist the effective config
      // so admin edits (an armed kill switch, the panic token, feature flags) survive a restart
      // instead of silently reverting to config.json/defaults.
      store.setConfigValue("config", JSON.stringify(appConfig));
    } else {
      // Best-effort logical wipe (no encryption): DELETE leaves recoverable pages on flash. See docs.
      store.wipeAll();
    }

    await rm(avatarsDir, { recursive: true, force: true });
    await rm(attachmentsDir, { recursive: true, force: true });
    attachmentOwners.clear();
    sessions.clear();
    claimAttempts.clear();
    panicAttempts.clear();

    broadcast({ type: "wipe" });

    for (const { socket } of sockets) {
      socket.close();
    }

    sockets.clear();

    data = { users: [], channels: [], messages: [] };
    loadData();

    if (appConfig.admin.bootstrap === "setupCode") {
      adminSetupCode = makeAdminSetupCode();
      server.log.info(`Admin setup code (single use): ${adminSetupCode}`);
    }

    server.log.warn("Kill switch executed: all data wiped, defaults re-seeded");
  }

  /**
   * Delete messages older than the configured retention TTL (ephemeral messages): remove them from
   * memory and the store, and broadcast `messageDeleted` so connected clients drop them from their
   * local caches too. In-flight streaming messages are spared until they finish. No-op when no TTL
   * is configured.
   */
  function reapExpiredMessages(): void {
    const ttl = appConfig.retention.messageTtlMs;

    if (!ttl) {
      return;
    }

    const cutoff = Date.now() - ttl;
    const expired = data.messages.filter((message) => message.createdAt < cutoff && !message.meta?.streaming);

    if (!expired.length) {
      return;
    }

    // Expand each expired message through the same cascade the delete endpoint uses, so an expired
    // thread root takes its replies and reactions with it instead of orphaning them against a
    // missing parent until their own TTL passes. In-flight streaming messages stay spared.
    const doomed = new Map<string, Message>();

    for (const message of expired) {
      for (const casualty of collectDeletionSet(message)) {
        if (!casualty.meta?.streaming) {
          doomed.set(casualty.id, casualty);
        }
      }
    }

    deleteMessages([...doomed.values()]);
    server.log.info(`Retention reaper deleted ${doomed.size} expired message(s)`);
  }

  /**
   * Delete attachment files no message references and no fresh pending upload claims: uploads
   * whose send was abandoned (past the grace period) and files orphaned by a restart (the pending
   * map is RAM-only, so at boot every unreferenced file is an orphan). Runs at boot and on the
   * reaper timer.
   */
  async function reapOrphanedAttachments(): Promise<void> {
    let files: string[];

    try {
      files = await readdir(attachmentsDir);
    } catch {
      return; // No attachments directory yet — nothing uploaded.
    }

    const referenced = new Set<string>();

    for (const message of data.messages) {
      if (message.type !== "reaction") {
        for (const attachment of message.attachments ?? []) {
          referenced.add(attachment.id);
        }
      }
    }

    const now = Date.now();

    for (const fileName of files) {
      const parsed = parseAttachmentFileName(fileName);

      if (!parsed || referenced.has(parsed.id)) {
        continue;
      }

      const pending = attachmentOwners.get(parsed.id);

      if (pending && now - pending.uploadedAt < attachmentPendingGraceMs) {
        continue;
      }

      attachmentOwners.delete(parsed.id);
      await rm(join(attachmentsDir, fileName), { force: true }).catch((error: unknown) =>
        server.log.warn(error),
      );
    }
  }

  /**
   * Collects a message together with everything that deleting it would orphan: reactions targeting
   * it, and — for a channel post that roots a thread — its replies plus the reactions on those.
   */
  function collectDeletionSet(target: Message): Message[] {
    const set = new Map<string, Message>([[target.id, target]]);
    const reactionTargets = new Set<string>([target.id]);

    if (target.type === "channelPost") {
      for (const message of data.messages) {
        if (message.type === "channelReply" && message.parentMessageId === target.id) {
          set.set(message.id, message);
          reactionTargets.add(message.id);
        }
      }
    }

    for (const message of data.messages) {
      if (message.type === "reaction" && reactionTargets.has(message.targetMessageId)) {
        set.set(message.id, message);
      }
    }

    return Array.from(set.values());
  }

  /**
   * Deletes a set of messages: persist the removals in one transaction, broadcast `messageDeleted`
   * for each while the in-memory mirror is still intact (so reaction DM-audience lookups can resolve
   * their target), then drop them from memory. Shared by the reaper and the delete endpoint.
   */
  function deleteMessages(messages: Message[]): void {
    if (!messages.length) {
      return;
    }

    const ids = new Set(messages.map((message) => message.id));
    // Tombstone alongside the delete: a peer that still holds these must not re-import them.
    store.transaction(() => {
      for (const id of ids) {
        store.deleteMessage(id);
        store.addTombstone(id);
      }
    });

    for (const id of ids) {
      tombstones.add(id);
    }

    // Best-effort removal of the deleted messages' attachment files.
    for (const message of messages) {
      if (message.type !== "reaction") {
        for (const attachment of message.attachments ?? []) {
          rm(join(attachmentsDir, attachmentFileName(attachment)), { force: true }).catch(
            (error: unknown) => server.log.warn(error),
          );
        }
      }
    }

    for (const message of messages) {
      broadcast({ type: "messageDeleted", messageId: message.id, message });
    }

    data.messages = data.messages.filter((message) => !ids.has(message.id));
  }

  /**
   * Whether a message may leave this node over node-to-node sync: only content that is public
   * here — posts/replies in public, non-archived channels and reactions on them. DMs, private
   * channels, in-flight streaming messages, and shadow-banned authors' messages never sync.
   */
  function isSyncableMessage(message: Message): boolean {
    if (message.type === "dm" || message.meta?.streaming) {
      return false;
    }

    // The author check applies to every type — a shadow-banned user's *reactions* are withheld
    // from local broadcasts too, so they must not leak out through the sync export either.
    const author = data.users.find((candidate) => candidate.id === message.authorId);

    if (author?.shadowBanned) {
      return false;
    }

    if (message.type === "reaction") {
      const target = data.messages.find((candidate) => candidate.id === message.targetMessageId);
      return !!target && isSyncableMessage(target);
    }

    const channel = ensureChannel(message.channelId);
    return !!channel && channel.visibility === "public" && !channel.archived;
  }

  /** What this node advertises to pulling peers (see SyncDigestSchema). */
  function buildSyncDigest(): SyncDigest {
    return {
      channels: data.channels.filter((channel) => channel.visibility === "public" && !channel.archived),
      messages: data.messages.filter(isSyncableMessage).map((message) => ({
        id: message.id,
        ...(message.editedAt !== undefined ? { editedAt: message.editedAt } : {}),
      })),
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

  /** GET/POST a peer endpoint with a timeout, a response-size cap, and schema validation. */
  async function fetchPeerJson<T>(
    peerUrl: string,
    path: string,
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
    body?: unknown,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      // Present the shared mesh token (if configured) so a token-guarded peer will serve us; harmless
      // when the peer runs open.
      const headers: Record<string, string> = {};
      if (body !== undefined) {
        headers["content-type"] = "application/json";
      }
      if (appConfig.sync.token) {
        headers["x-loam-sync-token"] = appConfig.sync.token;
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

      const raw = await readPeerBody(response, maxPeerJsonBytes);
      const parsed = schema.safeParse(JSON.parse(raw.toString("utf8")));

      if (!parsed.success) {
        throw new Error("Peer sent an invalid payload");
      }

      return parsed.data;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Import a peer's user profiles for message authors we don't know yet. Authority and moderation
   * state are stripped — a peer's admin or moderator is a stranger here, and a peer must never be
   * able to ban/shadow-ban someone on this node.
   */
  function importPeerUsers(users: User[]): void {
    for (const user of users) {
      if (data.users.some((candidate) => candidate.id === user.id)) {
        continue;
      }

      const sanitized = UserSchema.parse({
        ...user,
        isAdmin: false,
        roles: undefined,
        banned: undefined,
        shadowBanned: undefined,
        pending: undefined,
      });
      store.upsertUser(sanitized);
      data.users.push(sanitized);
      broadcast({ type: "userUpserted", user: sanitized });
    }
  }

  /** Best-effort copy of an imported message's attachment files from the peer that has them. */
  async function importPeerAttachments(peerUrl: string, message: Message): Promise<void> {
    if (message.type === "reaction" || !message.attachments?.length) {
      return;
    }

    for (const attachment of message.attachments) {
      const filePath = join(attachmentsDir, attachmentFileName(attachment));

      try {
        await stat(filePath);
        continue; // already have it
      } catch {
        // fall through to fetch
      }

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        const response = await fetch(
          `${peerUrl.replace(/\/+$/, "")}/api/attachments/${attachmentFileName(attachment)}`,
          { signal: controller.signal },
        ).finally(() => clearTimeout(timeout));

        if (!response.ok) {
          continue;
        }

        // Bounded read: the cap applies while streaming, not after buffering the whole body.
        const bytes = await readPeerBody(response, attachmentMaxBytes);

        if (!bytes.length || !avatarImageHasExpectedSignature(bytes, attachment.mimeType)) {
          continue;
        }

        await mkdir(attachmentsDir, { recursive: true });
        await writeFile(filePath, bytes);
      } catch {
        // Message still imports; the image 404s until a later sync round retries... it won't —
        // acceptable v1 tradeoff, the text is the payload that matters off-grid.
      }
    }
  }

  /**
   * Import a batch of peer messages: posts before replies before reactions (so parents/targets
   * land first), never into private/unknown channels (a malicious peer must not inject into a
   * local private channel id), never over a tombstone, and edits only when strictly newer.
   */
  async function importPeerMessages(peerUrl: string, messages: Message[]): Promise<number> {
    const order = { channelPost: 0, channelReply: 1, reaction: 2, dm: 3 } as const;
    const sorted = [...messages].sort((a, b) => order[a.type] - order[b.type] || a.createdAt - b.createdAt);
    let imported = 0;

    for (const message of sorted) {
      if (message.type === "dm" || message.meta?.streaming || tombstones.has(message.id)) {
        continue;
      }

      if (message.type === "reaction") {
        const target = data.messages.find((candidate) => candidate.id === message.targetMessageId);

        // The reaction's target must exist locally and be public-audience (no DM/private targets).
        if (!target || messageAudienceUserIds(message) !== undefined) {
          continue;
        }
      } else {
        const channel = ensureChannel(message.channelId);

        if (!channel || channel.visibility !== "public" || channel.archived) {
          continue;
        }

        // A reply needs a valid local parent in the same channel (posts sort first, so a parent
        // in the same batch already landed). A parent we tombstoned or never had stays deleted —
        // and takes its replies with it, matching the local cascade semantics.
        if (message.type === "channelReply") {
          const parent = data.messages.find((candidate) => candidate.id === message.parentMessageId);

          if (!parent || parent.type !== "channelPost" || parent.channelId !== message.channelId) {
            continue;
          }
        }

        await importPeerAttachments(peerUrl, message);
      }

      const existing = data.messages.find((candidate) => candidate.id === message.id);

      if (existing) {
        if ((message.editedAt ?? 0) > (existing.editedAt ?? 0)) {
          const updated = MessageSchema.parse(message);
          store.updateMessage(updated);
          Object.assign(existing, updated);
          broadcast({ type: "messageUpdated", message: existing });
          imported += 1;
        }

        continue;
      }

      store.insertMessage(message);
      data.messages.push(message);
      broadcast({ type: "messageCreated", message });
      imported += 1;
    }

    if (imported) {
      data.messages.sort((a, b) => a.createdAt - b.createdAt);
    }

    return imported;
  }

  /** One pull round against one peer: digest → diff (skipping tombstones) → fetch → import. */
  async function syncWithPeer(peer: SyncPeer): Promise<void> {
    const status = peerSyncStatus.get(peer.url) ?? { imported: 0 };
    peerSyncStatus.set(peer.url, status);
    status.lastAttemptAt = Date.now();

    try {
      const digest = await fetchPeerJson(peer.url, "/api/sync/digest", SyncDigestSchema);

      for (const channel of digest.channels) {
        if (channel.visibility !== "public" || ensureChannel(channel.id)) {
          continue;
        }

        const created = ChannelSchema.parse({ ...channel, memberUserIds: undefined });
        store.upsertChannel(created);
        data.channels.push(created);
        broadcast({ type: "channelUpserted", channel: created });
      }

      const localById = new Map(data.messages.map((message) => [message.id, message]));
      const wanted = digest.messages
        .filter((entry) => {
          if (tombstones.has(entry.id)) {
            return false;
          }

          const mine = localById.get(entry.id);
          return !mine || (entry.editedAt !== undefined && entry.editedAt > (mine.editedAt ?? 0));
        })
        .map((entry) => entry.id);

      let imported = 0;

      for (let start = 0; start < wanted.length; start += 200) {
        const payload = await fetchPeerJson(
          peer.url,
          "/api/sync/messages",
          SyncMessagesResponseSchema,
          { ids: wanted.slice(start, start + 200) },
        );
        importPeerUsers(payload.users);
        imported += await importPeerMessages(peer.url, payload.messages);
      }

      status.lastSuccessAt = Date.now();
      status.lastError = undefined;
      status.imported += imported;

      if (imported) {
        server.log.info(`Synced ${imported} message(s) from peer ${peer.url}`);
      }
    } catch (error) {
      status.lastError = error instanceof Error ? error.message : "Sync failed";
      server.log.warn(`Sync with peer ${peer.url} failed: ${status.lastError}`);
    }
  }

  /** The pull loop: one round across all peers, at most once per configured interval. */
  async function runSyncLoop(force = false): Promise<void> {
    if (!appConfig.sync.enabled || syncRunning || !appConfig.sync.peers.length) {
      return;
    }

    if (!force && Date.now() - lastSyncLoopAt < appConfig.sync.intervalMs) {
      return;
    }

    syncRunning = true;
    lastSyncLoopAt = Date.now();

    try {
      // Peers sync concurrently — syncWithPeer never rejects (it records failures in its own
      // status entry), and the import path re-checks message existence after its last await, so
      // interleaved rounds can't double-insert.
      await Promise.all(appConfig.sync.peers.map((peer) => syncWithPeer(peer)));
    } finally {
      syncRunning = false;
    }
  }

  /** Peer list with live status, as shown in the admin UI (SyncStatusReportSchema is the contract). */
  function syncStatusReport(): SyncStatusReport {
    return {
      enabled: appConfig.sync.enabled,
      intervalMs: appConfig.sync.intervalMs,
      peers: appConfig.sync.peers.map((peer) => ({
        ...peer,
        status: peerSyncStatus.get(peer.url),
      })),
    };
  }

  /**
   * Registers the client distribution directory as the server's static file root when it exists.
   */
  async function registerStaticFiles(): Promise<void> {
    if (!options.clientDistDir) {
      return;
    }

    try {
      const stats = await stat(options.clientDistDir);

      if (!stats.isDirectory()) {
        return;
      }
    } catch {
      return;
    }

    await server.register(fastifyStatic, {
      root: options.clientDistDir,
      prefix: "/",
    });
    staticFilesRegistered = true;
  }

  await loadAppConfig();
  loadData();
  reapExpiredMessages();

  if (appConfig.admin.bootstrap === "setupCode" && !anyAdminExists()) {
    adminSetupCode = makeAdminSetupCode();
  }

  void reapOrphanedAttachments();

  const reaperTimer = setInterval(() => {
    try {
      reapExpiredMessages();
    } catch (error) {
      server.log.error(error);
    }

    // Drop expired per-IP identity counters so the map can't grow unbounded across many peers.
    const now = Date.now();
    for (const [ip, entry] of identityMintCounters) {
      if (entry.resetAt <= now) {
        identityMintCounters.delete(ip);
      }
    }

    void reapOrphanedAttachments().catch((error: unknown) => server.log.error(error));
  }, 30_000);

  // Sync ticker: a fixed 5s heartbeat; runSyncLoop itself enforces the configured interval (so an
  // admin shortening sync.intervalMs takes effect without re-arming a timer).
  const syncTimer = setInterval(() => {
    void runSyncLoop().catch((error: unknown) => server.log.error(error));
  }, 5_000);

  // Security headers on every response. A strict CSP is defense-in-depth behind the already-hardened
  // markdown sanitizer: the client is fully self-contained (its own JS/CSS, images from this origin,
  // ws:// to this host), so it needs no external origins. `nosniff` stops content-type confusion on
  // the user-uploaded images. `frame-ancestors 'none'` blocks clickjacking. No HSTS — LOAM runs on
  // plain-http LANs by design (docs/08), so forcing https would break it.
  server.addHook("onSend", async (request, reply) => {
    reply.header("x-content-type-options", "nosniff");

    // Only decorate the app shell / navigations, not API JSON or image bytes (those set their own).
    if (!request.url.startsWith("/api/") && request.url !== "/ws") {
      reply.header(
        "content-security-policy",
        [
          "default-src 'self'",
          // Inline styles: the client injects generated SVG (avatars, QR) with style attributes.
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "connect-src 'self' ws: wss:",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
          "frame-ancestors 'none'",
        ].join("; "),
      );
      reply.header("referrer-policy", "no-referrer");
    }
  });

  // Blanket per-IP throttle for every HTTP route; the abuse-sensitive endpoints (claim, panic,
  // avatar upload) add their own tighter semantic limits on top.
  await server.register(fastifyRateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
  });
  await server.register(fastifyWebsocket);
  await registerStaticFiles();

  // Liveness probe that mints NO identity — the Android host launcher polls this before loading the
  // WebView. Polling /api/config here would consume the one-time `firstUser` admin grant with a
  // throwaway loopback session, leaving the real operator (and the kill switch) locked out.
  server.get("/api/health", async () => ({ ok: true }));

  server.get("/api/config", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));

    return {
      nodeName: appConfig.node.name,
      version: options.version ?? "dev",
      joinUrl: `http://${joinHost}:${clientPort}`,
      websocketPath: "/ws",
      currentUser: publicUser(currentUser),
      networkConfig: currentNetworkConfig(),
    };
  });

  server.get("/api/users", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));
    const accessError = participationError(currentUser);

    if (accessError) {
      return reply.code(403).send(errorBody(accessError));
    }

    return visibleUsers();
  });
  server.patch("/api/users/me", async (request, reply) => {
    const body = UserUpdateRequestSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send(errorBody("Invalid user update request"));
    }

    if (
      (body.data.displayName !== undefined && !appConfig.identity.allowUserDisplayNameEdit) ||
      (body.data.avatar !== undefined && !appConfig.identity.allowUserAvatarEdit)
    ) {
      return reply.code(403).send(errorBody("User profile editing is disabled on this LOAM node"));
    }

    const user = ensureSessionUser(getSessionUserId(request, reply));
    const accessError = participationError(user);

    if (accessError) {
      return reply.code(403).send(errorBody(accessError));
    }

    return applyUserUpdate(user, body.data);
  });
  server.put(
    "/api/users/me/avatar-image",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
    if (!appConfig.identity.allowUserAvatarEdit || !appConfig.identity.allowUserAvatarUpload) {
      return reply.code(403).send(errorBody("User avatar uploads are disabled on this LOAM node"));
    }

    const uploader = ensureSessionUser(getSessionUserId(request, reply));
    const accessError = participationError(uploader);

    if (accessError) {
      return reply.code(403).send(errorBody(accessError));
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
    await mkdir(avatarsDir, { recursive: true });
    await writeFile(avatarImagePath(imageId, body.data.mimeType), image);

    const updated = applyUserUpdate(user, {
      avatar: {
        kind: "image",
        imageId,
        mimeType: body.data.mimeType,
        uploadedAt: Date.now(),
      },
    });

    // Keep only the latest image per user — remove the replaced file (best effort).
    if (previousAvatar?.kind === "image" && previousAvatar.imageId && previousAvatar.mimeType) {
      await rm(avatarImagePath(previousAvatar.imageId, previousAvatar.mimeType), { force: true }).catch(
        (error: unknown) => server.log.warn(error),
      );
    }

    return updated;
  });
  server.patch<{ Params: { userId: string } }>("/api/users/:userId", async (request, reply) => {
    const body = UserUpdateRequestSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send(errorBody("Invalid user update request"));
    }

    const currentUser = ensureSessionUser(getSessionUserId(request, reply));

    if (!currentUser.isAdmin || !appConfig.identity.allowAdminUserEdit) {
      return reply.code(403).send(errorBody("Admin user editing is disabled on this LOAM node"));
    }

    const user = data.users.find((candidate) => candidate.id === request.params.userId);

    if (!user) {
      return reply.code(404).send(errorBody("User does not exist"));
    }

    return applyUserUpdate(user, body.data);
  });

  // Set a user's granted roles (replaces the whole set). Admin-only — roles confer moderation and
  // greeter powers, so only an admin may hand them out. An admin's roles are never changed here.
  server.patch<{ Params: { userId: string } }>("/api/admin/users/:userId/roles", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));

    if (!currentUser.isAdmin) {
      return reply.code(403).send(errorBody("Admin access required"));
    }

    const body = RolesUpdateRequestSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send(errorBody("Invalid roles update request"));
    }

    const user = data.users.find((candidate) => candidate.id === request.params.userId);

    if (!user) {
      return reply.code(404).send(errorBody("User does not exist"));
    }

    if (user.isAdmin) {
      return reply.code(400).send(errorBody("Cannot change the roles of an admin"));
    }

    return applyUserModeration(user, { roles: body.data.roles });
  });

  // Promote a member to admin — host handover and co-admins. Deliberately no demote counterpart:
  // admin removal happens by re-bootstrapping the node (or the kill switch), never by another
  // admin, so a contested node can't descend into a mutual-demotion fight over governance.
  server.post<{ Params: { userId: string } }>("/api/admin/users/:userId/promote", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));

    if (!currentUser.isAdmin) {
      return reply.code(403).send(errorBody("Admin access required"));
    }

    const user = data.users.find((candidate) => candidate.id === request.params.userId);

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
    store.upsertUser(next);
    Object.assign(user, next);
    broadcast({ type: "userUpserted", user });
    return user;
  });

  // Ban / shadow-ban / unban a user. Open to admins and moderators; never usable against an admin
  // or oneself. Banning a user also tears down their live sessions (see invalidateUserSessions).
  server.patch<{ Params: { userId: string } }>("/api/moderation/users/:userId", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));

    if (!canModerate(currentUser)) {
      return reply.code(403).send(errorBody("Moderator access required"));
    }

    const body = ModerationUpdateRequestSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send(errorBody("Invalid moderation request"));
    }

    const user = data.users.find((candidate) => candidate.id === request.params.userId);

    if (!user) {
      return reply.code(404).send(errorBody("User does not exist"));
    }

    if (user.isAdmin || user.id === currentUser.id) {
      return reply.code(403).send(errorBody("You cannot moderate an admin or yourself"));
    }

    const changes: Partial<Pick<User, "banned" | "shadowBanned">> = {};

    if (body.data.banned !== undefined) {
      changes.banned = body.data.banned;
    }

    if (body.data.shadowBanned !== undefined) {
      changes.shadowBanned = body.data.shadowBanned;
    }

    // Broadcast the userUpserted first (so the target's own client learns it is banned), then tear
    // down their sessions and sockets.
    const updated = applyUserModeration(user, changes);

    if (changes.banned === true) {
      invalidateUserSessions(user.id);
    }

    return updated;
  });

  // The full human roster including banned and shadow-banned users, so the moderation UI can review
  // and unban them (visibleUsers hides banned/pending from everyone else). Admins and moderators.
  server.get("/api/moderation/users", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));

    if (!canModerate(currentUser)) {
      return reply.code(403).send(errorBody("Moderator access required"));
    }

    return data.users.filter((user) => user.type === "human");
  });

  // Users awaiting approval under the `approval` join policy. Admins and greeters.
  server.get("/api/access/pending", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));

    if (!canGreet(currentUser)) {
      return reply.code(403).send(errorBody("Greeter access required"));
    }

    return data.users.filter((user) => user.type === "human" && user.pending === true);
  });

  // Approve a pending user so they can participate. Admins and greeters.
  server.post<{ Params: { userId: string } }>("/api/access/users/:userId/approve", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));

    if (!canGreet(currentUser)) {
      return reply.code(403).send(errorBody("Greeter access required"));
    }

    const user = data.users.find((candidate) => candidate.id === request.params.userId);

    if (!user) {
      return reply.code(404).send(errorBody("User does not exist"));
    }

    return applyUserModeration(user, { pending: false });
  });

  // Deny a pending user: bans them (clearing pending) and tears down their sessions. Admins and
  // greeters — but, like moderation, never usable against an admin or oneself.
  server.post<{ Params: { userId: string } }>("/api/access/users/:userId/deny", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));

    if (!canGreet(currentUser)) {
      return reply.code(403).send(errorBody("Greeter access required"));
    }

    const user = data.users.find((candidate) => candidate.id === request.params.userId);

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

    const updated = applyUserModeration(user, { banned: true, pending: false });
    invalidateUserSessions(user.id);
    return updated;
  });

  server.get<{ Params: { fileName: string } }>(
    "/api/avatars/:fileName",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
    const avatar = parseAvatarImageId(request.params.fileName);

    if (!avatar) {
      return reply.code(404).send(errorBody("Avatar image does not exist"));
    }

    try {
      const image = await readFile(avatarImagePath(avatar.imageId, avatar.mimeType));
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
  server.post(
    "/api/attachments",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const currentUser = ensureSessionUser(getSessionUserId(request, reply));
      const accessError = participationError(currentUser);

      if (accessError) {
        return reply.code(403).send(errorBody(accessError));
      }

      if (!appConfig.features.enableAttachments) {
        return reply.code(403).send(errorBody("Attachments are disabled on this LOAM node"));
      }

      const body = AttachmentUploadRequestSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send(errorBody("Invalid attachment upload request"));
      }

      const image = Buffer.from(body.data.data, "base64");

      if (image.length === 0 || image.length > attachmentMaxBytes) {
        return reply.code(400).send(errorBody("Attachment image must be 256KB or smaller"));
      }

      if (!avatarImageHasExpectedSignature(image, body.data.mimeType)) {
        return reply.code(400).send(errorBody("Attachment image type does not match the uploaded data"));
      }

      const attachment: MessageAttachment = {
        id: newAttachmentId(),
        mimeType: body.data.mimeType,
        ...(body.data.width !== undefined ? { width: body.data.width } : {}),
        ...(body.data.height !== undefined ? { height: body.data.height } : {}),
      };
      await mkdir(attachmentsDir, { recursive: true });
      await writeFile(join(attachmentsDir, attachmentFileName(attachment)), image);
      attachmentOwners.set(attachment.id, { userId: currentUser.id, uploadedAt: Date.now() });
      return reply.code(201).send(attachment);
    },
  );

  server.get<{ Params: { fileName: string } }>(
    "/api/attachments/:fileName",
    { config: { rateLimit: { max: 240, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const attachment = parseAttachmentFileName(request.params.fileName);

      if (!attachment) {
        return reply.code(404).send(errorBody("Attachment does not exist"));
      }

      // Audience-gate the file exactly like its owning message: attachments on public messages
      // are anonymously fetchable (peer nodes copy them without a session); DM / private-channel
      // attachments are only served to the people who may read the message. A pending upload
      // (no owning message yet) is visible only to its uploader.
      const owningMessage = data.messages.find(
        (message) =>
          message.type !== "reaction" && !!message.attachments?.some((entry) => entry.id === attachment.id),
      );
      const sessionUserId = getSessionUserIdFromRequest(request);

      if (!owningMessage) {
        if (!sessionUserId || attachmentOwners.get(attachment.id)?.userId !== sessionUserId) {
          return reply.code(404).send(errorBody("Attachment does not exist"));
        }
      } else if (!isSyncableMessage(owningMessage)) {
        const user = sessionUserId
          ? data.users.find((candidate) => candidate.id === sessionUserId)
          : undefined;

        if (!user || participationError(user)) {
          return reply.code(404).send(errorBody("Attachment does not exist"));
        }

        const audience = messageAudienceUserIds(owningMessage);

        if (audience && !audience.has(user.id)) {
          return reply.code(404).send(errorBody("Attachment does not exist"));
        }
      }

      try {
        // Rebuild the filename from the parsed id + MIME type (like the avatar route) rather than
        // joining the raw request param — the served path is then provably derived from the
        // whitelisted pattern, never from user input.
        const image = await readFile(join(attachmentsDir, attachmentFileName(attachment)));
        return reply.type(attachment.mimeType).header("cache-control", "private, max-age=3600").header("x-content-type-options", "nosniff").send(image);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return reply.code(404).send(errorBody("Attachment does not exist"));
        }

        throw error;
      }
    },
  );

  server.get("/api/channels", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));
    const accessError = participationError(currentUser);

    if (accessError) {
      return reply.code(403).send(errorBody(accessError));
    }

    return data.channels.filter((channel) => !channel.archived && canAccessChannel(channel, currentUser.id));
  });
  server.get<{ Params: { channelId: string } }>("/api/messages/:channelId", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));
    const accessError = participationError(currentUser);

    if (accessError) {
      return reply.code(403).send(errorBody(accessError));
    }

    const userId = currentUser.id;
    const channel = ensureChannel(request.params.channelId);

    // Unknown channels and inaccessible private channels answer identically, so probing this
    // endpoint can never confirm that a private channel exists.
    if (!channel || !canAccessChannel(channel, userId)) {
      return reply.code(404).send(errorBody("Channel does not exist"));
    }

    return channelMessages(channel.id, userId);
  });

  // The member roster of a private channel. Members only — like every private-channel endpoint,
  // outsiders get the same 404 as a channel that does not exist.
  server.get<{ Params: { channelId: string } }>("/api/channels/:channelId/members", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));
    const accessError = participationError(currentUser);

    if (accessError) {
      return reply.code(403).send(errorBody(accessError));
    }

    const channel = ensureChannel(request.params.channelId);

    if (!channel || (channel.visibility === "private" && !canAccessChannel(channel, currentUser.id) && !currentUser.isAdmin)) {
      return reply.code(404).send(errorBody("Channel does not exist"));
    }

    if (channel.visibility !== "private") {
      return reply.code(400).send(errorBody("Only private channels have a member list"));
    }

    const members = channelMemberIds(channel);
    return data.users.filter((user) => members.has(user.id));
  });

  // Invite a user into a private channel. The channel owner or an admin only; adding an existing
  // member is a no-op. The member-only `channelUpserted` broadcast tells the invitee about the
  // channel the moment they are added.
  server.post<{ Params: { channelId: string } }>("/api/channels/:channelId/members", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));
    const accessError = participationError(currentUser);

    if (accessError) {
      return reply.code(403).send(errorBody(accessError));
    }

    const channel = ensureChannel(request.params.channelId);

    if (!channel || (channel.visibility === "private" && !canAccessChannel(channel, currentUser.id) && !currentUser.isAdmin)) {
      return reply.code(404).send(errorBody("Channel does not exist"));
    }

    if (channel.visibility !== "private") {
      return reply.code(400).send(errorBody("Only private channels have a member list"));
    }

    if (!currentUser.isAdmin && channel.ownerUserId !== currentUser.id) {
      return reply.code(403).send(errorBody("Only the channel owner or an admin can invite members"));
    }

    const body = ChannelMemberAddRequestSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send(errorBody("Invalid member request"));
    }

    const target = data.users.find((user) => user.id === body.data.userId);

    if (!target || target.type !== "human") {
      return reply.code(400).send(errorBody("User does not exist"));
    }

    if (target.banned) {
      return reply.code(400).send(errorBody("That user has been removed from this node"));
    }

    const members = channelMemberIds(channel);

    if (members.has(target.id)) {
      return channel;
    }

    return applyChannelMembers(channel, [...members, target.id]);
  });

  // Remove a member from a private channel. The owner or an admin may remove anyone but the owner;
  // any member may remove themselves (leave). The removed user gets a targeted `channelRemoved`
  // notice so their client drops the channel immediately.
  server.delete<{ Params: { channelId: string; userId: string } }>(
    "/api/channels/:channelId/members/:userId",
    async (request, reply) => {
      const currentUser = ensureSessionUser(getSessionUserId(request, reply));
      const accessError = participationError(currentUser);

      if (accessError) {
        return reply.code(403).send(errorBody(accessError));
      }

      const channel = ensureChannel(request.params.channelId);

      if (!channel || (channel.visibility === "private" && !canAccessChannel(channel, currentUser.id) && !currentUser.isAdmin)) {
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

      const members = channelMemberIds(channel);

      if (!members.has(targetId)) {
        return reply.code(400).send(errorBody("That user is not a member of this channel"));
      }

      members.delete(targetId);
      applyChannelMembers(channel, [...members]);
      sendEventToUsers(new Set([targetId]), { type: "channelRemoved", channelId: channel.id });
      return { ok: true };
    },
  );

  // Transfer a channel's ownership to another user. The current owner or an admin may do this; for a
  // private channel the new owner is added to the roster if absent (so they can actually reach it).
  // Ownership drives the `owner`-only posting policy and who may manage the channel, so it's a
  // deliberate, audited hand-off — the previous owner stays a member but loses owner powers.
  server.post<{ Params: { channelId: string } }>("/api/channels/:channelId/transfer", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));
    const accessError = participationError(currentUser);

    if (accessError) {
      return reply.code(403).send(errorBody(accessError));
    }

    const channel = ensureChannel(request.params.channelId);

    if (!channel || (channel.visibility === "private" && !canAccessChannel(channel, currentUser.id) && !currentUser.isAdmin)) {
      return reply.code(404).send(errorBody("Channel does not exist"));
    }

    if (!currentUser.isAdmin && channel.ownerUserId !== currentUser.id) {
      return reply.code(403).send(errorBody("Only the channel owner or an admin can transfer ownership"));
    }

    const body = ChannelTransferRequestSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send(errorBody("Invalid member request"));
    }

    const target = data.users.find((user) => user.id === body.data.userId);

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
    const members = channelMemberIds(channel);
    members.add(target.id);
    const memberUserIds = channel.visibility === "private" ? [...members] : channel.memberUserIds;

    const next = ChannelSchema.parse({ ...channel, ownerUserId: target.id, memberUserIds });
    store.upsertChannel(next);
    Object.assign(channel, next);
    broadcast({ type: "channelUpserted", channel });
    return channel;
  });

  server.get<{ Params: { userId: string } }>("/api/dms/:userId", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));
    const accessError = participationError(currentUser);

    if (accessError) {
      return reply.code(403).send(errorBody(accessError));
    }

    return dmMessages(request.params.userId, currentUser.id);
  });

  // Case-insensitive substring search over message bodies, scoped strictly to what the caller may
  // read: channel messages in channels they can access (never archived ones), and their own DMs.
  // Shadow-banned authors' messages stay visible only to themselves, matching the broadcast filter.
  server.get<{ Querystring: { q?: string; limit?: string } }>("/api/search", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));
    const accessError = participationError(currentUser);

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
    const channelsById = new Map(data.channels.map((channel) => [channel.id, channel]));
    const results: Message[] = [];

    // Walk newest-first (data.messages is kept in createdAt order) and stop at the limit.
    for (let index = data.messages.length - 1; index >= 0 && results.length < limit; index -= 1) {
      const message = data.messages[index];

      if (!message || !("body" in message) || !message.body.toLowerCase().includes(needle)) {
        continue;
      }

      const author = data.users.find((user) => user.id === message.authorId);

      if (author?.shadowBanned && message.authorId !== currentUser.id) {
        continue;
      }

      if (message.type === "dm") {
        if (message.authorId !== currentUser.id && message.recipientUserId !== currentUser.id) {
          continue;
        }
      } else {
        const channel = channelsById.get(message.channelId);

        if (!channel || channel.archived || !canAccessChannel(channel, currentUser.id)) {
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

  /**
   * Whether a peer request may be served: true when sync runs open (no shared token), or the request
   * presents the matching token (constant-time). A missing/wrong token is treated exactly like sync
   * being disabled — a 404 — so a prober can't distinguish "token-guarded" from "feature off".
   */
  function syncPeerAuthorized(request: FastifyRequest): boolean {
    const required = appConfig.sync.token;
    if (!required) {
      return true;
    }

    const header = request.headers["x-loam-sync-token"];
    const provided = Array.isArray(header) ? header[0] : header;
    if (typeof provided !== "string") {
      return false;
    }

    const a = Buffer.from(provided);
    const b = Buffer.from(required);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  server.get(
    "/api/sync/digest",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!appConfig.sync.enabled || !syncPeerAuthorized(request)) {
        return reply.code(404).send(errorBody("Not found"));
      }

      return buildSyncDigest();
    },
  );

  server.post(
    "/api/sync/messages",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!appConfig.sync.enabled || !syncPeerAuthorized(request)) {
        return reply.code(404).send(errorBody("Not found"));
      }

      const body = SyncMessagesRequestSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send(errorBody("Invalid sync request"));
      }

      const wanted = new Set(body.data.ids);
      const messages = data.messages.filter((message) => wanted.has(message.id) && isSyncableMessage(message));
      const authorIds = new Set(messages.map((message) => message.authorId));
      const users = data.users.filter((user) => authorIds.has(user.id));
      return { messages, users };
    },
  );

  server.get("/api/admin/sync", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));

    if (!currentUser.isAdmin) {
      return reply.code(403).send(errorBody("Admin access required"));
    }

    return syncStatusReport();
  });

  // Run a sync round right now (ignoring the interval) — the admin UI's "Sync now" button.
  server.post("/api/admin/sync/run", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));

    if (!currentUser.isAdmin) {
      return reply.code(403).send(errorBody("Admin access required"));
    }

    if (!appConfig.sync.enabled || !appConfig.sync.peers.length) {
      return reply.code(400).send(errorBody("Enable sync and add at least one peer first"));
    }

    await runSyncLoop(true);
    return syncStatusReport();
  });

  server.post("/api/messages", async (request, reply) => {
    const body = MessageCreateRequestSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send(errorBody("Invalid message request"));
    }

    const result = createMessage(body.data, getSessionUserId(request, reply));

    if (result.error) {
      // Moderation rejections (banned/pending author) are 403; everything else is a bad request.
      return reply.code(result.forbidden ? 403 : 400).send(errorBody(result.error));
    }

    if (result.deletedMessageId && result.deletedMessage) {
      broadcast({
        type: "messageDeleted",
        messageId: result.deletedMessageId,
        message: result.deletedMessage,
      });
      return reply.send(result);
    }

    if (!result.message) {
      return reply.code(400).send(errorBody("Unable to create message"));
    }

    broadcast({ type: "messageCreated", message: result.message });
    void createOllamaResponse(result.message);
    return reply.code(201).send(result);
  });

  server.delete<{ Params: { messageId: string } }>("/api/messages/:messageId", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));
    const accessError = participationError(currentUser);

    if (accessError) {
      return reply.code(403).send(errorBody(accessError));
    }

    const target = data.messages.find((message) => message.id === request.params.messageId);

    if (!target) {
      return reply.code(404).send(errorBody("Message does not exist"));
    }

    // Don't delete a message that's still streaming: its in-flight writer would re-persist it.
    if (target.meta?.streaming) {
      return reply.code(409).send(errorBody("This message is still being written"));
    }

    const deletionSet = collectDeletionSet(target);

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

    deleteMessages(deletionSet);
    return reply.send({ deletedIds: deletionSet.map((message) => message.id) });
  });

  server.patch<{ Params: { messageId: string } }>("/api/messages/:messageId", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));
    const accessError = participationError(currentUser);

    if (accessError) {
      return reply.code(403).send(errorBody(accessError));
    }

    const target = data.messages.find((message) => message.id === request.params.messageId);

    if (!target) {
      return reply.code(404).send(errorBody("Message does not exist"));
    }

    // Only the author may edit — rewriting someone else's words is impersonation, so not even an
    // admin can (admins moderate by deleting instead).
    if (target.authorId !== currentUser.id) {
      return reply.code(403).send(errorBody("You can only edit your own messages"));
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
    store.updateMessage(updated);
    Object.assign(target, updated);
    broadcast({ type: "messageUpdated", message: target });
    return target;
  });

  server.post(
    "/api/admin/claim",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
    const body = AdminClaimRequestSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send(errorBody("Invalid admin claim request"));
    }

    const currentUser = ensureSessionUser(getSessionUserId(request, reply));

    if (currentUser.isAdmin) {
      return currentUser;
    }

    const strategy = appConfig.admin.bootstrap;

    if (strategy !== "setupCode" && strategy !== "passphrase") {
      return reply.code(403).send(errorBody("Admin claiming is not enabled on this LOAM node"));
    }

    // Key on the caller's IP: a session-id key could be reset by simply omitting the cookie.
    if (attemptRateLimited(claimAttempts, request.ip)) {
      return reply.code(429).send(errorBody("Too many claim attempts; try again later"));
    }

    const expected = strategy === "setupCode" ? adminSetupCode : appConfig.admin.passphrase;
    const secretMatches =
      !!expected &&
      (strategy === "setupCode"
        ? timingSafeEqualStrings(body.data.secret, expected)
        : verifySecret(body.data.secret, expected));

    if (!secretMatches) {
      return reply.code(403).send(errorBody("Invalid admin secret"));
    }

    if (strategy === "setupCode") {
      adminSetupCode = undefined;
    }

    currentUser.isAdmin = true;
    store.upsertUser(currentUser);
    broadcast({ type: "userUpserted", user: currentUser });
    return currentUser;
  });

  server.get("/api/admin/config", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));

    if (!currentUser.isAdmin) {
      return reply.code(403).send(errorBody("Admin access required"));
    }

    return redactedConfig();
  });

  server.post("/api/admin/kill-switch", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));

    if (!currentUser.isAdmin) {
      return reply.code(403).send(errorBody("Admin access required"));
    }

    if (!appConfig.killSwitch.enabled) {
      return reply.code(403).send(errorBody("The kill switch is not enabled on this LOAM node"));
    }

    const body = KillSwitchRequestSchema.safeParse(request.body ?? {});

    if (!body.success) {
      return reply.code(400).send(errorBody("Invalid kill-switch request"));
    }

    if (appConfig.killSwitch.requireConfirmation && body.data.confirm !== "wipe") {
      return reply.code(400).send(errorBody('Confirmation required: send { "confirm": "wipe" }'));
    }

    await executeKillSwitch();
    return { ok: true };
  });

  // Unauthenticated panic trigger: fires the kill switch with a pre-shared token so a wipe can be
  // set off fast (bookmark/NFC/second device) without navigating the admin UI. 404s unless a token
  // is configured, so the route stays indistinguishable from absent on ordinary nodes.
  server.post(
    "/api/panic",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
    // Every non-success answers 404 — identical to an unconfigured node — so a prober can't tell a
    // panic-armed node from a plain one (only someone holding the token learns otherwise, and that
    // fires the wipe). The rate limiter still blocks brute force; it just doesn't reveal itself.
    if (!appConfig.killSwitch.enabled || !appConfig.killSwitch.panicToken) {
      return reply.code(404).send(errorBody("Not found"));
    }

    const body = PanicRequestSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(404).send(errorBody("Not found"));
    }

    if (attemptRateLimited(panicAttempts, request.ip)) {
      return reply.code(404).send(errorBody("Not found"));
    }

    if (!verifySecret(body.data.token, appConfig.killSwitch.panicToken)) {
      return reply.code(404).send(errorBody("Not found"));
    }

    await executeKillSwitch();
    return { ok: true };
  });

  server.patch("/api/admin/config", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));

    if (!currentUser.isAdmin) {
      return reply.code(403).send(errorBody("Admin access required"));
    }

    const body = LoamConfigUpdateSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send(errorBody("Invalid config update request"));
    }

    let next: LoamConfig;

    try {
      next = mergeConfig(appConfig, body.data);
    } catch {
      return reply.code(400).send(errorBody("Invalid config values"));
    }

    // Passphrase bootstrap without a passphrase would advertise a claim flow that can never
    // succeed (and clearing the passphrase while the mode is active would lock admins out).
    if (next.admin.bootstrap === "passphrase" && !next.admin.passphrase) {
      return reply.code(400).send(errorBody("The passphrase bootstrap strategy requires a passphrase"));
    }

    appConfig = next;
    store.setConfigValue("config", JSON.stringify(appConfig));
    ensureOllamaBotUser();
    broadcast({ type: "configUpdated", networkConfig: currentNetworkConfig() });
    // If presence was just enabled, connected clients need the current roster to light up.
    broadcastPresence();
    return redactedConfig();
  });

  // Unlike GET /api/channels (which hides archived channels from everyone), the admin list returns
  // every channel so an admin can see and restore archived ones.
  server.get("/api/admin/channels", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));

    if (!currentUser.isAdmin) {
      return reply.code(403).send(errorBody("Admin access required"));
    }

    return data.channels;
  });

  // Create a channel. Admins always may; ordinary users may when `enableUserChannels` is on. The
  // creator becomes the owner.
  server.post("/api/channels", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));
    const accessError = participationError(currentUser);

    if (accessError) {
      return reply.code(403).send(errorBody(accessError));
    }

    if (!currentUser.isAdmin && !appConfig.features.enableUserChannels) {
      return reply.code(403).send(errorBody("Creating channels is disabled on this LOAM node"));
    }

    const body = ChannelCreateRequestSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send(errorBody("Invalid channel create request"));
    }

    if (body.data.visibility === "private" && !appConfig.features.enablePrivateChannels) {
      return reply.code(403).send(errorBody("Private channels are disabled on this LOAM node"));
    }

    return reply.code(201).send(createChannelFromRequest(body.data, currentUser.id));
  });

  // Rename / re-configure / archive a channel. Allowed for an admin or the channel's owner.
  server.patch<{ Params: { channelId: string } }>("/api/channels/:channelId", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));
    const accessError = participationError(currentUser);

    if (accessError) {
      return reply.code(403).send(errorBody(accessError));
    }

    const channel = ensureChannel(request.params.channelId);

    if (!channel) {
      return reply.code(404).send(errorBody("Channel does not exist"));
    }

    if (!currentUser.isAdmin && channel.ownerUserId !== currentUser.id) {
      return reply.code(403).send(errorBody("Only the channel owner or an admin can change this channel"));
    }

    const body = ChannelUpdateRequestSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send(errorBody("Invalid channel update request"));
    }

    return applyChannelUpdate(channel, body.data);
  });

  server.get("/ws", { websocket: true }, (connection: SocketClient, request) => {
    const userId = getSessionUserIdFromRequest(request);

    if (!userId) {
      connection.send(JSON.stringify({ type: "error", ...errorBody("Unauthenticated websocket") }));
      connection.close();
      return;
    }

    // A banned identity keeps its session mapping (so the ban stays pinned to it — see
    // invalidateUserSessions) but must not be readmitted to the live feed by a reconnect.
    // Pending users may connect: the broadcast filter limits them to their own approval notice.
    const user = data.users.find((candidate) => candidate.id === userId);

    if (user?.banned) {
      connection.send(JSON.stringify({ type: "error", ...errorBody("This session is no longer valid") }));
      connection.close();
      return;
    }

    const socketSession = { socket: connection, userId };
    sockets.add(socketSession);
    broadcastPresence();
    connection.on("close", () => {
      sockets.delete(socketSession);
      broadcastPresence();
    });
  });

  server.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      void reply.code(404).send(errorBody("Not found"));
      return;
    }

    if (staticFilesRegistered) {
      void reply.sendFile("index.html");
      return;
    }

    void reply.type("text/html").send("<h1>LOAM server is running</h1><p>Start the client with pnpm dev and open http://localhost:3000.</p>");
  });

  return {
    server,
    // Getter, not a snapshot: the kill switch may close and reopen the store (encrypted wipe).
    get store() {
      return store;
    },
    adminSetupCode,
    reapExpiredMessages,
    reapOrphanedAttachments,
    async close() {
      clearInterval(reaperTimer);
      clearInterval(syncTimer);
      await server.close();
      store.close();
    },
  };
}
