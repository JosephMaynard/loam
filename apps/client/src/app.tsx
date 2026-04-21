import { encodeQR, renderQRToSvg } from "@loam/qr";
import {
  MessageSchema,
  UserSchema,
  type Channel,
  type Message,
  type MessageCreateRequest,
  type NetworkConfig,
  type User,
  type UserUpdateRequest,
} from "@loam/schema";
import { generateDisplayName } from "@loam/display-name";
import { LocationProvider, useLocation } from "preact-iso";
import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "preact/hooks";

import loamMark from "./assets/loam.svg";
import { Avatar } from "./components/Avatar";
import { deleteRecord, getAllRecords, putRecords } from "./lib/local-store";
import { renderMarkdown } from "./lib/markdown";

type Conversation =
  | {
      kind: "channel";
      id: string;
      threadId?: string;
    }
  | {
      kind: "dm";
      id: string;
    };

type RouteState =
  | {
      screen: "channels";
      conversation?: Conversation;
    }
  | {
      screen: "settings";
    };

type Config = {
  nodeName: string;
  joinUrl: string;
  websocketPath: string;
  currentUser: User;
  networkConfig: NetworkConfig;
};

type MessageResponse = {
  message?: Message;
  deletedMessageId?: string;
};

type SocketEvent =
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
    }
  | {
      type: "userUpserted";
      user: User;
    };

type ReactionSummary = {
  reaction: string;
  count: number;
  active: boolean;
};

const CURRENT_USER_KEY = "loam.currentUserId";
const CURRENT_USER_CREATED_AT_KEY = "loam.currentUserCreatedAt";
const LAST_CONVERSATION_KEY = "loam.lastConversation";
const SERVER_URL_KEY = "loam.serverUrl";
const DEFAULT_CHANNEL_ID = "general";
const QUICK_REACTIONS = ["👍", "❤️", "✅"];
const REQUEST_TIMEOUT_MS = 10_000;
const AVATAR_MODES = ["face", "initial", "pattern"] as const;

function makeClientUserId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `user.${suffix}`;
}

function getOrCreateCurrentUser(): User {
  let id = localStorage.getItem(CURRENT_USER_KEY);

  if (!id) {
    id = makeClientUserId();
    localStorage.setItem(CURRENT_USER_KEY, id);
  }

  let createdAt = Number(localStorage.getItem(CURRENT_USER_CREATED_AT_KEY));

  if (!Number.isFinite(createdAt) || createdAt <= 0) {
    createdAt = Date.now();
    localStorage.setItem(CURRENT_USER_CREATED_AT_KEY, String(createdAt));
  }

  return {
    id,
    displayName: generateDisplayName(id),
    type: "human",
    isAdmin: false,
    createdAt,
    ephemeral: false,
  };
}

function rememberCurrentUser(user: User): void {
  localStorage.setItem(CURRENT_USER_KEY, user.id);
  localStorage.setItem(CURRENT_USER_CREATED_AT_KEY, String(user.createdAt));
}

function parseRoute(path: string): RouteState {
  if (path === "/" || path === "/channels") {
    return { screen: "channels" };
  }

  if (path === "/settings") {
    return { screen: "settings" };
  }

  const channelThread = path.match(/^\/channel\/([^/]+)\/thread\/([^/]+)$/);

  if (channelThread) {
    return {
      screen: "channels",
      conversation: {
        kind: "channel",
        id: decodeURIComponent(channelThread[1] ?? DEFAULT_CHANNEL_ID),
        threadId: decodeURIComponent(channelThread[2] ?? ""),
      },
    };
  }

  const channel = path.match(/^\/channel\/([^/]+)$/);

  if (channel) {
    return {
      screen: "channels",
      conversation: {
        kind: "channel",
        id: decodeURIComponent(channel[1] ?? DEFAULT_CHANNEL_ID),
      },
    };
  }

  const dm = path.match(/^\/dm\/([^/]+)$/);

  if (dm) {
    return {
      screen: "channels",
      conversation: {
        kind: "dm",
        id: decodeURIComponent(dm[1] ?? ""),
      },
    };
  }

  return { screen: "channels" };
}

function compareCreatedAt(left: Message, right: Message): number {
  return left.createdAt - right.createdAt;
}

function apiUrl(path: string): string {
  return `${localStorage.getItem(SERVER_URL_KEY) ?? ""}${path}`;
}

