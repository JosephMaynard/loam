import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { generateDisplayName } from "@loam/display-name";
import {
  AdminClaimRequestSchema,
  AvatarImageUploadRequestSchema,
  LoamConfigSchema,
  LoamConfigUpdateSchema,
  MessageCreateRequestSchema,
  MessageSchema,
  UserSchema,
  UserUpdateRequestSchema,
  type AvatarImageMimeType,
  type Channel,
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

import { importLegacyJsonData, openStore, type LoamStore } from "./db.js";

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
      type: "configUpdated";
      networkConfig: NetworkConfig;
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
  logger?: boolean;
};

export type LoamApp = {
  server: FastifyInstance;
  store: LoamStore;
  /** One-time admin claim code, present when bootstrap is `setupCode` and no admin exists yet. */
  adminSetupCode?: string;
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
    security: {
      profile: "standard",
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
    security: { ...base.security, ...update.security },
  };
  const systemPrompt = merged.llm.ollama.systemPrompt?.trim();
  merged.llm.ollama.systemPrompt = systemPrompt || undefined;
  const passphrase = merged.admin.passphrase?.trim();
  merged.admin.passphrase = passphrase || undefined;
  return LoamConfigSchema.parse(merged);
}

/**
 * Compare two secrets in constant time (via SHA-256 digests, so lengths never leak).
 */
