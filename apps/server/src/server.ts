import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { generateDisplayName } from "@loam/display-name";
import {
  AvatarImageUploadRequestSchema,
  ChannelSchema,
  MessageCreateRequestSchema,
  MessageSchema,
  UserSchema,
  UserUpdateRequestSchema,
  type AvatarImageMimeType,
  type Channel,
  type Message,
  type MessageCreateRequest,
  type NetworkConfig,
  type User,
  type UserUpdateRequest,
} from "@loam/schema";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";

type DataFile = "users" | "channels" | "messages" | "sessions";
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
type SessionRecord = {
  token: string;
  userId: string;
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

let data: AppData = {
  users: [],
  channels: [],
  messages: [],
};
let dirty = false;
let dataRev = 0;
let saveInProgress: Promise<void> | undefined;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

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

function dataPath(file: DataFile): string {
  return join(dataDir, `${file}.json`);
}

async function readJsonArray<T>(file: DataFile): Promise<T[]> {
  try {
    const raw = await readFile(dataPath(file), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function writeJson(file: DataFile, value: unknown): Promise<void> {
  await mkdir(dirname(dataPath(file)), { recursive: true });
  await writeFile(dataPath(file), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

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

function makeSessionUserId(): string {
  return `user.${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

function makeSessionToken(): string {
  return crypto.randomUUID();
}

function markDirty(): void {
  dirty = true;
  dataRev += 1;
}

function sessionRecords(): SessionRecord[] {
  return Array.from(sessions, ([token, userId]) => ({ token, userId }));
}

function isSessionRecord(value: unknown): value is SessionRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Partial<SessionRecord>;
  return (
    typeof record.token === "string" &&
    record.token.length > 0 &&
    typeof record.userId === "string" &&
    record.userId.length > 0
  );
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
  markDirty();
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

function ensureUser(id: string, isAdmin = false): User {
  const existing = data.users.find((user) => user.id === id);

  if (existing) {
    return existing;
  }

  const user = makeUser(id, isAdmin);
  data.users.push(user);
  markDirty();
  broadcast({ type: "userUpserted", user });
  return user;
}

function ensureOllamaBotUser(): User | undefined {
  if (!appConfig.llm.ollama.enabled) {
    return undefined;
  }

  const existing = data.users.find((user) => user.id === appConfig.llm.ollama.botId);

  if (existing) {
    const next = {
      ...existing,
      displayName: appConfig.llm.ollama.botDisplayName,
      type: "bot" as const,
      isAdmin: false,
      avatar: existing.avatar ?? {
        seed: appConfig.llm.ollama.botId,
        mode: "pattern" as const,
      },
    };
    const parsed = UserSchema.parse(next);
    Object.assign(existing, parsed);
    markDirty();
    broadcast({ type: "userUpserted", user: existing });
    return existing;
  }

  const user = makeBotUser(appConfig.llm.ollama);
  data.users.push(user);
  markDirty();
  broadcast({ type: "userUpserted", user });
  return user;
}

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

function applyUserUpdate(user: User, update: UserUpdateRequest): User {
  const next = UserSchema.parse({
    ...user,
    displayName: update.displayName ?? user.displayName,
    avatar: update.avatar === undefined ? user.avatar : update.avatar,
  });
  Object.assign(user, next);
  markDirty();
  broadcast({ type: "userUpserted", user });
  return user;
}

function visibleUsers(): User[] {
  return appConfig.llm.ollama.enabled ? data.users : data.users.filter((user) => user.type !== "bot");
}

function newAvatarImageId(): string {
  return `avt_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function avatarImageExtension(mimeType: AvatarImageMimeType): string {
  if (mimeType === "image/png") {
    return "png";
  }

  if (mimeType === "image/jpeg") {
    return "jpg";
  }

  return "webp";
}

function avatarImagePath(imageId: string, mimeType: AvatarImageMimeType): string {
  return join(avatarsDir, `${imageId}.${avatarImageExtension(mimeType)}`);
}

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

function avatarImageHasExpectedSignature(buffer: Buffer, mimeType: AvatarImageMimeType): boolean {
  if (mimeType === "image/png") {
    return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }

  if (mimeType === "image/jpeg") {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
  }

  return buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
}

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

function newMessageId(prefix = "msg"): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

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
      markDirty();
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
  markDirty();
  return { message };
}

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
  markDirty();
  broadcast({ type: "messageUpdated", message });
  return message;
}

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

function ollamaUrl(path: string): string {
  return `${appConfig.llm.ollama.baseUrl.replace(/\/+$/, "")}${path}`;
}

async function* streamOllamaChat(
  messages: { role: "system" | "user" | "assistant"; content: string }[],
): AsyncGenerator<string> {
  const response = await fetch(ollamaUrl("/api/chat"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
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
}

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
  markDirty();
  broadcast({ type: "messageCreated", message: assistantMessage });

  let body = "";

  try {
    for await (const delta of streamOllamaChat(llmMessagesForUser(bot.id, userMessage.authorId))) {
      body += delta;
      updateMessage(assistantMessage, body, true);
    }

    updateMessage(assistantMessage, body.trim() || "(No response.)", false);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Ollama error.";
    updateMessage(assistantMessage, `${body}\n\nLLM error: ${message}`.trim(), false);
    server.log.error(error);
  }
}

async function loadData(): Promise<void> {
  await mkdir(dataDir, { recursive: true });

  data = {
    users: (await readJsonArray<User>("users")).map((user) => UserSchema.parse(user)),
    channels: (await readJsonArray<Channel>("channels")).map((channel) => ChannelSchema.parse(channel)),
    messages: (await readJsonArray<Message>("messages")).map((message) => MessageSchema.parse(message)),
  };
  sessions.clear();

  for (const session of await readJsonArray<SessionRecord>("sessions")) {
    if (isSessionRecord(session)) {
      sessions.set(session.token, session.userId);
    }
  }

  if (!data.channels.length) {
    data.channels = defaultChannels.map((channel) => ({ ...channel }));
    markDirty();
  }

  for (const id of seedUsers) {
    ensureUser(id, id === "user.1234");
  }

  ensureOllamaBotUser();
}

async function saveAllData(): Promise<void> {
  if (!dirty) {
    return;
  }

  if (saveInProgress) {
    await saveInProgress;
    return saveAllData();
  }

  const startRev = dataRev;

  saveInProgress = (async () => {
    try {
      await Promise.all([
        writeJson("users", data.users),
        writeJson("channels", data.channels),
        writeJson("messages", data.messages),
        writeJson("sessions", sessionRecords()),
      ]);

      if (dataRev === startRev) {
        dirty = false;
      }
    } catch (error) {
      dirty = true;
      throw error;
    } finally {
      saveInProgress = undefined;
    }
  })();

  await saveInProgress;
}

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

setInterval(() => {
  saveAllData().catch((error) => server.log.error(error));
}, 1000);

process.on("SIGINT", () => {
  saveAllData()
    .catch((error) => server.log.error(error))
    .finally(() => process.exit(0));
});

await server.listen({ host, port });