async function fetchJson<T>(path: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(apiUrl(path), {
      credentials: "include",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }

    return response.json() as Promise<T>;
  } finally {
    window.clearTimeout(timeout);
  }
}

function parseSocketEvent(data: unknown): SocketEvent | undefined {
  let payload: unknown;

  try {
    payload = JSON.parse(String(data));
  } catch (error) {
    console.warn("Ignoring invalid websocket payload.", error);
    return undefined;
  }

  if (!payload || typeof payload !== "object" || !("type" in payload)) {
    return undefined;
  }

  const candidate = payload as { type: unknown; message?: unknown; messageId?: unknown; user?: unknown };

  if (candidate.type === "messageCreated") {
    const message = MessageSchema.safeParse(candidate.message);
    return message.success ? { type: "messageCreated", message: message.data } : undefined;
  }

  if (candidate.type === "messageUpdated") {
    const message = MessageSchema.safeParse(candidate.message);
    return message.success ? { type: "messageUpdated", message: message.data } : undefined;
  }

  if (candidate.type === "messageDeleted") {
    return typeof candidate.messageId === "string"
      ? { type: "messageDeleted", messageId: candidate.messageId }
      : undefined;
  }

  if (candidate.type === "userUpserted") {
    const user = UserSchema.safeParse(candidate.user);
    return user.success ? { type: "userUpserted", user: user.data } : undefined;
  }

  return undefined;
}

function parseMessageResponse(payload: unknown): MessageResponse | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const candidate = payload as { message?: unknown; deletedMessageId?: unknown };
  const result: MessageResponse = {};

  if (candidate.message !== undefined) {
    const message = MessageSchema.safeParse(candidate.message);

    if (!message.success) {
      return undefined;
    }

    result.message = message.data;
  }

  if (candidate.deletedMessageId !== undefined) {
    if (typeof candidate.deletedMessageId !== "string") {
      return undefined;
    }

    result.deletedMessageId = candidate.deletedMessageId;
  }

  return result.message || result.deletedMessageId ? result : undefined;
}

function isConversationMessage(
  message: Message,
  conversation: Conversation,
  currentUserId: string,
): boolean {
  if (conversation.kind === "channel") {
    return (
      (message.type === "channelPost" || message.type === "channelReply") &&
      message.channelId === conversation.id
    );
  }

  return (
    message.type === "dm" &&
    ((message.authorId === currentUserId && message.recipientUserId === conversation.id) ||
      (message.authorId === conversation.id && message.recipientUserId === currentUserId))
  );
}

function conversationMessages(
  allMessages: Message[],
  conversation: Conversation,
  currentUserId: string,
): Message[] {
  const messages = allMessages.filter((message) =>
    isConversationMessage(message, conversation, currentUserId),
  );
  const ids = new Set(messages.map((message) => message.id));
  const reactions = allMessages.filter(
    (message) => message.type === "reaction" && ids.has(message.targetMessageId),
  );
  return [...messages, ...reactions].sort(compareCreatedAt);
}

function topLevelMessages(messages: Message[], conversation: Conversation): Message[] {
  return messages
    .filter((message) => {
      if (conversation.kind === "channel") {
        return message.type === "channelPost";
      }

      return message.type === "dm";
    })
    .sort(compareCreatedAt);
}

function repliesFor(messages: Message[], parentMessageId: string): Message[] {
  return messages
    .filter((message) => message.type === "channelReply" && message.parentMessageId === parentMessageId)
    .sort(compareCreatedAt);
}

function reactionSummary(
  messages: Message[],
  targetMessageId: string,
  currentUserId: string,
): ReactionSummary[] {
  const counts = new Map<string, { count: number; active: boolean }>();

  for (const message of messages) {
    if (message.type !== "reaction" || message.targetMessageId !== targetMessageId) {
      continue;
    }

    const current = counts.get(message.reaction) ?? { count: 0, active: false };
    current.count += 1;
    current.active = current.active || message.authorId === currentUserId;
    counts.set(message.reaction, current);
  }

  return Array.from(counts.entries())
    .map(([reaction, value]) => ({ reaction, ...value }))
    .sort((left, right) => right.count - left.count || left.reaction.localeCompare(right.reaction));
}

function displayTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

function bodyFor(message: Message): string {
  if (!("body" in message)) {
    return "";
  }

  return message.body || (message.meta?.streaming ? "Thinking..." : "");
}