function timingSafeEqualStrings(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

/**
 * Create a human user record with a generated display name and creation timestamp.
 *
 * @param id - The unique user identifier
 * @param isAdmin - Whether the user has administrative privileges
 * @returns A validated `User` object constructed from the provided values
 */
function makeUser(id: string, isAdmin = false): User {
  return UserSchema.parse({
    id,
    displayName: generateDisplayName(id),
    type: "human",
    isAdmin,
    createdAt: Date.now(),
    ephemeral: false,
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
  let staticFilesRegistered = false;
  let appConfig: LoamConfig = defaultLoamConfig();
  let adminSetupCode: string | undefined;

  let data: AppData = {
    users: [],
    channels: [],
    messages: [],
  };

  await mkdir(dataDir, { recursive: true });
  const store = openStore(join(dataDir, "loam.db"));

  /**
   * Load the effective configuration: defaults, overlaid by the config file (when present and
   * valid), overlaid by admin edits persisted in the DB `config` table.
   */
  async function loadAppConfig(): Promise<void> {
    let config = defaultLoamConfig();

    try {
      const raw = await readFile(configPath, "utf8");
      const fileUpdate = LoamConfigUpdateSchema.safeParse(JSON.parse(raw));

      if (fileUpdate.success) {
        config = mergeConfig(config, fileUpdate.data);
      } else {
        server.log.warn(`Ignoring invalid config file at ${configPath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    const stored = store.getConfigValue("config");

    if (stored) {
      const storedUpdate = LoamConfigUpdateSchema.safeParse(JSON.parse(stored));

      if (storedUpdate.success) {
        config = mergeConfig(config, storedUpdate.data);
      } else {
        server.log.warn("Ignoring invalid persisted config; falling back to file/defaults");
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
   * @returns The existing or newly created User
   */
  function ensureUser(id: string, isAdmin = false): User {
    const existing = data.users.find((user) => user.id === id);

    if (existing) {
      return existing;
    }

    const user = makeUser(id, isAdmin);
    data.users.push(user);
    store.upsertUser(user);
    broadcast({ type: "userUpserted", user });
    return user;
  }

  /**
   * Ensure a session-originated user exists, applying the `firstUser` admin bootstrap: when that
   * strategy is active and no admin exists yet, the first session user created becomes admin.
   */
  function ensureSessionUser(id: string): User {
    return ensureUser(id, appConfig.admin.bootstrap === "firstUser" && !anyAdminExists());
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
        Object.assign(existing, next);
        store.upsertUser(existing);
        broadcast({ type: "userUpserted", user: existing });
      }

      return existing;
    }

    const user = makeBotUser(appConfig.llm.ollama);
    data.users.push(user);
    store.upsertUser(user);
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
      allowAdminClaim:
        appConfig.admin.bootstrap === "setupCode" || appConfig.admin.bootstrap === "passphrase",
    };
  }

  /** The effective config as exposed to admins — the passphrase value is never returned. */
  function redactedConfig(): LoamConfig {
    return {
      ...appConfig,
      admin: { ...appConfig.admin, passphrase: undefined },
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
    Object.assign(user, next);
    store.upsertUser(user);
    broadcast({ type: "userUpserted", user });
    return user;
  }

  /**
   * Determine which users should be exposed to clients based on the LLM bot visibility setting.
   */
  function visibleUsers(): User[] {
    return appConfig.llm.ollama.enabled ? data.users : data.users.filter((user) => user.type !== "bot");
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
    if (event.type === "userUpserted" || event.type === "configUpdated") {
      return true;
    }

    const message = event.message;
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
  ): { message?: Message; deletedMessage?: Message; deletedMessageId?: string; error?: string } {
    ensureSessionUser(authorId);

    if (input.type === "channelPost" && !appConfig.features.enablePublicChannels) {
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

    if (input.type === "channelPost" && !ensureChannel(input.channelId)) {
      return { error: "Channel does not exist" };
    }

    if (input.type === "channelReply") {
      if (!ensureChannel(input.channelId)) {
        return { error: "Channel does not exist" };
      }

      const parent = data.messages.find((message) => message.id === input.parentMessageId);

      if (!parent || !("channelId" in parent)) {
        return { error: "Parent message does not exist" };
      }

      if (parent.channelId !== input.channelId) {
        return { error: "Parent message belongs to a different channel" };
      }
    }

    if (input.type === "reaction" && !data.messages.some((message) => message.id === input.targetMessageId)) {
      return { error: "Target message does not exist" };
    }

    if (input.type === "reaction") {
      const existingIndex = data.messages.findIndex(
        (message) =>
          message.type === "reaction" &&
          message.authorId === authorId &&
          message.targetMessageId === input.targetMessageId &&
          message.reaction === input.reaction,
      );

      if (existingIndex >= 0) {
        const [deleted] = data.messages.splice(existingIndex, 1);

        if (deleted) {
          store.deleteMessage(deleted.id);
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
    data.messages.push(message);
    store.insertMessage(message);
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
    Object.assign(message, updated);
    store.updateMessage(message);
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
    data.messages.push(assistantMessage);
    store.insertMessage(assistantMessage);
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
   * Track a claim attempt for the given user and report whether they are over the limit.
   */
  function claimRateLimited(userId: string): boolean {
    const now = Date.now();
    const entry = claimAttempts.get(userId);

    if (!entry || entry.resetAt <= now) {
      claimAttempts.set(userId, { count: 1, resetAt: now + claimAttemptWindowMs });
      return false;
    }

    entry.count += 1;
    return entry.count > claimAttemptLimit;
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

  if (appConfig.admin.bootstrap === "setupCode" && !anyAdminExists()) {
    adminSetupCode = makeAdminSetupCode();
  }

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
  server.put("/api/users/me/avatar-image", async (request, reply) => {
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
    const imageId = newAvatarImageId();
    await mkdir(avatarsDir, { recursive: true });
    await writeFile(avatarImagePath(imageId, body.data.mimeType), image);

    return applyUserUpdate(user, {
      avatar: {
        kind: "image",
        imageId,
        mimeType: body.data.mimeType,
        uploadedAt: Date.now(),
      },
    });
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
  server.get<{ Params: { fileName: string } }>("/api/avatars/:fileName", async (request, reply) => {
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
      return reply.code(400).send({ error: result.error });
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

  server.post("/api/admin/claim", async (request, reply) => {
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

    if (claimRateLimited(currentUser.id)) {
      return reply.code(429).send({ error: "Too many claim attempts; try again later" });
    }

    const expected = strategy === "setupCode" ? adminSetupCode : appConfig.admin.passphrase;

    if (!expected || !timingSafeEqualStrings(body.data.secret, expected)) {
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

    appConfig = next;
    store.setConfigValue("config", JSON.stringify(appConfig));
    ensureOllamaBotUser();
    broadcast({ type: "configUpdated", networkConfig: currentNetworkConfig() });
    return redactedConfig();
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
    store,
    adminSetupCode,
    async close() {
      await server.close();
      store.close();
    },
  };
}
