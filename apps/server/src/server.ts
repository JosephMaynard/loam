import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { generateDisplayName } from "@loam/display-name";
import {
  AvatarImageUploadRequestSchema,
  MessageCreateRequestSchema,
  MessageSchema,
  UserSchema,
  UserUpdateRequestSchema,
  type AvatarImageMimeType,
  type Channel,
  type Message,
  type MessageCreateRequest,
  type NetworkConfig,
  type StreamEvent,
  type User,
  type UserUpdateRequest,
} from "@loam/schema";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";

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
    };

type IdentityConfig = {
  allowUserDisplayNameEdit: boolean;
  allowUserAvatarEdit: boolean;
  allowUserAvatarUpload: boolean;
  allowAdminUserEdit: boolean;
};

type OllamaConfig = {
  enabled: boolean;
  baseUrl: string;
  model: string;
  botId: string;
  botDisplayName: string;
  systemPrompt?: string;
};

type LoamConfig = {
  identity: IdentityConfig;
  llm: {
    ollama: OllamaConfig;
  };
};

const rootDir = fileURLToPath(new URL("../../..", import.meta.url));
const dataDir = process.env.LOAM_DATA_DIR ?? join(rootDir, ".loam");
const avatarsDir = join(dataDir, "avatars");
const configPath = process.env.LOAM_CONFIG_FILE ?? join(dataDir, "config.json");
const clientDistDir = join(rootDir, "apps/client/dist");
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const clientPort = Number.parseInt(process.env.CLIENT_PORT ?? "3000", 10);
const host = process.env.HOST ?? "0.0.0.0";
const joinHost = process.env.LOAM_JOIN_HOST ?? localIPv4();
const sessionCookieName = "loam_session";
const sessionCookieMaxAge = 60 * 60 * 24 * 365;
const defaultChannelCreatedAt = 1_704_067_200_000;
const isProduction = process.env.NODE_ENV === "production";
const server = Fastify({
  logger: true,
  serverFactory: (handler) => createServer(handler),
});
const sockets = new Set<SocketSession>();
const sessions = new Map<string, string>();
let staticFilesRegistered = false;
let appConfig: LoamConfig = defaultLoamConfig();
let store: LoamStore;

let data: AppData = {
  users: [],
  channels: [],
  messages: [],
};

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
 * Create the default LOAM configuration for identity and LLM (Ollama) behavior.
 *
 * @returns A `LoamConfig` populated with conservative defaults: user display name and avatar edits/uploads disabled, admin user editing enabled, and Ollama LLM disabled with a localhost `baseUrl`, default `model`, `botId`, and `botDisplayName`.
 */