function routeForConversation(conversation: Conversation): string {
  if (conversation.kind === "channel") {
    return conversation.threadId
      ? `/channel/${encodeURIComponent(conversation.id)}/thread/${encodeURIComponent(conversation.threadId)}`
      : `/channel/${encodeURIComponent(conversation.id)}`;
  }

  return `/dm/${encodeURIComponent(conversation.id)}`;
}

function backRouteForThread(conversation: Conversation): string {
  return conversation.kind === "channel"
    ? `/channel/${encodeURIComponent(conversation.id)}`
    : routeForConversation(conversation);
}

export function App() {
  return (
    <LocationProvider>
      <LoamApp />
    </LocationProvider>
  );
}

function LoamApp() {
  const [currentUser, setCurrentUser] = useState(getOrCreateCurrentUser);
  const location = useLocation();
  const routeState = parseRoute(location.path);
  const activeConversation = routeState.screen === "channels" ? routeState.conversation : undefined;
  const shellClassName = [
    "app-shell",
    activeConversation ? "has-conversation" : undefined,
    !activeConversation && routeState.screen === "channels" ? "no-conversation" : undefined,
    activeConversation?.kind === "channel" && activeConversation.threadId ? "thread-open" : undefined,
    routeState.screen === "settings" ? "settings-open" : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  const [channels, setChannels] = useState<Channel[]>([]);
  const [users, setUsers] = useState<User[]>([currentUser]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [config, setConfig] = useState<Config>();
  const [connection, setConnection] = useState<"connecting" | "live" | "offline">("connecting");
  const [error, setError] = useState<string>();

  const upsertUsers = useCallback((incomingUsers: User[]) => {
    setUsers((previous) => {
      const next = new Map(previous.map((user) => [user.id, user]));

      for (const user of incomingUsers) {
        next.set(user.id, user);
      }

      return Array.from(next.values()).sort((left, right) =>
        left.displayName.localeCompare(right.displayName),
      );
    });
    void putRecords("users", incomingUsers);
  }, []);

  const upsertMessages = useCallback((incomingMessages: Message[]) => {
    setMessages((previous) => {
      const next = new Map(previous.map((message) => [message.id, message]));

      for (const message of incomingMessages) {
        next.set(message.id, message);
      }

      return Array.from(next.values()).sort(compareCreatedAt);
    });
    void putRecords("messages", incomingMessages);
  }, []);

  const removeMessage = useCallback((messageId: string) => {
    setMessages((previous) => previous.filter((message) => message.id !== messageId));
    void deleteRecord("messages", messageId);
  }, []);

  const sendMessage = useCallback(
    async (request: MessageCreateRequest) => {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch(apiUrl("/api/messages"), {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": "application/json",
          },
          signal: controller.signal,
          body: JSON.stringify(request),
        });

        if (!response.ok) {
          throw new Error(`Message send failed: ${response.status}`);
        }

        let payload: unknown;

        try {
          payload = await response.json();
        } catch (error) {
          throw new Error("Message send failed: invalid JSON response.", { cause: error });
        }

        const result = parseMessageResponse(payload);

        if (!result) {
          throw new Error("Message send failed: invalid response payload.");
        }

        if (result.message) {
          upsertMessages([result.message]);
        }

        if (result.deletedMessageId) {
          removeMessage(result.deletedMessageId);
        }
      } finally {
        window.clearTimeout(timeout);
      }
    },
    [removeMessage, upsertMessages],
  );

  const updateCurrentUser = useCallback(
    async (request: UserUpdateRequest) => {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch(apiUrl("/api/users/me"), {
          method: "PATCH",
          credentials: "include",
          headers: {
            "content-type": "application/json",
          },
          signal: controller.signal,
          body: JSON.stringify(request),
        });

        if (!response.ok) {
          throw new Error(`Profile update failed: ${response.status}`);
        }

        const user = UserSchema.parse(await response.json());
        setCurrentUser(user);
        upsertUsers([user]);
      } finally {
        window.clearTimeout(timeout);
      }
    },
    [upsertUsers],
  );

  useEffect(() => {
    if (location.path === "/") {
      location.route("/channels", true);
    }
  }, [location]);

  useEffect(() => {
    localStorage.setItem(LAST_CONVERSATION_KEY, location.path);
  }, [location.path]);

  useEffect(() => {
    let active = true;

    Promise.all([
      getAllRecords<Channel>("channels"),
      getAllRecords<User>("users"),
      getAllRecords<Message>("messages"),
    ])
      .then(([cachedChannels, cachedUsers, cachedMessages]) => {
        if (!active) {
          return;
        }

        setChannels(cachedChannels);
        upsertUsers([currentUser, ...cachedUsers]);
        setMessages(cachedMessages.sort(compareCreatedAt));
      })
      .catch(() => undefined);

    Promise.all([fetchJson<Config>("/api/config"), fetchJson<Channel[]>("/api/channels"), fetchJson<User[]>("/api/users")])
      .then(([nextConfig, nextChannels, nextUsers]) => {
        if (!active) {
          return;
        }

        setConfig(nextConfig);
        rememberCurrentUser(nextConfig.currentUser);
        setCurrentUser(nextConfig.currentUser);
        setUsers((previous) =>
          previous.filter((user) => user.id !== currentUser.id || user.id === nextConfig.currentUser.id),
        );
        setChannels(nextChannels);
        upsertUsers([nextConfig.currentUser, ...nextUsers]);
        void putRecords("channels", nextChannels);
      })
      .catch((nextError: unknown) => {
        if (active) {
          setError(nextError instanceof Error ? nextError.message : "Unable to reach the LOAM server.");
          setConnection("offline");
        }
      });

    return () => {
      active = false;
    };
  }, [currentUser.id, upsertUsers]);

  useEffect(() => {
    if (!activeConversation) {
      return;
    }

    const path =
      activeConversation.kind === "channel"
        ? `/api/messages/${encodeURIComponent(activeConversation.id)}`
        : `/api/dms/${encodeURIComponent(activeConversation.id)}`;

    fetchJson<Message[]>(path)
      .then((nextMessages) => upsertMessages(nextMessages))
      .catch((nextError: unknown) => {
        setError(nextError instanceof Error ? nextError.message : "Unable to load messages.");
      });
  }, [activeConversation?.id, activeConversation?.kind, currentUser.id, upsertMessages]);

  useEffect(() => {
    if (!config?.currentUser.id) {
      return;
    }

    const configuredServer = localStorage.getItem(SERVER_URL_KEY);
    const socketUrl = configuredServer
      ? `${configuredServer.replace(/^http/, "ws")}/ws`
      : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`;
    let disposed = false;
    let reconnectAttempts = 0;
    let reconnectTimer: number | undefined;
    let socket: WebSocket | undefined;
    let socketAttempt = 0;

    function scheduleReconnect(): void {
      if (disposed || reconnectTimer !== undefined) {
        return;
      }

      const delay = Math.min(30_000, 1_000 * 2 ** reconnectAttempts);
      reconnectAttempts += 1;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        connectWebSocket();
      }, delay);
    }

    function connectWebSocket(): void {
      if (disposed) {
        return;
      }

      socketAttempt += 1;
      const attempt = socketAttempt;
      const nextSocket = new WebSocket(socketUrl);
      socket = nextSocket;
      setConnection("connecting");

      nextSocket.onopen = () => {
        if (disposed || attempt !== socketAttempt) {
          return;
        }

        reconnectAttempts = 0;
        setConnection("live");
      };
      nextSocket.onclose = () => {
        if (disposed || attempt !== socketAttempt) {
          return;
        }

        setConnection("offline");
        scheduleReconnect();
      };
      nextSocket.onerror = () => {
        if (disposed || attempt !== socketAttempt) {
          return;
        }

        setConnection("offline");
        nextSocket.close();
      };
      nextSocket.onmessage = (event) => {
        if (disposed || attempt !== socketAttempt) {
          return;
        }

        const payload = parseSocketEvent(event.data);

        if (!payload) {
          return;
        }

        if (payload.type === "messageCreated" || payload.type === "messageUpdated") {
          upsertMessages([payload.message]);
          return;
        }

        if (payload.type === "messageDeleted") {
          removeMessage(payload.messageId);
          return;
        }

        upsertUsers([payload.user]);
      };
    }

    connectWebSocket();

    return () => {
      disposed = true;

      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
      }

      socket?.close();
    };
  }, [config?.currentUser.id, removeMessage, upsertMessages, upsertUsers]);

  const usersById = useMemo(() => {
    const indexed = new Map(users.map((user) => [user.id, user]));
    indexed.set(currentUser.id, currentUser);
    return indexed;
  }, [currentUser, users]);
  const selectedMessages = useMemo(
    () =>
      activeConversation
        ? conversationMessages(messages, activeConversation, currentUser.id)
        : [],
    [activeConversation, currentUser.id, messages],
  );

  return (
    <main className={shellClassName}>
      <Sidebar
        activeConversation={activeConversation}
        channels={channels}
        connection={connection}
        currentUser={currentUser}
        users={users}
      />
      {routeState.screen === "settings" ? (
        <SettingsView config={config} currentUser={currentUser} onUpdateCurrentUser={updateCurrentUser} />
      ) : (
        <ConversationView
          conversation={activeConversation}
          currentUser={currentUser}
          messages={selectedMessages}
          onReact={(messageId, reaction) =>
            sendMessage({
              type: "reaction",
              targetMessageId: messageId,
              reaction,
            })
          }
          onSend={(body) => {
            if (!activeConversation) {
              return Promise.resolve();
            }

            if (activeConversation.kind === "channel") {
              return sendMessage({
                type: "channelPost",
                channelId: activeConversation.id,
                body,
              });
            }

            return sendMessage({
              type: "dm",
              recipientUserId: activeConversation.id,
              body,
            });
          }}
          onThreadReply={(parentMessageId, body) => {
            if (!activeConversation || activeConversation.kind !== "channel") {
              return Promise.resolve();
            }

            return sendMessage({
              type: "channelReply",
              channelId: activeConversation.id,
              parentMessageId,
              body,
            });
          }}
          usersById={usersById}
        />
      )}
      {error ? <p className="connection-error">{error}</p> : null}
    </main>
  );
}

interface SidebarProps {
  activeConversation?: Conversation;
  channels: Channel[];
  connection: "connecting" | "live" | "offline";
  currentUser: User;
  users: User[];
}

function Sidebar({ activeConversation, channels, connection, currentUser, users }: SidebarProps) {
  const peers = users.filter((user) => user.id !== currentUser.id);

  return (
    <aside className="sidebar">
      <div className="brand-row">
        <img src={loamMark} alt="" className="brand-mark" />
        <div>
          <p className="brand-title">LOAM</p>
          <p className={`status-pill status-${connection}`}>{connection}</p>
        </div>
      </div>

      <section className="nav-section">
        <h2>Channels</h2>
        <nav aria-label="Channels">
          {channels.map((channel) => (
            <NavLink
              active={activeConversation?.kind === "channel" && activeConversation.id === channel.id}
              href={`/channel/${encodeURIComponent(channel.id)}`}
              key={channel.id}
            >
              <span className="nav-glyph">#</span>
              {channel.name}
            </NavLink>
          ))}
        </nav>
      </section>

      <section className="nav-section">
        <h2>Direct Messages</h2>
        <nav aria-label="Direct messages">
          {peers.map((user) => (
            <NavLink
              active={activeConversation?.kind === "dm" && activeConversation.id === user.id}
              href={`/dm/${encodeURIComponent(user.id)}`}
              key={user.id}
            >
              <Avatar avatar={user.avatar} id={user.id} />
              {user.displayName}
            </NavLink>
          ))}
        </nav>
      </section>

      <div className="sidebar-footer">
        <NavLink active={false} href="/settings">
          <span className="nav-glyph">⌁</span>
          Join QR and settings
        </NavLink>
        <div className="current-user">
          <Avatar avatar={currentUser.avatar} id={currentUser.id} />
          <div>
            <strong>{currentUser.displayName}</strong>
            <span>{currentUser.id}</span>
          </div>
        </div>
      </div>
    </aside>
  );
}

interface NavLinkProps {
  active: boolean;
  children: ComponentChildren;
  className?: string;
  href: string;
}

function NavLink({ active, children, className, href }: NavLinkProps) {
  const location = useLocation();
  const linkClassName = className ?? `nav-link${active ? " active" : ""}`;

  return (
    <a
      aria-current={active ? "page" : undefined}
      className={linkClassName}
      href={href}
      onClick={(event) => {
        event.preventDefault();
        location.route(href);
      }}
    >
      {children}
    </a>
  );
}

interface ConversationViewProps {
  conversation?: Conversation;
  currentUser: User;
  messages: Message[];
  onReact: (messageId: string, reaction: string) => Promise<void>;
  onSend: (body: string) => Promise<void>;
  onThreadReply: (parentMessageId: string, body: string) => Promise<void>;
  usersById: Map<string, User>;
}

function ConversationView({
  conversation,
  currentUser,
  messages,
  onReact,
  onSend,
  onThreadReply,
  usersById,
}: ConversationViewProps) {
  const location = useLocation();
  const topMessages = conversation ? topLevelMessages(messages, conversation) : [];
  const threadParent =
    conversation?.kind === "channel" && conversation.threadId
      ? topMessages.find((message) => message.id === conversation.threadId)
      : undefined;

  if (!conversation) {
    return (
      <section className="conversation empty-state">
        <div>
          <p className="eyebrow">Local node ready</p>
          <h1>Choose a channel or direct message.</h1>
          <p>
            Messages, replies and reactions persist locally and sync through the laptop or Raspberry Pi
            server while it is running.
          </p>
        </div>
      </section>
    );
  }

  const title =
    conversation.kind === "channel"
      ? `# ${conversation.id}`
      : usersById.get(conversation.id)?.displayName ?? conversation.id;

  return (
    <>
      <section className="conversation">
        <ConversationHeader conversation={conversation} title={title} />
        <MessageList
          conversation={conversation}
          currentUser={currentUser}
          messages={messages}
          onOpenThread={(messageId) => {
            if (conversation.kind === "channel") {
              location.route(`/channel/${encodeURIComponent(conversation.id)}/thread/${encodeURIComponent(messageId)}`);
            }
          }}
          onReact={onReact}
          topMessages={topMessages}
          usersById={usersById}
        />
        <MessageComposer
          label={conversation.kind === "channel" ? `Message ${conversation.id}` : `Message ${title}`}
          onSend={onSend}
          placeholder={conversation.kind === "channel" ? "Post an update" : "Send a direct message"}
        />
      </section>

      {threadParent ? (
        <ThreadPanel
          currentUser={currentUser}
          messages={messages}
          onClose={() => location.route(backRouteForThread(conversation))}
          onReact={onReact}
          onReply={(body) => onThreadReply(threadParent.id, body)}
          parent={threadParent}
          usersById={usersById}
        />
      ) : null}
    </>
  );
}

function ConversationHeader({ conversation, title }: { conversation: Conversation; title: string }) {
  return (
    <header className="conversation-header">
      <NavLink active={false} className="mobile-back" href="/channels">
        ←
      </NavLink>
      <div>
        <p className="eyebrow">{conversation.kind === "channel" ? "Channel" : "Direct message"}</p>
        <h1>{title}</h1>
      </div>
    </header>
  );
}

interface MessageListProps {
  conversation: Conversation;
  currentUser: User;
  messages: Message[];
  onOpenThread: (messageId: string) => void;
  onReact: (messageId: string, reaction: string) => Promise<void>;
  topMessages: Message[];
  usersById: Map<string, User>;
}

function MessageList({
  conversation,
  currentUser,
  messages,
  onOpenThread,
  onReact,
  topMessages,
  usersById,
}: MessageListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const previousScrollHeightRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const el = listRef.current;

    if (!el) {
      return;
    }

    const previousScrollHeight = previousScrollHeightRef.current;
    const distanceFromBottom =
      previousScrollHeight === undefined ? 0 : previousScrollHeight - el.scrollTop - el.clientHeight;

    previousScrollHeightRef.current = el.scrollHeight;

    if (distanceFromBottom < 100) {
      el.scrollTo({ top: el.scrollHeight });
    }
  }, [topMessages.length]);

  return (
    <div className="message-list" ref={listRef}>
      {topMessages.length ? (
        topMessages.map((message) => (
          <MessageItem
            currentUser={currentUser}
            key={message.id}
            message={message}
            onOpenThread={conversation.kind === "channel" ? onOpenThread : undefined}
            onReact={onReact}
            reactions={reactionSummary(messages, message.id, currentUser.id)}
            replyCount={repliesFor(messages, message.id).length}
            usersById={usersById}
          />
        ))
      ) : (
        <p className="empty-copy">No messages yet. Start with the practical detail everyone needs.</p>
      )}
    </div>
  );
}

