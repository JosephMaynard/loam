import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { generateDisplayName } from "@loam/display-name";
import {
  ChannelSchema,
  MessageSchema,
  UserSchema,
  type Channel,
  type Message,
  type User,
} from "@loam/schema";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";

type DataFile = "users" | "channels" | "messages";
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

type CreateMessageRequest =
  | {
      type: "channelPost";
      channelId: string;
      body: string;
    }
  | {
      type: "channelReply";
      channelId: string;
      parentMessageId: string;
      body: string;
    }
  | {
      type: "dm";
      recipientUserId: string;
      body: string;
    }
  | {
      type: "reaction";
      targetMessageId: string;
      reaction: string;
    };

type ClientEvent =
  | {
      type: "messageCreated";
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

const rootDir = fileURLToPath(new URL("../../..", import.meta.url));
const dataDir = process.env.LOAM_DATA_DIR ?? join(rootDir, ".loam");
const clientDistDir = join(rootDir, "apps/client/dist");
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const clientPort = Number.parseInt(process.env.CLIENT_PORT ?? "3000", 10);
const host = process.env.HOST ?? "0.0.0.0";
const joinHost = process.env.LOAM_JOIN_HOST ?? localIPv4();
const sessionCookieName = "loam_session";
const sessionCookieMaxAge = 60 * 60 * 24 * 365;
const server = Fastify({
  logger: true,
  serverFactory: (handler) => createServer(handler),
});
const sockets = new Set<SocketSession>();
const sessions = new Map<string, string>();
let staticFilesRegistered = false;

let data: AppData = {
  users: [],
  channels: [],
  messages: [],
};
let dirty = false;
let dataRev = 0;

const defaultChannels: Channel[] = [
  {
    id: "announcements",
    name: "Announcements",
    description: "Local broadcast notes and coordination updates.",
    visibility: "public",
    allowPosting: "everyone",
    allowReplies: true,
    discoverable: true,
    createdAt: Date.now(),
  },
  {
    id: "general",
    name: "General",
    description: "Open room for everyone on this local LOAM node.",
    visibility: "public",
    allowPosting: "everyone",
    allowReplies: true,
    discoverable: true,
    createdAt: Date.now(),
  },
];

const seedUsers = ["user.1234", "user.5678"];

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
  reply.header(
    "set-cookie",
    `${sessionCookieName}=${encodeCookieValue(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionCookieMaxAge}`,
  );
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

  const message = event.type === "messageCreated" ? event.message : event.message;
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
  input: CreateMessageRequest,
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
    ensureUser(input.recipientUserId);
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

async function loadData(): Promise<void> {
  await mkdir(dataDir, { recursive: true });

  data = {
    users: (await readJsonArray<User>("users")).map((user) => UserSchema.parse(user)),
    channels: (await readJsonArray<Channel>("channels")).map((channel) => ChannelSchema.parse(channel)),
    messages: (await readJsonArray<Message>("messages")).map((message) => MessageSchema.parse(message)),
  };

  if (!data.channels.length) {
    data.channels = defaultChannels;
    markDirty();
  }

  for (const id of seedUsers) {
    ensureUser(id, id === "user.1234");
  }
}

async function saveAllData(): Promise<void> {
  if (!dirty) {
    return;
  }

  const startRev = dataRev;

  try {
    await Promise.all([
      writeJson("users", data.users),
      writeJson("channels", data.channels),
      writeJson("messages", data.messages),
    ]);

    if (dataRev === startRev) {
      dirty = false;
    }
  } catch (error) {
    dirty = true;
    throw error;
  }
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
    networkConfig: {
      enablePublicChannels: true,
      enablePrivateChannels: false,
      enableUserChannels: true,
      enableReplies: true,
      enableDMs: true,
      enableReactions: true,
      enableMarkdown: true,
      enableLLMStreaming: false,
    },
  };
});

server.get("/api/users", async () => data.users);
server.get("/api/channels", async () => data.channels.filter((channel) => !channel.archived));
server.get<{ Params: { channelId: string } }>("/api/messages/:channelId", async (request) =>
  channelMessages(request.params.channelId),
);
server.get<{ Params: { userId: string } }>(
  "/api/dms/:userId",
  async (request, reply) => dmMessages(request.params.userId, getSessionUserId(request, reply)),
);

server.post<{ Body: CreateMessageRequest }>("/api/messages", async (request, reply) => {
  const result = createMessage(request.body, getSessionUserId(request, reply));

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