function defaultLoamConfig(): LoamConfig {
  return {
    identity: {
      allowUserDisplayNameEdit: false,
      allowUserAvatarEdit: false,
      allowUserAvatarUpload: false,
      allowAdminUserEdit: true,
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
 * Select the input boolean when it's strictly a boolean; otherwise select the fallback.
 *
 * @param value - The value to validate as a boolean
 * @param fallback - The boolean to use if `value` is not a boolean
 * @returns `value` if it's a boolean, `fallback` otherwise
 */
function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Get the trimmed string when the input is a non-empty string; otherwise use the fallback.
 *
 * @param value - Value to evaluate and trim if it is a non-empty string
 * @param fallback - String to return when `value` is not a non-empty string
 * @returns The trimmed `value` when it is a non-empty string, otherwise `fallback`
 */
function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/**
 * Loads the server configuration from disk and applies the validated settings to the global `appConfig`.
 *
 * Reads JSON from `configPath`. If the file is missing or the top-level shape is not an object, the default
 * configuration is used. Identity and LLM (ollama) sub-settings are validated and merged with sensible defaults;
 * unexpected I/O or parse errors are propagated.
 */
async function loadAppConfig(): Promise<void> {
  const defaults = defaultLoamConfig();

  try {
    const raw = await readFile(configPath, "utf8");
    const parsed: unknown = JSON.parse(raw);

    if (!isRecord(parsed)) {
      appConfig = defaults;
      return;
    }

    const identity = isRecord(parsed.identity) ? parsed.identity : {};
    const llm = isRecord(parsed.llm) ? parsed.llm : {};
    const ollama = isRecord(llm.ollama) ? llm.ollama : {};

    appConfig = {
      identity: {
        allowUserDisplayNameEdit: readBoolean(
          identity.allowUserDisplayNameEdit,
          defaults.identity.allowUserDisplayNameEdit,
        ),
        allowUserAvatarEdit: readBoolean(identity.allowUserAvatarEdit, defaults.identity.allowUserAvatarEdit),
        allowUserAvatarUpload: readBoolean(identity.allowUserAvatarUpload, defaults.identity.allowUserAvatarUpload),
        allowAdminUserEdit: readBoolean(identity.allowAdminUserEdit, defaults.identity.allowAdminUserEdit),
      },
      llm: {
        ollama: {
          enabled: readBoolean(ollama.enabled, defaults.llm.ollama.enabled),
          baseUrl: readString(ollama.baseUrl, defaults.llm.ollama.baseUrl),
          model: readString(ollama.model, defaults.llm.ollama.model),
          botId: readString(ollama.botId, defaults.llm.ollama.botId),
          botDisplayName: readString(ollama.botDisplayName, defaults.llm.ollama.botDisplayName),
          systemPrompt:
            typeof ollama.systemPrompt === "string" && ollama.systemPrompt.trim()
              ? ollama.systemPrompt.trim()
              : undefined,
        },
      },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      appConfig = defaults;
      return;
    }

    throw error;
  }
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
  return `user.${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

function makeSessionToken(): string {
  return crypto.randomUUID();
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
 * Ensures a user with the specified id exists in the application's in-memory user list, creating, persisting, and broadcasting a new user when absent.
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
 * Ensures the configured Ollama bot user exists in the in-memory user store and is up to date.
 *
 * If Ollama is disabled in the current configuration, no changes are made.
 *
 * Side effects: may create or update a user record, mark data as dirty for persistence, and broadcast a `userUpserted` client event.
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
 *
 * @returns The NetworkConfig object containing feature flags for channels, replies, DMs, reactions, markdown, LLM chat/streaming, and user avatar/display edit/upload permissions.
 */
function currentNetworkConfig(): NetworkConfig {
  return {
    enablePublicChannels: true,
    enablePrivateChannels: false,
    enableUserChannels: true,
    enableReplies: true,
    enableDMs: true,
    enableReactions: true,
    enableMarkdown: true,
    enableLLMChat: appConfig.llm.ollama.enabled,
    enableLLMStreaming: appConfig.llm.ollama.enabled,
    allowUserDisplayNameEdit: appConfig.identity.allowUserDisplayNameEdit,
    allowUserAvatarEdit: appConfig.identity.allowUserAvatarEdit,
    allowUserAvatarUpload: appConfig.identity.allowUserAvatarUpload,
  };
}

/**
 * Apply validated user update fields to an existing user object.
 *
 * Validates the merged user record, mutates the provided `user` in-place with validated values,
 * marks persistent data as dirty, and broadcasts a `userUpserted` client event.
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
 *
 * @returns The array of users to expose: when Ollama LLM is enabled, all users; otherwise users excluding those whose `type` is `"bot"`.
 */
function visibleUsers(): User[] {
  return appConfig.llm.ollama.enabled ? data.users : data.users.filter((user) => user.type !== "bot");
}

/**
 * Generates a new unique avatar image identifier.
 *
 * @returns A string in the form `avt_<16-hex-chars>` suitable for use as an avatar image filename base
 */
function newAvatarImageId(): string {
  return `avt_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
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
 * Build the filesystem path for a stored avatar image file.
 *
 * @param imageId - The image identifier (without file extension)
 * @param mimeType - The avatar image MIME type used to determine the file extension
 * @returns The path to the avatar image file inside the avatars directory
 */
function avatarImagePath(imageId: string, mimeType: AvatarImageMimeType): string {
  return join(avatarsDir, `${imageId}.${avatarImageExtension(mimeType)}`);
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

/**
 * Finds the in-memory channel matching the provided id.
 *
 * @param id - The channel id to look up
 * @returns The matching Channel if found, `undefined` otherwise
 */
function ensureChannel(id: string): Channel | undefined {
  return data.channels.find((channel) => channel.id === id);
}

function localIPv4(): string {
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const address of interfaces ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        return address.address;
      }
    }
  }

  return "localhost";
}

function isChannelMessage(message: Message, channelId: string): boolean {
  return (
    (message.type === "channelPost" || message.type === "channelReply") &&
    message.channelId === channelId
  );
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
  if (event.type === "userUpserted") {
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

function newMessageId(prefix = "msg"): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

/**
 * Validate input and create a new message record, or remove an existing reaction when toggled.
 *
 * @param input - The message creation payload specifying type-specific fields (channelId, parentMessageId, targetMessageId, recipientUserId, etc.)
 * @param authorId - The ID of the user creating the message
 * @returns An object containing either `message` with the created Message, `deletedMessageId` and `deletedMessage` when a reaction was toggled off, or `error` with a human-readable failure reason
 */
function createMessage(
  input: MessageCreateRequest,
  authorId: string,
): { message?: Message; deletedMessage?: Message; deletedMessageId?: string; error?: string } {
  ensureUser(authorId);

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
    meta: input.type === "reaction" ? undefined : { markdown: true, source: "human" as const },
  };
  const message = MessageSchema.parse({ ...input, ...base });
  data.messages.push(message);
  store.insertMessage(message);
  return { message };
}

/**
 * Update a message's body and edited metadata in-place.
 *
 * Mutates the provided message (same object), sets `editedAt` to now, updates `meta.streaming` to the provided value, marks in-memory data dirty, and broadcasts a `messageUpdated` client event. If the message has no `body` field, it is returned unchanged.
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
 *
 * @param botId - The bot user's id whose messages should be mapped to the `assistant` role
 * @param currentUserId - The current human user's id whose messages should be mapped to the `user` role
 * @returns An array of chat message objects with `role` (`system` | `user` | `assistant`) and `content`; when a system prompt is configured it is prepended as the first message.
 */
function llmMessagesForUser(botId: string, currentUserId: string): { role: "system" | "user" | "assistant"; content: string }[] {
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
    ? [{ role: "system", content: appConfig.llm.ollama.systemPrompt }, ...messages]
    : messages;
}

/**
 * Build a full Ollama API URL by joining the configured base URL and the given path.
 *
 * @param path - The path to append to the Ollama base URL (e.g., `/api/chat`).
 * @returns The full URL formed by concatenating the configured Ollama base URL with trailing slashes removed and `path`.
 */
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
 * Triggers an Ollama LLM assistant reply to a direct message and streams the assistant's content into a new DM message.
 *
 * If Ollama is disabled, the message is not a DM, the configured bot user is missing, the DM is not addressed to the bot, or the bot authored the message, the function returns without performing any action.
 *
 * Creates a streaming assistant DM message, appends and broadcasts it, incrementally updates its body with streamed deltas from Ollama, finalizes the message on completion, and on error appends an `LLM error` note and logs the error.
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
 * Opens the SQLite store and loads persisted application data into memory.
 *
 * Ensures the data directory exists, runs the one-time legacy JSON import when applicable, then
 * loads `users`, `channels`, `messages`, and `sessions` into the module-level `data` and `sessions`
 * stores. If no channels are persisted, seeds the default channels. Ensures predefined seed users
 * exist and creates or updates the Ollama bot user if configured.
 */
async function loadData(): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  store = openStore(join(dataDir, "loam.db"));

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
    ensureUser(id, id === "user.1234");
  }

  ensureOllamaBotUser();
}

/**
 * Registers the client distribution directory as the server's static file root when that directory exists.
 *
 * If the client distribution directory is found and mounted at `/`, sets `staticFilesRegistered = true`.
 */
async function registerStaticFiles(): Promise<void> {
  try {
    const stats = await stat(clientDistDir);

    if (!stats.isDirectory()) {
      return;
    }
  } catch {
    return;
  }

  await server.register(fastifyStatic, {
    root: clientDistDir,
    prefix: "/",
  });
  staticFilesRegistered = true;
}

await loadAppConfig();
await loadData();
await server.register(fastifyWebsocket);
await registerStaticFiles();

server.get("/api/config", async (request, reply) => {
  const currentUser = ensureUser(getSessionUserId(request, reply));

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

  const user = ensureUser(getSessionUserId(request, reply));
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

  const user = ensureUser(getSessionUserId(request, reply));
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

  const currentUser = ensureUser(getSessionUserId(request, reply));

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

process.on("SIGINT", () => {
  store.close();
  process.exit(0);
});

await server.listen({ host, port });
