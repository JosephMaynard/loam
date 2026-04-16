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
import Fastify from "fastify";

type DataFile = "users" | "channels" | "messages";
type SocketClient = {
  OPEN: number;
  readyState: number;
  send: (payload: string) => void;
  on: (event: "close", listener: () => void) => void;
};

type AppData = {
  users: User[];
  channels: Channel[];
  messages: Message[];
};

type CreateMessageRequest =
  | {
      type: "channelPost";
      authorId: string;
      channelId: string;
      body: string;
    }
  | {
      type: "channelReply";
      authorId: string;
      channelId: string;
      parentMessageId: string;
      body: string;
    }
  | {
      type: "dm";
      authorId: string;
      recipientUserId: string;
      body: string;
    }
  | {
      type: "reaction";
      authorId: string;
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
const server = Fastify({
  logger: true,
  serverFactory: (handler) => createServer(handler),
});
const sockets = new Set<SocketClient>();
let staticFilesRegistered = false;

let data: AppData = {
  users: [],
  channels: [],
  messages: [],
};
let dirty = false;

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

function ensureUser(id: string, isAdmin = false): User {
  const existing = data.users.find((user) => user.id === id);

  if (existing) {
    return existing;
  }

  const user = makeUser(id, isAdmin);
  data.users.push(user);
  dirty = true;
  broadcast({ type: "userUpserted", user });
  return user;
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

function broadcast(event: ClientEvent): void {
  const payload = JSON.stringify(event);

  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) {
      socket.send(payload);
    }
  }
}

function newMessageId(prefix = "msg"): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function createMessage(input: CreateMessageRequest): { message?: Message; deletedMessageId?: string } {
  ensureUser(input.authorId);

  if (input.type === "reaction") {
    const existingIndex = data.messages.findIndex(
      (message) =>
        message.type === "reaction" &&
        message.authorId === input.authorId &&
        message.targetMessageId === input.targetMessageId &&
        message.reaction === input.reaction,
    );

    if (existingIndex >= 0) {
      const [deleted] = data.messages.splice(existingIndex, 1);
      dirty = true;
      return { deletedMessageId: deleted?.id };
    }
  }

  if (input.type === "dm") {
    ensureUser(input.recipientUserId);
  }

  const base = {
    id: newMessageId(input.type === "reaction" ? "react" : "msg"),
    authorId: input.authorId,
    createdAt: Date.now(),
    meta: input.type === "reaction" ? undefined : { markdown: true, source: "human" as const },
  };
  const message = MessageSchema.parse({ ...base, ...input });
  data.messages.push(message);
  dirty = true;
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
    dirty = true;
  }

  for (const id of seedUsers) {
    ensureUser(id, id === "user.1234");
  }
}

async function saveAllData(): Promise<void> {
  if (!dirty) {
    return;
  }

  dirty = false;
  await Promise.all([
    writeJson("users", data.users),
    writeJson("channels", data.channels),
    writeJson("messages", data.messages),
  ]);
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

server.get("/api/config", async () => ({
  nodeName: "LOAM local",
  joinUrl: `http://${joinHost}:${clientPort}`,
  websocketPath: "/ws",
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
}));

server.get("/api/users", async () => data.users);
server.get("/api/channels", async () => data.channels.filter((channel) => !channel.archived));
server.get<{ Params: { channelId: string } }>("/api/messages/:channelId", async (request) =>
  channelMessages(request.params.channelId),
);
server.get<{ Params: { userId: string }; Querystring: { currentUserId?: string } }>(
  "/api/dms/:userId",
  async (request) => dmMessages(request.params.userId, request.query.currentUserId ?? "user.1234"),
);

server.post<{ Body: CreateMessageRequest }>("/api/messages", async (request, reply) => {
  const result = createMessage(request.body);

  if (result.deletedMessageId) {
    broadcast({ type: "messageDeleted", messageId: result.deletedMessageId });
    return reply.send(result);
  }

  if (!result.message) {
    return reply.code(400).send({ error: "Unable to create message" });
  }

  broadcast({ type: "messageCreated", message: result.message });
  return reply.code(201).send(result);
});

server.get("/ws", { websocket: true }, (connection: SocketClient) => {
  sockets.add(connection);
  connection.on("close", () => sockets.delete(connection));
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