interface MessageItemProps {
  currentUser: User;
  message: Message;
  onOpenThread?: (messageId: string) => void;
  onReact: (messageId: string, reaction: string) => Promise<void>;
  reactions: ReactionSummary[];
  replyCount?: number;
  usersById: Map<string, User>;
}

function MessageItem({
  currentUser,
  message,
  onOpenThread,
  onReact,
  reactions,
  replyCount = 0,
  usersById,
}: MessageItemProps) {
  const author = usersById.get(message.authorId) ?? {
    id: message.authorId,
    displayName: generateDisplayName(message.authorId),
    type: "human",
    isAdmin: false,
    createdAt: message.createdAt,
    ephemeral: true,
  };
  const isMine = message.authorId === currentUser.id;
  const messageClassName = ["message", isMine ? "mine" : undefined, message.meta?.streaming ? "streaming" : undefined]
    .filter(Boolean)
    .join(" ");

  return (
    <article className={messageClassName}>
      <Avatar avatar={author.avatar} id={author.id} />
      <div className="message-main">
        <div className="message-meta">
          <strong>{author.displayName}</strong>
          <span>{displayTime(message.createdAt)}</span>
        </div>
        <div
          className="markdown-body"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(bodyFor(message)) }}
        />
        <div className="message-actions">
          {message.meta?.streaming ? <span className="streaming-pill">Streaming</span> : null}
          {!message.meta?.streaming && reactions.map((reaction) => (
            <button
              className={reaction.active ? "reaction active" : "reaction"}
              key={reaction.reaction}
              onClick={() => void onReact(message.id, reaction.reaction)}
              type="button"
            >
              {reaction.reaction} {reaction.count}
            </button>
          ))}
          {!message.meta?.streaming && QUICK_REACTIONS.filter(
            (reaction) => !reactions.some((summary) => summary.reaction === reaction),
          ).map((reaction) => (
            <button
              className="quick-reaction"
              key={reaction}
              onClick={() => void onReact(message.id, reaction)}
              type="button"
            >
              {reaction}
            </button>
          ))}
          {onOpenThread && !message.meta?.streaming ? (
            <button className="thread-button" onClick={() => onOpenThread(message.id)} type="button">
              {replyCount ? `${replyCount} repl${replyCount === 1 ? "y" : "ies"}` : "Reply"}
            </button>
          ) : null}
        </div>
      </div>
    </article>
  );
}

