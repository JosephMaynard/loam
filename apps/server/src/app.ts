import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { generateDisplayName } from "@loam/display-name";
import {
  AdminClaimRequestSchema,
  AvatarImageUploadRequestSchema,
  ChannelCreateRequestSchema,
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
  UserSchema,
  UserUpdateRequestSchema,
  type AvatarImageMimeType,
  type Channel,
  type ChannelCreateRequest,
  type ChannelUpdateRequest,
  type LoamConfig,
  type LoamConfigUpdate,
  type Message,
  type MessageCreateRequest,
  type NetworkConfig,
  type OllamaConfig,
  type StreamEvent,
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
  logger?: boolean;
};

export type LoamApp = {
  server: FastifyInstance;
  store: LoamStore;
  /** One-time admin claim code, present when bootstrap is `setupCode` and no admin exists yet. */
  adminSetupCode?: string;
  /** Delete messages older than the configured retention TTL now (also runs on a timer). */
  reapExpiredMessages(): void;
  close(): Promise<void>;
};

const sessionCookieName = "loam_session";
const sessionCookieMaxAge = 60 * 60 * 24 * 365;
const defaultChannelCreatedAt = 1_704_067_200_000;
const isProduction = process.env.NODE_ENV === "production";
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
 * Create the default LOAM configuration: conservative identity permissions, all core messaging
 * features on, Ollama disabled, `firstUser` admin bootstrap, and the `standard` security profile.
 */
