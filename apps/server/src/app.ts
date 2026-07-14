import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import {
  createMeshIdentity,
  createTransportIdentity,
  currentEpoch,
  mailboxTag,
  meshIdFromSignPublic,
  openMailbox,
  openTransport,
  sealMailbox,
  sealTransport,
  transportServerAccept,
  verifyKxBinding,
  verifyTransportKeypair,
  type MeshIdentity,
  type TransportIdentity,
} from "@loam/crypto";
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
  MeshBroadcastRequestSchema,
  MeshIdentityCardSchema,
  MeshInboundRequestSchema,
  MeshSendRequestSchema,
  MessageSchema,
  ModerationUpdateRequestSchema,
  PanicRequestSchema,
  RolesUpdateRequestSchema,
  securityProfilePreset,
  SyncAttachmentRequestSchema,
  SyncAttachmentResponseSchema,
  SyncDigestSchema,
  SyncMessagesRequestSchema,
  SyncMessagesResponseSchema,
  TransportHandshakeRequestSchema,
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
  type MeshContact,
  type MeshIdentityCard,
  type SealedMessage,
  type NetworkConfig,
  type OllamaConfig,
  type StreamEvent,
  type SyncDigest,
  type ServerErrorCode,
  type SyncPeer,
  type SyncStatusReport,
  type User,
  type UserUpdateRequest,
} from "@loam/schema";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import { importLegacyJsonData, openStore, type LoamStore, type StoreDriver } from "./db.js";
import {
  fetchPeerTransportPosture,
  handshakeWithPeer,
  sealedFetch,
  type PeerTransportPosture,
  type PeerTransportSession,
} from "./sync-transport.js";

type SocketClient = {
  OPEN: number;
  readyState: number;
  send: (payload: string) => void;
  close: () => void;
  on: {
    (event: "close", listener: () => void): void;
    (event: "message", listener: (data: unknown) => void): void;
  };
};
type SocketSession = {
  socket: SocketClient;
  userId: string;
  /** Transport session key (docs/08) when the client connected `/ws?enc=<sid>`; outbound frames are
   * then XChaCha20-Poly1305-sealed. Undefined = plaintext frames (transport off / no session). */
  transportKey?: string;
  /** Fresh per-socket id (docs/20 §7). Application frames are sealed under an AAD that includes it, so
   * a frame captured on one connection can't be replayed on a reconnected socket sharing the same
   * transport session. Set only for an encrypted, key-confirmed socket. */
  connectionId?: string;
  /** Monotonic server→client frame sequence for this connection (docs/20 §7) — the client rejects a
   * replayed/stale frame. Starts at 0; `wsSend` pre-increments. */
  frameSeq?: number;
  /** The transport session id this (encrypted) socket rides, so it can be torn down when that session is
   * evicted/pruned (docs/20 §7 — a confirmed socket must not outlive its session key). */
  transportSessionId?: string;
};

/** Direction-separated AADs for the reflection-safe WS key-confirmation (docs/20 §7): the challenge
 * and the proof seal under DIFFERENT constants, so a keyless attacker can't reflect the server's
 * challenge ciphertext back as a valid proof. Application frames bind to the connection id. */
const WS_CHALLENGE_AAD = "loam.ws.challenge.v1";
const WS_PROOF_AAD = "loam.ws.proof.v1";
const WS_FRAME_AAD_PREFIX = "loam.ws.frame.v1";
/** How long an encrypted socket has to answer the key-confirmation challenge before it's dropped. */
const WS_CHALLENGE_TIMEOUT_MS = 10_000;
/** Cap on simultaneously-unconfirmed encrypted sockets (anti-flood on the pre-auth path, docs/20 §7). */
const WS_UNCONFIRMED_CAP = 128;
/** Tighter PER-IP cap on unconfirmed sockets, so a few LAN hosts can't exhaust the global pool and lock
 * everyone out. A real client confirms in milliseconds, so it never holds more than one or two at once. */
const WS_UNCONFIRMED_PER_IP_CAP = 8;

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

/**
 * Streaming callbacks for on-device LLM inference. The Android host's launcher
 * (`apps/app/nodejs-project-template/main.js`) installs a function of this shape on
 * `globalThis.__loamOnDeviceChat` before requiring the server bundle; it forwards chat messages to
 * the RN/native model over the `rn-bridge` channel and streams the reply back through these
 * callbacks. It is **absent on every other host** (desktop, Pi, CI) — the server checks for it and
 * degrades gracefully — so the server bundle never depends on `rn-bridge` or any native module.
 */
export type OnDeviceChatHook = (
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  callbacks: {
    onDelta: (text: string) => void;
    onEnd: () => void;
    onError: (message: string) => void;
  },
) => void;

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
  /**
   * Hard cap on live transport-encryption sessions (docs/08) — `POST /api/transport/handshake` is
   * deliberately unauthenticated (it's the bootstrap step before any session exists), so without a
   * real bound a flood of handshakes could grow the session map without limit. Expired sessions are
   * pruned on every handshake; once still at/over the cap, the oldest live sessions are evicted to
   * make room. Defaults to 5,000; lowered in tests to exercise eviction without 5,000 iterations.
   */
  transportSessionCap?: number;
  /**
   * How long (ms) a tombstone blocks re-import before the reaper GCs it (docs/15 #7). Defaults to
   * 30 days — deliberately generous, longer than any realistic sync/courier window. Overridable
   * only so tests can exercise the GC without waiting; production deployments should leave it at
   * the default.
   */
  tombstoneHorizonMs?: number;
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
  /** One-time admin claim code, present when bootstrap is `setupCode` and no admin exists yet. A
   * boot-time snapshot; use `getAdminSetupCode()` to read the value after it's re-minted/cleared at
   * runtime. */
  adminSetupCode?: string;
  /** The live one-time admin claim code (re-minted/cleared at runtime by the kill switch or a config
   * PATCH entering/leaving setupCode bootstrap) — survives the test wrapper's object spread. */
  getAdminSetupCode(): string | undefined;
  /** Delete messages older than the configured retention TTL now (also runs on a timer). */
  reapExpiredMessages(): void;
  /** Delete unreferenced/abandoned attachment files now (also runs on the reaper timer). */
  reapOrphanedAttachments(): Promise<void>;
  /** Drop expired per-IP rate-limit entries (identity budget + claim/panic attempt limiters) now
   * (also runs on the reaper timer) so the maps stay bounded to the IPs active within a window. */
  pruneExpiredRateLimiters(): void;
  /** Test/introspection hook: current entry counts of the per-IP rate-limit maps. */
  rateLimiterEntryCounts(): { claim: number; panic: number; identity: number };
  close(): Promise<void>;
};

const sessionCookieName = "loam_session";
const sessionCookieMaxAge = 60 * 60 * 24 * 365;
const defaultChannelCreatedAt = 1_704_067_200_000;
const claimAttemptLimit = 5;
const claimAttemptWindowMs = 5 * 60_000;
// Default for `AppOptions.tombstoneHorizonMs` (docs/15 #7): how long a tombstone blocks re-import
// before it's GC'd. Deliberately generous — far longer than any realistic sync/courier interval —
// so within the horizon a deleted message can never resurface from a peer or a mesh carrier; only
// a peer offline longer than this window can hand it back, an accepted DTN limitation (not gated
// on `sync.enabled`: a delete made while sync is off must still stick once a peer/mesh link
// appears later, or moderation is bypassable).
const defaultTombstoneHorizonMs = 30 * 24 * 60 * 60 * 1000;

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
 * with a mixed-version mesh. The canonical set of codes is `SERVER_ERROR_CODES` in `@loam/schema`
 * (values here are typed against it, so a typo or unlisted code fails to compile); every code must
 * also have a matching `error.<code>` key in the client i18n catalogs (enforced by
 * `apps/client/src/i18n/i18n.test.ts`, which asserts against the same `SERVER_ERROR_CODES` list).
 */