interface MessageComposerProps {
  label: string;
  onSend: (body: string) => Promise<void>;
  placeholder: string;
}

function MessageComposer({ label, onSend, placeholder }: MessageComposerProps) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const composerId = useId();
  const textAreaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const textArea = textAreaRef.current;

    if (!textArea) {
      return;
    }

    textArea.style.height = "auto";
    textArea.style.height = `${Math.min(textArea.scrollHeight, 168)}px`;
  }, [value]);

  async function submit(): Promise<void> {
    const body = value.trim();

    if (!body || sending) {
      return;
    }

    setSending(true);

    try {
      await onSend(body);
      setValue("");
    } finally {
      setSending(false);
    }
  }

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label className="sr-only" for={composerId}>
        {label}
      </label>
      <textarea
        id={composerId}
        onInput={(event) => setValue(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder={placeholder}
        ref={textAreaRef}
        rows={1}
        value={value}
      />
      <button disabled={!value.trim() || sending} type="submit">
        Send
      </button>
    </form>
  );
}

interface ThreadPanelProps {
  currentUser: User;
  messages: Message[];
  onClose: () => void;
  onReact: (messageId: string, reaction: string) => Promise<void>;
  onReply: (body: string) => Promise<void>;
  parent: Message;
  usersById: Map<string, User>;
}