export function defaultLoamConfig(): LoamConfig {
  return {
    identity: {
      allowUserDisplayNameEdit: false,
      allowUserAvatarEdit: false,
      allowUserAvatarUpload: false,
      allowAdminUserEdit: true,
    },
    features: {
      enablePublicChannels: true,
      enablePrivateChannels: false,
      enableUserChannels: true,
      enableReplies: true,
      enableDMs: true,
      enableReactions: true,
      enableMarkdown: true,
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
      profile: "standard",
    },
    access: {
      joinPolicy: "open",
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
    identity: { ...base.identity, ...update.identity },
    features: { ...base.features, ...update.features },
    llm: { ollama: { ...base.llm.ollama, ...update.llm?.ollama } },
    admin: { ...base.admin, ...update.admin },
    killSwitch: { ...base.killSwitch, ...update.killSwitch },
    retention: { ...base.retention, ...update.retention },
    security: { ...base.security, ...update.security },
    access: { ...base.access, ...update.access },
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
  return LoamConfigSchema.parse(merged);
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
        config = mergeConfig(config, fileUpdate);
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
        config = mergeConfig(config, storedUpdate);
      }
    }

    appConfig = config;
  }

  function anyAdminExists(): boolean {
    return data.users.some((user) => user.isAdmin);
  }

  function getSessionUserId(request: FastifyRequest, reply: FastifyReply): string {
    const cookieToken = readCookie(request.headers.cookie, sessionCookieName);
    const cookieUserId = cookieToken ? sessions.get(cookieToken) : undefined;

    if (cookieUserId) {
      return cookieUserId;
    }

    const userId = makeSessionUserId();
    const token = makeSessionToken();
    sessions.set(token, userId);
    store.putSession(token, userId);
    const cookie = `${sessionCookieName}=${encodeCookieValue(
      token,
    )}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionCookieMaxAge}${isProduction ? "; Secure" : ""}`;
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
   * as can anyone granted the `moderator` role.
   */
  function canModerate(user: User): boolean {
    return user.isAdmin || !!user.roles?.includes("moderator");
  }

  /**
   * Whether a user may greet newcomers (approve / deny pending users, see the in-client join QR):
   * admins always can, as can anyone granted the `greeter` role.
   */
  function canGreet(user: User): boolean {
    return user.isAdmin || !!user.roles?.includes("greeter");
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
  function visibleUsers(): User[] {
    const base = appConfig.llm.ollama.enabled
      ? data.users
      : data.users.filter((user) => user.type !== "bot");
    return base.filter((user) => !user.banned && !user.pending);
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
   * Builds a public channel from a create request, persists it, and broadcasts it. Shared by admin
   * creation and (when `enableUserChannels` is on) user creation. Owner = the creator. Channels are
   * public + discoverable for now; private channels need a membership model that does not exist yet
   * (see socketCanReceiveEvent and docs/07-more-features.md).
   */
  function createChannelFromRequest(input: ChannelCreateRequest, ownerId: string): Channel {
    const channel: Channel = {
      id: uniqueChannelId(input.name),
      name: input.name,
      description: input.description,
      ownerUserId: ownerId,
      visibility: "public",
      allowPosting: input.allowPosting ?? "everyone",
      allowReplies: input.allowReplies ?? true,
      discoverable: true,
      createdAt: Date.now(),
    };

    // Persist before exposing in memory / broadcasting, so a failed write never surfaces a channel
    // that was not stored (mirrors applyUserUpdate).
    store.upsertChannel(channel);
    data.channels.push(channel);
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

  function channelMessages(channelId: string): Message[] {
    const directMessages = data.messages.filter((message) => isChannelMessage(message, channelId));
    const ids = new Set(directMessages.map((message) => message.id));
    const reactions = data.messages.filter(
      (message) => message.type === "reaction" && ids.has(message.targetMessageId),
    );
    return [...directMessages, ...reactions].sort((a, b) => a.createdAt - b.createdAt);
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
    return [...directMessages, ...reactions].sort((a, b) => a.createdAt - b.createdAt);
  }

  function messageAudienceUserIds(message: Message): Set<string> | undefined {
    if (message.type === "dm") {
      return new Set([message.authorId, message.recipientUserId]);
    }

    if (message.type === "reaction") {
      const target = data.messages.find((candidate) => candidate.id === message.targetMessageId);
      return target ? messageAudienceUserIds(target) : new Set([message.authorId]);
    }

    return undefined;
  }

  function socketCanReceiveEvent(userId: string, event: ClientEvent): boolean {
    if (
      event.type === "userUpserted" ||
      event.type === "channelUpserted" ||
      event.type === "configUpdated" ||
      event.type === "wipe"
    ) {
      // Channels are created public + discoverable and `GET /api/channels` already returns every
      // non-archived channel to everyone, so channel upserts go to all sockets. When private
      // channels gain real membership enforcement this must filter by visibility/membership.
      return true;
    }

    const message = event.message;

    // Shadow ban: a message whose author is currently shadow-banned is delivered only back to the
    // author, so their own UI still shows it while nobody else ever sees it. Layered on top of the
    // DM-audience filtering below (a shadow-banned DM is only ever seen by its author).
    if (event.type === "messageCreated" || event.type === "messageUpdated") {
      const author = data.users.find((candidate) => candidate.id === message.authorId);

      if (author?.shadowBanned && userId !== message.authorId) {
        return false;
      }
    }

    const audience = messageAudienceUserIds(message);
    return !audience || audience.has(userId);
  }

  function broadcast(event: ClientEvent): void {
    const payload = JSON.stringify(event);

    for (const { socket, userId } of sockets) {
      if (socket.readyState === socket.OPEN && socketCanReceiveEvent(userId, event)) {
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
    if (author.banned) {
      return { error: "You have been removed from this node", forbidden: true };
    }

    if (author.pending) {
      return { error: "Your join is awaiting approval", forbidden: true };
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

    if (input.type === "channelPost" || input.type === "channelReply") {
      const channel = ensureChannel(input.channelId);

      if (!channel) {
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
          store.deleteMessage(deleted.id);
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
    } else {
      // Best-effort logical wipe (no encryption): DELETE leaves recoverable pages on flash. See docs.
      store.wipeAll();
    }

    await rm(avatarsDir, { recursive: true, force: true });
    sessions.clear();
    claimAttempts.clear();

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

    deleteMessages(expired);
    server.log.info(`Retention reaper deleted ${expired.length} expired message(s)`);
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
    store.transaction(() => {
      for (const id of ids) {
        store.deleteMessage(id);
      }
    });

    for (const message of messages) {
      broadcast({ type: "messageDeleted", messageId: message.id, message });
    }

    data.messages = data.messages.filter((message) => !ids.has(message.id));
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

  const reaperTimer = setInterval(() => {
    try {
      reapExpiredMessages();
    } catch (error) {
      server.log.error(error);
    }
  }, 30_000);

  // Blanket per-IP throttle for every HTTP route; the abuse-sensitive endpoints (claim, panic,
  // avatar upload) add their own tighter semantic limits on top.
  await server.register(fastifyRateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
  });
  await server.register(fastifyWebsocket);
  await registerStaticFiles();

  server.get("/api/config", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));

    return {
      nodeName: "LOAM local",
      joinUrl: `http://${joinHost}:${clientPort}`,
      websocketPath: "/ws",
      currentUser,
      networkConfig: currentNetworkConfig(),
    };
  });

  server.get("/api/users", async () => visibleUsers());
  server.patch("/api/users/me", async (request, reply) => {
    const body = UserUpdateRequestSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send({ error: "Invalid user update request" });
    }

    if (
      (body.data.displayName !== undefined && !appConfig.identity.allowUserDisplayNameEdit) ||
      (body.data.avatar !== undefined && !appConfig.identity.allowUserAvatarEdit)
    ) {
      return reply.code(403).send({ error: "User profile editing is disabled on this LOAM node" });
    }

    const user = ensureSessionUser(getSessionUserId(request, reply));
    return applyUserUpdate(user, body.data);
  });
  server.put(
    "/api/users/me/avatar-image",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
    if (!appConfig.identity.allowUserAvatarEdit || !appConfig.identity.allowUserAvatarUpload) {
      return reply.code(403).send({ error: "User avatar uploads are disabled on this LOAM node" });
    }

    const body = AvatarImageUploadRequestSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send({ error: "Invalid avatar image upload request" });
    }

    const image = Buffer.from(body.data.data, "base64");

    if (image.length === 0 || image.length > 128 * 1024) {
      return reply.code(400).send({ error: "Avatar image must be 128KB or smaller" });
    }

    if (!avatarImageHasExpectedSignature(image, body.data.mimeType)) {
      return reply.code(400).send({ error: "Avatar image type does not match the uploaded data" });
    }

    const user = ensureSessionUser(getSessionUserId(request, reply));
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
      return reply.code(400).send({ error: "Invalid user update request" });
    }

    const currentUser = ensureSessionUser(getSessionUserId(request, reply));

    if (!currentUser.isAdmin || !appConfig.identity.allowAdminUserEdit) {
      return reply.code(403).send({ error: "Admin user editing is disabled on this LOAM node" });
    }

    const user = data.users.find((candidate) => candidate.id === request.params.userId);

    if (!user) {
      return reply.code(404).send({ error: "User does not exist" });
    }

    return applyUserUpdate(user, body.data);
  });

  // Set a user's granted roles (replaces the whole set). Admin-only — roles confer moderation and
  // greeter powers, so only an admin may hand them out. An admin's roles are never changed here.
  server.patch<{ Params: { userId: string } }>("/api/admin/users/:userId/roles", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));

    if (!currentUser.isAdmin) {
      return reply.code(403).send({ error: "Admin access required" });
    }

    const body = RolesUpdateRequestSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send({ error: "Invalid roles update request" });
    }

    const user = data.users.find((candidate) => candidate.id === request.params.userId);

    if (!user) {
      return reply.code(404).send({ error: "User does not exist" });
    }

    if (user.isAdmin) {
      return reply.code(400).send({ error: "Cannot change the roles of an admin" });
    }

    return applyUserModeration(user, { roles: body.data.roles });
  });

  // Ban / shadow-ban / unban a user. Open to admins and moderators; never usable against an admin
  // or oneself. Banning a user also tears down their live sessions (see invalidateUserSessions).
  server.patch<{ Params: { userId: string } }>("/api/moderation/users/:userId", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));

    if (!canModerate(currentUser)) {
      return reply.code(403).send({ error: "Moderator access required" });
    }

    const body = ModerationUpdateRequestSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send({ error: "Invalid moderation request" });
    }

    const user = data.users.find((candidate) => candidate.id === request.params.userId);

    if (!user) {
      return reply.code(404).send({ error: "User does not exist" });
    }

    if (user.isAdmin || user.id === currentUser.id) {
      return reply.code(403).send({ error: "You cannot moderate an admin or yourself" });
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
      return reply.code(403).send({ error: "Moderator access required" });
    }

    return data.users.filter((user) => user.type === "human");
  });

  // Users awaiting approval under the `approval` join policy. Admins and greeters.
  server.get("/api/access/pending", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));

    if (!canGreet(currentUser)) {
      return reply.code(403).send({ error: "Greeter access required" });
    }

    return data.users.filter((user) => user.type === "human" && user.pending === true);
  });

  // Approve a pending user so they can participate. Admins and greeters.
  server.post<{ Params: { userId: string } }>("/api/access/users/:userId/approve", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));

    if (!canGreet(currentUser)) {
      return reply.code(403).send({ error: "Greeter access required" });
    }

    const user = data.users.find((candidate) => candidate.id === request.params.userId);

    if (!user) {
      return reply.code(404).send({ error: "User does not exist" });
    }

    return applyUserModeration(user, { pending: false });
  });

  // Deny a pending user: bans them (clearing pending) and tears down their sessions. Admins and
  // greeters — but, like moderation, never usable against an admin or oneself.
  server.post<{ Params: { userId: string } }>("/api/access/users/:userId/deny", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));

    if (!canGreet(currentUser)) {
      return reply.code(403).send({ error: "Greeter access required" });
    }

    const user = data.users.find((candidate) => candidate.id === request.params.userId);

    if (!user) {
      return reply.code(404).send({ error: "User does not exist" });
    }

    if (user.isAdmin || user.id === currentUser.id) {
      return reply.code(403).send({ error: "You cannot deny an admin or yourself" });
    }

    // Deny is an onboarding action, scoped to pending newcomers. Banning an established member is a
    // moderation action that requires the moderator role (PATCH /api/moderation/users/:id) — without
    // this guard, a greeter could ban any approved member (privilege escalation).
    if (!user.pending) {
      return reply.code(400).send({ error: "Only pending users can be denied" });
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
      return reply.code(404).send({ error: "Avatar image does not exist" });
    }

    try {
      const image = await readFile(avatarImagePath(avatar.imageId, avatar.mimeType));
      return reply.type(avatar.mimeType).header("cache-control", "private, max-age=3600").send(image);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return reply.code(404).send({ error: "Avatar image does not exist" });
      }

      throw error;
    }
  });
  server.get("/api/channels", async () => data.channels.filter((channel) => !channel.archived));
  server.get<{ Params: { channelId: string } }>("/api/messages/:channelId", async (request) =>
    channelMessages(request.params.channelId),
  );
  server.get<{ Params: { userId: string } }>(
    "/api/dms/:userId",
    async (request, reply) => dmMessages(request.params.userId, getSessionUserId(request, reply)),
  );

  server.post("/api/messages", async (request, reply) => {
    const body = MessageCreateRequestSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send({ error: "Invalid message request" });
    }

    const result = createMessage(body.data, getSessionUserId(request, reply));

    if (result.error) {
      // Moderation rejections (banned/pending author) are 403; everything else is a bad request.
      return reply.code(result.forbidden ? 403 : 400).send({ error: result.error });
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
      return reply.code(400).send({ error: "Unable to create message" });
    }

    broadcast({ type: "messageCreated", message: result.message });
    void createOllamaResponse(result.message);
    return reply.code(201).send(result);
  });

  server.delete<{ Params: { messageId: string } }>("/api/messages/:messageId", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));
    const target = data.messages.find((message) => message.id === request.params.messageId);

    if (!target) {
      return reply.code(404).send({ error: "Message does not exist" });
    }

    // Don't delete a message that's still streaming: its in-flight writer would re-persist it.
    if (target.meta?.streaming) {
      return reply.code(409).send({ error: "This message is still being written" });
    }

    const deletionSet = collectDeletionSet(target);

    if (!currentUser.isAdmin) {
      // A non-admin may delete only their own message, and only when the cascade won't remove
      // another user's reply (clearing others' reactions on it is fine). Admins can delete anything
      // — moderation is part of the trusted-host model.
      if (target.authorId !== currentUser.id) {
        return reply.code(403).send({ error: "You can only delete your own messages" });
      }

      const removesOthersContent = deletionSet.some(
        (message) => message.type !== "reaction" && message.authorId !== currentUser.id,
      );

      if (removesOthersContent) {
        return reply
          .code(403)
          .send({ error: "This thread has replies from other people — only an admin can delete it" });
      }
    }

    deleteMessages(deletionSet);
    return reply.send({ deletedIds: deletionSet.map((message) => message.id) });
  });

  server.patch<{ Params: { messageId: string } }>("/api/messages/:messageId", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));
    const target = data.messages.find((message) => message.id === request.params.messageId);

    if (!target) {
      return reply.code(404).send({ error: "Message does not exist" });
    }

    // Only the author may edit — rewriting someone else's words is impersonation, so not even an
    // admin can (admins moderate by deleting instead).
    if (target.authorId !== currentUser.id) {
      return reply.code(403).send({ error: "You can only edit your own messages" });
    }

    if (target.type === "reaction") {
      return reply.code(400).send({ error: "Reactions cannot be edited" });
    }

    if (target.meta?.streaming) {
      return reply.code(409).send({ error: "This message is still being written" });
    }

    const body = MessageEditRequestSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send({ error: "Invalid message edit request" });
    }

    target.body = body.data.body;
    target.editedAt = Date.now();
    store.updateMessage(target);
    broadcast({ type: "messageUpdated", message: target });
    return target;
  });

  server.post(
    "/api/admin/claim",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
    const body = AdminClaimRequestSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send({ error: "Invalid admin claim request" });
    }

    const currentUser = ensureSessionUser(getSessionUserId(request, reply));

    if (currentUser.isAdmin) {
      return currentUser;
    }

    const strategy = appConfig.admin.bootstrap;

    if (strategy !== "setupCode" && strategy !== "passphrase") {
      return reply.code(403).send({ error: "Admin claiming is not enabled on this LOAM node" });
    }

    // Key on the caller's IP: a session-id key could be reset by simply omitting the cookie.
    if (attemptRateLimited(claimAttempts, request.ip)) {
      return reply.code(429).send({ error: "Too many claim attempts; try again later" });
    }

    const expected = strategy === "setupCode" ? adminSetupCode : appConfig.admin.passphrase;
    const secretMatches =
      !!expected &&
      (strategy === "setupCode"
        ? timingSafeEqualStrings(body.data.secret, expected)
        : verifySecret(body.data.secret, expected));

    if (!secretMatches) {
      return reply.code(403).send({ error: "Invalid admin secret" });
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
      return reply.code(403).send({ error: "Admin access required" });
    }

    return redactedConfig();
  });

  server.post("/api/admin/kill-switch", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));

    if (!currentUser.isAdmin) {
      return reply.code(403).send({ error: "Admin access required" });
    }

    if (!appConfig.killSwitch.enabled) {
      return reply.code(403).send({ error: "The kill switch is not enabled on this LOAM node" });
    }

    const body = KillSwitchRequestSchema.safeParse(request.body ?? {});

    if (!body.success) {
      return reply.code(400).send({ error: "Invalid kill-switch request" });
    }

    if (appConfig.killSwitch.requireConfirmation && body.data.confirm !== "wipe") {
      return reply.code(400).send({ error: 'Confirmation required: send { "confirm": "wipe" }' });
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
    if (!appConfig.killSwitch.enabled || !appConfig.killSwitch.panicToken) {
      return reply.code(404).send({ error: "Not found" });
    }

    const body = PanicRequestSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send({ error: "Invalid request" });
    }

    if (attemptRateLimited(panicAttempts, request.ip)) {
      return reply.code(429).send({ error: "Too many attempts" });
    }

    if (!verifySecret(body.data.token, appConfig.killSwitch.panicToken)) {
      return reply.code(403).send({ error: "Invalid token" });
    }

    await executeKillSwitch();
    return { ok: true };
  });

  server.patch("/api/admin/config", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));

    if (!currentUser.isAdmin) {
      return reply.code(403).send({ error: "Admin access required" });
    }

    const body = LoamConfigUpdateSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send({ error: "Invalid config update request" });
    }

    let next: LoamConfig;

    try {
      next = mergeConfig(appConfig, body.data);
    } catch {
      return reply.code(400).send({ error: "Invalid config values" });
    }

    // Passphrase bootstrap without a passphrase would advertise a claim flow that can never
    // succeed (and clearing the passphrase while the mode is active would lock admins out).
    if (next.admin.bootstrap === "passphrase" && !next.admin.passphrase) {
      return reply.code(400).send({ error: "The passphrase bootstrap strategy requires a passphrase" });
    }

    appConfig = next;
    store.setConfigValue("config", JSON.stringify(appConfig));
    ensureOllamaBotUser();
    broadcast({ type: "configUpdated", networkConfig: currentNetworkConfig() });
    return redactedConfig();
  });

  // Unlike GET /api/channels (which hides archived channels from everyone), the admin list returns
  // every channel so an admin can see and restore archived ones.
  server.get("/api/admin/channels", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));

    if (!currentUser.isAdmin) {
      return reply.code(403).send({ error: "Admin access required" });
    }

    return data.channels;
  });

  // Create a channel. Admins always may; ordinary users may when `enableUserChannels` is on. The
  // creator becomes the owner.
  server.post("/api/channels", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));

    if (!currentUser.isAdmin && !appConfig.features.enableUserChannels) {
      return reply.code(403).send({ error: "Creating channels is disabled on this LOAM node" });
    }

    const body = ChannelCreateRequestSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send({ error: "Invalid channel create request" });
    }

    return reply.code(201).send(createChannelFromRequest(body.data, currentUser.id));
  });

  // Rename / re-configure / archive a channel. Allowed for an admin or the channel's owner.
  server.patch<{ Params: { channelId: string } }>("/api/channels/:channelId", async (request, reply) => {
    const currentUser = ensureSessionUser(getSessionUserId(request, reply));
    const channel = ensureChannel(request.params.channelId);

    if (!channel) {
      return reply.code(404).send({ error: "Channel does not exist" });
    }

    if (!currentUser.isAdmin && channel.ownerUserId !== currentUser.id) {
      return reply.code(403).send({ error: "Only the channel owner or an admin can change this channel" });
    }

    const body = ChannelUpdateRequestSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send({ error: "Invalid channel update request" });
    }

    return applyChannelUpdate(channel, body.data);
  });

  server.get("/ws", { websocket: true }, (connection: SocketClient, request) => {
    const userId = getSessionUserIdFromRequest(request);

    if (!userId) {
      connection.send(JSON.stringify({ type: "error", error: "Unauthenticated websocket" }));
      connection.close();
      return;
    }

    const socketSession = { socket: connection, userId };
    sockets.add(socketSession);
    connection.on("close", () => sockets.delete(socketSession));
  });

  server.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      void reply.code(404).send({ error: "Not found" });
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
    async close() {
      clearInterval(reaperTimer);
      await server.close();
      store.close();
    },
  };
}