const ERROR_CODES: Record<string, ServerErrorCode> = {
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
  "Invalid transfer request": "invalid_transfer_request",
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

/** All stable error codes actually in use, exported so tests can assert client-catalog coverage. */
export const ALL_ERROR_CODES: readonly ServerErrorCode[] = Object.values(ERROR_CODES);

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
      enableLocationSharing: false,
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
      // On-device backend, off by default. Enabling it is a no-op unless the host provides the
      // inference hook (the Android host) AND a model has been added — otherwise a graceful error.
      onDevice: {
        enabled: false,
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
      // Off by default so existing plain-HTTP deployments are unchanged; operators opt in via a profile
      // or this axis (docs/08).
      transportEncryption: "off",
    },
    access: {
      joinPolicy: "open",
    },
    sync: {
      enabled: false,
      peers: [],
      intervalMs: 30_000,
    },
    // Opportunistic sealed-mailbox mesh, off by default (docs/16). Inert until an operator enables it.
    mesh: {
      enabled: false,
      relay: false,
      ttlMs: 72 * 3_600_000,
      hopLimit: 6,
      maxCarried: 5_000,
      maxContacts: 1_000,
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
    llm: {
      ollama: { ...base.llm.ollama, ...update.llm?.ollama },
      onDevice: { ...base.llm.onDevice, ...update.llm?.onDevice },
    },
    admin: { ...base.admin, ...update.admin },
    killSwitch: { ...base.killSwitch, ...update.killSwitch },
    retention: { ...base.retention, ...update.retention },
    security: { ...base.security, ...update.security },
    access: { ...base.access, ...update.access },
    sync: { ...base.sync, ...update.sync },
    mesh: { ...base.mesh, ...update.mesh },
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
    merged.security.transportEncryption = preset.transportEncryption;
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
  const transportDiverges =
    update.security?.transportEncryption !== undefined &&
    update.security.transportEncryption !== preset.transportEncryption;

  if (killSwitchDiverges || joinDiverges || ttlDiverges || transportDiverges) {
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

/** A fresh 256-bit secure identity token (docs/20) — high-entropy, so a fast hash (not scrypt) is the
 * right at-rest protection. */
function makeIdentityToken(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256 of an identity token, base64url — what's stored/looked-up, never the bearer value. */
function hashIdentityToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
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
  // Encrypted sockets that have connected but not yet passed the key-confirmation challenge (docs/20 §7).
  // `unconfirmedSocketCount` is the global cap; `unconfirmedByIp` is a tighter per-IP cap so a couple of
  // LAN hosts can't hold the whole global pool and lock everyone else out (the pre-auth path is
  // unauthenticated). `pendingSockets` lets revocation (ban/logout/kill-switch) reach a socket that is
  // still mid-challenge — otherwise it exists only as closures and could confirm AFTER being revoked.
  let unconfirmedSocketCount = 0;
  const unconfirmedByIp = new Map<string, number>();
  const pendingSockets = new Set<{ userId: string; close: () => void }>();
  const sessions = new Map<string, string>();
  const claimAttempts = new Map<string, { count: number; resetAt: number }>();
  const panicAttempts = new Map<string, { count: number; resetAt: number }>();
  // The host's static transport keypair (docs/08). Loaded/generated in loadData, persisted in the
  // config table (encrypted at rest when the DB is), rotated by the kill switch. Its public key goes
  // in the join QR + NetworkConfig.
  let transportIdentity: TransportIdentity | undefined;
  // Live transport sessions: sessionId → derived key + expiry + anti-replay window. In-memory only;
  // cleared by the kill switch. Ephemeral handshakes mean a lost entry just forces a re-handshake.
  // `maxSeq`/`seen` implement a DTLS-style sliding replay window (docs/08): every sealed REST request
  // carries a per-session monotonically increasing sequence number inside its authenticated envelope,
  // and a captured ciphertext replayed within the session's 12h life is rejected because its sequence
  // was already spent. `seen` holds only the sequence numbers still inside the window (pruned as it
  // advances), so it stays bounded regardless of how long the session lives.
  interface TransportSession {
    key: string;
    expiresAt: number;
    maxSeq: number;
    seen: Set<number>;
    // Identity binding (docs/20). A session starts `anonymous` (handshake is unauthenticated); a sealed
    // `/api/session/resume` promotes it to `bound` and records the user it authenticates + the hash of
    // the identity token that bound it. A `bound` session is what makes the secure rules apply (content
    // only via the tunnel, no cookie, WS key-confirmation) — independent of the node's global mode.
    // `resumeResult` caches the sealed resume payload so a fresh-sequence retry is idempotent.
    authMode: "anonymous" | "bound";
    userId?: string;
    identityTokenHash?: string;
    resumeResult?: { s?: number; m: string; p: string; currentUser: unknown; token: string };
  }
  const transportSessions = new Map<string, TransportSession>();
  // Secure identity tokens (docs/20): tokenHash → userId, mirrored in memory from the DAL. SEPARATE from
  // the cookie `sessions` map — a cookie token is NEVER a valid identity token, and vice versa.
  const identityTokens = new Map<string, string>();
  const TRANSPORT_SESSION_TTL_MS = 12 * 3_600_000;
  // How far a sealed request's sequence number may lag `maxSeq` and still be accepted — i.e. how much
  // reordering/concurrency the replay window tolerates. Browsers open only a handful of concurrent
  // connections per origin, so real reordering is tiny; this is generous headroom. A sequence at or
  // below `maxSeq - WINDOW` is refused as too old (indistinguishable from a replay of an evicted entry).
  const TRANSPORT_REPLAY_WINDOW = 1_024;
  // Hard cap on live sessions: the handshake endpoint is deliberately unauthenticated (it's the
  // bootstrap step before any session exists), so without a real bound a flood of handshakes from many
  // IPs could grow this map without limit even though each IP is individually rate-limited.
  const TRANSPORT_SESSION_CAP = options.transportSessionCap ?? 5_000;
  // Per-request session key, resolved once in onRequest and reused to decrypt the body (preValidation)
  // and encrypt the response (onSend). WeakMap so it's GC'd with the request — no manual cleanup.
  const transportRequestKeys = new WeakMap<FastifyRequest, string>();
  // The resolved transport session for a request, so `preValidation` can run the anti-replay window
  // against the same session `onRequest` authenticated. WeakMap → GC'd with the request.
  const transportRequestSessions = new WeakMap<FastifyRequest, TransportSession>();
  // The sealed request's authenticated sequence number `s` (docs/20 §9), stashed in preValidation so the
  // tunnel + resume handlers can BIND it into their sealed response descriptor — the client verifies the
  // response answers the exact `{ s, m, p }` it sent, defeating a cross-fed response under the tunnel's
  // constant AAD. WeakMap → GC'd with the request.
  const transportRequestSeq = new WeakMap<FastifyRequest, number>();
  // The node sync token a sealed request carried INSIDE its `{ s, b, tok }` envelope (docs/08) — the
  // authenticated, confidential channel for the `sync.token` bearer credential (never a wire header for a
  // sealed peer). `syncPeerAuthorized` reads it from here for a sealed request, falling back to the header
  // only on the plaintext path. WeakMap → GC'd with the request.
  const transportRequestSyncToken = new WeakMap<FastifyRequest, string>();
  // Per-boot secret proving a request is an internal re-dispatch from the transport tunnel handler
  // (`POST /api/transport/tunnel`, docs/08), not a real client socket. 256 bits of randomness compared
  // in constant time — an external request can't forge it, so the transport-enforcement bypass it
  // unlocks for internal requests is safe. Never leaves the process; regenerated every boot.
  const internalTunnelToken = randomBytes(32).toString("base64url");

  /** Whether a request is an internal tunnel re-dispatch (carries the valid per-boot internal token).
   * Such requests skip transport enforcement (they run plaintext inside the process) and the global
   * rate limiter (they're already bounded by the outer tunnel request that spawned them). */
  function isInternalTunnelRequest(request: FastifyRequest): boolean {
    const header = request.headers["x-loam-internal"];
    if (typeof header !== "string" || header.length !== internalTunnelToken.length) {
      return false;
    }
    try {
      return timingSafeEqual(Buffer.from(header), Buffer.from(internalTunnelToken));
    } catch {
      return false;
    }
  }

  /** The bound identity carried by a genuine internal tunnel re-dispatch, or `undefined`. The tunnel
   * handler sets `x-loam-user` to the tunnelling **bound** session's userId; we trust it ONLY when the
   * request also carries the unforgeable internal token (external `x-loam-user` is stripped in
   * `onRequest`, but gating on the token here is the real guarantee — a client can't produce it). This
   * is how a `bound` session (docs/20 §2) authenticates content: the un-sniffable session key is the
   * credential, resolved server-side to `session.userId`, never a cookie. An anonymous optional-mode
   * tunnel carries no `x-loam-user`, so this returns `undefined` and the caller falls back to cookie. */
  function tunnelBoundUserId(request: FastifyRequest): string | undefined {
    if (!isInternalTunnelRequest(request)) {
      return undefined;
    }
    const bound = request.headers["x-loam-user"];
    return typeof bound === "string" && bound.length > 0 ? bound : undefined;
  }

  /**
   * Anti-replay check for a sealed REST request's per-session sequence number (docs/08). Accepts a
   * sequence exactly once, tolerating up to `TRANSPORT_REPLAY_WINDOW` of reordering/concurrency:
   * a higher-than-seen sequence advances the window (and prunes entries that fall out of it); a
   * sequence still inside the window is accepted only if unseen; anything at/below the window floor,
   * a duplicate, or a non-positive/non-integer value is rejected. Returns `true` iff the request may
   * proceed. Mutates `session.maxSeq`/`session.seen`.
   */
  function acceptTransportSeq(session: TransportSession, seq: number): boolean {
    // isSafeInteger, not isInteger: a value past 2^53 loses precision, so a key-holding client could
    // otherwise submit an enormous sequence and poison its own replay window (docs/20 review #8). The
    // client re-handshakes long before its counter approaches this, resetting the window.
    if (!Number.isSafeInteger(seq) || seq < 1) {
      return false;
    }

    if (seq > session.maxSeq) {
      session.maxSeq = seq;
      session.seen.add(seq);
      const floor = seq - TRANSPORT_REPLAY_WINDOW;
      for (const previous of session.seen) {
        if (previous <= floor) {
          session.seen.delete(previous);
        }
      }
      return true;
    }

    if (seq <= session.maxSeq - TRANSPORT_REPLAY_WINDOW || session.seen.has(seq)) {
      return false;
    }

    session.seen.add(seq);
    return true;
  }
  // Per-IP new-identity budget (RAM-only): bounds how many fresh anonymous users one address can mint
  // per window, so a client discarding its cookie can't grow the user table without limit. Pruned on
  // the reaper timer. On a LAN each device gets its own IP, so this reads as per-device.
  const identityMintCounters = new Map<string, { count: number; resetAt: number }>();
  const maxNewIdentitiesPerWindow = options.maxNewIdentitiesPerWindow ?? 60;
  const identityWindowMs = options.identityWindowMs ?? 10 * 60_000;
  const tombstoneHorizonMs = options.tombstoneHorizonMs ?? defaultTombstoneHorizonMs;
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
  // Bumped by every kill-switch wipe. A sync round captures it before its first await and abandons
  // itself the moment it changes, so an in-flight pull can't re-persist peer data onto the freshly
  // wiped store (docs/15 #2). A monotonic counter, never reset — only equality across a round matters.
  let wipeGeneration = 0;
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
   * Parse one PRESENT config layer, **aborting startup** if it's malformed or invalid. Silently ignoring
   * it and continuing from defaults is dangerous: a typo'd `security.transportEncryption: "required"` node
   * (e.g. a `sync.token` under the 16-char minimum invalidating the whole document) would fall back to the
   * `off` default and serve plaintext while the operator believes it's hardened. Fail closed instead — the
   * caller only invokes this when a config source actually exists (an absent file is a normal fresh boot).
   */
  function parseConfigUpdate(raw: string, source: string): LoamConfigUpdate {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error(`Invalid configuration in ${source}: not valid JSON. Fix or remove it; refusing to start from defaults.`);
    }

    const parsed = LoamConfigUpdateSchema.safeParse(json);
    if (parsed.success) {
      return parsed.data;
    }

    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid configuration in ${source}: ${detail}. Fix it; refusing to start from defaults.`);
  }

  /**
   * Load the effective configuration: defaults, overlaid by the config file (when present and
   * valid), overlaid by admin edits persisted in the DB `config` table.
   */
  async function loadAppConfig(): Promise<void> {
    let config = defaultLoamConfig();

    try {
      const raw = await readFile(configPath, "utf8");
      // A present-but-invalid config.json throws here (fail closed); an ABSENT file is ENOENT → a normal
      // fresh boot from defaults, handled by the catch below.
      const fileUpdate = parseConfigUpdate(raw, configPath);

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
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    const stored = store.getConfigValue("config");

    // `!== undefined` (not truthiness): a PRESENT empty string is a corrupt row that must fail closed
    // through `parseConfigUpdate` (JSON.parse("") throws → abort), not be silently skipped to defaults. An
    // absent key returns `undefined` → a normal fresh boot.
    if (stored !== undefined) {
      const storedUpdate = parseConfigUpdate(stored, "the persisted config table");

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
    // A bound session's identity arrives via the internal tunnel (docs/20 §10) — trusted over any
    // cookie, and it mints nothing (the identity already exists from resume). Checked first so a
    // stale/forwarded cookie can never shadow the session-key-proven identity.
    const boundUserId = tunnelBoundUserId(request);
    if (boundUserId) {
      return boundUserId;
    }

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
    const boundUserId = tunnelBoundUserId(request);
    if (boundUserId) {
      return boundUserId;
    }
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
    const user = ensureUser(id, isAdmin, pending);
    // Give a real local user a mesh identity the first time we see them under mesh mode, so they can
    // send and receive sealed mail (no-op when mesh is off or they already have one).
    if (appConfig.mesh.enabled && user.type === "human" && !user.identityKey) {
      ensureMeshIdentity(user.id);
    }
    return user;
  }

  /** Whether any LLM backend is active — the laptop Ollama connection or the on-device model. The
   * bot DM contact, streaming, and all LLM routes are gated on this, so it stays off unless the
   * operator explicitly enables a backend (both default off). */
  function llmEnabled(): boolean {
    return appConfig.llm.ollama.enabled || appConfig.llm.onDevice.enabled;
  }

  /** The model label shown on assistant replies — the on-device model when that backend is active,
   * else the Ollama model. */
  function activeLlmModel(): string {
    if (appConfig.llm.onDevice.enabled) {
      return appConfig.llm.onDevice.model ?? "on-device";
    }
    return appConfig.llm.ollama.model;
  }

  /**
   * Ensures the assistant bot user exists in the in-memory user store and is up to date. The bot's
   * identity (id, display name) is shared from `llm.ollama` regardless of which backend answers, so
   * switching between the laptop-Ollama and on-device backends keeps the same DM contact.
   *
   * If no LLM backend is enabled, no changes are made.
   *
   * @returns The bot `User` after creation or update, or `undefined` when no backend is enabled.
   */
  function ensureBotUser(): User | undefined {
    if (!llmEnabled()) {
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
      enableMesh: appConfig.mesh.enabled,
      enableLLMChat: llmEnabled(),
      enableLLMStreaming: llmEnabled(),
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
      transportEncryption: appConfig.security.transportEncryption,
      // Publish the host's static public key only when transport encryption is in play, so the client
      // can handshake + show the fingerprint. The client still prefers the QR-delivered key (docs/08).
      transportPublicKey:
        appConfig.security.transportEncryption === "off" ? undefined : transportIdentity?.publicKey,
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

  /** A base64url string (the shape every `TransportIdentity` key field must have — the crypto layer's
   * decoder throws on anything else). */
  const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

  /** Guard a value parsed from storage against the `TransportIdentity` shape before trusting it as the
   * host's transport keypair: both fields must be present, non-empty, base64url strings. A record that
   * merely happens to be a JS object (e.g. `{}`, or one with a missing/blank/non-string field from a
   * truncated write) would otherwise flow straight into the crypto layer and either throw or silently
   * mint an unusable identity. */
  function isValidTransportIdentity(value: unknown): value is TransportIdentity {
    if (!value || typeof value !== "object") {
      return false;
    }
    const candidate = value as Partial<TransportIdentity>;
    // Both fields must be well-formed base64url AND form a consistent keypair — the public key is
    // exactly the one derived from the secret (docs/20 #7). A truncated/mismatched persisted record that
    // merely passes the charset check would otherwise slip through and only surface later inside the
    // crypto at handshake time; caught here it's regenerated. `verifyTransportKeypair` also enforces the
    // 32-byte secret length and re-derives the (32-byte) public, so no separate length check is needed.
    return (
      typeof candidate.publicKey === "string" &&
      typeof candidate.secretKey === "string" &&
      BASE64URL_RE.test(candidate.publicKey) &&
      BASE64URL_RE.test(candidate.secretKey) &&
      verifyTransportKeypair(candidate.publicKey, candidate.secretKey)
    );
  }

  /** Load the host's persisted transport keypair (docs/08), or mint + persist one on first boot.
   * Idempotent; the secret is stored in the config table (encrypted at rest when the DB is). */
  function ensureTransportIdentity(): TransportIdentity {
    if (transportIdentity) {
      return transportIdentity;
    }
    const stored = store.getConfigValue("transportIdentity");
    if (stored) {
      try {
        const parsed: unknown = JSON.parse(stored);
        if (isValidTransportIdentity(parsed)) {
          transportIdentity = parsed;
          return transportIdentity;
        }
        // Parsed fine but isn't a well-formed identity — treat exactly like a corrupt record below.
      } catch {
        // Corrupt record — fall through and regenerate.
      }
    }
    transportIdentity = createTransportIdentity();
    store.setConfigValue("transportIdentity", JSON.stringify(transportIdentity));
    return transportIdentity;
  }

  /** Rotate to a fresh transport keypair (kill switch) — the old join QR stops working and every live
   * transport session is invalidated, matching the "emergency reset" intent (docs/08). */
  function rotateTransportIdentity(): void {
    transportIdentity = createTransportIdentity();
    store.setConfigValue("transportIdentity", JSON.stringify(transportIdentity));
    transportSessions.clear();
  }

  /** The transport session key a request presented via a valid, unexpired `x-loam-enc` header (the
   * session id), or undefined. */
  function transportSessionForRequest(request: FastifyRequest): TransportSession | undefined {
    const sid = request.headers["x-loam-enc"];
    if (typeof sid !== "string" || sid.length === 0) {
      return undefined;
    }
    const session = transportSessions.get(sid);
    if (!session || session.expiresAt <= Date.now()) {
      return undefined;
    }
    return session;
  }

  /** The live transport session for a WebSocket connection, taken from the `?enc=<sid>` query (browsers
   * can't set custom headers on a WS upgrade), or undefined. The session carries the key AND its
   * `authMode`/`userId`, so the WS can bind identity to a `bound` session (docs/20) rather than a cookie. */
  function wsTransportSession(url: string): TransportSession | undefined {
    const query = url.split("?")[1];
    if (!query) {
      return undefined;
    }
    const sid = new URLSearchParams(query).get("enc");
    if (!sid) {
      return undefined;
    }
    const session = transportSessions.get(sid);
    if (!session || session.expiresAt <= Date.now()) {
      return undefined;
    }
    return session;
  }

  /** Whether this **external** request is a content route that, under `required` mode, is reachable
   * ONLY through the internal tunnel dispatch (docs/20) — so a direct hit is refused (401) and a
   * captured session id / cookie is inert. Matched on the RESOLVED route pattern (`routeOptions.url`),
   * NOT the raw request URL — Fastify percent-decodes the path before routing, so string-matching the
   * raw URL let `/%61pi/users` (→ `/api/users`) slip past enforcement. The only DIRECTLY reachable
   * `/api/` routes in required mode are the public bootstrap, health, the handshake, the sealed resume,
   * the sealed logout, the DIRECT cookie-clear (`/api/session/end` — unauthenticated + side-effect-only,
   * it mints nothing and only clears the caller's own presented cookie, so a device wipe can revoke a
   * legacy cookie that a bound session's `credentials:"omit"` requests never send, docs/20 #3), and the
   * tunnel endpoint itself; everything else — including `/api/config`, which now returns `currentUser`
   * only for a bound session over the tunnel — is content. (Internal tunnel dispatches never reach this —
   * they return at the top of `onRequest`; the static shell + `/ws` are handled separately.) */
  function requiresTransportSession(request: FastifyRequest): boolean {
    const routeUrl = request.routeOptions?.url;
    if (!routeUrl || !routeUrl.startsWith("/api/")) {
      return false;
    }
    return (
      routeUrl !== "/api/bootstrap" &&
      routeUrl !== "/api/health" &&
      routeUrl !== "/api/transport/handshake" &&
      routeUrl !== "/api/session/resume" &&
      routeUrl !== "/api/session/logout" &&
      routeUrl !== "/api/session/end" &&
      routeUrl !== "/api/transport/tunnel"
    );
  }

  /**
   * The node-to-node sync content routes. Under `required` mode (or a bound session) user-facing content
   * is tunnel-only (`/api/transport/tunnel`), but these two are reachable via a DIRECT sealed request
   * instead: sync is authenticated by the shared `sync.token` (docs/11) — a node credential, not a user
   * identity, so there is nothing to bind or carry over `x-loam-user`, and the tunnel would neither
   * forward the token nor admit an unbound session (docs/20 §2). They still MUST be sealed in `required`
   * mode (a plaintext hit with no resolved transport session falls through to the 401 in `onRequest`), so
   * inter-node sync is encrypted end-to-end; they are only exempt from the tunnel/bound requirement, not
   * from encryption. Both carry public data only (DMs/private channels/shadow-banned authors never
   * export). See `sync-transport.ts` (the puller half).
   */
  const DIRECT_SEALED_SYNC_ROUTES = new Set([
    "/api/sync/digest",
    "/api/sync/messages",
    "/api/sync/attachment",
  ]);

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
   * Whether a user id belongs to a locally-authoritative identity (admin / moderator / greeter). Used
   * to reject sync-imported content that tries to impersonate one — a peer must never be able to make
   * a message render as authored by this node's admin. Imported users are always stripped of authority
   * (`importPeerUsers`), so an authoritative local id is by definition a real local identity.
   */
  function isLocallyAuthoritative(userId: string): boolean {
    const user = data.users.find((candidate) => candidate.id === userId);
    return !!user && (canModerate(user) || canGreet(user));
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

    // Tear down any BOUND transport sessions for this user (docs/20) so a banned user's live sealed
    // session stops working at once. The identity TOKEN is deliberately KEPT (like the cookie session
    // mapping above): a reconnect re-binds to the SAME banned identity, so the ban stays pinned rather
    // than being shed by a fresh handshake+resume.
    for (const [sid, session] of [...transportSessions]) {
      if (session.userId === userId) {
        transportSessions.delete(sid);
      }
    }

    for (const socketSession of [...sockets]) {
      if (socketSession.userId === userId) {
        socketSession.socket.close();
        sockets.delete(socketSession);
      }
    }

    // Also close any of this user's sockets still mid-challenge (docs/20 §7/§8) — otherwise a socket that
    // completes its proof after the ban would slip into the live feed.
    for (const pending of [...pendingSockets]) {
      if (pending.userId === userId) {
        pending.close();
      }
    }
  }

  /** Close CONFIRMED sockets (those in the live `sockets` set) riding a transport session that is being
   * pruned/evicted (docs/20 §7), so a socket can't keep receiving frames after its session key is gone. The
   * per-socket expiry timer covers natural expiry; this covers an ABRUPT removal (cap eviction) before that
   * timer fires. A socket still MID-CHALLENGE for that session isn't in `sockets` yet, but it can't slip
   * through: the confirm-time `stillValid` check re-reads `transportSessions.get(sid)`, which no longer
   * matches the evicted session, so its late proof is refused. */
  function closeSocketsForTransportSession(sid: string): void {
    for (const socketSession of [...sockets]) {
      if (socketSession.transportSessionId === sid) {
        socketSession.socket.close();
        sockets.delete(socketSession);
      }
    }
  }

  /** Revoke a secure identity token (docs/20 §8) — for explicit logout / device wipe / rotation, where
   * the user is discarding the identity itself (unlike a ban, which keeps the token pinned). Deletes the
   * token row (memory + store), drops every transport session it bound, and closes that identity's
   * sockets. Returns the userId the token authenticated, or undefined if it was already gone. */
  function revokeIdentityToken(tokenHash: string): string | undefined {
    const userId = identityTokens.get(tokenHash);
    identityTokens.delete(tokenHash);
    store.deleteIdentityToken(tokenHash);

    for (const [sid, session] of [...transportSessions]) {
      if (session.identityTokenHash === tokenHash) {
        transportSessions.delete(sid);
      }
    }
    if (userId) {
      for (const socketSession of [...sockets]) {
        if (socketSession.userId === userId) {
          socketSession.socket.close();
          sockets.delete(socketSession);
        }
      }
      // Close this identity's mid-challenge sockets too (docs/20 §7/§8), so none confirms after logout.
      for (const pending of [...pendingSockets]) {
        if (pending.userId === userId) {
          pending.close();
        }
      }
    }
    return userId;
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
    // Always drop the property (not just when truthy): if a restored user carried `shadowBanned:
    // false` while a shadow-banned user's copy omitted it, the field's mere presence/absence would
    // itself leak status. Removing it unconditionally makes every public record uniform. `roles`
    // (moderator/greeter) is stripped for the same reason a joiner must not be able to enumerate who
    // holds authority on the node — only the subject themselves and moderators see it (rolesVisibleUser).
    const clone = { ...user };
    delete clone.shadowBanned;
    delete clone.roles;
    return clone;
  }

  /** Like `publicUser` but keeps `roles` — for the record's own owner (so their client can gate its
   * moderation UI) and for moderators (who legitimately manage roles). Still never leaks shadowBanned. */
  function rolesVisibleUser(user: User): User {
    const clone = { ...user };
    delete clone.shadowBanned;
    return clone;
  }

  /** The single record of `user` that `viewer` is allowed to see: `roles` only on the viewer's own
   * record or when the viewer is a moderator/admin; `shadowBanned` never. The one sanitizer every
   * user-egress path (roster, channel members, pending queue, approve/deny) routes through. */
  function sanitizeUserFor(viewer: User, user: User): User {
    return canModerate(viewer) || user.id === viewer.id ? rolesVisibleUser(user) : publicUser(user);
  }

  /** A mesh sender's display id (`mesh.<hash>`) — a sealed-mail delivery artifact, not a public roster
   * member (docs/16). Never a local session/seed/bot id (those are `user.`/`llm.`). */
  function isMeshSentinelUser(id: string): boolean {
    return id.startsWith("mesh.");
  }

  /** Whether `viewerId` has received sealed mail from mesh sender `meshId` — the only reason that
   * sender's display record is visible to them (it never joins the shared roster). */
  function meshSenderVisibleTo(meshId: string, viewerId: string): boolean {
    return data.messages.some(
      (message) => message.type === "dm" && message.authorId === meshId && message.recipientUserId === viewerId,
    );
  }

  /** The roster as `viewer` may see it: sanitized per-user, and with mesh sender artifacts hidden
   * except from the recipients they actually mailed. */
  function visibleUsers(viewer: User): User[] {
    const base = llmEnabled() ? data.users : data.users.filter((user) => user.type !== "bot");
    return base
      .filter((user) => !user.banned && !user.pending)
      .filter((user) => !isMeshSentinelUser(user.id) || meshSenderVisibleTo(user.id, viewer.id))
      .map((user) => sanitizeUserFor(viewer, user));
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
    // Filter the root messages by shadow-ban FIRST, then keep only reactions that target a still-
    // visible root (and whose own author isn't shadow-banned). Deriving the reaction ids from the
    // unfiltered roots would leave orphan reactions pointing at a hidden message — leaking that a
    // shadow-banned author's post exists.
    const roots = withoutShadowBanned(
      data.messages.filter((message) => isChannelMessage(message, channelId)),
      viewerId,
    );
    const visibleRootIds = new Set(roots.map((message) => message.id));
    const reactions = withoutShadowBanned(
      data.messages.filter((message) => message.type === "reaction" && visibleRootIds.has(message.targetMessageId)),
      viewerId,
    );
    return [...roots, ...reactions].sort((a, b) => a.createdAt - b.createdAt);
  }

  function dmMessages(peerId: string, currentUserId: string): Message[] {
    // Same ordering as channelMessages: shadow-ban the roots first, then only reactions on visible
    // roots survive, so a hidden DM never leaks via a dangling reaction.
    const roots = withoutShadowBanned(
      data.messages.filter(
        (message) =>
          message.type === "dm" &&
          ((message.authorId === currentUserId && message.recipientUserId === peerId) ||
            (message.authorId === peerId && message.recipientUserId === currentUserId)),
      ),
      currentUserId,
    );
    const visibleRootIds = new Set(roots.map((message) => message.id));
    const reactions = withoutShadowBanned(
      data.messages.filter((message) => message.type === "reaction" && visibleRootIds.has(message.targetMessageId)),
      currentUserId,
    );
    return [...roots, ...reactions].sort((a, b) => a.createdAt - b.createdAt);
  }

  function messageAudienceUserIds(message: Message): Set<string> | undefined {
    if (message.type === "dm") {
      return new Set([message.authorId, message.recipientUserId]);
    }

    if (message.type === "reaction") {
      const target = data.messages.find((candidate) => candidate.id === message.targetMessageId);
      return target ? messageAudienceUserIds(target) : new Set([message.authorId]);
    }

    // Sealed mailbox mail is opaque and never broadcast to any client — it moves only over sync and is
    // delivered (decrypted) as a fresh DM. Empty audience = no socket receives the sealed blob itself.
    if (message.type === "sealed") {
      return new Set();
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

  /** Send one already-serialized frame to a socket. For an encrypted, key-confirmed socket the frame is
   * sealed under a CONNECTION-BOUND aad (`loam.ws.frame.v1 <connectionId>`, docs/20 §7) and wrapped in a
   * `{ q, f }` envelope carrying a monotonic per-connection sequence `q`, so the client rejects a frame
   * replayed from another connection or re-sent on this one. A plaintext socket (transport off) sends the
   * raw payload. Callers keep their own readyState + audience checks. */
  function wsSend(session: SocketSession, payload: string): void {
    if (session.transportKey && session.connectionId) {
      session.frameSeq = (session.frameSeq ?? 0) + 1;
      const aad = `${WS_FRAME_AAD_PREFIX} ${session.connectionId}`;
      session.socket.send(sealTransport(session.transportKey, JSON.stringify({ q: session.frameSeq, f: payload }), aad));
      return;
    }
    session.socket.send(payload);
  }

  function broadcast(event: ClientEvent): void {
    if (event.type === "userUpserted") {
      // Two shapes: `roles` (moderator/greeter) reach only the subject (so their own client can gate
      // its moderation UI) and moderators (who manage roles); everyone else gets the fully-public
      // record. `shadowBanned` is never on the wire in EITHER shape — not even to self or moderators
      // (they read it via /api/moderation/users). The ban still takes full effect server-side.
      const subject = event.user;
      const strippedPayload = JSON.stringify({ ...event, user: publicUser(subject) });
      const rolesPayload = JSON.stringify({ ...event, user: rolesVisibleUser(subject) });

      for (const session of sockets) {
        if (session.socket.readyState !== session.socket.OPEN || !socketCanReceiveEvent(session.userId, event)) {
          continue;
        }
        const recipient = data.users.find((candidate) => candidate.id === session.userId);
        const seesRoles = session.userId === subject.id || (!!recipient && canModerate(recipient));
        wsSend(session, seesRoles ? rolesPayload : strippedPayload);
      }
      return;
    }

    const payload = JSON.stringify(event);
    for (const session of sockets) {
      if (session.socket.readyState === session.socket.OPEN && socketCanReceiveEvent(session.userId, event)) {
        wsSend(session, payload);
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

    for (const session of sockets) {
      if (session.socket.readyState === session.socket.OPEN && audience.has(session.userId)) {
        wsSend(session, payload);
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

    for (const session of sockets) {
      if (session.socket.readyState === session.socket.OPEN && audience.has(session.userId)) {
        wsSend(session, payload);
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

    if (input.type !== "reaction" && input.location && !appConfig.features.enableLocationSharing) {
      return { error: "Location sharing is disabled on this LOAM node" };
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
   * Stream a reply from the **on-device** model. Inference doesn't run in this (embedded Node)
   * process — it runs in the Android host's RN/native layer, reachable via a hook the launcher
   * (`nodejs-project-template/main.js`) installs on `globalThis.__loamOnDeviceChat` before requiring
   * the server bundle. On any other host (desktop, Pi, CI) the hook is simply absent, so enabling the
   * on-device backend there yields a clean error rather than a crash — messaging is never affected.
   * The callback-style hook is adapted into the same `AsyncGenerator<string>` shape as Ollama so the
   * assistant flow below is backend-agnostic.
   */
  async function* streamOnDeviceChat(
    messages: { role: "system" | "user" | "assistant"; content: string }[],
  ): AsyncGenerator<string> {
    const hook = (globalThis as { __loamOnDeviceChat?: OnDeviceChatHook }).__loamOnDeviceChat;

    if (typeof hook !== "function") {
      throw new Error("The on-device model is not available on this host.");
    }

    const queue: string[] = [];
    let finished = false;
    let failure: Error | undefined;
    let wake: (() => void) | undefined;
    const signal = () => {
      wake?.();
      wake = undefined;
    };

    // Bound the request like the Ollama path: if the host hook goes silent (a wedged model, a dropped
    // rn-bridge round-trip) the generator would otherwise hang forever. After 5 minutes, fail it.
    const timeout = setTimeout(
      () => {
        if (!finished) {
          failure = new Error("The on-device model timed out.");
          finished = true;
          signal();
        }
      },
      5 * 60 * 1000,
    );

    hook(messages, {
      onDelta: (text) => {
        if (text) {
          queue.push(text);
        }
        signal();
      },
      onEnd: () => {
        finished = true;
        signal();
      },
      onError: (message) => {
        failure = new Error(message || "The on-device model failed.");
        finished = true;
        signal();
      },
    });

    try {
      while (true) {
        if (queue.length) {
          yield queue.shift() as string;
          continue;
        }
        if (failure) {
          throw failure;
        }
        if (finished) {
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Stream from whichever LLM backend is active: the on-device model takes precedence when enabled,
   * otherwise the laptop Ollama connection. */
  function streamChat(
    messages: { role: "system" | "user" | "assistant"; content: string }[],
  ): AsyncGenerator<string> {
    return appConfig.llm.onDevice.enabled ? streamOnDeviceChat(messages) : streamOllamaChat(messages);
  }

  /**
   * Triggers an LLM assistant reply to a direct message and streams the assistant's content into a
   * new DM message via StreamEvent deltas, persisting the final body once. Backend-agnostic — the
   * deltas come from `streamChat` (Ollama or the on-device model).
   *
   * @param userMessage - The incoming DM message that may trigger the bot response
   */
  async function createAssistantResponse(userMessage: Message): Promise<void> {
    if (!llmEnabled() || userMessage.type !== "dm") {
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
        model: activeLlmModel(),
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
      for await (const delta of streamChat(llmMessagesForUser(bot.id, userMessage.authorId))) {
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
      const message = error instanceof Error ? error.message : "Unknown LLM error.";
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

    transportIdentity = undefined;
    ensureTransportIdentity();

    meshIdentities.clear();
    loadMeshIdentities();
    meshContacts.clear();
    loadMeshContacts();

    sessions.clear();

    for (const session of store.loadSessions()) {
      sessions.set(session.token, session.userId);
    }

    identityTokens.clear();
    for (const record of store.loadIdentityTokens()) {
      identityTokens.set(record.tokenHash, record.userId);
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

    ensureBotUser();
    ensureAllMeshIdentities();
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
   * Drop expired entries from the per-IP rate-limit maps: the claim and panic attempt limiters and
   * the new-identity budget. Each keys on source IP and is written only on its semantic path, so
   * without periodic pruning a long-lived node facing many distinct peers would retain one dead entry
   * per IP forever. Runs on the 30s reaper timer, bounding growth to the IPs active within a single
   * window rather than every IP ever seen (docs/15 #9). Behaviour is otherwise unchanged: an expired
   * entry and a pruned one both reset on the next access.
   */
  function pruneExpiredRateLimiters(): void {
    const now = Date.now();
    for (const counters of [claimAttempts, panicAttempts, identityMintCounters]) {
      for (const [key, entry] of counters) {
        if (entry.resetAt <= now) {
          counters.delete(key);
        }
      }
    }
  }

  /**
   * Execute the kill switch: wipe all persisted and in-memory data (messages, users, channels,
   * sessions, avatar files), signal connected clients to purge their local caches, close their
   * sockets, and re-seed the node's defaults so it comes back factory-fresh. Config (including the
   * kill-switch settings themselves) survives — the wipe destroys data, not settings.
   */
  async function executeKillSwitch(): Promise<void> {
    // Invalidate any in-flight sync round up front (before the first await here): a pull that resumes
    // after this point will see the changed generation and bail instead of writing peer data back
    // onto the store we're about to wipe (docs/15 #2).
    wipeGeneration += 1;

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
    // Drop every secure identity token (docs/20): the DB rows are gone (wipeAll / encrypted file delete),
    // so clear the in-memory mirror too — no wiped identity can be resumed after an emergency reset.
    identityTokens.clear();
    claimAttempts.clear();
    panicAttempts.clear();

    broadcast({ type: "wipe" });

    for (const { socket } of sockets) {
      socket.close();
    }

    sockets.clear();
    // Close any sockets still mid key-confirmation (docs/20 §7) — they never entered `sockets`, so the
    // loop above misses them; without this a socket could complete its proof after the wipe.
    for (const pending of [...pendingSockets]) {
      pending.close();
    }

    data = { users: [], channels: [], messages: [] };
    loadData();
    // Rotate the transport keypair + drop all live sessions: the old join QR stops working and no
    // captured session key survives the wipe (docs/08). loadData reloaded whatever was persisted
    // (the old key on an unencrypted wipe), so rotate explicitly to guarantee a fresh one on both paths.
    rotateTransportIdentity();
    // Drop cached puller-side sessions to peers too — RAM hygiene during an emergency wipe (docs/08).
    peerTransportSessions.clear();

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
  /** Drop sealed mailbox mail past its own `ttlExpiresAt` (independent of retention). Deleted +
   * tombstoned so a peer can't re-hand it; never broadcast (clients never saw the blob). This, with
   * the hop limit and per-carrier cap, is what makes carried mail converge instead of flood. Runs
   * regardless of `mesh.enabled` so turning mesh off doesn't strand already-expired sealed rows. */
  function reapExpiredSealed(): void {
    const now = Date.now();
    const expired = data.messages.filter(
      (message): message is SealedMessage => message.type === "sealed" && message.ttlExpiresAt <= now,
    );
    if (!expired.length) {
      return;
    }
    const ids = new Set(expired.map((message) => message.id));
    store.transaction(() => {
      for (const id of ids) {
        store.deleteMessage(id);
        store.addTombstone(id);
      }
    });
    for (const id of ids) {
      tombstones.add(id);
    }
    data.messages = data.messages.filter((message) => !ids.has(message.id));
    server.log.info(`Mesh reaper dropped ${ids.size} expired sealed message(s)`);
  }

  /**
   * Horizon GC for the `tombstones` table (docs/15 #7): a tombstone is added forever on every
   * delete (so sync/mesh never re-hands a locally deleted message back), which would otherwise
   * grow without bound on a long-lived node. Pruning is unconditional — not gated on
   * `sync.enabled` — because a delete made while sync is off must still block re-import once sync
   * or a mesh link comes on later; gating it reintroduces a moderation bypass. Runs on every
   * reaper tick, so a tombstone is only ever vulnerable to resurrection once its peer has been
   * unreachable for longer than the horizon.
   */
  function pruneTombstonesHorizon(): void {
    const cutoff = Date.now() - tombstoneHorizonMs;
    const pruned = store.pruneTombstonesOlderThan(cutoff);

    for (const id of pruned) {
      tombstones.delete(id);
    }

    if (pruned.length) {
      server.log.info(`Tombstone GC pruned ${pruned.length} entr${pruned.length === 1 ? "y" : "ies"} past the horizon`);
    }
  }

  function reapExpiredMessages(): void {
    reapExpiredSealed();
    pruneTombstonesHorizon();

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
      if (message.type !== "reaction" && message.type !== "sealed") {
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
    // Tombstone alongside the delete: a peer that still holds these must not re-import them. This is
    // unconditional (NOT gated on sync.enabled) — sync is a runtime toggle, so a node that deletes
    // while sync is off and joins a mesh later must still refuse the resurrected copy (docs/11). Bounding
    // tombstone growth is a horizon-GC problem, not a skip-when-off one (docs/15 #7).
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
      if (message.type !== "reaction" && message.type !== "sealed") {
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

    // Sealed mailbox mail (opportunistic-mesh, docs/16): syncable only when mesh is enabled, still
    // within its TTL, and with hop budget left. No channel/shadow-ban checks — it carries no channel
    // and its real author is sealed inside the ciphertext.
    if (message.type === "sealed") {
      return appConfig.mesh.enabled && message.ttlExpiresAt > Date.now() && message.hopLimit > 0;
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
      messages: data.messages
        .filter((message) => message.type !== "sealed" && isSyncableMessage(message))
        .map((message) => ({
          id: message.id,
          ...(message.editedAt !== undefined ? { editedAt: message.editedAt } : {}),
        })),
      // Sealed mailbox mail on offer — only when mesh is enabled (else the array is omitted and the
      // digest is byte-identical to today). Tag/TTL/hop up front so a puller decides before fetching.
      ...(appConfig.mesh.enabled
        ? {
            sealed: data.messages
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

  /** The shared sync-token header (if configured), presented so a token-guarded peer will serve us and
   * harmless when the peer runs open. Under transport encryption this rides INSIDE the sealed session. */
  function peerSyncHeaders(): Record<string, string> {
    return appConfig.sync.token ? { "x-loam-sync-token": appConfig.sync.token } : {};
  }

  /** Handshake a fresh transport session against a peer (honouring any operator-pinned key) and cache
   * it. The pinned key comes from the peer's own sync-config entry (`SyncPeer.transportKey`). */
  async function handshakePeerAndCache(peerUrl: string): Promise<PeerTransportSession> {
    const pinnedKey = appConfig.sync.peers.find((peer) => peer.url === peerUrl)?.transportKey;
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
    const pinnedKey = appConfig.sync.peers.find((peer) => peer.url === peerUrl)?.transportKey;
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

    const pinnedKey = appConfig.sync.peers.find((peer) => peer.url === peerUrl)?.transportKey;

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
      syncToken: appConfig.sync.token,
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

      const existing = data.users.find((candidate) => candidate.id === user.id);
      if (existing) {
        // Trust-on-first-use: adopt a valid key the FIRST time we see one for a known user, but never
        // overwrite an existing key from a later (possibly hostile) sync — a peer can't silently rebind
        // a user we already hold a key for.
        if (!existing.identityKey && importedKey) {
          const next = UserSchema.parse({ ...existing, identityKey: importedKey });
          store.upsertUser(next);
          Object.assign(existing, next);
          broadcast({ type: "userUpserted", user: existing });
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
      store.upsertUser(sanitized);
      data.users.push(sanitized);
      broadcast({ type: "userUpserted", user: sanitized });
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
      const filePath = join(attachmentsDir, attachmentFileName(attachment));

      try {
        await stat(filePath);
        continue; // already have it
      } catch {
        // fall through to fetch
      }

      try {
        const bytes = await fetchPeerAttachmentBytes(peerUrl, attachment);

        if (
          bytes.length > attachmentMaxBytes ||
          !bytes.length ||
          !avatarImageHasExpectedSignature(bytes, attachment.mimeType)
        ) {
          continue;
        }

        // A kill switch during the fetch just deleted the attachments dir — don't recreate it and
        // write an orphaned file the wipe was meant to destroy (docs/15 #2).
        if (wipeGeneration !== generation) {
          return;
        }

        await mkdir(attachmentsDir, { recursive: true });
        await writeFile(filePath, bytes);

        // ...and if the wipe landed *during* the write, remove the file we just orphaned.
        if (wipeGeneration !== generation) {
          await rm(filePath, { force: true });
          return;
        }
      } catch {
        // Best-effort at import time: the fetch genuinely failed (peer unreachable, attachment gone, or a
        // transient error). The message still imports; the image stays absent (the puller only re-requests
        // messages it lacks, so an imported message's attachment isn't retried) — acceptable off-grid,
        // where the text is the payload that matters. The required-mode 401 that dropped EVERY attachment
        // is the case this path now fixes.
      }
    }
  }

  // ---- Opportunistic mesh: sealed mailbox (docs/16) ----------------------------------------------
  // Sealed mail is end-to-end encrypted to a single recipient's key: intermediaries carry opaque
  // bytes, only the recipient's home node can open it. All of this is gated on `mesh.enabled`; with
  // it off nothing below runs and the public-data flow is byte-identical to today.

  const MESH_EPOCH_WINDOW_MS = 24 * 3_600_000; // daily routing-tag epoch
  const MESH_SENTINEL_AUTHOR = "mesh.sealed"; // opaque authorId on a sealed message (real sender is inside)
  // Local users' mesh keypairs (userId → identity), mirrored from the store. Secret keys stay here.
  const meshIdentities = new Map<string, MeshIdentity>();

  function loadMeshIdentities(): void {
    for (const { userId, data: json } of store.loadMeshIdentities()) {
      try {
        meshIdentities.set(userId, JSON.parse(json) as MeshIdentity);
      } catch {
        // Skip a corrupt row rather than crash boot.
      }
    }
  }

  // Per-local-user mesh address book (ownerUserId → recipient meshId → the recipient's card). A card
  // carries the contact's secret mailbox token, so it lives here (not on the public user record) and is
  // exchanged deliberately (QR/paste), never synced. Sealing to a contact is the ONLY send path: it
  // needs the token, and the card's self-certifying meshId defeats the key-substitution a synced
  // identityKey couldn't (docs/16).
  const meshContacts = new Map<string, Map<string, MeshIdentityCard>>();

  function loadMeshContacts(): void {
    for (const { ownerUserId, meshId, data: json } of store.loadMeshContacts()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch {
        continue; // corrupt JSON — skip rather than crash boot
      }
      // Re-validate on the way in: a stored row could have been tampered with. The card must parse,
      // its row key must match the card's own id, and it must still be self-certifying + key-bound —
      // exactly the checks addMeshContact applied before it was ever stored.
      const result = MeshIdentityCardSchema.safeParse(parsed);
      if (
        !result.success ||
        result.data.meshId !== meshId ||
        meshIdFromSignPublic(result.data.sign) !== result.data.meshId ||
        !verifyKxBinding(result.data.sign, result.data.kx, result.data.kxSig)
      ) {
        continue;
      }
      let book = meshContacts.get(ownerUserId);
      if (!book) {
        book = new Map();
        meshContacts.set(ownerUserId, book);
      }
      book.set(meshId, result.data);
    }
  }

  /** Mint (if needed) and publish a local human user's mesh identity — the public keys land on the
   * user's `identityKey` so senders on other nodes can seal mail to them. No-op when mesh is off. */
  function ensureMeshIdentity(userId: string): MeshIdentity | undefined {
    if (!appConfig.mesh.enabled) {
      return undefined;
    }

    const user = data.users.find((candidate) => candidate.id === userId);
    if (!user || user.type !== "human" || user.banned) {
      return undefined;
    }

    let identity = meshIdentities.get(userId);
    if (!identity) {
      identity = createMeshIdentity();
      meshIdentities.set(userId, identity);
      store.upsertMeshIdentity(userId, JSON.stringify(identity));
    }

    const identityKey = {
      alg: "ed25519" as const,
      sign: identity.signPublic,
      kx: identity.kxPublic,
      kxSig: identity.kxSig,
    };
    if (JSON.stringify(user.identityKey) !== JSON.stringify(identityKey)) {
      const next = UserSchema.parse({ ...user, identityKey });
      store.upsertUser(next);
      Object.assign(user, next);
      broadcast({ type: "userUpserted", user });
    }
    return identity;
  }

  /** Publish mesh identities for every eligible local user (boot + whenever mesh is enabled). */
  function ensureAllMeshIdentities(): void {
    if (!appConfig.mesh.enabled) {
      return;
    }
    for (const user of data.users) {
      if (user.type === "human" && !user.banned) {
        ensureMeshIdentity(user.id);
      }
    }
  }

  /** Immutable relay metadata authenticated by the envelope (AEAD AAD + inner signature): a carrier
   * can't extend the TTL or retarget the tag without breaking decryption. (v1 binds toTag+TTL; the
   * original hop budget is bounded by the schema max instead — docs/16.) */
  function sealedAad(toTag: string, ttlExpiresAt: number): string {
    return `${toTag}|${ttlExpiresAt}`;
  }

  /** Routing tags a local identity answers to across the live TTL window (+ one epoch clock-skew).
   * Derived from the identity's SECRET mailbox token, so only the recipient and the senders it handed
   * a card to can compute them — a passive carrier holding the sealed blob cannot correlate it to a
   * recipient (metadata-unlinkability; docs/16 §2). A sender computes the same tag from the contact's
   * `mailboxToken`, which it obtained out-of-band with the rest of the card. */
  function localTagsForWindow(identity: MeshIdentity, now: number): Set<string> {
    const tags = new Set<string>();
    const start = currentEpoch(now - appConfig.mesh.ttlMs, MESH_EPOCH_WINDOW_MS);
    const end = currentEpoch(now + MESH_EPOCH_WINDOW_MS, MESH_EPOCH_WINDOW_MS);
    for (let epoch = start; epoch <= end; epoch += 1) {
      tags.add(mailboxTag(identity.mailboxToken, epoch));
    }
    return tags;
  }

  /** Ensure a display record exists for a remote mesh sender and make it resolvable to `recipientUserId`
   * ONLY — never via the shared roster or a global broadcast. Putting a mesh sender on the public
   * roster would leak that some local user just received sealed mail (docs/16); `visibleUsers` hides
   * these ids from everyone but the recipients they've mailed, and this notifies just the recipient. */
  function ensureMeshSenderUser(meshId: string, recipientUserId: string): void {
    let user = data.users.find((candidate) => candidate.id === meshId);
    if (!user) {
      // Persist first, then mirror in memory — but no global broadcast (unlike ensureUser).
      user = makeUser(meshId);
      store.upsertUser(user);
      data.users.push(user);
    }
    // Idempotent on the recipient's client; sent every delivery so a second recipient of the same
    // sender still learns the record without it ever reaching a third party.
    sendEventToUsers(new Set([recipientUserId]), { type: "userUpserted", user: publicUser(user) });
  }

  /** Deliver an opened sealed message to a local user as an ordinary DM from the sender's mesh id. */
  function deliverSealedAsDm(recipientUserId: string, senderMeshId: string, plaintext: string, now: number): void {
    ensureMeshSenderUser(senderMeshId, recipientUserId); // display-only, recipient-scoped (not the shared roster)
    const dm = MessageSchema.parse({
      id: newMessageId("mesh"),
      type: "dm",
      authorId: senderMeshId,
      recipientUserId,
      body: plaintext,
      createdAt: now,
      meta: { source: "system" },
    });
    store.insertMessage(dm);
    data.messages.push(dm);
    broadcast({ type: "messageCreated", message: dm });
  }

  /** Try to open a sealed blob for one of our local users and deliver it. Returns true when it was
   * ours (delivered + tombstoned so it isn't re-imported or carried further). */
  function tryDeliverSealed(message: SealedMessage): boolean {
    const now = Date.now();
    if (message.ttlExpiresAt <= now) {
      return false;
    }

    const aad = sealedAad(message.toTag, message.ttlExpiresAt);
    for (const [recipientUserId, identity] of meshIdentities) {
      if (!localTagsForWindow(identity, now).has(message.toTag)) {
        continue; // cheap tag pre-check before an ECDH decrypt attempt
      }
      const opened = openMailbox({ blob: message.sealed, recipientKxSecret: identity.kxSecret, aad });
      if (!opened) {
        continue; // not actually ours, or tampered
      }
      deliverSealedAsDm(recipientUserId, opened.senderMeshId, opened.plaintext, now);
      store.addTombstone(message.id);
      tombstones.add(message.id);
      return true;
    }
    return false;
  }

  /** Handle a sealed message pulled from a peer: deliver locally, else relay onward (hop-decremented,
   * bounded), else drop. Never broadcast to clients. Returns true when accepted (delivered or carried). */
  function acceptSealedFromPeer(message: SealedMessage): boolean {
    if (!appConfig.mesh.enabled) {
      return false;
    }
    const now = Date.now();
    if (message.ttlExpiresAt <= now || message.hopLimit <= 0 || tombstones.has(message.id)) {
      return false;
    }
    if (data.messages.some((candidate) => candidate.id === message.id)) {
      return false; // already hold it
    }
    if (tryDeliverSealed(message)) {
      return true;
    }
    // Not for a local user → carry it onward, if this node relays and has room.
    if (!appConfig.mesh.relay) {
      return false;
    }
    const carried = data.messages.reduce((count, candidate) => count + (candidate.type === "sealed" ? 1 : 0), 0);
    if (carried >= appConfig.mesh.maxCarried) {
      return false; // at capacity — refuse new mail (soonest-to-expire eviction is a v2 refinement)
    }
    const relayed = MessageSchema.parse({ ...message, hopLimit: message.hopLimit - 1 });
    store.insertMessage(relayed);
    data.messages.push(relayed);
    return true; // opaque — no client broadcast
  }

  /** Verify and store a mesh contact card in `ownerUserId`'s address book. Rejects a card whose
   * self-certifying `meshId` doesn't derive from its signing key, or whose `kxSig` doesn't bind its
   * agreement key — the two checks that make sealing to a contact immune to key substitution. The
   * card (name included) stays in the caller's private address book; it is NOT promoted to a shared
   * roster user, so one local user's contacts aren't exposed to the others. Returns an error string
   * on failure. */
  function addMeshContact(ownerUserId: string, card: MeshIdentityCard): string | undefined {
    if (meshIdFromSignPublic(card.sign) !== card.meshId) {
      return "This mesh card is invalid (id does not match its key).";
    }
    if (!verifyKxBinding(card.sign, card.kx, card.kxSig)) {
      return "This mesh card is invalid (key binding failed).";
    }
    let book = meshContacts.get(ownerUserId);
    if (!book) {
      book = new Map();
      meshContacts.set(ownerUserId, book);
    }
    // Bound the address book so an authenticated client can't grow mesh_contacts without limit.
    // Re-adding an existing contact (a key/name refresh) is always allowed — only NEW ids are capped.
    if (!book.has(card.meshId) && book.size >= appConfig.mesh.maxContacts) {
      return "Your mesh contact list is full.";
    }
    // Persist first, then mirror in memory — if the store write throws, the book doesn't diverge.
    store.upsertMeshContact(ownerUserId, card.meshId, JSON.stringify(card));
    book.set(card.meshId, card);
    return undefined;
  }

  /** The current user's own shareable mesh identity card — public keys PLUS the secret mailbox token,
   * so a recipient can be sealed to. Returned only over the authenticated identity endpoint. */
  function meshIdentityCard(identity: MeshIdentity, displayName: string): MeshIdentityCard {
    return {
      meshId: identity.meshId,
      alg: "ed25519",
      sign: identity.signPublic,
      kx: identity.kxPublic,
      kxSig: identity.kxSig,
      mailboxToken: identity.mailboxToken,
      displayName,
    };
  }

  /** Seal a message to a contact (a card the sender previously added) and inject it into the mesh:
   * delivered immediately if the recipient is local, else stored for sync to carry. Returns an error
   * string on failure. */
  function sendSealed(sender: MeshIdentity, contact: MeshIdentityCard, body: string): string | undefined {
    // Bound self-originated mail by the same per-node storage cap as relayed mail, so a local
    // participant can't fill the store with undeliverable sealed blobs (they persist until TTL).
    const carried = data.messages.reduce((count, message) => count + (message.type === "sealed" ? 1 : 0), 0);
    if (carried >= appConfig.mesh.maxCarried) {
      return "This node's sealed-mail queue is full; try again later.";
    }
    const now = Date.now();
    const ttlExpiresAt = now + appConfig.mesh.ttlMs;
    const toTag = mailboxTag(contact.mailboxToken, currentEpoch(now, MESH_EPOCH_WINDOW_MS));
    const aad = sealedAad(toTag, ttlExpiresAt);
    const blob = sealMailbox({
      recipientKxPublic: contact.kx,
      sender: { signPublic: sender.signPublic, signSecret: sender.signSecret, kxPublic: sender.kxPublic },
      plaintext: body,
      aad,
    });
    const message = MessageSchema.parse({
      id: newMessageId("seal"),
      type: "sealed",
      authorId: MESH_SENTINEL_AUTHOR,
      toTag,
      sealed: blob,
      ttlExpiresAt,
      hopLimit: appConfig.mesh.hopLimit,
      createdAt: now,
    }) as SealedMessage;

    // If the recipient is local, deliver now; otherwise store it so the sync layer carries it.
    if (!tryDeliverSealed(message)) {
      store.insertMessage(message);
      data.messages.push(message);
    }
    return undefined;
  }

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
      if (message.type === "dm" || message.meta?.streaming || tombstones.has(message.id)) {
        continue;
      }

      // Never import content attributed to one of *our* admins/moderators/greeters — a compromised or
      // hostile peer could otherwise inject a message that renders as authored by this node's admin
      // (local ids are discoverable; they're exported as message authorIds in the sync digest).
      if (isLocallyAuthoritative(message.authorId)) {
        continue;
      }

      // Sealed mailbox mail (opportunistic-mesh, docs/16) is handled entirely apart from the public
      // flow: it's never broadcast to clients — it's decrypted-and-delivered to a local recipient, or
      // relayed onward (hop-decremented, bounded), or dropped. Never falls through to store+broadcast.
      if (message.type === "sealed") {
        if (acceptSealedFromPeer(message)) {
          imported += 1;
        }
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

        await importPeerAttachments(peerUrl, message, generation);
        // A kill switch during the attachment fetch just wiped the store — stop before we insert
        // this (and any later) message back onto it (docs/15 #2).
        if (wipeGeneration !== generation) {
          return imported;
        }
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
    // Snapshot the wipe generation: if a kill switch fires mid-round, every post-await check below
    // abandons the round rather than writing peer data back onto the wiped store (docs/15 #2).
    const generation = wipeGeneration;
    const status = peerSyncStatus.get(peer.url) ?? { imported: 0 };
    peerSyncStatus.set(peer.url, status);
    status.lastAttemptAt = Date.now();

    try {
      const digest = await fetchPeerJson(peer.url, "/api/sync/digest", SyncDigestSchema);
      if (wipeGeneration !== generation) {
        return;
      }

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

      // Sealed mailbox mail on offer: pull a blob only if it's addressed to a local identity (a tag
      // match) or this node relays and has room — never mail that's neither ours nor carriable.
      if (appConfig.mesh.enabled && digest.sealed?.length) {
        const now = Date.now();
        const localTags = new Set<string>();
        for (const identity of meshIdentities.values()) {
          for (const tag of localTagsForWindow(identity, now)) {
            localTags.add(tag);
          }
        }
        const carried = data.messages.reduce((count, message) => count + (message.type === "sealed" ? 1 : 0), 0);
        const canRelay = appConfig.mesh.relay && carried < appConfig.mesh.maxCarried;
        for (const entry of digest.sealed) {
          if (tombstones.has(entry.id) || localById.has(entry.id) || entry.ttlExpiresAt <= now || entry.hopLimit <= 0) {
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
        if (wipeGeneration !== generation) {
          return;
        }
        importPeerUsers(payload.users);
        imported += await importPeerMessages(peer.url, payload.messages, generation);
        if (wipeGeneration !== generation) {
          return;
        }
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

  try {
    await loadAppConfig();
    loadData();
    reapExpiredMessages();
  } catch (error) {
    // Startup aborted (e.g. `loadAppConfig` fails closed on an invalid config source) — release the SQLite
    // handle opened above so a rejected `buildApp` doesn't leak an open store / lock file (matters under
    // repeated test builds and a supervisor that retries boot).
    store.close();
    throw error;
  }

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

    // Drop expired per-IP rate-limit entries (identity budget + claim/panic attempt limiters) so the
    // maps can't grow unbounded across many source IPs (docs/15 #9).
    pruneExpiredRateLimiters();

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
  // ---- Transport encryption (docs/08): transparently decrypt requests / encrypt responses ----------
  // With a live transport session (from POST /api/transport/handshake), the client sends request
  // bodies as { enc: <sealed> } and gets responses back the same way, so plain HTTP carries only
  // ciphertext for message/DM/config CONTENT. GET request paths + query strings and image bytes remain
  // visible (metadata); that's the documented Layer-1 scope. All inert when the mode is `off`.
  server.addHook("onRequest", async (request, reply) => {
    // An internal tunnel re-dispatch runs plaintext inside the process — never enforce/decrypt it
    // (its response is sealed by the outer tunnel request instead). Checked before anything else so
    // it holds in every mode.
    if (isInternalTunnelRequest(request)) {
      return; // trusted internal re-dispatch — its x-loam-internal/x-loam-user headers are legitimate
    }
    // This request is EXTERNAL: strip the trusted internal headers so a client can never forge identity
    // or the tunnel bypass (docs/20 — defence in depth; the resolver already gates x-loam-user on the
    // internal token, but these must never reach a handler on an external request).
    delete request.headers["x-loam-internal"];
    delete request.headers["x-loam-user"];

    const mode = appConfig.security.transportEncryption;
    if (mode === "off") {
      return;
    }
    const activeSession = transportSessionForRequest(request);
    const presentedSessionId = request.headers["x-loam-enc"];
    if (activeSession) {
      transportRequestKeys.set(request, activeSession.key);
      transportRequestSessions.set(request, activeSession);
    } else if (typeof presentedSessionId === "string" && presentedSessionId.length > 0) {
      // The client presented a transport session that is unknown/expired (server restart or 12h TTL).
      // Refuse with 401 in BOTH modes so its re-handshake path fires, rather than silently serving or
      // accepting plaintext — which in `optional` mode would downgrade the wire while the client's UI
      // still shows "encrypted" (docs/08).
      return reply.code(401).send(errorBody("Transport session expired"));
    }

    // Content is reachable ONLY through the internal tunnel dispatch (which returned above) — so a DIRECT
    // external hit on a content route is refused, making a captured credential inert (docs/20). This fires
    // when EITHER the node globally requires encryption OR the resolved session is `bound` — the secure
    // rules key off session state, not just global mode (docs/20 §2), so a bound session on an `optional`
    // node is still tunnel-only (never serving its content directly / by cookie). Bootstrap/health/
    // handshake/resume/logout/tunnel stay directly reachable.
    const boundSession = activeSession?.authMode === "bound";
    if ((mode === "required" || boundSession) && requiresTransportSession(request)) {
      // Node-to-node sync is reachable via a DIRECT sealed request rather than the identity tunnel: it is
      // sync-token-authed public data with no user identity to bind (docs/08/11/20 — see
      // `DIRECT_SEALED_SYNC_ROUTES`). It still must be sealed — a sync route reached WITHOUT a resolved
      // transport session has no `activeSession` here and falls through to the 401, so plaintext sync is
      // still refused in `required` mode.
      if (activeSession && DIRECT_SEALED_SYNC_ROUTES.has(request.routeOptions?.url ?? "")) {
        return;
      }
      return reply.code(401).send(errorBody("This node requires an encrypted session. Scan the join QR to connect."));
    }
  });

  server.addHook("preValidation", async (request, reply) => {
    const key = transportRequestKeys.get(request);
    if (!key) {
      return;
    }
    // An encrypted request carries { enc: "<sealed>" }; a GET may carry no body (response-only sealing).
    const body = request.body as { enc?: unknown } | undefined;
    if (body && typeof body.enc === "string") {
      const opened = openTransport(key, body.enc, `${request.method} ${request.url}`);
      if (opened === null) {
        return reply.code(400).send(errorBody("Malformed encrypted request"));
      }
      // The sealed plaintext is a `{ s: <seq>, b?: <body> }` envelope (docs/08): `s` is a per-session
      // monotonic sequence for replay protection, `b` the actual request body (omitted for a bodyless
      // mutation). `s` lives INSIDE the AEAD, so it's authenticated — an attacker can't renumber a
      // replay to dodge the window without breaking the tag.
      let envelope: { s?: unknown; b?: unknown; tok?: unknown };
      try {
        envelope = JSON.parse(opened) as { s?: unknown; b?: unknown; tok?: unknown };
      } catch {
        return reply.code(400).send(errorBody("Malformed encrypted request"));
      }
      const activeSession = transportRequestSessions.get(request);
      if (!activeSession || typeof envelope.s !== "number" || !acceptTransportSeq(activeSession, envelope.s)) {
        // Replayed, reordered beyond the window, or a missing/garbage sequence — refuse before the
        // handler runs. 409 (not 401) so a legitimate client doesn't mistake it for an expired session
        // and silently re-handshake+retry: a real client never reuses a sequence, so this fires only on
        // a captured-and-replayed request (docs/08).
        return reply.code(409).send(errorBody("Replayed or out-of-order encrypted request"));
      }
      transportRequestSeq.set(request, envelope.s);
      // A sealed node-to-node sync request carries the `sync.token` INSIDE the envelope (docs/08) — stash it
      // (authenticated by the AEAD) for `syncPeerAuthorized`, which prefers it over any wire header.
      if (typeof envelope.tok === "string") {
        transportRequestSyncToken.set(request, envelope.tok);
      }
      request.body = envelope.b;
      return;
    }
    // A GET/HEAD may legitimately carry no body at all (response-only sealing) — nothing to enforce.
    // But a mutation (POST/PATCH/DELETE/PUT) presented under a resolved transport session MUST arrive
    // as a sealed envelope: without this, a request that carries a live/known session id (visible on
    // the wire in the `x-loam-enc` header) alongside a plain, attacker-supplied JSON body would just
    // run as-is — an active network attacker could inject or rewrite a mutation's body without ever
    // needing the session key, defeating the whole point of the encrypted session. The client always
    // seals mutations, including bodyless ones (an empty envelope), so a legitimate request is never
    // affected (docs/08).
    if (request.method !== "GET" && request.method !== "HEAD") {
      return reply.code(400).send(errorBody("Encrypted session requires a sealed request body"));
    }
  });

  server.addHook("onSend", async (request, reply, payload) => {
    const key = transportRequestKeys.get(request);
    // Only seal string payloads (JSON) — binary bodies (images, static files) pass through, and can't
    // be app-decrypted by a browser <img> anyway (a documented Layer-1 limitation).
    if (!key || typeof payload !== "string") {
      return payload;
    }
    // Bind a node-to-node sync RESPONSE to the request's authenticated sequence (docs/08 / Sol round-2 #1):
    // sealing under `${method} ${url}#${seq}` means a captured response can't be replayed or cross-fed to a
    // different request on the same route (the puller opens with the exact seq it sent). Scoped to the
    // direct-sealed sync routes — the browser's own direct/tunnel paths are unchanged. (`transportRequestSeq`
    // is always set for a sync request, since every sealed sync request now carries a `{ s }` envelope.)
    const seq = transportRequestSeq.get(request);
    const routeUrl = request.routeOptions?.url;
    const responseAad =
      seq !== undefined && routeUrl !== undefined && DIRECT_SEALED_SYNC_ROUTES.has(routeUrl)
        ? `${request.method} ${request.url}#${seq}`
        : `${request.method} ${request.url}`;
    const sealed = sealTransport(key, payload, responseAad);
    reply.header("content-type", "application/json; charset=utf-8");
    reply.header("x-loam-enc", "1");
    return JSON.stringify({ enc: sealed });
  });

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
    // Internal tunnel re-dispatches are already bounded by the outer tunnel request that spawned them
    // (and all share the loopback IP), so exempt them rather than double-counting / self-throttling.
    allowList: (request) => isInternalTunnelRequest(request as FastifyRequest),
  });
  await server.register(fastifyWebsocket);
  await registerStaticFiles();

  // Liveness probe that mints NO identity — the Android host launcher polls this before loading the
  // WebView. Polling /api/config here would consume the one-time `firstUser` admin grant with a
  // throwaway loopback session, leaving the real operator (and the kill switch) locked out.
  server.get("/api/health", async () => ({ ok: true }));

  // Public, cookie-free bootstrap (docs/20). Returns ONLY public data — node name, version, connection
  // details, and the network config (which advertises the transport mode + host public key). Mints NO
  // identity and sets NO cookie, so a `required`/bound client can learn how to connect before it has a
  // session, and no bearer credential is ever established over plaintext. The client fetches this FIRST,
  // with `credentials: "omit"`. Unlike `/api/config`, it never returns `currentUser`.
  server.get("/api/bootstrap", async () => ({
    nodeName: appConfig.node.name,
    version: options.version ?? "dev",
    joinUrl: `http://${joinHost}:${clientPort}`,
    websocketPath: "/ws",
    networkConfig: currentNetworkConfig(),
  }));

  server.get("/api/config", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));

    return {
      nodeName: appConfig.node.name,
      version: options.version ?? "dev",
      joinUrl: `http://${joinHost}:${clientPort}`,
      websocketPath: "/ws",
      currentUser: rolesVisibleUser(currentUser),
      networkConfig: currentNetworkConfig(),
    };
  });

  // Transport handshake (docs/08): client sends its ephemeral X25519 public key; the host derives a
  // session key against its static transport key + a fresh ephemeral and returns its ephemeral public
  // + a session id (used in `x-loam-enc` on subsequent encrypted requests). Unauthenticated (it's
  // bootstrap, before any session), rate-limited, and 404 when transport encryption is off.
  server.post(
    "/api/transport/handshake",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (appConfig.security.transportEncryption === "off") {
        return reply.code(404).send(errorBody("Not found"));
      }

      const body = TransportHandshakeRequestSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send(errorBody("Invalid handshake request"));
      }

      const identity = ensureTransportIdentity();
      let accepted: { hostEphemeralPublic: string; sessionKey: string };
      try {
        accepted = transportServerAccept({
          hostSecret: identity.secretKey,
          clientEphemeralPublic: body.data.clientEphemeralPublic,
        });
      } catch {
        return reply.code(400).send(errorBody("Invalid handshake request"));
      }

      // Prune expired sessions on every handshake (cheap — handshakes are already rate-limited per
      // IP), then enforce a hard cap: if still at/over it, evict the oldest live sessions to make room
      // rather than letting the map grow without bound. Map iteration order is insertion order, and
      // every session shares the same TTL, so the earliest-inserted entries are also the
      // earliest-expiring — evicting from the front is a reasonable least-recently-established policy.
      const now = Date.now();
      for (const [id, existingSession] of transportSessions) {
        if (existingSession.expiresAt <= now) {
          transportSessions.delete(id);
          closeSocketsForTransportSession(id);
        }
      }
      while (transportSessions.size >= TRANSPORT_SESSION_CAP) {
        const oldest = transportSessions.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        transportSessions.delete(oldest);
        closeSocketsForTransportSession(oldest);
      }

      const sessionId = randomUUID();
      transportSessions.set(sessionId, {
        key: accepted.sessionKey,
        expiresAt: Date.now() + TRANSPORT_SESSION_TTL_MS,
        maxSeq: 0,
        seen: new Set(),
        authMode: "anonymous",
      });
      return {
        sessionId,
        hostEphemeralPublic: accepted.hostEphemeralPublic,
        hostPublicKey: identity.publicKey,
      };
    },
  );

  // Sealed identity resume + session binding (docs/20). A DIRECT sealed endpoint (not tunnelled) so the
  // outer TransportSession is reachable while there's no user yet. It requires a live transport session
  // (onRequest resolves it; preValidation decrypts + replay-checks the sealed `{ s, b }` body into the
  // `{ token? }` payload), and binds identity to that SESSION — so the un-sniffable session key becomes
  // the credential. It NEVER accepts a legacy cookie token. The `{ currentUser, token }` response is
  // sealed by onSend, so the secure token only ever crosses the wire encrypted.
  server.post("/api/session/resume", async (request, reply) => {
    const activeSession = transportRequestSessions.get(request);
    if (!activeSession) {
      // Reachable only with a live, sealed session (its body was decrypted). A plaintext hit is refused.
      return reply.code(400).send(errorBody("Resume requires an encrypted session"));
    }

    // Idempotent: a fresh-sequence retry after a lost response returns the cached identity — never a
    // second mint, never a rebind to a different identity. Re-stamp the response's bound sequence `s` to
    // THIS request's sequence (docs/20 §9) so a retrying client's response-binding check passes — the
    // user + token are identical, only the sequence it answers differs. `m`/`p` are constant.
    if (activeSession.authMode === "bound") {
      if (!activeSession.resumeResult) {
        return reply.code(409).send(errorBody("Session already bound"));
      }
      return { ...activeSession.resumeResult, s: transportRequestSeq.get(request) };
    }

    const body = request.body as { token?: unknown } | undefined;
    const rawToken = body?.token;
    // A `token` that is present but not a string ({token:123}, {token:{}}, …) is a malformed request — a
    // hard 400, not a silent mint (which would fragment an incompatible client's identity, docs/20 review).
    if (rawToken !== undefined && typeof rawToken !== "string") {
      return reply.code(400).send(errorBody("Invalid identity token"));
    }
    // Absent or empty-string → mint (an empty string is never a real 256-bit token); a non-empty string →
    // resume. Empty is treated as "no token" rather than "nonempty invalid" so an odd client isn't 401-looped.
    const presentedToken = typeof rawToken === "string" && rawToken.length > 0 ? rawToken : undefined;

    let userId: string;
    let token: string;
    let tokenHash: string;
    if (presentedToken !== undefined) {
      tokenHash = hashIdentityToken(presentedToken);
      const resumed = identityTokens.get(tokenHash);
      if (!resumed) {
        // A non-empty but unknown/revoked token is an explicit auth failure — NEVER silently mint (that
        // would let a client launder a stolen-then-revoked token into a fresh working identity).
        return reply.code(401).send(errorBody("Invalid identity token"));
      }
      userId = resumed;
      token = presentedToken;
    } else {
      // First contact on this device: mint a new anonymous identity + a fresh secure token (the per-IP
      // identity-mint budget bounds it, exactly like a cookie mint).
      if (!consumeIdentityBudget(request.ip)) {
        throw new IdentityLimitError();
      }
      userId = makeSessionUserId();
      token = makeIdentityToken();
      tokenHash = hashIdentityToken(token);
      identityTokens.set(tokenHash, userId);
      store.putIdentityToken(tokenHash, userId, Date.now());
    }

    const currentUser = ensureSessionUser(userId);
    // Bind identity to this transport session — `authMode:"bound"` is what activates the secure rules
    // (content only via the tunnel, no cookie, WS key-confirmation) for this session, independent of the
    // node's global mode.
    activeSession.authMode = "bound";
    activeSession.userId = userId;
    activeSession.identityTokenHash = tokenHash;
    // Bind the response to the request it answers (docs/20 §9). Resume's aad is the same for every resume
    // request, and the response carries the secret token, so the client MUST confirm this reply is for
    // the exact `{ s, m, p }` it sent before storing the token.
    const result = {
      s: transportRequestSeq.get(request),
      m: "POST",
      p: "/api/session/resume",
      currentUser: rolesVisibleUser(currentUser),
      token,
    };
    activeSession.resumeResult = result;
    return result;
  });

  // Sealed logout / device-wipe revocation (docs/20 §8). A DIRECT sealed endpoint (like resume) so it can
  // reach the outer bound session. Revokes THIS device's secure identity token — deletes its row, drops
  // the transport sessions it bound, and closes its sockets — so a later resume with the same token fails
  // (401) and the identity can't be rehydrated. The client calls this BEFORE wiping its local IndexedDB.
  server.post("/api/session/logout", async (request, reply) => {
    const activeSession = transportRequestSessions.get(request);
    if (!activeSession) {
      return reply.code(400).send(errorBody("Logout requires an encrypted session"));
    }
    // Only a bound session has a secure token to revoke; a cookie session logs out via /api/session/end.
    if (activeSession.authMode === "bound" && activeSession.identityTokenHash) {
      revokeIdentityToken(activeSession.identityTokenHash);
    }
    return { ok: true };
  });

  // Methods the tunnel may re-dispatch — the full set the REST API uses. Validated so the cast to
  // Fastify's inject method type is sound and no odd verb reaches `server.inject`.
  const TUNNELLABLE_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);

  // Transport tunnel (docs/08, "v2"): the strongest metadata-hiding mode. Instead of each request
  // going to its real path (leaking e.g. `/api/search?q=<plaintext>` or which channel is being read),
  // the client sends every post-handshake request as an opaque `POST /api/transport/tunnel` whose
  // sealed body is `{ m, p, body }` (method, real path+query, optional body). The server re-dispatches
  // it INTERNALLY via `server.inject` (carrying the caller's own cookie + the unforgeable internal
  // token, so authz is unchanged and the inner request skips transport enforcement) and returns the
  // inner response as a `{ status, contentType, bodyB64 }` descriptor — which the outer request's
  // `onSend` hook then seals, so status, headers, and body (base64 → binary images tunnel losslessly)
  // are all ciphertext on the wire. Replay protection rides the same `{ s, b }` envelope as any sealed
  // request (the `s` is checked in preValidation before this handler runs).
  server.post("/api/transport/tunnel", async (request, reply) => {
    // Only a request whose body was actually sealed (so preValidation resolved a session key) may
    // tunnel — refuse a plaintext hit so the endpoint can never dispatch on an attacker-supplied path
    // outside an authenticated session.
    if (!transportRequestKeys.has(request)) {
      return reply.code(400).send(errorBody("Tunnel requires an encrypted session"));
    }

    const payload = request.body as { m?: unknown; p?: unknown; body?: unknown } | undefined;
    const method = typeof payload?.m === "string" ? payload.m.toUpperCase() : undefined;
    const path = typeof payload?.p === "string" ? payload.p : undefined;
    // The target check MUST match how Fastify routes the path, not the raw string. `server.inject`
    // percent-decodes the path before routing, so a raw `startsWith`/`includes` check on `p` diverges
    // from the routed path — e.g. `/api/transp%6frt/tunnel` decodes to `/api/transport/tunnel`
    // (recursion into this handler) and `/api/%2e%2e/admin` decodes to a traversal, both slipping past a
    // raw check. So: reject an encoded slash outright (`%2f` restructures segments and Fastify won't
    // treat it as a separator — pure ambiguity, and LOAM's own API paths never contain one), then
    // validate the fully-DECODED path. The raw `path` is what's handed to `inject` (routed identically).
    let decodedPath: string | undefined;
    if (path !== undefined && !/%2f/i.test(path)) {
      try {
        decodedPath = decodeURIComponent(path.split("?", 1)[0]);
      } catch {
        decodedPath = undefined; // malformed %-escape
      }
    }
    if (
      !method ||
      !TUNNELLABLE_METHODS.has(method) ||
      !decodedPath ||
      !decodedPath.startsWith("/api/") ||
      decodedPath.startsWith("/api/transport/") ||
      decodedPath.includes("..")
    ) {
      return reply.code(400).send(errorBody("Invalid tunnel target"));
    }

    const hasBody = payload?.body !== undefined;
    const headers: Record<string, string> = { "x-loam-internal": internalTunnelToken };
    // Identity for the inner request depends on how this session authenticated (docs/20 §2):
    //  • bound  → carry `x-loam-user` (the session-key-proven identity); NEVER forward a cookie — a
    //    bound session's cookie is not a credential, so a sniffed one is inert.
    //  • anonymous → optional/off best-effort cookie-auth: forward the cookie as before. Under
    //    `required` mode an anonymous session may not tunnel content at all — it must resume first,
    //    else a captured cookie tunnelled through an attacker's own session would impersonate.
    const tunnelSession = transportRequestSessions.get(request);
    if (tunnelSession?.authMode === "bound" && tunnelSession.userId) {
      headers["x-loam-user"] = tunnelSession.userId;
    } else if (appConfig.security.transportEncryption === "required") {
      return reply.code(401).send(errorBody("Resume an identity before tunnelling content"));
    } else if (typeof request.headers.cookie === "string") {
      headers.cookie = request.headers.cookie;
    }
    if (hasBody) {
      headers["content-type"] = "application/json";
    }

    const injected = await server.inject({
      method: method as "GET",
      url: path,
      headers,
      // Forward the real caller's address so the inner request's `request.ip` is the client's, not
      // loopback — otherwise every tunnelled request would share one IP for the per-IP identity-mint
      // budget and the claim/panic limiters (one client could exhaust them for everyone).
      remoteAddress: request.ip,
      payload: hasBody ? JSON.stringify(payload?.body) : undefined,
    });

    // Forward a freshly-minted session cookie on the OUTER response for an ANONYMOUS optional-mode tunnel
    // (identity bootstrap through the tunnel) — the browser must see Set-Cookie to store it. A bound
    // session's inner request mints no cookie (identity came via `x-loam-user`), so there's nothing to
    // forward there.
    const setCookie = injected.headers["set-cookie"];
    if (setCookie !== undefined) {
      reply.header("set-cookie", setCookie);
    }

    // The onSend transport hook seals THIS descriptor (a JSON string) under the tunnel route's CONSTANT
    // aad, so the real status/content-type/body never appear in cleartext. Because the aad is the same
    // for every tunnel request, we BIND the response to the exact request it answers (docs/20 §9): the
    // authenticated sequence `s`, method `m`, and path `p` the client sealed. The client verifies these
    // before using the body — so an attacker can't cross-feed one in-flight response as another's. Body
    // is base64 for lossless binary.
    return {
      s: transportRequestSeq.get(request),
      m: method,
      p: path,
      status: injected.statusCode,
      contentType: injected.headers["content-type"] ?? "application/octet-stream",
      bodyB64: injected.rawPayload.toString("base64"),
    };
  });

  server.get("/api/users", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));
    const accessError = participationError(currentUser);

    if (accessError) {
      return reply.code(403).send(errorBody(accessError));
    }

    return visibleUsers(currentUser);
  });

  // End the caller's own session: invalidate the token server-side and clear the cookie. A device
  // wipe calls this so that a reload afterwards mints a FRESH identity instead of re-presenting the
  // same HttpOnly cookie (which JS can't clear) and re-hydrating the wiped identity (docs/15 #4).
  // Deliberately unauthenticated and side-effect-only — it never mints a session, and an absent or
  // unknown cookie is a no-op success.
  server.post("/api/session/end", async (request, reply) => {
    const token = readCookie(request.headers.cookie, sessionCookieName);
    if (token) {
      sessions.delete(token);
      store.deleteSession(token);
    }
    // Match the mint path's attributes (incl. conditional Secure over TLS) so the browser reliably
    // delete-matches and clears the cookie.
    const secure = request.protocol === "https";
    reply.header(
      "set-cookie",
      `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`,
    );
    return { ok: true };
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

    return data.users
      .filter((user) => user.type === "human" && user.pending === true)
      .map((user) => sanitizeUserFor(currentUser, user));
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

    return sanitizeUserFor(currentUser, applyUserModeration(user, { pending: false }));
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
    return sanitizeUserFor(currentUser, updated);
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
          message.type !== "reaction" &&
          message.type !== "sealed" &&
          !!message.attachments?.some((entry) => entry.id === attachment.id),
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
    // Sanitize like the roster: a non-moderator member must not learn another member's roles/shadowBan.
    return data.users.filter((user) => members.has(user.id)).map((user) => sanitizeUserFor(currentUser, user));
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
      return reply.code(400).send(errorBody("Invalid transfer request"));
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
  /**
   * True when a request arrived over the loopback interface. The opportunistic-mesh transport bridge
   * endpoints (`/api/mesh/outbound` + `/api/mesh/inbound`, docs/17) are for the **in-process** Android
   * launcher only — it fetches them over 127.0.0.1 to shuttle sealed blobs between the native
   * BLE/Wi-Fi-Aware radio and the already-built relay. Restricting them to loopback keeps a joiner on
   * the hotspot LAN from draining this node's sealed queue or injecting into it directly (that path
   * stays the token-guarded `/api/sync/*`). `trustProxy` is off by design (see the join-URL protocol
   * note above), so `request.ip` is the real socket peer and can't be spoofed via `x-forwarded-for`.
   */
  function requestFromLoopback(request: FastifyRequest): boolean {
    const ip = request.ip;
    return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  }

  function syncPeerAuthorized(request: FastifyRequest): boolean {
    const required = appConfig.sync.token;
    if (!required) {
      return true;
    }

    // An ENCRYPTED request (one that resolved a transport key) must authenticate ONLY via the token sealed
    // inside its `{ s, b, tok }` envelope — never a plaintext `x-loam-sync-token` header. Accepting the
    // header on a sealed session would let a captured token authorize an attacker's own encrypted session
    // by simply attaching it as a header, defeating the whole point of sealing it. The header is honoured
    // only on the plaintext (`off`-mode) path, which has no sealed channel to carry the token (docs/08).
    const encrypted = transportRequestKeys.has(request);
    const header = request.headers["x-loam-sync-token"];
    const provided = encrypted
      ? transportRequestSyncToken.get(request)
      : Array.isArray(header)
        ? header[0]
        : header;
    if (typeof provided !== "string") {
      return false;
    }

    const a = Buffer.from(provided);
    const b = Buffer.from(required);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // GET for a plaintext (`off`-mode) peer; POST for a sealed peer, which carries the `{ s, b, tok }`
  // envelope so the sync token is sealed and the request proves session-key possession (docs/08). The
  // handler ignores the (empty) POST body — it's the sealed envelope that matters. Registered as two
  // POSITIONAL routes rather than one `server.route({ config })` so CodeQL's missing-rate-limiting query
  // credits the per-route limit (it only recognises the `server.<method>(url, { config }, handler)` form).
  const syncDigestHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!appConfig.sync.enabled || !syncPeerAuthorized(request)) {
      return reply.code(404).send(errorBody("Not found"));
    }
    return buildSyncDigest();
  };
  server.get("/api/sync/digest", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, syncDigestHandler);
  server.post("/api/sync/digest", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, syncDigestHandler);

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
      // Sanitize author records before they cross to a peer: a peer operator has no more business
      // enumerating who holds authority here than a joiner does (`publicUser` strips roles +
      // shadowBanned), and an import strips authority regardless.
      const users = data.users.filter((user) => authorIds.has(user.id)).map(publicUser);
      return { messages, users };
    },
  );

  // A peer fetches a public-message attachment's bytes as base64 JSON here (docs/08) rather than the
  // tunnel-only binary `/api/attachments/:fileName`, so it rides the sealed transport channel (`onSend`
  // seals string payloads; a raw binary GET can't be app-sealed and is 401'd in required mode). Only
  // attachments on SYNCABLE (public, non-shadow-banned) messages are served — the same scope as the
  // messages export — so DM / private-channel attachments never cross.
  server.post(
    "/api/sync/attachment",
    { config: { rateLimit: { max: 240, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!appConfig.sync.enabled || !syncPeerAuthorized(request)) {
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
      const owningMessage = data.messages.find(
        (message) =>
          isSyncableMessage(message) &&
          message.type !== "reaction" &&
          message.type !== "sealed" &&
          !!message.attachments?.some((entry) => entry.id === attachment.id),
      );
      if (!owningMessage) {
        return reply.code(404).send(errorBody("Attachment does not exist"));
      }

      try {
        const bytes = await readFile(join(attachmentsDir, attachmentFileName(attachment)));
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
  server.get("/api/mesh/identity", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));
    const accessError = participationError(currentUser);

    if (accessError) {
      return reply.code(403).send(errorBody(accessError));
    }
    if (!appConfig.mesh.enabled) {
      return reply.code(404).send(errorBody("Not found"));
    }

    const identity = ensureMeshIdentity(currentUser.id);
    if (!identity) {
      return reply.code(400).send(errorBody("This user has no mesh identity"));
    }
    return meshIdentityCard(identity, currentUser.displayName);
  });

  // Add a mesh contact from a scanned/pasted identity card (docs/16). The card is re-verified
  // server-side (self-certifying id + kx binding) before storing, so a forged or substituted card
  // can't be added and later sealed to. 404 unless mesh is enabled (indistinguishable from absent).
  server.post(
    "/api/mesh/contacts",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const currentUser = ensureSessionUser(getSessionUserId(request, reply));
      const accessError = participationError(currentUser);

      if (accessError) {
        return reply.code(403).send(errorBody(accessError));
      }
      if (!appConfig.mesh.enabled) {
        return reply.code(404).send(errorBody("Not found"));
      }

      const card = MeshIdentityCardSchema.safeParse(request.body);
      if (!card.success) {
        return reply.code(400).send(errorBody("Invalid mesh card"));
      }

      const addError = addMeshContact(currentUser.id, card.data);
      if (addError) {
        return reply.code(400).send(errorBody(addError));
      }
      return { ok: true, meshId: card.data.meshId };
    },
  );

  // The current user's mesh address book (docs/16) — meshId + display name only, never any secret.
  server.get("/api/mesh/contacts", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));
    const accessError = participationError(currentUser);

    if (accessError) {
      return reply.code(403).send(errorBody(accessError));
    }
    if (!appConfig.mesh.enabled) {
      return reply.code(404).send(errorBody("Not found"));
    }

    const book = meshContacts.get(currentUser.id);
    const contacts: MeshContact[] = book
      ? [...book.values()].map((card) => ({ meshId: card.meshId, displayName: card.displayName }))
      : [];
    return contacts;
  });

  // Send a sealed mailbox message (opportunistic-mesh — docs/16) to a contact the sender has already
  // added (by their self-certifying mesh id). The server seals it to that contact's key and lets the
  // sync layer carry it; only the recipient's home node can open it. 404 unless mesh is enabled.
  server.post(
    "/api/mesh/messages",
    // Sealing runs public-key crypto and consumes relay/storage capacity across the mesh, so cap it
    // well below the global limit (like avatar/attachment uploads).
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));
    const accessError = participationError(currentUser);

    if (accessError) {
      return reply.code(403).send(errorBody(accessError));
    }

    if (!appConfig.mesh.enabled) {
      return reply.code(404).send(errorBody("Not found"));
    }

    const body = MeshSendRequestSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send(errorBody("Invalid mesh send request"));
    }

    const sender = ensureMeshIdentity(currentUser.id);

    if (!sender) {
      return reply.code(400).send(errorBody("This user has no mesh identity"));
    }

    const contact = meshContacts.get(currentUser.id)?.get(body.data.toMeshId);

    if (!contact) {
      return reply.code(404).send(errorBody("No such mesh contact"));
    }

    // A shadow-banned sender gets a normal-looking success, but the mail is silently dropped — never
    // sealed or propagated — mirroring how their public posts go nowhere without revealing the ban.
    if (currentUser.shadowBanned) {
      return { ok: true };
    }

    const sendError = sendSealed(sender, contact, body.data.body);

    if (sendError) {
      return reply.code(400).send(errorBody(sendError));
    }

    return { ok: true };
  });

  // Broadcast a sealed mailbox message (opportunistic-mesh group/broadcast fan-out — docs/16) to
  // MULTIPLE contacts in one call. Each recipient is sealed independently via `sendSealed` — there is
  // no shared key, so per-recipient confidentiality/unlinkability is identical to the single-send path
  // above; this is purely a client-convenience batch. Same gating as `/api/mesh/messages`: 404 unless
  // mesh is enabled, a shadow-banned sender's mail silently drops, and a `toMeshId` that isn't an
  // already-added contact is reported back rather than 404ing the whole request (unlike the single-send
  // route, since a mix of valid/invalid recipients in one call shouldn't fail the valid ones).
  server.post(
    "/api/mesh/broadcast",
    // Same per-route cap as the single-send route — a broadcast still costs one request, but seals up
    // to `MeshBroadcastRequestSchema`'s cap (50) worth of public-key crypto, so keep it tightly limited.
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const currentUser = ensureSessionUser(getSessionUserId(request, reply));
      const accessError = participationError(currentUser);

      if (accessError) {
        return reply.code(403).send(errorBody(accessError));
      }

      if (!appConfig.mesh.enabled) {
        return reply.code(404).send(errorBody("Not found"));
      }

      const body = MeshBroadcastRequestSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send(errorBody("Invalid mesh broadcast request"));
      }

      const sender = ensureMeshIdentity(currentUser.id);

      if (!sender) {
        return reply.code(400).send(errorBody("This user has no mesh identity"));
      }

      // A shadow-banned sender gets a normal-looking success, but nothing is sealed or sent — same
      // silent-drop behaviour as the single-send route.
      if (currentUser.shadowBanned) {
        return { ok: true, sent: 0, skipped: [] };
      }

      const book = meshContacts.get(currentUser.id);
      const toMeshIds = [...new Set(body.data.toMeshIds)]; // de-duplicate: never mail a contact twice

      let sent = 0;
      const skipped: string[] = [];
      for (const toMeshId of toMeshIds) {
        const contact = book?.get(toMeshId);
        if (!contact) {
          skipped.push(toMeshId);
          continue;
        }
        // `sendSealed` enforces the same `mesh.maxCarried` storage bound as the single-send path; if
        // the queue fills partway through, stop here and report what actually went out rather than
        // silently dropping the remainder or throwing away the count of what succeeded.
        const sendError = sendSealed(sender, contact, body.data.body);
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
  // blob through the same defensive `acceptSealedFromPeer` used by sync imports. Both 404 (identical to
  // absent) unless `mesh.enabled`, and both refuse non-loopback callers so only this device's launcher
  // can reach them. Public-data sync is completely untouched.

  server.get(
    "/api/mesh/outbound",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!appConfig.mesh.enabled || !requestFromLoopback(request)) {
        return reply.code(404).send(errorBody("Not found"));
      }

      // Exactly what the sync digest would advertise as `sealed`, but as full records ready to hand to
      // the radio. Bounded so one transfer window can't try to push the whole store at once.
      const messages = data.messages
        .filter((message): message is SealedMessage => message.type === "sealed" && isSyncableMessage(message))
        .slice(0, 200);
      return { messages };
    },
  );

  server.post(
    "/api/mesh/inbound",
    { config: { rateLimit: { max: 240, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!appConfig.mesh.enabled || !requestFromLoopback(request)) {
        return reply.code(404).send(errorBody("Not found"));
      }

      const body = MeshInboundRequestSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send(errorBody("Invalid mesh inbound request"));
      }

      // `acceptSealedFromPeer` is the single trust boundary: it re-checks TTL/hop/tombstone/dedup and
      // the per-node storage cap, then delivers-if-ours or relays-onward (hop-decremented). A blob that
      // fails any check is silently ignored, exactly as an inbound sync copy would be.
      let accepted = 0;
      for (const message of body.data.messages) {
        if (acceptSealedFromPeer(message)) {
          accepted += 1;
        }
      }
      return { accepted };
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
    void createAssistantResponse(result.message);
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
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "1 minute",
          // Answer 404 (not the default 429) when the route limit trips, so a rate-limited prober
          // sees the same "not found" as every other failure path here — no 429 to reveal the route.
          errorResponseBuilder: () => {
            const error = new Error("Not found") as Error & { statusCode: number };
            error.statusCode = 404;
            return error;
          },
        },
      },
    },
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

    const switchedToSetupCode = next.admin.bootstrap === "setupCode" && appConfig.admin.bootstrap !== "setupCode";
    const switchedAwayFromSetupCode =
      appConfig.admin.bootstrap === "setupCode" && next.admin.bootstrap !== "setupCode";
    appConfig = next;
    store.setConfigValue("config", JSON.stringify(appConfig));
    // Drop live sync-status for peers an admin just removed, so peerSyncStatus can't accrete entries
    // for peers that no longer exist (docs/15 #9).
    const activePeerUrls = new Set(appConfig.sync.peers.map((peer) => peer.url));
    for (const url of [...peerSyncStatus.keys()]) {
      if (!activePeerUrls.has(url)) {
        peerSyncStatus.delete(url);
      }
    }
    // Drop every cached puller-side transport session (docs/08): a peer's URL, pinned transportKey, or
    // the sync token may have just changed, so an entry established under the old config could be stale
    // or pinned to a now-wrong key. They re-handshake lazily on the next sync tick.
    peerTransportSessions.clear();
    // Switching INTO setupCode bootstrap at runtime must mint a code — otherwise the claim flow is
    // enabled but no code was ever generated, so `allowAdminClaim` stays false and no one can claim
    // (docs/15 #8). Only on the transition (not every PATCH while already in setupCode), so a code
    // consumed by an earlier claim isn't silently re-minted. `/api/admin/claim` grants admin against
    // a valid code regardless of existing admins, so this is the intended "let someone claim" lever.
    if (switchedToSetupCode && adminSetupCode === undefined) {
      adminSetupCode = makeAdminSetupCode();
      server.log.info(`Admin setup code (single use): ${adminSetupCode}`);
    } else if (switchedAwayFromSetupCode) {
      // Leaving setupCode invalidates the outstanding code immediately, so a later switch back mints a
      // fresh one (and a code minted for a now-abandoned mode can't be claimed later).
      adminSetupCode = undefined;
    }
    ensureBotUser();
    // Enabling mesh mints + publishes identity keys for existing local users so they're reachable.
    ensureAllMeshIdentities();
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
    const mode = appConfig.security.transportEncryption;
    const transportSession = mode === "off" ? undefined : wsTransportSession(request.url);
    const transportKey = transportSession?.key;
    // The presented transport session id (used at confirm-time to detect a mid-challenge revocation:
    // ban/logout/kill-switch/eviction deletes the session from `transportSessions`).
    const wsParams = new URLSearchParams(request.url.split("?")[1] ?? "");
    const encPresent = wsParams.has("enc");
    const sid = wsParams.get("enc") ?? "";

    // FAIL CLOSED on a presented-but-unresolved session (docs/20). Distinguish "no `?enc=` at all" (fine —
    // a plaintext socket on off/optional) from "`?enc=` was supplied but doesn't resolve to a live
    // session": the latter is REFUSED in EVERY mode — INCLUDING `off` (`transportSession` is always
    // undefined there). A legitimate plaintext client never sends `?enc=`, so only a stale key-pinned
    // client would; refusing it stops that client from silently downgrading to a plaintext cookie socket
    // (wrong-user attribution + cleartext) after the node was switched to `off` or its session expired. We
    // key on parameter PRESENCE (`has`), so even a bare `?enc=` (empty value) fails closed.
    if (encPresent && !transportSession) {
      connection.send(JSON.stringify({ type: "error", ...errorBody("Transport session expired") }));
      connection.close();
      return;
    }

    // Identity: a `bound` transport session's userId is the WS identity (docs/20) — the session key is
    // the credential, proven below by the key-confirmation challenge; the plaintext cookie is not used.
    // For an anonymous session (optional/off) the cookie identity applies, as before.
    const boundUserId =
      transportSession?.authMode === "bound" && transportSession.userId ? transportSession.userId : undefined;
    const userId = boundUserId ?? getSessionUserIdFromRequest(request);

    if (!userId) {
      connection.send(JSON.stringify({ type: "error", ...errorBody("Unauthenticated websocket") }));
      connection.close();
      return;
    }

    // Under `required` mode the socket must ride a `bound` transport session — an anonymous session (or
    // none) can't reach the live feed, mirroring the tunnel-only content rule.
    if (mode === "required" && !boundUserId) {
      connection.send(JSON.stringify({ type: "error", ...errorBody("This node requires an encrypted session") }));
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

    // A plaintext socket (transport off, or an anonymous optional session with no key) is admitted
    // directly — there is no session key to confirm. Its frames go out in the clear (documented).
    if (!transportKey) {
      const socketSession: SocketSession = { socket: connection, userId };
      sockets.add(socketSession);
      broadcastPresence();
      connection.on("close", () => {
        sockets.delete(socketSession);
        broadcastPresence();
      });
      return;
    }

    // Encrypted socket: a visible session id is NOT proof of the key (docs/20 §7). Withhold everything
    // — presence, events, admission to `sockets` — until the client answers a reflection-safe
    // challenge. Cap simultaneously-unconfirmed sockets both globally AND per-IP so this pre-auth path
    // can't be flooded (a few LAN hosts mustn't lock everyone out), and time out a socket that never proves.
    const ip = request.ip;
    if (unconfirmedSocketCount >= WS_UNCONFIRMED_CAP || (unconfirmedByIp.get(ip) ?? 0) >= WS_UNCONFIRMED_PER_IP_CAP) {
      connection.send(JSON.stringify({ type: "error", ...errorBody("Too many pending connections; try again") }));
      connection.close();
      return;
    }

    const connectionId = randomUUID();
    const nonce = randomBytes(32).toString("base64url");
    let confirmed = false;
    let settled = false; // guards the unconfirmed counters against a double decrement (confirm then close)
    unconfirmedSocketCount += 1;
    unconfirmedByIp.set(ip, (unconfirmedByIp.get(ip) ?? 0) + 1);

    /** Release the unconfirmed-socket reservation exactly once (on confirm, timeout, or close). */
    function releaseUnconfirmed(): void {
      if (settled) {
        return;
      }
      settled = true;
      unconfirmedSocketCount -= 1;
      const remaining = (unconfirmedByIp.get(ip) ?? 1) - 1;
      if (remaining <= 0) {
        unconfirmedByIp.delete(ip);
      } else {
        unconfirmedByIp.set(ip, remaining);
      }
    }

    const socketSession: SocketSession = {
      socket: connection,
      userId,
      transportKey,
      connectionId,
      frameSeq: 0,
      transportSessionId: sid,
    };
    // Closes the socket when its transport session reaches `expiresAt`, so a confirmed socket can't keep
    // receiving frames past the session key's lifetime (docs/20 §7). Set on confirm, cleared on close.
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    // Register the mid-challenge socket so ban/logout/kill-switch can reach and close it — otherwise it
    // exists only as closures and could complete its proof AFTER being revoked and slip into the feed.
    const pending = { userId, close: () => connection.close() };
    pendingSockets.add(pending);

    const timer = setTimeout(() => {
      if (!confirmed) {
        connection.close();
      }
    }, WS_CHALLENGE_TIMEOUT_MS);
    // node:timers `unref` so a pending challenge never keeps the process alive in tests; guarded since
    // the WS mock in unit tests may not return a real Timeout.
    (timer as { unref?: () => void }).unref?.();

    connection.on("message", (raw: unknown) => {
      if (confirmed) {
        return; // the client has no reason to speak again; ignore late/extra frames
      }
      const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
      const opened = openTransport(transportKey, text, WS_PROOF_AAD);
      if (opened === null) {
        return; // undecryptable under the proof aad — a reflected challenge lands here and is ignored
      }
      let proof: { type?: unknown; connectionId?: unknown; nonce?: unknown };
      try {
        proof = JSON.parse(opened) as typeof proof;
      } catch {
        return;
      }
      // The proof must echo THIS connection's id + nonce, sealed under the proof aad. A reflected
      // challenge fails (wrong aad → openTransport null above); a stale/other-connection proof fails the
      // constant-time nonce+id comparison.
      const nonceOk =
        typeof proof.nonce === "string" &&
        Buffer.byteLength(proof.nonce) === Buffer.byteLength(nonce) &&
        timingSafeEqual(Buffer.from(proof.nonce), Buffer.from(nonce));
      if (proof.type !== "proof" || proof.connectionId !== connectionId || !nonceOk) {
        return;
      }

      // Re-check revocation AND expiry at CONFIRM time (docs/20 §8): a ban / logout / kill-switch (or an
      // evicted transport session) may have landed during the up-to-10s challenge window, and the session
      // may have crossed `expiresAt` in that window. Ban is only checked at connect otherwise, and a
      // revocation/expiry that fired mid-challenge must not be undone by a late proof.
      const stillValid =
        transportSessions.get(sid) === transportSession &&
        transportSession.expiresAt > Date.now() &&
        !data.users.find((candidate) => candidate.id === userId)?.banned;
      if (!stillValid) {
        connection.close();
        return;
      }

      confirmed = true;
      clearTimeout(timer);
      releaseUnconfirmed();
      pendingSockets.delete(pending);
      sockets.add(socketSession);
      // Bound the socket's life to its session key's expiry (docs/20 §7).
      expiryTimer = setTimeout(() => connection.close(), Math.max(0, transportSession.expiresAt - Date.now()));
      (expiryTimer as { unref?: () => void }).unref?.();
      broadcastPresence();
    });

    connection.on("close", () => {
      clearTimeout(timer);
      if (expiryTimer) {
        clearTimeout(expiryTimer);
      }
      releaseUnconfirmed();
      pendingSockets.delete(pending);
      sockets.delete(socketSession);
      broadcastPresence();
    });

    // Kick off the challenge. Sealed under the challenge aad; the client replies under the proof aad.
    connection.send(
      sealTransport(transportKey, JSON.stringify({ type: "challenge", connectionId, nonce }), WS_CHALLENGE_AAD),
    );
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
    // Boot-time snapshot (kept for existing callers). The code is also (re)minted/cleared at runtime
    // (kill switch, a config PATCH entering/leaving setupCode), so read the LIVE value via
    // getAdminSetupCode() — a method survives the test wrapper's `{ ...app }` spread, a getter wouldn't.
    adminSetupCode,
    getAdminSetupCode: () => adminSetupCode,
    reapExpiredMessages,
    reapOrphanedAttachments,
    pruneExpiredRateLimiters,
    rateLimiterEntryCounts: () => ({
      claim: claimAttempts.size,
      panic: panicAttempts.size,
      identity: identityMintCounters.size,
    }),
    async close() {
      clearInterval(reaperTimer);
      clearInterval(syncTimer);
      await server.close();
      store.close();
    },
  };
}