function ThreadPanel({
  currentUser,
  messages,
  onClose,
  onReact,
  onReply,
  parent,
  usersById,
}: ThreadPanelProps) {
  const replies = repliesFor(messages, parent.id);

  return (
    <aside className="thread-panel">
      <header className="thread-header">
        <button className="mobile-back" onClick={onClose} type="button">
          ←
        </button>
        <div>
          <p className="eyebrow">Thread</p>
          <h2>Replies</h2>
        </div>
        <button aria-label="Close thread" className="close-button" onClick={onClose} type="button">
          ×
        </button>
      </header>
      <div className="thread-scroll">
        <MessageItem
          currentUser={currentUser}
          message={parent}
          onReact={onReact}
          reactions={reactionSummary(messages, parent.id, currentUser.id)}
          usersById={usersById}
        />
        <div className="reply-divider">{replies.length ? `${replies.length} replies` : "No replies yet"}</div>
        {replies.map((reply) => (
          <MessageItem
            currentUser={currentUser}
            key={reply.id}
            message={reply}
            onReact={onReact}
            reactions={reactionSummary(messages, reply.id, currentUser.id)}
            usersById={usersById}
          />
        ))}
      </div>
      <MessageComposer label="Reply in thread" onSend={onReply} placeholder="Reply in thread" />
    </aside>
  );
}

