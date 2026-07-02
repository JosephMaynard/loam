import { encodeQR, renderQRToSvg } from "@loam/qr";
import {
  AdminBootstrapStrategySchema,
  LoamConfigSchema,
  UserSchema,
  type Channel,
  type FeatureFlags,
  type IdentityConfig,
  type LoamConfig,
  type Message,
  type MessageCreateRequest,
  type NetworkConfig,
  type StreamEvent,
  type User,
  type UserUpdateRequest,
} from "@loam/schema";
import { generateDisplayName } from "@loam/display-name";
import { LocationProvider, useLocation } from "preact-iso";
import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "preact/hooks";

import loamMark from "./assets/loam.svg";
import { Avatar } from "./components/Avatar";
import { deleteRecord, destroyDatabase, getAllRecords, putRecords } from "./lib/local-store";
import { parseMessageResponse, parseRoute, parseSocketEvent, type Conversation } from "./lib/protocol";
import { renderMarkdown } from "./lib/markdown";

type Config = {
  nodeName: string;
  joinUrl: string;
  websocketPath: string;
  currentUser: User;
  networkConfig: NetworkConfig;
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
const QUICK_REACTIONS = ["👍", "❤️", "✅"];
const REQUEST_TIMEOUT_MS = 10_000;
const AVATAR_MODES = ["face", "initial", "pattern"] as const;
const AVATAR_OUTPUT_SIZE = 256;
const AVATAR_MAX_UPLOAD_BYTES = 128 * 1024;

/**
 * Generates a random client user identifier.
 *
 * @returns A string of the form `user.<32-hex-chars>` where the suffix is 16 random bytes encoded as lowercase hex.
 */
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

/**
 * Format a numeric timestamp into a localized hours-and-minutes time string.
 *
 * @param timestamp - Milliseconds since the UNIX epoch
 * @returns The time formatted as hours and minutes according to the current locale (e.g., "09:05")
 */
function displayTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

/**
 * Get the display text for a message, substituting a streaming placeholder when appropriate.
 *
 * @param message - The message to extract text from; may be any Message variant.
 * @returns The message `body` if present and non-empty, `"Thinking..."` when `body` is empty and `message.meta?.streaming` is true, or an empty string when no body is available.
 */
function bodyFor(message: Message): string {
  if (!("body" in message)) {
    return "";
  }

  return message.body || (message.meta?.streaming ? "Thinking..." : "");
}

/**
 * Builds the route path for a conversation (channel or direct message).
 *
 * @param conversation - The conversation to route to; for channels may include `threadId` to target a thread.
 * @returns The URL path for the conversation, e.g. `/channels/<id>`, `/channel/<id>/thread/<threadId>`, or `/dm/<id>`
 */
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

/**
 * Root application component that manages client state, local persistence, server sync (REST + WebSocket), and renders the LOAM chat UI.
 *
 * Manages users/channels/messages/config, performs initial hydration and server loading, provides message send/update/delete flows, handles live websocket events and reconnection, and wires profile/avatar update and upload handlers into the settings view.
 *
 * @returns The main application element containing the sidebar, the conversation or settings view, and connection/error UI.
 */
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
  const [wiped, setWiped] = useState(false);

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

  const purgeLocalData = useCallback(async () => {
    // Remote wipe (kill switch): drop everything this browser knows, then show a neutral
    // disconnected screen. Best-effort on every step — nothing here may block another.
    setWiped(true);
    setMessages([]);
    setChannels([]);
    setUsers([]);
    setConfig(undefined);
    localStorage.removeItem(CURRENT_USER_KEY);
    localStorage.removeItem(CURRENT_USER_CREATED_AT_KEY);
    localStorage.removeItem(LAST_CONVERSATION_KEY);
    localStorage.removeItem(SERVER_URL_KEY);

    try {
      await destroyDatabase();
    } catch {
      // best effort
    }

    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations().catch(() => []);
      await Promise.all(registrations.map((registration) => registration.unregister().catch(() => false)));
    }

    if (typeof caches !== "undefined") {
      const cacheKeys = await caches.keys().catch(() => []);
      await Promise.all(cacheKeys.map((key) => caches.delete(key).catch(() => false)));
    }
  }, []);

  const applyStreamEvent = useCallback((event: StreamEvent) => {
    if (event.type !== "delta") {
      // start/end/error carry no body text; the final authoritative message arrives via the
      // regular messageUpdated broadcast, which also persists it to IndexedDB.
      return;
    }

    // Append in memory only — per-delta IndexedDB writes would be wasteful, and the closing
    // messageUpdated stores the complete message.
    setMessages((previous) =>
      previous.map((message) =>
        message.id === event.messageId && "body" in message
          ? { ...message, body: message.body + event.text }
          : message,
      ),
    );
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

  const claimAdmin = useCallback(
    async (secret: string) => {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch(apiUrl("/api/admin/claim"), {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": "application/json",
          },
          signal: controller.signal,
          body: JSON.stringify({ secret }),
        });
        const payload: unknown = await response.json().catch(() => undefined);

        if (!response.ok) {
          const message =
            payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
              ? payload.error
              : `Admin claim failed: ${response.status}`;
          throw new Error(message);
        }

        const user = UserSchema.parse(payload);
        setCurrentUser(user);
        upsertUsers([user]);
        setConfig((previous) => (previous ? { ...previous, currentUser: user } : previous));
      } finally {
        window.clearTimeout(timeout);
      }
    },
    [upsertUsers],
  );

  const uploadAvatarImage = useCallback(
    async (blob: Blob) => {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const buffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = "";

      for (const byte of bytes) {
        binary += String.fromCharCode(byte);
      }

      try {
        const response = await fetch(apiUrl("/api/users/me/avatar-image"), {
          method: "PUT",
          credentials: "include",
          headers: {
            "content-type": "application/json",
          },
          signal: controller.signal,
          body: JSON.stringify({
            mimeType: blob.type || "image/png",
            data: btoa(binary),
          }),
        });

        if (!response.ok) {
          throw new Error(`Avatar upload failed: ${response.status}`);
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

        if (payload.type === "stream") {
          applyStreamEvent(payload.event);
          return;
        }

        if (payload.type === "configUpdated") {
          setConfig((previous) =>
            previous ? { ...previous, networkConfig: payload.networkConfig } : previous,
          );
          return;
        }

        if (payload.type === "wipe") {
          void purgeLocalData();
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
  }, [applyStreamEvent, config?.currentUser.id, purgeLocalData, removeMessage, upsertMessages, upsertUsers]);

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

  if (wiped) {
    return (
      <main className="wiped-screen">
        <div>
          <p className="brand-title">LOAM</p>
          <h1>Disconnected</h1>
          <p>This node is no longer available.</p>
        </div>
      </main>
    );
  }

  return (
    <main className={shellClassName}>
      <Sidebar
        activeConversation={activeConversation}
        channels={channels}
        connection={connection}
        currentUser={currentUser}
        users={users}
      />
      {routeState.screen === "admin" ? (
        <AdminView currentUser={currentUser} onWiped={purgeLocalData} />
      ) : routeState.screen === "settings" ? (
        <SettingsView
          config={config}
          currentUser={currentUser}
          onClaimAdmin={claimAdmin}
          onUpdateCurrentUser={updateCurrentUser}
          onUploadAvatarImage={uploadAvatarImage}
        />
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

/**
 * Render the application sidebar with channels, direct-message peers, connection status, and current user info.
 *
 * @param activeConversation - The currently selected conversation (used to mark the active channel or DM).
 * @param channels - List of channels to display in the Channels section.
 * @param connection - Current connection status string (used to display the status pill).
 * @param currentUser - The currently signed-in user (used for the footer identity display).
 * @param users - All known users; peers (other users) are shown in the Direct Messages section.
 * @returns The sidebar element containing navigation links for channels, direct messages, settings, and a current-user panel.
 */
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
        {currentUser.isAdmin ? (
          <NavLink active={false} href="/admin">
            <span className="nav-glyph">⚙</span>
            Admin
          </NavLink>
        ) : null}
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

/**
 * Render a single chat message including avatar, author metadata, formatted body, reactions, and thread/reply controls.
 *
 * @param currentUser - The currently signed-in user (used to determine message ownership).
 * @param message - The message to render.
 * @param onOpenThread - Optional callback invoked with the message id to open its thread view.
 * @param onReact - Callback invoked with the message id and reaction string when a reaction or quick reaction is triggered.
 * @param reactions - Aggregated reaction summaries for this message (used to render reaction buttons and active state).
 * @param replyCount - Number of replies to this message; used to label the thread button.
 * @param usersById - Map of users keyed by id; used to resolve the message author (falls back to a generated ephemeral author when missing).
 * @returns A JSX element representing the message item.
 */
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

/**
 * Renders the thread side panel containing the thread parent message, its replies, and a reply composer.
 *
 * @param currentUser - The currently signed-in user (used to determine ownership and reaction state).
 * @param messages - All messages in the store; used to compute replies and reaction summaries for the thread.
 * @param parent - The parent message that the thread is showing replies for.
 * @param usersById - Map of user id to User objects used to resolve author information for displayed messages.
 * @param onClose - Callback invoked when the panel should be closed (e.g., back or close button).
 * @param onReact - Callback invoked when a reaction action is triggered for a message.
 * @param onReply - Callback invoked with the reply body when the composer submits a new thread reply.
 *
 * @returns The thread panel JSX element.
 */
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

type AvatarCrop = {
  offsetX: number;
  offsetY: number;
  rotation: number;
  zoom: number;
};

type CanvasPointer = {
  x: number;
  y: number;
};

interface AvatarImageEditorProps {
  disabled: boolean;
  onUpload: (blob: Blob) => Promise<void>;
}

/**
 * Constrains a number to the inclusive [min, max] range.
 *
 * @param value - The number to clamp.
 * @param min - The minimum allowed value.
 * @param max - The maximum allowed value.
 * @returns The input value limited to the inclusive range between `min` and `max`.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Convert a pointer event's client coordinates into canvas coordinates scaled to the avatar output size.
 *
 * @param canvas - The target HTML canvas element.
 * @param event - The pointer event whose `clientX`/`clientY` will be mapped.
 * @returns An object with `x` and `y` coordinates in the canvas coordinate space (0..AVATAR_OUTPUT_SIZE).
 */
function canvasPoint(canvas: HTMLCanvasElement, event: PointerEvent): CanvasPointer {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * AVATAR_OUTPUT_SIZE,
    y: ((event.clientY - rect.top) / rect.height) * AVATAR_OUTPUT_SIZE,
  };
}

/**
 * Compute the Euclidean distance between two canvas pointer coordinates.
 *
 * @param left - The first canvas pointer (with `x` and `y`).
 * @param right - The second canvas pointer (with `x` and `y`).
 * @returns The straight-line distance between `left` and `right` in canvas coordinate units.
 */
function pointerDistance(left: CanvasPointer, right: CanvasPointer): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

/**
 * Compute the angle in radians from the `left` point to the `right` point.
 *
 * @param left - The origin point from which the angle is measured
 * @param right - The target point to which the angle is measured
 * @returns The angle in radians measured from the positive X axis to the vector from `left` to `right` (range approximately -π to π)
 */
function pointerAngle(left: CanvasPointer, right: CanvasPointer): number {
  return Math.atan2(right.y - left.y, right.x - left.x);
}

/**
 * Renders the provided image into the given canvas using the specified crop transform.
 *
 * The canvas is cleared and painted with a neutral background, then the image is drawn
 * centered and transformed by `crop.offsetX`, `crop.offsetY` (pixel offsets from center),
 * `crop.rotation` (degrees), and `crop.zoom` (scale multiplier). The image is scaled
 * so its smaller dimension fits the avatar output size before applying `crop.zoom`.
 *
 * @param canvas - Target canvas element sized to `AVATAR_OUTPUT_SIZE`
 * @param image - Source HTMLImageElement to draw (uses `naturalWidth`/`naturalHeight`)
 * @param crop - Crop transform containing:
 *   - `offsetX` and `offsetY`: pixel translations from canvas center
 *   - `rotation`: degrees to rotate the image
 *   - `zoom`: multiplicative scale applied after fitting the image to the output size
 */
function drawAvatarCanvas(canvas: HTMLCanvasElement, image: HTMLImageElement, crop: AvatarCrop): void {
  const context = canvas.getContext("2d");

  if (!context) {
    return;
  }

  const baseScale = AVATAR_OUTPUT_SIZE / Math.min(image.naturalWidth, image.naturalHeight);
  context.clearRect(0, 0, AVATAR_OUTPUT_SIZE, AVATAR_OUTPUT_SIZE);
  context.fillStyle = "#f8fbf6";
  context.fillRect(0, 0, AVATAR_OUTPUT_SIZE, AVATAR_OUTPUT_SIZE);
  context.save();
  context.translate(AVATAR_OUTPUT_SIZE / 2 + crop.offsetX, AVATAR_OUTPUT_SIZE / 2 + crop.offsetY);
  context.rotate((crop.rotation * Math.PI) / 180);
  context.scale(baseScale * crop.zoom, baseScale * crop.zoom);
  context.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2);
  context.restore();
}

/**
 * Create an image Blob from a canvas suitable for avatar upload.
 *
 * Attempts to encode and compress the provided canvas into an image Blob whose size does not exceed AVATAR_MAX_UPLOAD_BYTES; rejects if no acceptable Blob can be produced.
 *
 * @param canvas - The source HTMLCanvasElement to convert
 * @returns A Blob containing the encoded image ready for upload
 */
function blobFromCanvas(canvas: HTMLCanvasElement): Promise<Blob> {
  const formats: { type: "image/webp" | "image/png"; quality?: number }[] = [
    { type: "image/webp", quality: 0.82 },
    { type: "image/webp", quality: 0.72 },
    { type: "image/png" },
  ];

  return new Promise((resolve, reject) => {
    function tryFormat(index: number): void {
      const format = formats[index];

      if (!format) {
        reject(new Error("Avatar image is too large after resizing."));
        return;
      }

      canvas.toBlob(
        (blob) => {
          if (!blob) {
            tryFormat(index + 1);
            return;
          }

          if (blob.size <= AVATAR_MAX_UPLOAD_BYTES) {
            resolve(blob);
            return;
          }

          tryFormat(index + 1);
        },
        format.type,
        format.quality,
      );
    }

    tryFormat(0);
  });
}

/**
 * Renders an avatar image crop-and-upload editor.
 *
 * Allows selecting an image, interactively panning/zooming/rotating a square crop on a 256px canvas, and uploading a compressed/cropped Blob.
 *
 * @param disabled - When true, user interactions and controls are disabled.
 * @param onUpload - Callback invoked with the cropped image Blob when the user chooses "Use cropped image"; the Blob is compressed and sized to meet upload limits.
 * @returns The avatar editor's JSX element.
 */
function AvatarImageEditor({ disabled, onUpload }: AvatarImageEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLImageElement>();
  const pointersRef = useRef(new Map<number, CanvasPointer>());
  const dragRef = useRef<{ point: CanvasPointer; offsetX: number; offsetY: number }>();
  const gestureRef = useRef<{
    angle: number;
    distance: number;
    rotation: number;
    zoom: number;
  }>();
  const objectUrlRef = useRef<string>();
  const loadingImageRef = useRef<HTMLImageElement>();
  const mountedRef = useRef(true);
  const [crop, setCrop] = useState<AvatarCrop>({ offsetX: 0, offsetY: 0, rotation: 0, zoom: 1 });
  const [hasImage, setHasImage] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;

    if (!canvas || !image) {
      return;
    }

    drawAvatarCanvas(canvas, image, crop);
  }, [crop, hasImage]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;

      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = undefined;
      }

      if (loadingImageRef.current) {
        loadingImageRef.current.onload = null;
        loadingImageRef.current.onerror = null;
        loadingImageRef.current.src = "";
        loadingImageRef.current = undefined;
      }
    };
  }, []);

  function startDrag(event: PointerEvent): void {
    const canvas = canvasRef.current;

    if (!canvas || disabled || !hasImage) {
      return;
    }

    canvas.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, canvasPoint(canvas, event));

    if (pointersRef.current.size === 1) {
      dragRef.current = {
        point: canvasPoint(canvas, event),
        offsetX: crop.offsetX,
        offsetY: crop.offsetY,
      };
      gestureRef.current = undefined;
      return;
    }

    const points = Array.from(pointersRef.current.values());
    const [first, second] = points;

    if (first && second) {
      gestureRef.current = {
        angle: pointerAngle(first, second),
        distance: pointerDistance(first, second),
        rotation: crop.rotation,
        zoom: crop.zoom,
      };
      dragRef.current = undefined;
    }
  }

  function moveDrag(event: PointerEvent): void {
    const canvas = canvasRef.current;

    if (!canvas || disabled || !hasImage || !pointersRef.current.has(event.pointerId)) {
      return;
    }

    const point = canvasPoint(canvas, event);
    pointersRef.current.set(event.pointerId, point);

    if (pointersRef.current.size >= 2 && gestureRef.current) {
      const points = Array.from(pointersRef.current.values());
      const [first, second] = points;

      if (!first || !second) {
        return;
      }

      const distance = pointerDistance(first, second);
      const angle = pointerAngle(first, second);
      const nextZoom = clamp(gestureRef.current.zoom * (distance / gestureRef.current.distance), 1, 3);
      const nextRotation = gestureRef.current.rotation + ((angle - gestureRef.current.angle) * 180) / Math.PI;
      setCrop((previous) => ({ ...previous, rotation: nextRotation, zoom: nextZoom }));
      return;
    }

    const drag = dragRef.current;

    if (!drag) {
      return;
    }

    setCrop((previous) => ({
      ...previous,
      offsetX: clamp(drag.offsetX + point.x - drag.point.x, -128, 128),
      offsetY: clamp(drag.offsetY + point.y - drag.point.y, -128, 128),
    }));
  }

  function endDrag(event: PointerEvent): void {
    pointersRef.current.delete(event.pointerId);
    dragRef.current = undefined;
    gestureRef.current = undefined;
  }

  async function selectImage(file: File): Promise<void> {
    if (!file.type.startsWith("image/") || file.type === "image/svg+xml") {
      setError("Choose a PNG, JPEG, or WebP image.");
      return;
    }

    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = undefined;
    }

    if (loadingImageRef.current) {
      loadingImageRef.current.onload = null;
      loadingImageRef.current.onerror = null;
      loadingImageRef.current.src = "";
      loadingImageRef.current = undefined;
    }

    const url = URL.createObjectURL(file);
    const image = new Image();
    objectUrlRef.current = url;
    loadingImageRef.current = image;

    try {
      await new Promise<void>((resolve, reject) => {
        image.onload = () => {
          image.onload = null;
          image.onerror = null;
          resolve();
        };
        image.onerror = () => {
          image.onload = null;
          image.onerror = null;
          reject(new Error("Unable to load image."));
        };
        image.src = url;
      });

      if (!mountedRef.current || objectUrlRef.current !== url) {
        return;
      }

      imageRef.current = image;
      setCrop({ offsetX: 0, offsetY: 0, rotation: 0, zoom: 1 });
      setHasImage(true);
      setError(undefined);
    } catch (nextError) {
      if (mountedRef.current && objectUrlRef.current === url) {
        setError(nextError instanceof Error ? nextError.message : "Unable to load image.");
      }
    } finally {
      if (objectUrlRef.current === url) {
        URL.revokeObjectURL(url);
        objectUrlRef.current = undefined;
      }

      if (loadingImageRef.current === image) {
        loadingImageRef.current = undefined;
      }
    }
  }

  async function upload(): Promise<void> {
    const canvas = canvasRef.current;

    if (!canvas || !hasImage) {
      return;
    }

    setUploading(true);
    setError(undefined);

    try {
      const blob = await blobFromCanvas(canvas);
      await onUpload(blob);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to upload avatar.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="avatar-editor">
      <canvas
        aria-label="Avatar crop preview"
        className="avatar-crop-canvas"
        height={AVATAR_OUTPUT_SIZE}
        onPointerDown={startDrag}
        onPointerCancel={endDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        ref={canvasRef}
        role="img"
        width={AVATAR_OUTPUT_SIZE}
      />
      <input
        accept="image/png,image/jpeg,image/webp,image/*"
        className="sr-only"
        disabled={disabled || uploading}
        onInput={(event) => {
          const file = event.currentTarget.files?.[0];

          if (file) {
            void selectImage(file);
          }
        }}
        ref={fileInputRef}
        type="file"
      />
      <div className="avatar-editor-controls">
        <button disabled={disabled || uploading} onClick={() => fileInputRef.current?.click()} type="button">
          Choose image
        </button>
        <button disabled={disabled || uploading || !hasImage} onClick={() => void upload()} type="button">
          {uploading ? "Uploading" : "Use cropped image"}
        </button>
      </div>
      <label>
        Zoom
        <input
          disabled={disabled || uploading || !hasImage}
          max="3"
          min="1"
          onInput={(event) => setCrop((previous) => ({ ...previous, zoom: Number(event.currentTarget.value) }))}
          step="0.01"
          type="range"
          value={crop.zoom}
        />
      </label>
      <label>
        Rotate
        <input
          disabled={disabled || uploading || !hasImage}
          max="180"
          min="-180"
          onInput={(event) => setCrop((previous) => ({ ...previous, rotation: Number(event.currentTarget.value) }))}
          step="1"
          type="range"
          value={crop.rotation}
        />
      </label>
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}

/**
 * Renders the settings screen for the current user, including join QR, identity preview,
 * profile form (display name and generated avatar style), and an image crop upload editor.
 *
 * The UI respects node feature flags from `config.networkConfig`: it enables or disables
 * display name editing, avatar style editing, and image uploads accordingly. Saving the
 * profile will invoke `onUpdateCurrentUser` with any changed display name or generated
 * avatar settings. Image avatar uploads produced by the crop editor are forwarded to
 * `onUploadAvatarImage`.
 *
 * @param onUpdateCurrentUser - Called with a `UserUpdateRequest` when the user saves profile changes.
 * @param onUploadAvatarImage - Called with the cropped avatar `Blob` when the user uploads an image avatar.
 */
function SettingsView({
  config,
  currentUser,
  onClaimAdmin,
  onUpdateCurrentUser,
  onUploadAvatarImage,
}: {
  config?: Config;
  currentUser: User;
  onClaimAdmin: (secret: string) => Promise<void>;
  onUpdateCurrentUser: (request: UserUpdateRequest) => Promise<void>;
  onUploadAvatarImage: (blob: Blob) => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState(currentUser.displayName);
  const [avatarKind, setAvatarKind] = useState(currentUser.avatar?.kind === "image" ? "image" : "generated");
  const [avatarSeed, setAvatarSeed] = useState(currentUser.avatar?.seed ?? currentUser.id);
  const [avatarMode, setAvatarMode] = useState(currentUser.avatar?.mode ?? "face");
  const [saving, setSaving] = useState(false);
  const [profileError, setProfileError] = useState<string>();
  const allowDisplayNameEdit = config?.networkConfig.allowUserDisplayNameEdit ?? false;
  const allowAvatarEdit = config?.networkConfig.allowUserAvatarEdit ?? false;
  const allowAvatarUpload = config?.networkConfig.allowUserAvatarUpload ?? false;
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
    avatar:
      avatarKind === "image"
        ? currentUser.avatar
        : {
            kind: "generated",
            seed: avatarSeed,
            mode: avatarMode,
          },
  };

  useEffect(() => {
    setDisplayName(currentUser.displayName);
    setAvatarKind(currentUser.avatar?.kind === "image" ? "image" : "generated");
    setAvatarSeed(currentUser.avatar?.seed ?? currentUser.id);
    setAvatarMode(currentUser.avatar?.mode ?? "face");
  }, [
    currentUser.avatar?.imageId,
    currentUser.avatar?.kind,
    currentUser.avatar?.mode,
    currentUser.avatar?.seed,
    currentUser.displayName,
    currentUser.id,
  ]);

  async function saveProfile(): Promise<void> {
    const update: UserUpdateRequest = {};

    if (allowDisplayNameEdit) {
      update.displayName = displayName.trim();
    }

    if (allowAvatarEdit && avatarKind !== "image") {
      update.avatar = {
        kind: "generated",
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
    setAvatarKind("generated");
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
              disabled={!allowAvatarEdit || saving || avatarKind === "image"}
              onInput={(event) => {
                setAvatarKind("generated");
                setAvatarMode(event.currentTarget.value as (typeof AVATAR_MODES)[number]);
              }}
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
          <div className="avatar-upload-panel">
            <div>
              <p className="eyebrow">Image avatar</p>
              <h2>Crop upload</h2>
            </div>
            <AvatarImageEditor
              disabled={!allowAvatarEdit || !allowAvatarUpload || saving}
              onUpload={onUploadAvatarImage}
            />
            {!allowAvatarUpload ? (
              <p className="form-note">Image avatar uploads are disabled on this LOAM node.</p>
            ) : null}
          </div>
          {!allowDisplayNameEdit && !allowAvatarEdit ? (
            <p className="form-note">Profile editing is disabled on this LOAM node.</p>
          ) : null}
          {profileError ? <p className="form-error">{profileError}</p> : null}
        </form>
        <AdminAccessPanel
          allowAdminClaim={config?.networkConfig.allowAdminClaim ?? false}
          currentUser={currentUser}
          onClaimAdmin={onClaimAdmin}
        />
      </div>
    </section>
  );
}

/**
 * Settings panel granting entry to the admin area: a link for admins, a secret claim form when the
 * node's bootstrap strategy allows claiming, or an explanatory note otherwise.
 */
function AdminAccessPanel({
  allowAdminClaim,
  currentUser,
  onClaimAdmin,
}: {
  allowAdminClaim: boolean;
  currentUser: User;
  onClaimAdmin: (secret: string) => Promise<void>;
}) {
  const [secret, setSecret] = useState("");
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string>();

  async function claim(): Promise<void> {
    setClaiming(true);
    setClaimError(undefined);

    try {
      await onClaimAdmin(secret.trim());
      setSecret("");
    } catch (error) {
      setClaimError(error instanceof Error ? error.message : "Unable to claim admin access.");
    } finally {
      setClaiming(false);
    }
  }

  return (
    <div className="profile-panel">
      <div>
        <p className="eyebrow">Administration</p>
        <h2>{currentUser.isAdmin ? "Admin tools" : "Admin access"}</h2>
      </div>
      {currentUser.isAdmin ? (
        <NavLink active={false} className="nav-link" href="/admin">
          Open the admin area →
        </NavLink>
      ) : allowAdminClaim ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void claim();
          }}
        >
          <label>
            Setup code or passphrase
            <input
              autoComplete="off"
              disabled={claiming}
              onInput={(event) => setSecret(event.currentTarget.value)}
              type="password"
              value={secret}
            />
          </label>
          <div className="profile-actions">
            <button disabled={claiming || !secret.trim()} type="submit">
              {claiming ? "Checking" : "Unlock admin"}
            </button>
          </div>
          {claimError ? <p className="form-error">{claimError}</p> : null}
        </form>
      ) : (
        <p className="form-note">Admin claiming is not enabled on this LOAM node.</p>
      )}
    </div>
  );
}

const FEATURE_FLAG_LABELS: [keyof FeatureFlags, string][] = [
  ["enablePublicChannels", "Public channels"],
  ["enablePrivateChannels", "Private channels (not implemented yet)"],
  ["enableUserChannels", "User-created channels (not implemented yet)"],
  ["enableReplies", "Thread replies"],
  ["enableDMs", "Direct messages"],
  ["enableReactions", "Reactions"],
  ["enableMarkdown", "Markdown rendering"],
];

const IDENTITY_LABELS: [keyof IdentityConfig, string][] = [
  ["allowUserDisplayNameEdit", "Users can edit their display name"],
  ["allowUserAvatarEdit", "Users can edit their avatar"],
  ["allowUserAvatarUpload", "Users can upload avatar images"],
  ["allowAdminUserEdit", "Admins can edit other users"],
];

/**
 * Admin-only configuration area: edits node feature flags, identity permissions, LLM settings, and
 * the admin bootstrap strategy via the /api/admin/config endpoints. Client gating is cosmetic —
 * the server enforces admin on every request.
 */
function AdminView({ currentUser, onWiped }: { currentUser: User; onWiped: () => Promise<void> }) {
  const [adminConfig, setAdminConfig] = useState<LoamConfig>();
  const [loadError, setLoadError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [passphrase, setPassphrase] = useState("");
  const [panicToken, setPanicToken] = useState("");
  const [wipeConfirmText, setWipeConfirmText] = useState("");
  const [firing, setFiring] = useState(false);
  const [fireError, setFireError] = useState<string>();

  useEffect(() => {
    if (!currentUser.isAdmin) {
      return;
    }

    let active = true;

    fetchJson<unknown>("/api/admin/config")
      .then((payload) => {
        if (!active) {
          return;
        }

        const parsed = LoamConfigSchema.safeParse(payload);

        if (parsed.success) {
          setAdminConfig(parsed.data);
        } else {
          setLoadError("Received an invalid config payload from the server.");
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setLoadError(error instanceof Error ? error.message : "Unable to load the node config.");
        }
      });

    return () => {
      active = false;
    };
  }, [currentUser.isAdmin]);

  async function save(): Promise<void> {
    if (!adminConfig) {
      return;
    }

    setSaving(true);
    setSaved(false);
    setSaveError(undefined);

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const update = {
        identity: adminConfig.identity,
        features: adminConfig.features,
        llm: { ollama: adminConfig.llm.ollama },
        admin: {
          bootstrap: adminConfig.admin.bootstrap,
          ...(passphrase.trim() ? { passphrase: passphrase.trim() } : {}),
        },
        killSwitch: {
          enabled: adminConfig.killSwitch.enabled,
          requireConfirmation: adminConfig.killSwitch.requireConfirmation,
          ...(panicToken.trim() ? { panicToken: panicToken.trim() } : {}),
        },
        retention: { messageTtlMs: adminConfig.retention.messageTtlMs ?? null },
        security: adminConfig.security,
      };
      const response = await fetch(apiUrl("/api/admin/config"), {
        method: "PATCH",
        credentials: "include",
        headers: {
          "content-type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify(update),
      });
      const payload: unknown = await response.json().catch(() => undefined);

      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
            ? payload.error
            : `Config update failed: ${response.status}`;
        throw new Error(message);
      }

      const parsed = LoamConfigSchema.safeParse(payload);

      if (!parsed.success) {
        throw new Error("The server accepted the update but returned an unrecognised config payload.");
      }

      setAdminConfig(parsed.data);
      setPassphrase("");
      setPanicToken("");
      setSaved(true);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Unable to save the node config.");
    } finally {
      window.clearTimeout(timeout);
      setSaving(false);
    }
  }

  function setFeature(key: keyof FeatureFlags, value: boolean): void {
    setAdminConfig((previous) =>
      previous ? { ...previous, features: { ...previous.features, [key]: value } } : previous,
    );
  }

  function setIdentity(key: keyof IdentityConfig, value: boolean): void {
    setAdminConfig((previous) =>
      previous ? { ...previous, identity: { ...previous.identity, [key]: value } } : previous,
    );
  }

  function setOllama(update: Partial<LoamConfig["llm"]["ollama"]>): void {
    setAdminConfig((previous) =>
      previous
        ? { ...previous, llm: { ollama: { ...previous.llm.ollama, ...update } } }
        : previous,
    );
  }

  function setKillSwitch(update: Partial<LoamConfig["killSwitch"]>): void {
    setAdminConfig((previous) =>
      previous ? { ...previous, killSwitch: { ...previous.killSwitch, ...update } } : previous,
    );
  }

  async function fireKillSwitch(): Promise<void> {
    setFiring(true);
    setFireError(undefined);

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      // The server independently requires { confirm: "wipe" } when requireConfirmation is on, so
      // pass through what the admin actually typed rather than asserting it.
      const body = adminConfig?.killSwitch.requireConfirmation
        ? { confirm: wipeConfirmText.trim() }
        : {};
      const response = await fetch(apiUrl("/api/admin/kill-switch"), {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => undefined);
        const message =
          payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
            ? payload.error
            : `Kill switch failed: ${response.status}`;
        throw new Error(message);
      }

      // The server also broadcasts a wipe event, but purge directly on HTTP success too so the
      // admin's own browser is cleaned even if its socket is closed (purging twice is harmless).
      await onWiped();
    } catch (error) {
      setFireError(error instanceof Error ? error.message : "Unable to trigger the kill switch.");
      setFiring(false);
    } finally {
      window.clearTimeout(timeout);
    }
  }

  if (!currentUser.isAdmin) {
    return (
      <section className="settings-view">
        <header className="conversation-header">
          <NavLink active={false} className="mobile-back" href="/channels">
            ←
          </NavLink>
          <div>
            <p className="eyebrow">Admin</p>
            <h1>Not authorized</h1>
          </div>
        </header>
        <p className="form-note">
          This area is for node administrators. Claim admin access from the settings page if this
          node allows it.
        </p>
      </section>
    );
  }

  return (
    <section className="settings-view">
      <header className="conversation-header">
        <NavLink active={false} className="mobile-back" href="/channels">
          ←
        </NavLink>
        <div>
          <p className="eyebrow">Admin</p>
          <h1>Node configuration</h1>
        </div>
      </header>
      {loadError ? <p className="form-error">{loadError}</p> : null}
      {!adminConfig && !loadError ? <p className="form-note">Loading node config…</p> : null}
      {adminConfig ? (
        <form
          className="settings-grid"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="profile-panel">
            <div>
              <p className="eyebrow">Features</p>
              <h2>Messaging</h2>
            </div>
            {FEATURE_FLAG_LABELS.map(([key, label]) => (
              <label className="admin-toggle" key={key}>
                <input
                  checked={adminConfig.features[key]}
                  disabled={saving}
                  onInput={(event) => setFeature(key, event.currentTarget.checked)}
                  type="checkbox"
                />
                {label}
              </label>
            ))}
          </div>
          <div className="profile-panel">
            <div>
              <p className="eyebrow">Identity</p>
              <h2>Profiles</h2>
            </div>
            {IDENTITY_LABELS.map(([key, label]) => (
              <label className="admin-toggle" key={key}>
                <input
                  checked={adminConfig.identity[key]}
                  disabled={saving}
                  onInput={(event) => setIdentity(key, event.currentTarget.checked)}
                  type="checkbox"
                />
                {label}
              </label>
            ))}
          </div>
          <div className="profile-panel">
            <div>
              <p className="eyebrow">LLM</p>
              <h2>Assistant (Ollama)</h2>
            </div>
            <label className="admin-toggle">
              <input
                checked={adminConfig.llm.ollama.enabled}
                disabled={saving}
                onInput={(event) => setOllama({ enabled: event.currentTarget.checked })}
                type="checkbox"
              />
              Enable the LLM assistant
            </label>
            <label>
              Ollama base URL
              <input
                disabled={saving}
                onInput={(event) => setOllama({ baseUrl: event.currentTarget.value })}
                value={adminConfig.llm.ollama.baseUrl}
              />
            </label>
            <label>
              Model
              <input
                disabled={saving}
                onInput={(event) => setOllama({ model: event.currentTarget.value })}
                value={adminConfig.llm.ollama.model}
              />
            </label>
            <label>
              Bot display name
              <input
                disabled={saving}
                maxLength={80}
                onInput={(event) => setOllama({ botDisplayName: event.currentTarget.value })}
                value={adminConfig.llm.ollama.botDisplayName}
              />
            </label>
            <label>
              System prompt (optional)
              <textarea
                disabled={saving}
                onInput={(event) => setOllama({ systemPrompt: event.currentTarget.value || undefined })}
                rows={3}
                value={adminConfig.llm.ollama.systemPrompt ?? ""}
              />
            </label>
          </div>
          <div className="profile-panel">
            <div>
              <p className="eyebrow">Privacy</p>
              <h2>Message retention</h2>
            </div>
            <label>
              Delete messages after (minutes; blank = keep forever)
              <input
                disabled={saving}
                min={1}
                onInput={(event) => {
                  const minutes = Number.parseInt(event.currentTarget.value, 10);
                  setAdminConfig((previous) =>
                    previous
                      ? {
                          ...previous,
                          retention: {
                            messageTtlMs:
                              Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : undefined,
                          },
                        }
                      : previous,
                  );
                }}
                type="number"
                value={
                  adminConfig.retention.messageTtlMs
                    ? String(Math.round(adminConfig.retention.messageTtlMs / 60_000))
                    : ""
                }
              />
            </label>
            <p className="form-note">
              Expired messages are deleted from the node and from connected clients (checked every
              30 seconds). The proactive companion to the kill switch below.
            </p>
          </div>
          <div className="profile-panel">
            <div>
              <p className="eyebrow">Safety</p>
              <h2>Kill switch</h2>
            </div>
            <label className="admin-toggle">
              <input
                checked={adminConfig.killSwitch.enabled}
                disabled={saving}
                onInput={(event) => setKillSwitch({ enabled: event.currentTarget.checked })}
                type="checkbox"
              />
              Enable the kill switch (instant wipe of all node data)
            </label>
            <label className="admin-toggle">
              <input
                checked={adminConfig.killSwitch.requireConfirmation}
                disabled={saving || !adminConfig.killSwitch.enabled}
                onInput={(event) => setKillSwitch({ requireConfirmation: event.currentTarget.checked })}
                type="checkbox"
              />
              Require typed confirmation before firing
            </label>
            <label>
              Panic token (optional, min 16 chars; enables unauthenticated POST /api/panic; leave
              blank to keep the current one)
              <input
                autoComplete="off"
                disabled={saving || !adminConfig.killSwitch.enabled}
                maxLength={256}
                onInput={(event) => setPanicToken(event.currentTarget.value)}
                type="password"
                value={panicToken}
              />
            </label>
            {adminConfig.killSwitch.enabled ? (
              <div className="danger-zone">
                <p className="form-note">
                  Firing the kill switch permanently deletes all messages, users, sessions, and
                  avatars on this node and remotely purges every connected client. Node settings
                  survive.
                </p>
                {adminConfig.killSwitch.requireConfirmation ? (
                  <label>
                    Type <strong>wipe</strong> to arm the button
                    <input
                      autoComplete="off"
                      disabled={firing}
                      onInput={(event) => setWipeConfirmText(event.currentTarget.value)}
                      value={wipeConfirmText}
                    />
                  </label>
                ) : null}
                <div className="profile-actions">
                  <button
                    className="danger-button"
                    disabled={
                      firing ||
                      (adminConfig.killSwitch.requireConfirmation && wipeConfirmText.trim() !== "wipe")
                    }
                    onClick={() => void fireKillSwitch()}
                    type="button"
                  >
                    {firing ? "Wiping…" : "Wipe this node now"}
                  </button>
                </div>
                {fireError ? <p className="form-error">{fireError}</p> : null}
              </div>
            ) : null}
          </div>
          <div className="profile-panel">
            <div>
              <p className="eyebrow">Admin access</p>
              <h2>Bootstrap</h2>
            </div>
            <label>
              Strategy
              <select
                disabled={saving}
                onInput={(event) =>
                  setAdminConfig((previous) =>
                    previous
                      ? {
                          ...previous,
                          admin: {
                            ...previous.admin,
                            bootstrap: AdminBootstrapStrategySchema.parse(event.currentTarget.value),
                          },
                        }
                      : previous,
                  )
                }
                value={adminConfig.admin.bootstrap}
              >
                {AdminBootstrapStrategySchema.options.map((strategy) => (
                  <option key={strategy} value={strategy}>
                    {strategy}
                  </option>
                ))}
              </select>
            </label>
            {adminConfig.admin.bootstrap === "passphrase" ? (
              <label>
                New admin passphrase (min 8 chars; leave blank to keep the current one)
                <input
                  autoComplete="off"
                  disabled={saving}
                  maxLength={256}
                  onInput={(event) => setPassphrase(event.currentTarget.value)}
                  type="password"
                  value={passphrase}
                />
              </label>
            ) : null}
            <p className="form-note">
              The setup-code strategy prints a one-time claim code in the server logs at startup.
            </p>
            <div className="profile-actions">
              <button disabled={saving} type="submit">
                {saving ? "Saving" : "Save node config"}
              </button>
            </div>
            {saved ? <p className="form-note">Saved. Connected clients pick the change up live.</p> : null}
            {saveError ? <p className="form-error">{saveError}</p> : null}
          </div>
        </form>
      ) : null}
    </section>
  );
}