function SettingsView({
  config,
  currentUser,
  onUpdateCurrentUser,
}: {
  config?: Config;
  currentUser: User;
  onUpdateCurrentUser: (request: UserUpdateRequest) => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState(currentUser.displayName);
  const [avatarSeed, setAvatarSeed] = useState(currentUser.avatar?.seed ?? currentUser.id);
  const [avatarMode, setAvatarMode] = useState(currentUser.avatar?.mode ?? "face");
  const [saving, setSaving] = useState(false);
  const [profileError, setProfileError] = useState<string>();
  const allowDisplayNameEdit = config?.networkConfig.allowUserDisplayNameEdit ?? false;
  const allowAvatarEdit = config?.networkConfig.allowUserAvatarEdit ?? false;
  const qrSvg = useMemo(() => {
    if (!config?.joinUrl) {
      return "";
    }

    return renderQRToSvg(encodeQR(config.joinUrl), {
      dark: "#203f34",
      light: "#ffffff",
    });
  }, [config?.joinUrl]);
  const previewUser: User = {
    ...currentUser,
    displayName,
    avatar: {
      seed: avatarSeed,
      mode: avatarMode,
    },
  };

  useEffect(() => {
    setDisplayName(currentUser.displayName);
    setAvatarSeed(currentUser.avatar?.seed ?? currentUser.id);
    setAvatarMode(currentUser.avatar?.mode ?? "face");
  }, [currentUser.avatar?.mode, currentUser.avatar?.seed, currentUser.displayName, currentUser.id]);

  async function saveProfile(): Promise<void> {
    const update: UserUpdateRequest = {};

    if (allowDisplayNameEdit) {
      update.displayName = displayName.trim();
    }

    if (allowAvatarEdit) {
      update.avatar = {
        seed: avatarSeed.trim() || currentUser.id,
        mode: avatarMode,
      };
    }

    if (!update.displayName && !update.avatar) {
      return;
    }

    setSaving(true);
    setProfileError(undefined);

    try {
      await onUpdateCurrentUser(update);
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "Unable to update profile.");
    } finally {
      setSaving(false);
    }
  }

  function randomizeAvatar(): void {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    setAvatarSeed(`avatar.${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`);
  }

  return (
    <section className="settings-view">
      <header className="conversation-header">
        <NavLink active={false} className="mobile-back" href="/channels">
          ←
        </NavLink>
        <div>
          <p className="eyebrow">Local access</p>
          <h1>Join this LOAM node</h1>
        </div>
      </header>
      <div className="settings-grid">
        <div className="join-panel">
          <div className="qr-box" dangerouslySetInnerHTML={{ __html: qrSvg }} />
          <p>{config?.joinUrl ?? window.location.origin}</p>
        </div>
        <div className="identity-panel">
          <Avatar avatar={previewUser.avatar} id={currentUser.id} />
          <div>
            <p className="eyebrow">This browser</p>
            <h2>{displayName}</h2>
            <p>{currentUser.id}</p>
          </div>
        </div>
        <form
          className="profile-panel"
          onSubmit={(event) => {
            event.preventDefault();
            void saveProfile();
          }}
        >
          <div>
            <p className="eyebrow">Profile</p>
            <h2>Local identity</h2>
          </div>
          <label>
            Display name
            <input
              disabled={!allowDisplayNameEdit || saving}
              maxLength={80}
              onInput={(event) => setDisplayName(event.currentTarget.value)}
              value={displayName}
            />
          </label>
          <label>
            Avatar style
            <select
              disabled={!allowAvatarEdit || saving}
              onInput={(event) => setAvatarMode(event.currentTarget.value as (typeof AVATAR_MODES)[number])}
              value={avatarMode}
            >
              {AVATAR_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {mode}
                </option>
              ))}
            </select>
          </label>
          <div className="profile-actions">
            <button disabled={!allowAvatarEdit || saving} onClick={randomizeAvatar} type="button">
              New avatar
            </button>
            <button disabled={saving || (!allowDisplayNameEdit && !allowAvatarEdit)} type="submit">
              {saving ? "Saving" : "Save profile"}
            </button>
          </div>
          {!allowDisplayNameEdit && !allowAvatarEdit ? (
            <p className="form-note">Profile editing is disabled on this LOAM node.</p>
          ) : null}
          {profileError ? <p className="form-error">{profileError}</p> : null}
        </form>
      </div>
    </section>
  );
}
