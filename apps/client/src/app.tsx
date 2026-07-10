import {
  AdminBootstrapStrategySchema,
  ChannelSchema,
  JoinPolicySchema,
  LoamConfigSchema,
  MessageAttachmentSchema,
  MessageSchema,
  securityProfilePreset,
  SecurityProfileSchema,
  SyncStatusReportSchema,
  UserSchema,
  type Channel,
  type ChannelPostingPolicy,
  type FeatureFlags,
  type IdentityConfig,
  type JoinPolicy,
  type LoamConfig,
  type Message,
  type MessageAttachment,
  type MessageCreateRequest,
  type NetworkConfig,
  type Role,
  type SecurityProfile,
  type StreamEvent,
  type SyncStatusReport,
  type User,
  type UserUpdateRequest,
} from "@loam/schema";
import { generateDisplayName } from "@loam/display-name";
import { LocationProvider, useLocation } from "preact-iso";
import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "preact/hooks";

import loamMark from "./assets/loam.svg";
import { Avatar } from "./components/Avatar";
import { InviteControl } from "./components/InviteControl";
import { NodeLinkControl } from "./components/NodeLinkControl";
import { SearchResult } from "./components/SearchResult";
import { UnreadBadge } from "./components/UnreadBadge";
import { ATTACHMENT_MAX_COUNT, attachmentPath, prepareImageAttachment } from "./lib/attachments";
import { canGreet, canManageRoles, canModerate, isProtectedTarget } from "./lib/capabilities";
import { dayKey, dayLabel } from "./lib/dates";
import { deleteRecord, destroyDatabase, getAllRecords, putRecord, putRecords } from "./lib/local-store";
import { parseMessageResponse, parseRoute, parseSocketEvent, type Conversation } from "./lib/protocol";
import { renderMarkdown } from "./lib/markdown";
import { RTL_LOCALES, resolveLocale, setActiveLocale, t } from "./i18n";
import { safeQrSvg } from "./lib/qr";

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
const TOAST_DISMISS_MS = 4_000;
// Single `sync`-store record holding the per-conversation last-read timestamps (ms). One row keeps
// the write cheap; the map is `conversationKey` → last-read time.
const CONVERSATION_READS_KEY = "conversationReads";

type ConversationReads = {
  id: string;
  reads: Record<string, number>;
};

type ToastItem = {
  id: string;
  title: string;
  body: string;
  route: string;
};
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
 * @returns The message `body` if present and non-empty, the localized "thinking" placeholder when `body` is empty and `message.meta?.streaming` is true, or an empty string when no body is available.
 */
function bodyFor(message: Message): string {
  if (!("body" in message)) {
    return "";
  }

  return message.body || (message.meta?.streaming ? t("composer.thinking") : "");
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

/**
 * Stable key for a conversation's read/unread bookkeeping (`channel:<id>` or `dm:<peerId>`).
 *
 * @param conversation - The conversation to key.
 * @returns The conversation key string.
 */
function conversationKey(conversation: Conversation): string {
  return `${conversation.kind}:${conversation.id}`;
}

/**
 * The conversation key a message belongs to from `currentUserId`'s perspective. Reactions have no
 * conversation of their own, so they return `undefined` (they never drive unread/toasts).
 *
 * @param message - The message to classify.
 * @param currentUserId - The signed-in user's id (used to resolve the DM peer).
 * @returns The `channel:<id>` / `dm:<peerId>` key, or `undefined` for reactions.
 */
function messageConversationKey(message: Message, currentUserId: string): string | undefined {
  if (message.type === "channelPost" || message.type === "channelReply") {
    return `channel:${message.channelId}`;
  }

  if (message.type === "dm") {
    const peer = message.authorId === currentUserId ? message.recipientUserId : message.authorId;
    return `dm:${peer}`;
  }

  return undefined;
}

/**
 * Best-effort OS notification for a new message. No-ops unless the Notification API exists, permission
 * is already granted, and the document is hidden — it never prompts and never throws (usually
 * unavailable over an insecure-context LAN origin).
 *
 * @param title - The notification title.
 * @param body - The notification body text.
 */
function notifyIfHidden(title: string, body: string): void {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted" || !document.hidden) {
      return;
    }

    new Notification(title, { body });
  } catch {
    // Best effort only — Notification is commonly blocked on insecure LAN origins.
  }
}

/**
 * Issues a user-related admin/moderation/access request and returns the validated user the server
 * echoes back. Throws with the server's error message (or a status fallback) on failure. Mirrors
 * `requestChannel` for the user-management endpoints.
 *
 * @param method - HTTP method (`POST` for approve/deny, `PATCH` for roles/moderation).
 * @param path - The API path.
 * @param body - Optional JSON request body.
 * @returns The updated `User`.
 */
async function requestUser(method: "POST" | "PATCH", path: string, body?: unknown): Promise<User> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(apiUrl(path), {
      method,
      credentials: "include",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      const message =
        payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
          ? payload.error
          : `Request failed: ${response.status}`;
      throw new Error(message);
    }

    const parsed = UserSchema.safeParse(payload);

    if (!parsed.success) {
      throw new Error("The server returned an unrecognised user payload.");
    }

    return parsed.data;
  } finally {
    window.clearTimeout(timeout);
  }
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
    routeState.screen === "settings" ||
    routeState.screen === "people" ||
    routeState.screen === "admin" ||
    routeState.screen === "search"
      ? "settings-open"
      : undefined,
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
  // Whether the wipe screen reflects a node kill switch ("node") or just this browser ("device").
  const [wipeScope, setWipeScope] = useState<"node" | "device">("node");
  // Bumped to force a full server re-sync: on WebSocket reconnect (missed events don't replay) and
  // on a failed boot fetch (retry with backoff instead of stranding the app offline).
  const [syncTick, setSyncTick] = useState(0);
  const syncFailuresRef = useRef(0);
  const [lastReadByConversation, setLastReadByConversation] = useState<Record<string, number>>({});
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  // Who is connected right now (server presence events; empty when the node disables presence).
  const [onlineUserIds, setOnlineUserIds] = useState<ReadonlySet<string>>(new Set());

  // Refs let the long-lived WebSocket handler read the latest active conversation / users / channels
  // without re-subscribing the socket on every navigation or roster change.
  const activeConversationRef = useRef(activeConversation);
  activeConversationRef.current = activeConversation;
  const routeRef = useRef(location.route);
  routeRef.current = location.route;
  const currentUserIdRef = useRef(currentUser.id);
  currentUserIdRef.current = currentUser.id;
  const channelsRef = useRef(channels);
  channelsRef.current = channels;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const usersByIdRef = useRef<Map<string, User>>(new Map());
  const lastReadRef = useRef(lastReadByConversation);

  /**
   * Persist and apply an updated per-conversation last-read map. `lastReadRef` is the write source of
   * truth so overlapping updates never race the async setState.
   */
  const updateLastRead = useCallback((update: (previous: Record<string, number>) => Record<string, number>) => {
    const next = update(lastReadRef.current);
    lastReadRef.current = next;
    setLastReadByConversation(next);
    void putRecord("sync", { id: CONVERSATION_READS_KEY, reads: next });
  }, []);

  const pushToast = useCallback((toast: ToastItem) => {
    setToasts((previous) => [...previous, toast]);
    window.setTimeout(() => {
      setToasts((previous) => previous.filter((item) => item.id !== toast.id));
    }, TOAST_DISMISS_MS);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((previous) => previous.filter((item) => item.id !== id));
  }, []);

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

  // A `userUpserted` for the signed-in user (approval clearing `pending`, a new role, or a self-ban)
  // rides the same event as every other roster change, so keep `currentUser` in sync too.
  const applyUserUpsert = useCallback(
    (user: User) => {
      upsertUsers([user]);
      setCurrentUser((previous) => (previous.id === user.id ? user : previous));
    },
    [upsertUsers],
  );

  /**
   * Surface a live incoming message in a non-active conversation (and, best effort, as an OS
   * notification) so people notice traffic elsewhere. Skips own messages and reactions. Reads the
   * latest UI state through refs since the WebSocket handler is a stable long-lived closure.
   */
  const maybeToastForMessage = useCallback(
    (message: Message) => {
      const meId = currentUserIdRef.current;

      if (message.authorId === meId) {
        return;
      }

      const key = messageConversationKey(message, meId);

      if (!key) {
        return;
      }

      const active = activeConversationRef.current;

      if (active && conversationKey(active) === key) {
        return;
      }

      const authorName = usersByIdRef.current.get(message.authorId)?.displayName ?? generateDisplayName(message.authorId);
      const body =
        bodyFor(message) ||
        (message.type !== "reaction" && message.attachments?.length ? t("toast.imageFallback") : "");
      let title = authorName;
      let route = routeForConversation({ kind: "dm", id: message.authorId });

      if (message.type === "channelPost" || message.type === "channelReply") {
        const channelName = channelsRef.current.find((channel) => channel.id === message.channelId)?.name ?? message.channelId;
        title = `${authorName} · #${channelName}`;
        route = routeForConversation({ kind: "channel", id: message.channelId });
      }

      pushToast({ id: `${message.id}:${Date.now()}`, title, body, route });
      notifyIfHidden(title, body);
    },
    [pushToast],
  );

  /**
   * Drop a channel this user can no longer see (removed from a private channel, or the channel was
   * archived): purge the channel and its cached messages locally, and leave the conversation if it
   * is on screen.
   */
  const removeChannel = useCallback((channelId: string) => {
    setChannels((previous) => previous.filter((channel) => channel.id !== channelId));
    void deleteRecord("channels", channelId);

    setMessages((previous) => {
      const keep: Message[] = [];

      for (const message of previous) {
        if (
          (message.type === "channelPost" || message.type === "channelReply") &&
          message.channelId === channelId
        ) {
          void deleteRecord("messages", message.id);
        } else {
          keep.push(message);
        }
      }

      return keep;
    });

    const active = activeConversationRef.current;

    if (active?.kind === "channel" && active.id === channelId) {
      routeRef.current("/channels");
    }
  }, []);

  const upsertChannels = useCallback(
    (incomingChannels: Channel[]) => {
      setChannels((previous) => {
        // Map upsert preserves insertion order: existing channels stay put, new ones append. No
        // re-sort, so the seeded Announcements/General keep their position. Archived channels are
        // dropped from the nav, so archiving hides a channel live and restoring re-adds it.
        const next = new Map(previous.map((channel) => [channel.id, channel]));

        for (const channel of incomingChannels) {
          if (channel.archived) {
            next.delete(channel.id);
          } else {
            next.set(channel.id, channel);
          }
        }

        return Array.from(next.values());
      });

      for (const channel of incomingChannels) {
        if (channel.archived) {
          // Archiving revokes visibility: purge like a removal (cached message bodies included —
          // an archived private channel's history must not linger in IndexedDB).
          removeChannel(channel.id);
        }
      }
      void putRecords(
        "channels",
        incomingChannels.filter((channel) => !channel.archived),
      );
    },
    [removeChannel],
  );

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

  /**
   * Apply a conversation's authoritative server message list: upsert everything returned and drop
   * local messages in that conversation (and reactions on them) that the server no longer has.
   * Deletions and retention expiries that happen while this client is offline never arrive as live
   * events, so a plain additive merge would keep the stale copies — including supposedly expired
   * bodies — in memory and IndexedDB forever.
   */
  const reconcileConversationMessages = useCallback(
    (conversation: Conversation, serverMessages: Message[], preFetchIds: Set<string>) => {
      const serverIds = new Set(serverMessages.map((message) => message.id));
      // Two guards against pruning legitimate messages that raced the fetch (sent locally or
      // arriving over the socket while it was in flight): only messages we already held when the
      // request started are prunable at all, and never anything newer than the snapshot's newest
      // entry (server timestamps compared to server timestamps — an empty snapshot has no edge,
      // so there the pre-fetch id set is the only, and sufficient, guard).
      const snapshotEdge = serverMessages.reduce((newest, message) => Math.max(newest, message.createdAt), 0);
      const meId = currentUserIdRef.current;

      setMessages((previous) => {
        const conversationIds = new Set(
          previous
            .filter((message) => isConversationMessage(message, conversation, meId))
            .map((message) => message.id),
        );
        const kept: Message[] = [];

        for (const message of previous) {
          const inConversation =
            isConversationMessage(message, conversation, meId) ||
            (message.type === "reaction" && conversationIds.has(message.targetMessageId));

          if (
            inConversation &&
            !serverIds.has(message.id) &&
            preFetchIds.has(message.id) &&
            (snapshotEdge === 0 || message.createdAt <= snapshotEdge)
          ) {
            void deleteRecord("messages", message.id);
            continue;
          }

          kept.push(message);
        }

        const next = new Map(kept.map((message) => [message.id, message]));

        for (const message of serverMessages) {
          next.set(message.id, message);
        }

        return Array.from(next.values()).sort(compareCreatedAt);
      });
      void putRecords("messages", serverMessages);
    },
    [],
  );

  const removeMessage = useCallback((messageId: string) => {
    setMessages((previous) => previous.filter((message) => message.id !== messageId));
    void deleteRecord("messages", messageId);
  }, []);

  const deleteMessage = useCallback(
    async (messageId: string) => {
      if (!window.confirm("Delete this message? This can't be undone.")) {
        return;
      }

      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch(apiUrl(`/api/messages/${encodeURIComponent(messageId)}`), {
          method: "DELETE",
          credentials: "include",
          signal: controller.signal,
        });

        if (!response.ok) {
          const payload: unknown = await response.json().catch(() => undefined);
          const message =
            payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
              ? payload.error
              : `Delete failed: ${response.status}`;
          throw new Error(message);
        }

        // The server broadcasts messageDeleted for the message and any cascaded replies/reactions;
        // remove the target immediately for snappy feedback (the rest arrive over the socket).
        removeMessage(messageId);
      } catch (error) {
        setError(error instanceof Error ? error.message : "Unable to delete the message.");
      } finally {
        window.clearTimeout(timeout);
      }
    },
    [removeMessage],
  );

  const editMessage = useCallback(
    async (messageId: string, body: string): Promise<boolean> => {
      const trimmed = body.trim();

      if (!trimmed) {
        return false;
      }

      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch(apiUrl(`/api/messages/${encodeURIComponent(messageId)}`), {
          method: "PATCH",
          credentials: "include",
          headers: { "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({ body: trimmed }),
        });
        const payload: unknown = await response.json().catch(() => undefined);

        if (!response.ok) {
          const message =
            payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
              ? payload.error
              : `Edit failed: ${response.status}`;
          throw new Error(message);
        }

        // The server also broadcasts messageUpdated; apply the returned message immediately so the
        // edit shows even if this browser's socket is momentarily closed.
        const updated = MessageSchema.safeParse(payload);
        if (updated.success) {
          upsertMessages([updated.data]);
        }
        return true;
      } catch (error) {
        setError(error instanceof Error ? error.message : "Unable to edit the message.");
        return false;
      } finally {
        window.clearTimeout(timeout);
      }
    },
    [upsertMessages],
  );

  const createChannel = useCallback(
    async (name: string, visibility: "public" | "private" = "public"): Promise<boolean> => {
      const trimmed = name.trim();

      if (!trimmed) {
        return false;
      }

      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch(apiUrl("/api/channels"), {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({ name: trimmed, ...(visibility === "private" ? { visibility } : {}) }),
        });
        const payload: unknown = await response.json().catch(() => undefined);

        if (!response.ok) {
          const message =
            payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
              ? payload.error
              : `Couldn't create the channel: ${response.status}`;
          throw new Error(message);
        }

        const parsed = ChannelSchema.safeParse(payload);
        if (parsed.success) {
          upsertChannels([parsed.data]);
          location.route(`/channel/${encodeURIComponent(parsed.data.id)}`);
        }
        return true;
      } catch (error) {
        setError(error instanceof Error ? error.message : "Unable to create the channel.");
        return false;
      } finally {
        window.clearTimeout(timeout);
      }
    },
    [location, upsertChannels],
  );

  const purgeLocalData = useCallback(async (scope: "node" | "device" = "node") => {
    // Wipe: drop everything this browser knows, then show a neutral end screen. `scope` only
    // changes the copy — a node kill switch reads "node unavailable", a local device wipe says so
    // honestly (the node is still up). Best-effort on every step — nothing here may block another.
    setWipeScope(scope);
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

  /**
   * Resize an image on-device (the original never leaves the browser) and upload it as a message
   * attachment. Returns the descriptor to include in the message create request.
   */
  const uploadAttachment = useCallback(async (file: File): Promise<MessageAttachment> => {
    const prepared = await prepareImageAttachment(file);
    const buffer = await prepared.blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";

    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(apiUrl("/api/attachments"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          mimeType: prepared.blob.type || "image/png",
          data: btoa(binary),
          width: prepared.width,
          height: prepared.height,
        }),
      });
      const payload: unknown = await response.json().catch(() => undefined);

      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
            ? payload.error
            : `Attachment upload failed: ${response.status}`;
        throw new Error(message);
      }

      const parsed = MessageAttachmentSchema.safeParse(payload);

      if (!parsed.success) {
        throw new Error("The server returned an unrecognised attachment payload.");
      }

      return parsed.data;
    } finally {
      window.clearTimeout(timeout);
    }
  }, []);

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

  // The browser tab carries the operator-chosen network name once known.
  useEffect(() => {
    const nodeName = config?.networkConfig.nodeName;
    document.title = nodeName && nodeName !== "LOAM local" ? `${nodeName} · LOAM` : "LOAM";
  }, [config?.networkConfig.nodeName]);

  // The admin selects one UI language for the whole node (config.networkConfig.locale); resolve it
  // (fallback `en`) and apply it via `setActiveLocale` — module state that `t()` reads — in a useMemo
  // so it runs *before* children render this pass (no stale-language flash). No context/provider is
  // needed: `config` is top-level state, so the live `configUpdated` handler's `setConfig` already
  // re-renders the whole tree in the new language.
  const locale = resolveLocale(config?.networkConfig.locale);
  useMemo(() => setActiveLocale(locale), [locale]);

  // Flip the whole layout for right-to-left locales and expose the language on <html lang>. Message
  // bodies already use dir="auto" per message; this mirrors the chrome (sidebar, panels) too. Keys
  // off the admin-selected node locale, not navigator.language.
  useEffect(() => {
    document.documentElement.dir = RTL_LOCALES.has(locale) ? "rtl" : "ltr";
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    let active = true;

    Promise.all([
      getAllRecords<Channel>("channels"),
      getAllRecords<User>("users"),
      getAllRecords<Message>("messages"),
      getAllRecords<ConversationReads>("sync"),
    ])
      .then(([cachedChannels, cachedUsers, cachedMessages, cachedSync]) => {
        if (!active) {
          return;
        }

        setChannels(cachedChannels);
        upsertUsers([currentUser, ...cachedUsers]);
        setMessages(cachedMessages.sort(compareCreatedAt));

        const reads = cachedSync.find((record) => record.id === CONVERSATION_READS_KEY)?.reads;

        if (reads) {
          lastReadRef.current = reads;
          setLastReadByConversation(reads);
        }
      })
      .catch(() => undefined);

    let retryTimer: number | undefined;

    // Config first: it identifies the session and says whether this user may read content at all.
    // Banned/pending sessions get 403 from the content endpoints, so those are only fetched for a
    // participating user; approval flips `currentUser.pending`, which re-runs this effect.
    fetchJson<Config>("/api/config")
      .then(async (nextConfig) => {
        if (!active) {
          return;
        }

        syncFailuresRef.current = 0;
        setError(undefined);
        setConfig(nextConfig);
        rememberCurrentUser(nextConfig.currentUser);
        setCurrentUser(nextConfig.currentUser);
        setUsers((previous) =>
          previous.filter((user) => user.id !== currentUser.id || user.id === nextConfig.currentUser.id),
        );

        if (nextConfig.currentUser.banned || nextConfig.currentUser.pending) {
          // Gated sessions must not keep previously hydrated content around (a banned user's
          // cached history stays readable otherwise): clear memory and the IndexedDB caches.
          setChannels([]);
          setMessages([]);

          for (const storeName of ["channels", "messages"] as const) {
            const cachedRecords = await getAllRecords<{ id: string }>(storeName).catch(() => []);

            for (const record of cachedRecords) {
              void deleteRecord(storeName, record.id);
            }
          }

          return;
        }

        const [nextChannels, nextUsers] = await Promise.all([
          fetchJson<Channel[]>("/api/channels"),
          fetchJson<User[]>("/api/users"),
        ]);

        if (!active) {
          return;
        }

        setChannels(nextChannels);
        upsertUsers([nextConfig.currentUser, ...nextUsers]);
        void putRecords("channels", nextChannels);

        // Drop cached channels the server no longer returns (deleted, archived, or access revoked
        // while this client was offline) — and their message bodies with them.
        const keep = new Set(nextChannels.map((channel) => channel.id));
        const cached = await getAllRecords<Channel>("channels").catch(() => [] as Channel[]);

        for (const channel of cached) {
          if (!keep.has(channel.id)) {
            removeChannel(channel.id);
          }
        }
      })
      .catch((nextError: unknown) => {
        if (!active) {
          return;
        }

        setError(nextError instanceof Error ? nextError.message : "Unable to reach the LOAM server.");
        setConnection("offline");
        // Retry with backoff — a one-shot boot fetch would strand the app offline forever when the
        // server is momentarily unreachable (previously a manual reload was the only way out).
        const delay = Math.min(30_000, 2_000 * 2 ** syncFailuresRef.current);
        syncFailuresRef.current += 1;
        retryTimer = window.setTimeout(() => setSyncTick((tick) => tick + 1), delay);
      });

    return () => {
      active = false;

      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
      }
    };
  }, [currentUser.id, currentUser.banned, currentUser.pending, removeChannel, syncTick, upsertUsers]);

  useEffect(() => {
    if (!activeConversation) {
      return;
    }

    const path =
      activeConversation.kind === "channel"
        ? `/api/messages/${encodeURIComponent(activeConversation.id)}`
        : `/api/dms/${encodeURIComponent(activeConversation.id)}`;

    const conversation = activeConversation;
    // Only the latest in-flight request may reconcile: a slow response applying after a newer
    // sync (conversation switch, reconnect resync) would resurrect or delete the wrong messages.
    let active = true;
    // What we held when the request started — reconciliation may only prune these (a message
    // sent or received while the fetch was in flight is not a deletion).
    const preFetchIds = new Set(messagesRef.current.map((message) => message.id));

    fetchJson<Message[]>(path)
      .then((nextMessages) => {
        if (active) {
          reconcileConversationMessages(conversation, nextMessages, preFetchIds);
        }
      })
      .catch((nextError: unknown) => {
        if (!active) {
          return;
        }

        // A 404 means the channel does not exist for this user (unknown id, or a private channel
        // they are not a member of) — an empty conversation, not a connectivity problem.
        if (nextError instanceof Error && nextError.message.endsWith("404")) {
          return;
        }

        setError(nextError instanceof Error ? nextError.message : "Unable to load messages.");
      });

    return () => {
      active = false;
    };
  }, [activeConversation?.id, activeConversation?.kind, currentUser.id, reconcileConversationMessages, syncTick]);

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

        // A reconnect means events were missed (deletes, edits, new channels don't replay): pull
        // fresh state — config/channels/users plus the open conversation — instead of trusting the
        // cache. The first connection skips this; boot hydration just ran.
        if (attempt > 1) {
          setSyncTick((tick) => tick + 1);
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

          if (payload.type === "messageCreated") {
            maybeToastForMessage(payload.message);
          }

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

          // Presence switched off: clear the dots immediately (no further events will arrive).
          if (!payload.networkConfig.enablePresence) {
            setOnlineUserIds(new Set());
          }

          return;
        }

        if (payload.type === "presence") {
          setOnlineUserIds(new Set(payload.onlineUserIds));
          return;
        }

        if (payload.type === "wipe") {
          void purgeLocalData();
          return;
        }

        if (payload.type === "channelUpserted") {
          upsertChannels([payload.channel]);
          return;
        }

        if (payload.type === "channelRemoved") {
          removeChannel(payload.channelId);
          return;
        }

        applyUserUpsert(payload.user);
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
  }, [
    applyStreamEvent,
    applyUserUpsert,
    config?.currentUser.id,
    maybeToastForMessage,
    purgeLocalData,
    removeChannel,
    removeMessage,
    upsertChannels,
    upsertMessages,
  ]);

  const usersById = useMemo(() => {
    const indexed = new Map(users.map((user) => [user.id, user]));
    indexed.set(currentUser.id, currentUser);
    return indexed;
  }, [currentUser, users]);
  usersByIdRef.current = usersById;
  const selectedMessages = useMemo(
    () =>
      activeConversation
        ? conversationMessages(messages, activeConversation, currentUser.id)
        : [],
    [activeConversation, currentUser.id, messages],
  );

  // Count unread (non-own) messages per conversation: any post/reply/DM newer than the conversation's
  // last-read timestamp. Reactions never count (they have no conversation key).
  const unreadByConversation = useMemo(() => {
    const counts = new Map<string, number>();

    for (const message of messages) {
      if (message.authorId === currentUser.id) {
        continue;
      }

      const key = messageConversationKey(message, currentUser.id);

      if (!key) {
        continue;
      }

      if (message.createdAt > (lastReadByConversation[key] ?? 0)) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }

    return counts;
  }, [currentUser.id, lastReadByConversation, messages]);

  // The active conversation is always "read": mark it on open and whenever fresh traffic arrives
  // while it is on screen, so its own new messages never light up an unread badge.
  useEffect(() => {
    if (!activeConversation) {
      return;
    }

    const key = conversationKey(activeConversation);
    updateLastRead((previous) => ({ ...previous, [key]: Date.now() }));
  }, [activeConversation?.id, activeConversation?.kind, messages.length, updateLastRead]);

  if (wiped) {
    return (
      <main className="wiped-screen">
        <div>
          <p className="brand-title">LOAM</p>
          {wipeScope === "device" ? (
            <>
              <h1>Device wiped</h1>
              <p>This browser&rsquo;s local copy has been erased. Scan the join QR to reconnect.</p>
            </>
          ) : (
            <>
              <h1>Disconnected</h1>
              <p>This node is no longer available.</p>
            </>
          )}
        </div>
      </main>
    );
  }

  if (currentUser.banned) {
    return (
      <main className="wiped-screen">
        <div>
          <p className="brand-title">LOAM</p>
          <h1>Removed from this node</h1>
          <p>A moderator has removed you. You can no longer post or read here.</p>
        </div>
      </main>
    );
  }

  if (currentUser.pending) {
    return (
      <main className="wiped-screen">
        <div>
          <p className="brand-title">LOAM</p>
          <h1>You&rsquo;re in the queue</h1>
          <p>Waiting for someone on this node to let you in. This screen updates the moment you&rsquo;re approved.</p>
          <p className="gate-status">Connection: {connection}</p>
        </div>
      </main>
    );
  }

  return (
    <>
    <main className={shellClassName}>
      <Sidebar
        activeConversation={activeConversation}
        canCreateChannel={currentUser.isAdmin || !!config?.networkConfig.enableUserChannels}
        canCreatePrivateChannel={!!config?.networkConfig.enablePrivateChannels}
        channels={channels}
        connection={connection}
        currentUser={currentUser}
        joinUrl={config?.joinUrl}
        nodeName={config?.networkConfig.nodeName}
        onCreateChannel={createChannel}
        onlineUserIds={onlineUserIds}
        unreadByConversation={unreadByConversation}
        users={users}
      />
      {routeState.screen === "admin" ? (
        <AdminView
          currentUser={currentUser}
          joinUrl={config?.joinUrl}
          onChannelUpsert={upsertChannels}
          onWiped={purgeLocalData}
        />
      ) : routeState.screen === "people" ? (
        <PeopleView currentUser={currentUser} onUsersChanged={upsertUsers} />
      ) : routeState.screen === "search" ? (
        <SearchView channels={channels} currentUser={currentUser} usersById={usersById} />
      ) : routeState.screen === "settings" ? (
        <SettingsView
          config={config}
          currentUser={currentUser}
          onClaimAdmin={claimAdmin}
          onUpdateCurrentUser={updateCurrentUser}
          onUploadAvatarImage={uploadAvatarImage}
          onWipeDevice={() => purgeLocalData("device")}
        />
      ) : (
        <ConversationView
          allowAttachments={!!config?.networkConfig.enableAttachments}
          channels={channels}
          conversation={activeConversation}
          currentUser={currentUser}
          messages={selectedMessages}
          onChannelUpsert={upsertChannels}
          onDelete={deleteMessage}
          onEdit={editMessage}
          onLeftChannel={removeChannel}
          onReact={(messageId, reaction) =>
            sendMessage({
              type: "reaction",
              targetMessageId: messageId,
              reaction,
            })
          }
          onSend={(body, attachments) => {
            if (!activeConversation) {
              return Promise.resolve();
            }

            if (activeConversation.kind === "channel") {
              return sendMessage({
                type: "channelPost",
                channelId: activeConversation.id,
                body,
                ...(attachments?.length ? { attachments } : {}),
              });
            }

            return sendMessage({
              type: "dm",
              recipientUserId: activeConversation.id,
              body,
              ...(attachments?.length ? { attachments } : {}),
            });
          }}
          onThreadReply={(parentMessageId, body, attachments) => {
            if (!activeConversation || activeConversation.kind !== "channel") {
              return Promise.resolve();
            }

            return sendMessage({
              type: "channelReply",
              channelId: activeConversation.id,
              parentMessageId,
              body,
              ...(attachments?.length ? { attachments } : {}),
            });
          }}
          onUploadAttachment={uploadAttachment}
          users={users}
          usersById={usersById}
        />
      )}
      {error ? <p className="connection-error">{error}</p> : null}
    </main>
    <ToastStack onDismiss={dismissToast} toasts={toasts} />
    </>
  );
}

/**
 * Fixed-position stack of auto-dismissing toasts announcing new messages in non-active
 * conversations. Tapping a toast opens the conversation and dismisses it.
 */
function ToastStack({ onDismiss, toasts }: { onDismiss: (id: string) => void; toasts: ToastItem[] }) {
  const location = useLocation();

  if (!toasts.length) {
    return null;
  }

  return (
    <div aria-live="polite" className="toast-stack" role="status">
      {toasts.map((toast) => (
        <button
          className="toast"
          key={toast.id}
          onClick={() => {
            location.route(toast.route);
            onDismiss(toast.id);
          }}
          type="button"
        >
          <strong className="toast-title">{toast.title}</strong>
          <span className="toast-body">{toast.body}</span>
        </button>
      ))}
    </div>
  );
}

interface SidebarProps {
  activeConversation?: Conversation;
  canCreateChannel: boolean;
  canCreatePrivateChannel: boolean;
  channels: Channel[];
  connection: "connecting" | "live" | "offline";
  currentUser: User;
  joinUrl?: string;
  nodeName?: string;
  onCreateChannel: (name: string, visibility?: "public" | "private") => Promise<boolean>;
  onlineUserIds: ReadonlySet<string>;
  unreadByConversation: Map<string, number>;
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
function Sidebar({
  activeConversation,
  canCreateChannel,
  canCreatePrivateChannel,
  channels,
  connection,
  currentUser,
  joinUrl,
  nodeName,
  onCreateChannel,
  onlineUserIds,
  unreadByConversation,
  users,
}: SidebarProps) {
  const peers = users.filter((user) => user.id !== currentUser.id);
  const showPeople = canModerate(currentUser) || canGreet(currentUser);

  return (
    <aside className="sidebar">
      <div className="brand-row">
        <img src={loamMark} alt="" className="brand-mark" />
        <div>
          {/* The operator-chosen network name is the headline; LOAM stays as the mark. */}
          <p className="brand-title" title={nodeName}>
            {nodeName ?? "LOAM"}
          </p>
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
              <span aria-label={channel.visibility === "private" ? "Private channel" : undefined} className="nav-glyph">
                {channel.visibility === "private" ? "🔒" : "#"}
              </span>
              <span className="nav-label">{channel.name}</span>
              <UnreadBadge count={unreadByConversation.get(`channel:${channel.id}`) ?? 0} />
            </NavLink>
          ))}
        </nav>
        {canCreateChannel ? (
          <NewChannelControl allowPrivate={canCreatePrivateChannel} onCreateChannel={onCreateChannel} />
        ) : null}
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
              <span className="presence-anchor">
                <Avatar avatar={user.avatar} id={user.id} />
                {onlineUserIds.has(user.id) ? (
                  <span aria-label="Online" className="presence-dot" title="Online" />
                ) : null}
              </span>
              <span className="nav-label">{user.displayName}</span>
              <UnreadBadge count={unreadByConversation.get(`dm:${user.id}`) ?? 0} />
            </NavLink>
          ))}
        </nav>
      </section>

      <div className="sidebar-footer">
        <NavLink active={false} href="/search">
          <span className="nav-glyph">⌕</span>
          Search messages
        </NavLink>
        {canGreet(currentUser) ? <InviteControl joinUrl={joinUrl} /> : null}
        {showPeople ? (
          <NavLink active={false} href="/people">
            <span className="nav-glyph">☺</span>
            People and moderation
          </NavLink>
        ) : null}
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

/**
 * A compact "new channel" affordance in the sidebar. Shown to admins, and to everyone when the
 * `enableUserChannels` flag is on. Collapses to a single button until the user starts creating.
 * When the node allows private channels, offers an invite-only toggle (the creator starts as the
 * only member and invites people from the channel's Members panel).
 */
function NewChannelControl({
  allowPrivate,
  onCreateChannel,
}: {
  allowPrivate: boolean;
  onCreateChannel: (name: string, visibility?: "public" | "private") => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [creating, setCreating] = useState(false);

  async function create(): Promise<void> {
    if (!name.trim()) {
      return;
    }

    setCreating(true);
    const ok = await onCreateChannel(name, isPrivate ? "private" : "public");
    setCreating(false);

    if (ok) {
      setName("");
      setIsPrivate(false);
      setOpen(false);
    }
  }

  if (!open) {
    return (
      <button className="new-channel-toggle" onClick={() => setOpen(true)} type="button">
        + New channel
      </button>
    );
  }

  return (
    <form
      className="new-channel-form"
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <input
        aria-label="New channel name"
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        disabled={creating}
        maxLength={80}
        onInput={(event) => setName(event.currentTarget.value)}
        placeholder="Channel name"
        value={name}
      />
      {allowPrivate ? (
        <label className="admin-toggle">
          <input
            checked={isPrivate}
            disabled={creating}
            onInput={(event) => setIsPrivate(event.currentTarget.checked)}
            type="checkbox"
          />
          Private (invite-only)
        </label>
      ) : null}
      <div className="new-channel-actions">
        <button disabled={creating || !name.trim()} type="submit">
          {creating ? "Creating…" : "Create"}
        </button>
        <button
          disabled={creating}
          onClick={() => {
            setOpen(false);
            setName("");
          }}
          type="button"
        >
          Cancel
        </button>
      </div>
    </form>
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
  allowAttachments: boolean;
  channels: Channel[];
  conversation?: Conversation;
  currentUser: User;
  messages: Message[];
  onChannelUpsert: (channels: Channel[]) => void;
  onDelete: (messageId: string) => void;
  onEdit: (messageId: string, body: string) => Promise<boolean>;
  onLeftChannel: (channelId: string) => void;
  onReact: (messageId: string, reaction: string) => Promise<void>;
  onSend: (body: string, attachments?: MessageAttachment[]) => Promise<void>;
  onThreadReply: (parentMessageId: string, body: string, attachments?: MessageAttachment[]) => Promise<void>;
  onUploadAttachment: (file: File) => Promise<MessageAttachment>;
  users: User[];
  usersById: Map<string, User>;
}

function ConversationView({
  allowAttachments,
  channels,
  conversation,
  currentUser,
  messages,
  onChannelUpsert,
  onDelete,
  onEdit,
  onLeftChannel,
  onReact,
  onSend,
  onThreadReply,
  onUploadAttachment,
  users,
  usersById,
}: ConversationViewProps) {
  const location = useLocation();
  const [membersOpen, setMembersOpen] = useState(false);
  const topMessages = conversation ? topLevelMessages(messages, conversation) : [];

  // Never carry the members panel from one conversation into another.
  useEffect(() => {
    setMembersOpen(false);
  }, [conversation?.kind, conversation?.id]);
  const threadParent =
    conversation?.kind === "channel" && conversation.threadId
      ? topMessages.find((message) => message.id === conversation.threadId)
      : undefined;

  if (!conversation) {
    return (
      <section className="conversation empty-state">
        <div>
          <p className="eyebrow">{t("conversation.emptyEyebrow")}</p>
          <h1>{t("conversation.emptyTitle")}</h1>
          <p>{t("conversation.emptyBody")}</p>
        </div>
      </section>
    );
  }

  const activeChannel =
    conversation.kind === "channel"
      ? channels.find((channel) => channel.id === conversation.id)
      : undefined;
  const isPrivateChannel = activeChannel?.visibility === "private";
  const title =
    conversation.kind === "channel"
      ? `${isPrivateChannel ? "🔒" : "#"} ${activeChannel?.name ?? conversation.id}`
      : usersById.get(conversation.id)?.displayName ?? conversation.id;

  return (
    <>
      <section className="conversation">
        {/* One wrapper = one grid row: .conversation is a strict header/list/composer 3-row grid. */}
        <div className="conversation-top">
          <ConversationHeader
            conversation={conversation}
            description={activeChannel?.description}
            title={title}
            trailing={
              isPrivateChannel ? (
                <button
                  aria-expanded={membersOpen}
                  className="ghost-button"
                  onClick={() => setMembersOpen((previous) => !previous)}
                  type="button"
                >
                  {t("conversation.members")}
                </button>
              ) : undefined
            }
          />
          {isPrivateChannel && membersOpen && activeChannel ? (
            <ChannelMembersPanel
              channel={activeChannel}
              currentUser={currentUser}
              onChannelUpsert={onChannelUpsert}
              onLeftChannel={onLeftChannel}
              users={users}
            />
          ) : null}
        </div>
        <MessageList
          conversation={conversation}
          currentUser={currentUser}
          messages={messages}
          onDelete={onDelete}
          onEdit={onEdit}
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
          label={t("conversation.composerLabel", { name: conversation.kind === "channel" ? conversation.id : title })}
          onSend={onSend}
          onUploadAttachment={allowAttachments ? onUploadAttachment : undefined}
          placeholder={
            conversation.kind === "channel"
              ? t("conversation.composerPlaceholderChannel")
              : t("conversation.composerPlaceholderDm")
          }
        />
      </section>

      {threadParent ? (
        <ThreadPanel
          currentUser={currentUser}
          messages={messages}
          onClose={() => location.route(backRouteForThread(conversation))}
          onDelete={onDelete}
          onEdit={onEdit}
          onReact={onReact}
          onReply={(body, attachments) => onThreadReply(threadParent.id, body, attachments)}
          onUploadAttachment={allowAttachments ? onUploadAttachment : undefined}
          parent={threadParent}
          usersById={usersById}
        />
      ) : null}
    </>
  );
}

function ConversationHeader({
  conversation,
  description,
  title,
  trailing,
}: {
  conversation: Conversation;
  description?: string;
  title: string;
  trailing?: ComponentChildren;
}) {
  return (
    <header className="conversation-header">
      <NavLink active={false} className="mobile-back" href="/channels">
        ←
      </NavLink>
      <div className="conversation-heading">
        <p className="eyebrow">{conversation.kind === "channel" ? t("conversation.kindChannel") : t("conversation.kindDm")}</p>
        <h1>{title}</h1>
        {description ? <p className="conversation-description">{description}</p> : null}
      </div>
      {trailing ? <div className="conversation-header-actions">{trailing}</div> : null}
    </header>
  );
}

/**
 * Member management for a private channel: shows the roster, lets the owner (or an admin) invite
 * and remove people, and lets any non-owner member leave. All gating here is cosmetic — the server
 * enforces every rule (owner-or-admin invites, members-only visibility, the owner can never be
 * removed).
 */
function ChannelMembersPanel({
  channel,
  currentUser,
  onChannelUpsert,
  onLeftChannel,
  users,
}: {
  channel: Channel;
  currentUser: User;
  onChannelUpsert: (channels: Channel[]) => void;
  onLeftChannel: (channelId: string) => void;
  users: User[];
}) {
  const [members, setMembers] = useState<User[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [inviteId, setInviteId] = useState("");
  const canManage = currentUser.isAdmin || channel.ownerUserId === currentUser.id;
  const memberIds = new Set(channel.memberUserIds ?? []);

  if (channel.ownerUserId) {
    memberIds.add(channel.ownerUserId);
  }

  const invitable = users.filter((user) => user.type === "human" && !memberIds.has(user.id));
  // Refetch whenever the roster itself changes (live channelUpserted events update the channel).
  const rosterKey = [...memberIds].sort().join(",");

  useEffect(() => {
    let active = true;
    setLoaded(false);
    setError(undefined);

    fetchJson<unknown>(`/api/channels/${encodeURIComponent(channel.id)}/members`)
      .then((payload) => {
        if (active) {
          setMembers(parseUserList(payload));
          setLoaded(true);
        }
      })
      .catch((loadError: unknown) => {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : t("members.loadError"));
        }
      });

    return () => {
      active = false;
    };
  }, [channel.id, rosterKey]);

  async function invite(): Promise<void> {
    if (!inviteId) {
      return;
    }

    setBusy(true);
    setError(undefined);

    try {
      const updated = await requestChannel(
        "POST",
        `/api/channels/${encodeURIComponent(channel.id)}/members`,
        { userId: inviteId },
      );
      onChannelUpsert([updated]);
      setInviteId("");
    } catch (inviteError) {
      setError(inviteError instanceof Error ? inviteError.message : t("members.inviteError"));
    } finally {
      setBusy(false);
    }
  }

  async function remove(userId: string): Promise<void> {
    const leaving = userId === currentUser.id;

    if (leaving && !window.confirm(t("members.leaveConfirm"))) {
      return;
    }

    setBusy(true);
    setError(undefined);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(
        apiUrl(`/api/channels/${encodeURIComponent(channel.id)}/members/${encodeURIComponent(userId)}`),
        { method: "DELETE", credentials: "include", signal: controller.signal },
      );

      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => undefined);
        const message =
          payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
            ? payload.error
            : t("common.requestFailed", { status: response.status });
        throw new Error(message);
      }

      if (leaving) {
        onLeftChannel(channel.id);
        return;
      }

      onChannelUpsert([
        { ...channel, memberUserIds: (channel.memberUserIds ?? []).filter((id) => id !== userId) },
      ]);
      setMembers((previous) => previous.filter((member) => member.id !== userId));
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : t("members.removeError"));
    } finally {
      window.clearTimeout(timeout);
      setBusy(false);
    }
  }

  return (
    <div className="channel-members-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">{t("members.eyebrow")}</p>
          <h2>{t("members.heading")}</h2>
        </div>
        {memberIds.has(currentUser.id) && channel.ownerUserId !== currentUser.id ? (
          <button className="danger-button" disabled={busy} onClick={() => void remove(currentUser.id)} type="button">
            {t("members.leave")}
          </button>
        ) : null}
      </div>
      {!loaded && !error ? <p className="form-note">{t("members.loading")}</p> : null}
      {loaded ? (
        <ul className="moderation-list">
          {members.map((member) => (
            <li className="moderation-row" key={member.id}>
              <div className="moderation-identity">
                <Avatar avatar={member.avatar} id={member.id} />
                <div className="moderation-name">
                  <strong>{member.displayName}</strong>
                  <span>{member.id === channel.ownerUserId ? t("members.owner") : member.id}</span>
                </div>
              </div>
              {canManage && member.id !== channel.ownerUserId ? (
                <div className="moderation-actions">
                  <button className="danger-button" disabled={busy} onClick={() => void remove(member.id)} type="button">
                    {t("common.remove")}
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {canManage ? (
        <form
          className="member-invite-form"
          onSubmit={(event) => {
            event.preventDefault();
            void invite();
          }}
        >
          <label>
            {t("members.inviteLabel")}
            <select disabled={busy || !invitable.length} onInput={(event) => setInviteId(event.currentTarget.value)} value={inviteId}>
              <option value="">{invitable.length ? t("members.choosePerson") : t("members.allMembers")}</option>
              {invitable.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.displayName}
                </option>
              ))}
            </select>
          </label>
          <button disabled={busy || !inviteId} type="submit">
            {t("members.invite")}
          </button>
        </form>
      ) : null}
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}

interface MessageListProps {
  conversation: Conversation;
  currentUser: User;
  messages: Message[];
  onDelete: (messageId: string) => void;
  onEdit: (messageId: string, body: string) => Promise<boolean>;
  onOpenThread: (messageId: string) => void;
  onReact: (messageId: string, reaction: string) => Promise<void>;
  topMessages: Message[];
  usersById: Map<string, User>;
}

function MessageList({
  conversation,
  currentUser,
  messages,
  onDelete,
  onEdit,
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
        topMessages.map((message, index) => {
          const previous = topMessages[index - 1];
          const newDay = !previous || dayKey(previous.createdAt) !== dayKey(message.createdAt);

          return (
            <div key={message.id}>
              {newDay ? (
                <div className="day-divider" role="separator">
                  <span>{dayLabel(message.createdAt)}</span>
                </div>
              ) : null}
              <MessageItem
                currentUser={currentUser}
                message={message}
                onDelete={onDelete}
                onEdit={onEdit}
                onOpenThread={conversation.kind === "channel" ? onOpenThread : undefined}
                onReact={onReact}
                reactions={reactionSummary(messages, message.id, currentUser.id)}
                replyCount={repliesFor(messages, message.id).length}
                usersById={usersById}
              />
            </div>
          );
        })
      ) : (
        <p className="empty-copy">{t("messageList.empty")}</p>
      )}
    </div>
  );
}

interface MessageItemProps {
  currentUser: User;
  message: Message;
  onDelete: (messageId: string) => void;
  onEdit: (messageId: string, body: string) => Promise<boolean>;
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
  onDelete,
  onEdit,
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
  const canEdit = isMine && !message.meta?.streaming && message.type !== "reaction";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const messageClassName = ["message", isMine ? "mine" : undefined, message.meta?.streaming ? "streaming" : undefined]
    .filter(Boolean)
    .join(" ");

  function startEditing(): void {
    setDraft(bodyFor(message));
    setEditing(true);
  }

  async function saveEdit(): Promise<void> {
    setSavingEdit(true);
    const ok = await onEdit(message.id, draft);
    setSavingEdit(false);
    if (ok) {
      setEditing(false);
    }
  }

  return (
    <article className={messageClassName}>
      <Avatar avatar={author.avatar} id={author.id} />
      <div className="message-main">
        <div className="message-meta">
          <strong>{author.displayName}</strong>
          <span>{displayTime(message.createdAt)}</span>
          {message.editedAt ? <span className="edited-tag">{t("message.editedTag")}</span> : null}
        </div>
        {editing ? (
          <form
            className="message-edit"
            onSubmit={(event) => {
              event.preventDefault();
              void saveEdit();
            }}
          >
            <textarea
              aria-label={t("message.editAriaLabel")}
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              dir="auto"
              disabled={savingEdit}
              onInput={(event) => setDraft(event.currentTarget.value)}
              rows={2}
              value={draft}
            />
            <div className="message-edit-actions">
              <button disabled={savingEdit || !draft.trim()} type="submit">
                {savingEdit ? t("common.saving") : t("common.save")}
              </button>
              <button disabled={savingEdit} onClick={() => setEditing(false)} type="button">
                {t("common.cancel")}
              </button>
            </div>
          </form>
        ) : (
          <div
            className="markdown-body"
            dir="auto"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(bodyFor(message)) }}
          />
        )}
        {message.type !== "reaction" && message.attachments?.length ? (
          <div className="message-attachments">
            {message.attachments.map((attachment) => (
              <a href={apiUrl(attachmentPath(attachment))} key={attachment.id} rel="noreferrer" target="_blank">
                <img
                  alt={t("message.attachedImageAlt")}
                  className="message-attachment"
                  height={attachment.height}
                  loading="lazy"
                  src={apiUrl(attachmentPath(attachment))}
                  width={attachment.width}
                />
              </a>
            ))}
          </div>
        ) : null}
        <div className="message-actions">
          {message.meta?.streaming ? <span className="streaming-pill">{t("message.streaming")}</span> : null}
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
              {replyCount ? t("message.replyCount", { n: replyCount }) : t("message.reply")}
            </button>
          ) : null}
          {canEdit && !editing ? (
            <button className="message-edit-button" onClick={startEditing} type="button">
              {t("message.edit")}
            </button>
          ) : null}
          {(isMine || currentUser.isAdmin) && !message.meta?.streaming ? (
            <button
              className="message-delete"
              onClick={() => onDelete(message.id)}
              title={isMine ? t("message.deleteOwnTitle") : t("message.deleteAdminTitle")}
              type="button"
            >
              {t("common.delete")}
            </button>
          ) : null}
        </div>
      </div>
    </article>
  );
}

interface MessageComposerProps {
  label: string;
  onSend: (body: string, attachments?: MessageAttachment[]) => Promise<void>;
  /** When present, the composer offers image attachments (resized on-device before upload). */
  onUploadAttachment?: (file: File) => Promise<MessageAttachment>;
  placeholder: string;
}

type PendingAttachment = {
  key: string;
  name: string;
  status: "uploading" | "ready" | "error";
  attachment?: MessageAttachment;
  error?: string;
};

function MessageComposer({ label, onSend, onUploadAttachment, placeholder }: MessageComposerProps) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const pendingKeyRef = useRef(0);
  const composerId = useId();
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const readyAttachments = pending.flatMap((entry) => (entry.attachment ? [entry.attachment] : []));
  const uploading = pending.some((entry) => entry.status === "uploading");

  useEffect(() => {
    const textArea = textAreaRef.current;

    if (!textArea) {
      return;
    }

    textArea.style.height = "auto";
    textArea.style.height = `${Math.min(textArea.scrollHeight, 168)}px`;
  }, [value]);

  function attachFiles(files: FileList | null): void {
    if (!onUploadAttachment || !files) {
      return;
    }

    const room = ATTACHMENT_MAX_COUNT - pending.filter((entry) => entry.status !== "error").length;

    for (const file of Array.from(files).slice(0, Math.max(0, room))) {
      pendingKeyRef.current += 1;
      const key = `att-${pendingKeyRef.current}`;
      setPending((previous) => [...previous, { key, name: file.name, status: "uploading" }]);
      onUploadAttachment(file)
        .then((attachment) => {
          setPending((previous) =>
            previous.map((entry) => (entry.key === key ? { ...entry, status: "ready", attachment } : entry)),
          );
        })
        .catch((uploadError: unknown) => {
          setPending((previous) =>
            previous.map((entry) =>
              entry.key === key
                ? {
                    ...entry,
                    status: "error",
                    error: uploadError instanceof Error ? uploadError.message : t("composer.uploadFailed"),
                  }
                : entry,
            ),
          );
        });
    }
  }

  async function submit(): Promise<void> {
    const body = value.trim();

    if ((!body && !readyAttachments.length) || sending || uploading) {
      return;
    }

    setSending(true);

    try {
      await onSend(body, readyAttachments.length ? readyAttachments : undefined);
      setValue("");
      setPending([]);
    } finally {
      setSending(false);
    }
  }

  return (
    <form
      className={onUploadAttachment ? "composer has-attach" : "composer"}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {pending.length ? (
        <div className="composer-attachments">
          {pending.map((entry) => (
            <span className={`attachment-chip ${entry.status}`} key={entry.key}>
              {entry.status === "uploading" ? "⏳ " : entry.status === "error" ? "⚠ " : "🖼 "}
              <span className="attachment-chip-name" title={entry.error}>
                {entry.name}
              </span>
              <button
                aria-label={t("composer.removeAttachment", { name: entry.name })}
                disabled={sending}
                onClick={() => setPending((previous) => previous.filter((item) => item.key !== entry.key))}
                type="button"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <label className="sr-only" for={composerId}>
        {label}
      </label>
      {onUploadAttachment ? (
        <>
          <input
            accept="image/png,image/jpeg,image/webp,image/*"
            className="sr-only"
            multiple
            onInput={(event) => {
              attachFiles(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
            ref={fileInputRef}
            type="file"
          />
          <button
            aria-label={t("composer.attachImage")}
            className="composer-attach"
            disabled={sending || pending.filter((entry) => entry.status !== "error").length >= ATTACHMENT_MAX_COUNT}
            onClick={() => fileInputRef.current?.click()}
            title={t("composer.attachImageHint")}
            type="button"
          >
            🖼
          </button>
        </>
      ) : null}
      <textarea
        dir="auto"
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
      <button disabled={(!value.trim() && !readyAttachments.length) || sending || uploading} type="submit">
        {t("composer.send")}
      </button>
    </form>
  );
}

interface ThreadPanelProps {
  currentUser: User;
  messages: Message[];
  onClose: () => void;
  onDelete: (messageId: string) => void;
  onEdit: (messageId: string, body: string) => Promise<boolean>;
  onReact: (messageId: string, reaction: string) => Promise<void>;
  onReply: (body: string, attachments?: MessageAttachment[]) => Promise<void>;
  onUploadAttachment?: (file: File) => Promise<MessageAttachment>;
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
  onDelete,
  onEdit,
  onReact,
  onReply,
  onUploadAttachment,
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
          <p className="eyebrow">{t("thread.eyebrow")}</p>
          <h2>{t("thread.heading")}</h2>
        </div>
        <button aria-label={t("thread.close")} className="close-button" onClick={onClose} type="button">
          ×
        </button>
      </header>
      <div className="thread-scroll">
        <MessageItem
          currentUser={currentUser}
          message={parent}
          onDelete={onDelete}
          onEdit={onEdit}
          onReact={onReact}
          reactions={reactionSummary(messages, parent.id, currentUser.id)}
          usersById={usersById}
        />
        <div className="reply-divider">
          {replies.length ? t("message.replyCount", { n: replies.length }) : t("thread.noReplies")}
        </div>
        {replies.map((reply) => (
          <MessageItem
            currentUser={currentUser}
            key={reply.id}
            message={reply}
            onDelete={onDelete}
            onEdit={onEdit}
            onReact={onReact}
            reactions={reactionSummary(messages, reply.id, currentUser.id)}
            usersById={usersById}
          />
        ))}
      </div>
      <MessageComposer
        label={t("thread.replyLabel")}
        onSend={onReply}
        onUploadAttachment={onUploadAttachment}
        placeholder={t("thread.replyLabel")}
      />
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
 * Full-text message search over `GET /api/search`. The server scopes results strictly to what this
 * user may read (public channels, their private channels, their own DMs), so the client just
 * renders whatever comes back. Tapping a result jumps to its conversation (or thread).
 */
function SearchView({
  channels,
  currentUser,
  usersById,
}: {
  channels: Channel[];
  currentUser: User;
  usersById: Map<string, User>;
}) {
  const location = useLocation();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Message[]>();
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string>();
  const searchInputId = useId();

  async function run(): Promise<void> {
    const trimmed = query.trim();

    if (!trimmed || searching) {
      return;
    }

    setSearching(true);
    setError(undefined);

    try {
      const payload = await fetchJson<unknown>(`/api/search?q=${encodeURIComponent(trimmed)}`);
      const rawResults =
        payload && typeof payload === "object" && "results" in payload && Array.isArray(payload.results)
          ? (payload.results as unknown[])
          : [];
      setResults(
        rawResults.flatMap((item) => {
          const parsed = MessageSchema.safeParse(item);
          return parsed.success ? [parsed.data] : [];
        }),
      );
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : "Unable to search messages.");
    } finally {
      setSearching(false);
    }
  }

  function contextLabel(message: Message): string {
    if (message.type === "channelPost" || message.type === "channelReply") {
      const channel = channels.find((entry) => entry.id === message.channelId);
      return `${channel?.visibility === "private" ? "🔒" : "#"}${channel?.name ?? message.channelId}`;
    }

    if (message.type === "dm") {
      const peerId = message.authorId === currentUser.id ? message.recipientUserId : message.authorId;
      return `DM with ${usersById.get(peerId)?.displayName ?? generateDisplayName(peerId)}`;
    }

    return "";
  }

  function routeFor(message: Message): string | undefined {
    if (message.type === "channelPost") {
      return `/channel/${encodeURIComponent(message.channelId)}`;
    }

    if (message.type === "channelReply") {
      return `/channel/${encodeURIComponent(message.channelId)}/thread/${encodeURIComponent(message.parentMessageId)}`;
    }

    if (message.type === "dm") {
      const peerId = message.authorId === currentUser.id ? message.recipientUserId : message.authorId;
      return `/dm/${encodeURIComponent(peerId)}`;
    }

    return undefined;
  }

  return (
    <section className="settings-view">
      <header className="conversation-header">
        <NavLink active={false} className="mobile-back" href="/channels">
          ←
        </NavLink>
        <div>
          <p className="eyebrow">Search</p>
          <h1>Find messages</h1>
        </div>
      </header>
      {/* One wrapper = one grid row: .settings-view is a strict header/content 2-row grid. */}
      <div className="search-content">
        <form
          className="search-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run();
          }}
        >
          <label className="sr-only" for={searchInputId}>
            Search messages
          </label>
          <input
            dir="auto"
            disabled={searching}
            id={searchInputId}
            maxLength={200}
            onInput={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search channel messages and your DMs"
            type="search"
            value={query}
          />
          <button disabled={searching || !query.trim()} type="submit">
            {searching ? "Searching…" : "Search"}
          </button>
        </form>
        {error ? <p className="form-error">{error}</p> : null}
        {results && !results.length ? <p className="form-note">No messages matched.</p> : null}
        {results?.length ? (
          <ul className="search-results">
            {results.map((message) => {
              const route = routeFor(message);
              const author = usersById.get(message.authorId);
              return (
                <SearchResult
                  authorName={author?.displayName ?? generateDisplayName(message.authorId)}
                  body={bodyFor(message)}
                  contextLabel={contextLabel(message)}
                  key={message.id}
                  onOpen={() => {
                    if (route) {
                      location.route(route);
                    }
                  }}
                  time={displayTime(message.createdAt)}
                />
              );
            })}
          </ul>
        ) : null}
      </div>
    </section>
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
  onWipeDevice,
}: {
  config?: Config;
  currentUser: User;
  onClaimAdmin: (secret: string) => Promise<void>;
  onUpdateCurrentUser: (request: UserUpdateRequest) => Promise<void>;
  onUploadAvatarImage: (blob: Blob) => Promise<void>;
  onWipeDevice: () => Promise<void>;
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
  const qrSvg = useMemo(() => safeQrSvg(config?.joinUrl, "#203f34"), [config?.joinUrl]);
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
      setProfileError(error instanceof Error ? error.message : t("settings.profileError"));
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
          <p className="eyebrow">{t("settings.joinEyebrow")}</p>
          <h1>{t("settings.joinTitle")}</h1>
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
            <p className="eyebrow">{t("settings.thisBrowser")}</p>
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
            <p className="eyebrow">{t("settings.profileEyebrow")}</p>
            <h2>{t("settings.profileTitle")}</h2>
          </div>
          <label>
            {t("settings.displayName")}
            <input
              disabled={!allowDisplayNameEdit || saving}
              maxLength={80}
              onInput={(event) => setDisplayName(event.currentTarget.value)}
              value={displayName}
            />
          </label>
          <label>
            {t("settings.avatarStyle")}
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
              {t("settings.newAvatar")}
            </button>
            <button disabled={saving || (!allowDisplayNameEdit && !allowAvatarEdit)} type="submit">
              {saving ? t("common.saving") : t("settings.saveProfile")}
            </button>
          </div>
          <div className="avatar-upload-panel">
            <div>
              <p className="eyebrow">{t("settings.imageAvatarEyebrow")}</p>
              <h2>{t("settings.cropUpload")}</h2>
            </div>
            <AvatarImageEditor
              disabled={!allowAvatarEdit || !allowAvatarUpload || saving}
              onUpload={onUploadAvatarImage}
            />
            {!allowAvatarUpload ? (
              <p className="form-note">{t("settings.avatarUploadDisabled")}</p>
            ) : null}
          </div>
          {!allowDisplayNameEdit && !allowAvatarEdit ? (
            <p className="form-note">{t("settings.profileEditingDisabled")}</p>
          ) : null}
          {profileError ? <p className="form-error">{profileError}</p> : null}
        </form>
        <AdminAccessPanel
          allowAdminClaim={config?.networkConfig.allowAdminClaim ?? false}
          currentUser={currentUser}
          onClaimAdmin={onClaimAdmin}
        />
        {config?.networkConfig.securityProfile === "hardened" ? (
          <DeviceWipePanel onWipeDevice={onWipeDevice} />
        ) : null}
      </div>
    </section>
  );
}

/**
 * Local ("wipe this device") kill switch, shown only under the hardened security profile. Erases
 * this browser's local copy after a typed confirmation; it does not touch the node or other devices
 * (that is the admin kill switch). Reuses the app's `purgeLocalData` flow.
 */
function DeviceWipePanel({ onWipeDevice }: { onWipeDevice: () => Promise<void> }) {
  const [confirmText, setConfirmText] = useState("");
  const [wiping, setWiping] = useState(false);

  async function wipe(): Promise<void> {
    setWiping(true);

    try {
      await onWipeDevice();
    } finally {
      setWiping(false);
    }
  }

  return (
    <div className="profile-panel">
      <div>
        <p className="eyebrow">{t("settings.securityEyebrow")}</p>
        <h2>{t("settings.wipeTitle")}</h2>
      </div>
      <div className="danger-zone">
        <p className="form-note">{t("settings.wipeBody")}</p>
        <label>
          {t("settings.wipeConfirmBefore")} <strong>wipe</strong> {t("settings.wipeConfirmAfter")}
          <input
            autoComplete="off"
            disabled={wiping}
            onInput={(event) => setConfirmText(event.currentTarget.value)}
            value={confirmText}
          />
        </label>
        <div className="profile-actions">
          <button
            className="danger-button"
            disabled={wiping || confirmText.trim() !== "wipe"}
            onClick={() => void wipe()}
            type="button"
          >
            {wiping ? t("settings.wiping") : t("settings.wipeTitle")}
          </button>
        </div>
      </div>
    </div>
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
      setClaimError(error instanceof Error ? error.message : t("settings.claimError"));
    } finally {
      setClaiming(false);
    }
  }

  return (
    <div className="profile-panel">
      <div>
        <p className="eyebrow">{t("settings.adminEyebrow")}</p>
        <h2>{currentUser.isAdmin ? t("settings.adminTools") : t("settings.adminAccess")}</h2>
      </div>
      {currentUser.isAdmin ? (
        <NavLink active={false} className="nav-link" href="/admin">
          {t("settings.openAdmin")}
        </NavLink>
      ) : allowAdminClaim ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void claim();
          }}
        >
          <label>
            {t("settings.claimLabel")}
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
              {claiming ? t("settings.checking") : t("settings.unlockAdmin")}
            </button>
          </div>
          {claimError ? <p className="form-error">{claimError}</p> : null}
        </form>
      ) : (
        <p className="form-note">{t("settings.claimDisabled")}</p>
      )}
    </div>
  );
}

/**
 * People & moderation surface for admins, moderators, and greeters. Greeters see the pending-join
 * queue; moderators (and admins) see the full roster with ban / shadow-ban controls; admins also get
 * role assignment. All gating here is cosmetic — the server enforces every capability.
 */
function PeopleView({
  currentUser,
  onUsersChanged,
}: {
  currentUser: User;
  onUsersChanged: (users: User[]) => void;
}) {
  const greeter = canGreet(currentUser);
  const moderator = canModerate(currentUser);

  if (!greeter && !moderator) {
    return (
      <section className="settings-view">
        <header className="conversation-header">
          <NavLink active={false} className="mobile-back" href="/channels">
            ←
          </NavLink>
          <div>
            <p className="eyebrow">People</p>
            <h1>Not authorized</h1>
          </div>
        </header>
        <p className="form-note">This area is for greeters, moderators, and admins.</p>
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
          <p className="eyebrow">People</p>
          <h1>People and moderation</h1>
        </div>
      </header>
      <div className="settings-grid">
        {greeter ? <PendingApprovalsPanel onUsersChanged={onUsersChanged} /> : null}
        {moderator ? <ModerationPanel currentUser={currentUser} onUsersChanged={onUsersChanged} /> : null}
      </div>
    </section>
  );
}

/**
 * Parse an array response into validated users, dropping any entries that fail the schema.
 */
function parseUserList(payload: unknown): User[] {
  return Array.isArray(payload)
    ? payload.flatMap((item) => {
        const parsed = UserSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
}

/**
 * Greeter queue: lists users awaiting approval (`GET /api/access/pending`) with Approve / Deny
 * actions. Pending users are hidden from the normal roster, so this panel fetches its own list and
 * offers a manual refresh.
 */
function PendingApprovalsPanel({ onUsersChanged }: { onUsersChanged: (users: User[]) => void }) {
  const [pending, setPending] = useState<User[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoaded(false);
    setLoadError(undefined);

    fetchJson<unknown>("/api/access/pending")
      .then((payload) => {
        if (!active) {
          return;
        }

        setPending(parseUserList(payload));
        setLoaded(true);
      })
      .catch((error: unknown) => {
        if (active) {
          setLoadError(error instanceof Error ? error.message : "Unable to load pending joins.");
        }
      });

    return () => {
      active = false;
    };
  }, [reloadKey]);

  return (
    <div className="profile-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Access</p>
          <h2>Pending joins</h2>
        </div>
        <button className="ghost-button" onClick={() => setReloadKey((key) => key + 1)} type="button">
          Refresh
        </button>
      </div>
      {loadError ? <p className="form-error">{loadError}</p> : null}
      {!loaded && !loadError ? <p className="form-note">Loading pending joins…</p> : null}
      {loaded && pending.length === 0 ? <p className="form-note">Nobody is waiting to join.</p> : null}
      {pending.length > 0 ? (
        <ul className="moderation-list">
          {pending.map((user) => (
            <PendingRow
              key={user.id}
              onResolved={(resolved) => {
                setPending((previous) => previous.filter((entry) => entry.id !== resolved.id));
                onUsersChanged([resolved]);
              }}
              user={user}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * One pending-join row: Approve lets the user in; Deny bans them. Holds its own busy/error state so
 * resolving one person never disturbs another.
 */
function PendingRow({ onResolved, user }: { onResolved: (user: User) => void; user: User }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function decide(action: "approve" | "deny"): Promise<void> {
    setBusy(true);
    setError(undefined);

    try {
      const updated = await requestUser("POST", `/api/access/users/${encodeURIComponent(user.id)}/${action}`);
      onResolved(updated);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to update this person.");
      setBusy(false);
    }
  }

  return (
    <li className="moderation-row">
      <div className="moderation-identity">
        <Avatar avatar={user.avatar} id={user.id} />
        <div className="moderation-name">
          <strong>{user.displayName}</strong>
          <span>{user.id}</span>
        </div>
      </div>
      <div className="moderation-actions">
        <button disabled={busy} onClick={() => void decide("approve")} type="button">
          Approve
        </button>
        <button className="danger-button" disabled={busy} onClick={() => void decide("deny")} type="button">
          Deny
        </button>
      </div>
      {error ? <p className="form-error">{error}</p> : null}
    </li>
  );
}

/**
 * Moderator roster: the full human user list including banned / shadow-banned people
 * (`GET /api/moderation/users`) so they can be unbanned. Each row exposes ban / shadow-ban toggles,
 * and (for admins) role assignment. Controls are hidden for admin targets and for yourself.
 */
function ModerationPanel({
  currentUser,
  onUsersChanged,
}: {
  currentUser: User;
  onUsersChanged: (users: User[]) => void;
}) {
  const [people, setPeople] = useState<User[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoaded(false);
    setLoadError(undefined);

    fetchJson<unknown>("/api/moderation/users")
      .then((payload) => {
        if (!active) {
          return;
        }

        setPeople(parseUserList(payload));
        setLoaded(true);
      })
      .catch((error: unknown) => {
        if (active) {
          setLoadError(error instanceof Error ? error.message : "Unable to load people.");
        }
      });

    return () => {
      active = false;
    };
  }, [reloadKey]);

  /** Merge an updated user into the roster (preserving order) and the app-wide roster in one step. */
  const applyUser = useCallback(
    (user: User) => {
      setPeople((previous) => {
        const next = new Map(previous.map((entry) => [entry.id, entry]));
        next.set(user.id, user);
        return Array.from(next.values());
      });
      onUsersChanged([user]);
    },
    [onUsersChanged],
  );

  return (
    <div className="profile-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Moderation</p>
          <h2>People</h2>
        </div>
        <button className="ghost-button" onClick={() => setReloadKey((key) => key + 1)} type="button">
          Refresh
        </button>
      </div>
      {loadError ? <p className="form-error">{loadError}</p> : null}
      {!loaded && !loadError ? <p className="form-note">Loading people…</p> : null}
      {loaded && people.length === 0 ? <p className="form-note">No people to show yet.</p> : null}
      {people.length > 0 ? (
        <ul className="moderation-list">
          {people.map((user) => (
            <ModerationUserRow currentUser={currentUser} key={user.id} onApply={applyUser} user={user} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * One roster row. Shows the person's identity and state badges; when the target is neither an admin
 * nor yourself, exposes role checkboxes (admins only) and ban / shadow-ban toggles.
 */
function ModerationUserRow({
  currentUser,
  onApply,
  user,
}: {
  currentUser: User;
  onApply: (user: User) => void;
  user: User;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const protectedTarget = isProtectedTarget(user, currentUser);
  const roles = new Set<Role>(user.roles ?? []);

  async function run(action: () => Promise<User>): Promise<void> {
    setBusy(true);
    setError(undefined);

    try {
      onApply(await action());
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to update this person.");
    } finally {
      setBusy(false);
    }
  }

  function setRole(role: Role, checked: boolean): void {
    const next = new Set(roles);

    if (checked) {
      next.add(role);
    } else {
      next.delete(role);
    }

    void run(() =>
      requestUser("PATCH", `/api/admin/users/${encodeURIComponent(user.id)}/roles`, {
        roles: Array.from(next),
      }),
    );
  }

  function setModeration(update: { banned?: boolean; shadowBanned?: boolean }): void {
    void run(() => requestUser("PATCH", `/api/moderation/users/${encodeURIComponent(user.id)}`, update));
  }

  function promote(): void {
    if (!window.confirm(`Make ${user.displayName} an admin? Admin access can't be revoked from here — only by re-setting up the node.`)) {
      return;
    }

    void run(() => requestUser("POST", `/api/admin/users/${encodeURIComponent(user.id)}/promote`));
  }

  return (
    <li className="moderation-row">
      <div className="moderation-identity">
        <Avatar avatar={user.avatar} id={user.id} />
        <div className="moderation-name">
          <strong>{user.displayName}</strong>
          <span>{user.id}</span>
        </div>
        <UserStateBadges user={user} />
      </div>
      {protectedTarget ? (
        <p className="moderation-note">{user.id === currentUser.id ? "That's you." : "Admins can't be moderated."}</p>
      ) : (
        <div className="moderation-controls">
          {canManageRoles(currentUser) ? (
            <div className="role-toggles">
              <label className="admin-toggle">
                <input
                  checked={roles.has("moderator")}
                  disabled={busy}
                  onInput={(event) => setRole("moderator", event.currentTarget.checked)}
                  type="checkbox"
                />
                Moderator
              </label>
              <label className="admin-toggle">
                <input
                  checked={roles.has("greeter")}
                  disabled={busy}
                  onInput={(event) => setRole("greeter", event.currentTarget.checked)}
                  type="checkbox"
                />
                Greeter
              </label>
            </div>
          ) : null}
          <div className="moderation-actions">
            <button
              className={user.banned ? undefined : "danger-button"}
              disabled={busy}
              onClick={() => setModeration({ banned: !user.banned })}
              type="button"
            >
              {user.banned ? "Unban" : "Ban"}
            </button>
            <button disabled={busy} onClick={() => setModeration({ shadowBanned: !user.shadowBanned })} type="button">
              {user.shadowBanned ? "Un-shadow-ban" : "Shadow-ban"}
            </button>
            {/* Promotion is admin-only and one-way (no demote — see the server route). Offered
                only for a non-banned, non-pending member so the new admin is immediately usable. */}
            {canManageRoles(currentUser) && !user.banned && !user.pending ? (
              <button disabled={busy} onClick={promote} type="button">
                Make admin
              </button>
            ) : null}
          </div>
        </div>
      )}
      {error ? <p className="form-error">{error}</p> : null}
    </li>
  );
}

/**
 * Compact state badges (admin / roles / pending / banned / shadow-banned) for a roster row.
 */
function UserStateBadges({ user }: { user: User }) {
  const badges: { key: string; label: string; className: string }[] = [];

  if (user.isAdmin) {
    badges.push({ key: "admin", label: "Admin", className: "badge-admin" });
  }

  for (const role of user.roles ?? []) {
    badges.push({ key: `role-${role}`, label: role, className: "badge-role" });
  }

  if (user.pending) {
    badges.push({ key: "pending", label: "Pending", className: "badge-pending" });
  }

  if (user.banned) {
    badges.push({ key: "banned", label: "Banned", className: "badge-banned" });
  }

  if (user.shadowBanned) {
    badges.push({ key: "shadow", label: "Shadow-banned", className: "badge-shadow" });
  }

  if (!badges.length) {
    return null;
  }

  return (
    <div className="state-badges">
      {badges.map((badge) => (
        <span className={`state-badge ${badge.className}`} key={badge.key}>
          {badge.label}
        </span>
      ))}
    </div>
  );
}

const FEATURE_FLAG_LABELS: [keyof FeatureFlags, string][] = [
  ["enablePublicChannels", "Public channels"],
  ["enablePrivateChannels", "Private channels (invite-only)"],
  ["enableUserChannels", "User-created channels"],
  ["enableReplies", "Thread replies"],
  ["enableDMs", "Direct messages"],
  ["enableReactions", "Reactions"],
  ["enableMarkdown", "Markdown rendering"],
  ["enableAttachments", "Image attachments"],
  ["enablePresence", "Online presence (reveals who is connected — off for high-risk use)"],
];

const IDENTITY_LABELS: [keyof IdentityConfig, string][] = [
  ["allowUserDisplayNameEdit", "Users can edit their display name"],
  ["allowUserAvatarEdit", "Users can edit their avatar"],
  ["allowUserAvatarUpload", "Users can upload avatar images"],
  ["allowAdminUserEdit", "Admins can edit other users"],
];

/**
 * Human-facing summary of what each security profile enforces. A named profile bundles the access,
 * retention, and kill-switch axes (docs/09); `custom` unlocks them for individual editing. Only the
 * axes LOAM enforces today are described — transport encryption / E2EE are future, which is why
 * `open` and `standard` currently apply the same settings.
 */
const SECURITY_PROFILE_LABELS: Record<SecurityProfile, { title: string; summary: string }> = {
  open: {
    title: "Open",
    summary: "Anyone joins and posts immediately. Messages are kept and the kill switch is off — maximum access, for disaster-relief style use.",
  },
  standard: {
    title: "Standard",
    summary: "Anyone with the join link participates; messages are kept and the kill switch is off. (Same enforced settings as Open until transport encryption lands.)",
  },
  hardened: {
    title: "Hardened",
    summary: "New joiners must be approved, messages expire after 1 hour, and the kill switch is armed. For high-risk use.",
  },
  custom: {
    title: "Custom",
    summary: "Set who can join, message retention, and the kill switch individually in the sections below.",
  },
};

/**
 * Admin-only configuration area: edits node feature flags, identity permissions, LLM settings, and
 * the admin bootstrap strategy via the /api/admin/config endpoints. Client gating is cosmetic —
 * the server enforces admin on every request.
 */
function AdminView({
  currentUser,
  joinUrl,
  onChannelUpsert,
  onWiped,
}: {
  currentUser: User;
  joinUrl?: string;
  onChannelUpsert: (channels: Channel[]) => void;
  onWiped: () => Promise<void>;
}) {
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
        node: adminConfig.node,
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
        access: adminConfig.access,
        sync: adminConfig.sync,
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

  /**
   * Switch the security profile. A named profile (open/standard/hardened) is a coherent bundle, so
   * we mirror the server by applying its access/retention/kill-switch axes locally — the form then
   * shows exactly what will be enforced. `custom` unlocks those axes for individual editing.
   */
  function setSecurityProfile(profile: SecurityProfile): void {
    setAdminConfig((previous) => {
      if (!previous) {
        return previous;
      }
      const preset = securityProfilePreset(profile);
      if (!preset) {
        return { ...previous, security: { ...previous.security, profile } };
      }
      return {
        ...previous,
        security: { ...previous.security, profile },
        access: { ...previous.access, joinPolicy: preset.joinPolicy },
        retention: { messageTtlMs: preset.messageTtlMs ?? undefined },
        killSwitch: { ...previous.killSwitch, enabled: preset.killSwitchEnabled },
      };
    });
  }

  function setJoinPolicy(joinPolicy: JoinPolicy): void {
    setAdminConfig((previous) =>
      previous ? { ...previous, access: { ...previous.access, joinPolicy } } : previous,
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
          <div className="profile-panel getting-started">
            <div>
              <p className="eyebrow">Getting started</p>
              <h2>Run your network in five steps</h2>
            </div>
            <ol className="getting-started-steps">
              <li><strong>Name it</strong> — set a Network name below so joiners recognise where they are.</li>
              <li><strong>Choose a posture</strong> — pick a Security profile (Open for relief, Hardened for high-risk), or Custom to tune each control.</li>
              <li><strong>Invite people</strong> — share the join QR from the sidebar; under an Approval policy, greeters let newcomers in from People &amp; moderation.</li>
              <li><strong>Set your team</strong> — grant moderator/greeter roles or promote a co-admin in People &amp; moderation.</li>
              <li><strong>Grow the mesh</strong> — to cover more than one hotspot, enable Node-to-node sync and link another host by QR.</li>
            </ol>
            <p className="form-note">
              Everything here is optional and reversible. See the{" "}
              <a href="https://github.com/JosephMaynard/loam/blob/master/docs/12-operators-guide.md" rel="noreferrer" target="_blank">
                operator&rsquo;s guide
              </a>{" "}
              for the full walkthrough.
            </p>
          </div>
          <div className="profile-panel">
            <div>
              <p className="eyebrow">Network</p>
              <h2>Identity</h2>
            </div>
            <label>
              Network name
              <input
                disabled={saving}
                maxLength={80}
                onInput={(event) =>
                  setAdminConfig((previous) =>
                    previous ? { ...previous, node: { ...previous.node, name: event.currentTarget.value } } : previous,
                  )
                }
                value={adminConfig.node.name}
              />
            </label>
            <p className="form-note">
              Shown to everyone who joins — in the sidebar and on the join screen. Give your network a
              name people will recognise (e.g. &ldquo;Riverside Relief&rdquo;).
            </p>
          </div>
          <div className="profile-panel">
            <div>
              <p className="eyebrow">Security</p>
              <h2>Profile</h2>
            </div>
            <label>
              Posture
              <select
                disabled={saving}
                onInput={(event) =>
                  setSecurityProfile(SecurityProfileSchema.parse(event.currentTarget.value))
                }
                value={adminConfig.security.profile}
              >
                {SecurityProfileSchema.options.map((profile) => (
                  <option key={profile} value={profile}>
                    {SECURITY_PROFILE_LABELS[profile].title}
                  </option>
                ))}
              </select>
            </label>
            <p className="form-note">{SECURITY_PROFILE_LABELS[adminConfig.security.profile].summary}</p>
            <label>
              Who can join
              <select
                disabled={saving || adminConfig.security.profile !== "custom"}
                onInput={(event) => setJoinPolicy(JoinPolicySchema.parse(event.currentTarget.value))}
                value={adminConfig.access.joinPolicy}
              >
                <option value="open">Open — anyone with the link joins</option>
                <option value="approval">Approval — a greeter or admin lets people in</option>
              </select>
            </label>
            {adminConfig.security.profile !== "custom" ? (
              <p className="form-note">
                Access, retention, and the kill switch are managed by the{" "}
                <strong>{SECURITY_PROFILE_LABELS[adminConfig.security.profile].title}</strong> profile.
                Switch to <strong>Custom</strong> to edit them individually.
              </p>
            ) : null}
          </div>
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
                disabled={saving || adminConfig.security.profile !== "custom"}
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
                disabled={saving || adminConfig.security.profile !== "custom"}
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
              <p className="eyebrow">Network</p>
              <h2>Node-to-node sync</h2>
            </div>
            <label className="admin-toggle">
              <input
                checked={adminConfig.sync.enabled}
                disabled={saving}
                onInput={(event) =>
                  setAdminConfig((previous) =>
                    previous
                      ? { ...previous, sync: { ...previous.sync, enabled: event.currentTarget.checked } }
                      : previous,
                  )
                }
                type="checkbox"
              />
              Sync public channels with peer nodes
            </label>
            <p className="form-note">
              Pull-based: this node fetches public channels, their messages, and profiles from each
              peer. DMs and private channels never leave a node. A peer&rsquo;s join URL (from its
              join QR) is its sync address. Enabling this also lets peers pull this node&rsquo;s
              public content.
            </p>
            {adminConfig.sync.enabled ? <NodeLinkControl joinUrl={joinUrl} /> : null}
            {adminConfig.sync.peers.length ? (
              <ul className="moderation-list">
                {adminConfig.sync.peers.map((peer) => (
                  <li className="moderation-row sync-peer" key={peer.url}>
                    <div className="moderation-name">
                      <strong>{peer.label ?? peer.url}</strong>
                      {peer.label ? <span>{peer.url}</span> : null}
                    </div>
                    <div className="moderation-actions">
                      <button
                        className="danger-button"
                        disabled={saving}
                        onClick={() =>
                          setAdminConfig((previous) =>
                            previous
                              ? {
                                  ...previous,
                                  sync: {
                                    ...previous.sync,
                                    peers: previous.sync.peers.filter((entry) => entry.url !== peer.url),
                                  },
                                }
                              : previous,
                          )
                        }
                        type="button"
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="form-note">No peers yet.</p>
            )}
            <AddSyncPeerControl
              disabled={saving || adminConfig.sync.peers.length >= 16}
              onAdd={(peer) =>
                setAdminConfig((previous) =>
                  previous && !previous.sync.peers.some((entry) => entry.url === peer.url)
                    ? { ...previous, sync: { ...previous.sync, peers: [...previous.sync.peers, peer] } }
                    : previous,
                )
              }
            />
            <p className="form-note">Peer changes apply when you save the node config below.</p>
            <SyncStatusPanel />
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
      <AdminChannelsPanel currentUser={currentUser} onChannelUpsert={onChannelUpsert} />
    </section>
  );
}

/** Compact add-a-peer form: URL (required, http/https) + optional label. */
function AddSyncPeerControl({
  disabled,
  onAdd,
}: {
  disabled: boolean;
  onAdd: (peer: { url: string; label?: string }) => void;
}) {
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const trimmedUrl = url.trim().replace(/\/+$/, "");
  const validUrl = /^https?:\/\/.+/.test(trimmedUrl);

  return (
    <div className="sync-peer-add">
      <label>
        Peer URL (its join URL)
        <input
          disabled={disabled}
          onInput={(event) => setUrl(event.currentTarget.value)}
          placeholder="http://192.168.0.10:3000"
          value={url}
        />
      </label>
      <label>
        Label (optional)
        <input
          disabled={disabled}
          maxLength={80}
          onInput={(event) => setLabel(event.currentTarget.value)}
          placeholder="e.g. Depot Pi"
          value={label}
        />
      </label>
      <button
        disabled={disabled || !validUrl}
        onClick={() => {
          onAdd({ url: trimmedUrl, ...(label.trim() ? { label: label.trim() } : {}) });
          setUrl("");
          setLabel("");
        }}
        type="button"
      >
        Add peer
      </button>
    </div>
  );
}

function parseSyncStatusReport(payload: unknown): SyncStatusReport | undefined {
  const parsed = SyncStatusReportSchema.safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Live per-peer sync status (`GET /api/admin/sync`) with a "Sync now" trigger. Reflects the
 * *saved* config — peers added above appear here after saving.
 */
function SyncStatusPanel() {
  const [report, setReport] = useState<SyncStatusReport>();
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;

    fetchJson<unknown>("/api/admin/sync")
      .then((payload) => {
        if (!active) {
          return;
        }

        const parsed = parseSyncStatusReport(payload);

        if (!parsed) {
          // Surface contract drift instead of rendering a silently blank panel.
          setError("The server returned an unrecognised sync status payload.");
          return;
        }

        setReport(parsed);
      })
      .catch((loadError: unknown) => {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : "Unable to load sync status.");
        }
      });

    return () => {
      active = false;
    };
  }, [reloadKey]);

  async function runNow(): Promise<void> {
    setRunning(true);
    setError(undefined);

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 60_000);

    try {
      const response = await fetch(apiUrl("/api/admin/sync/run"), {
        method: "POST",
        credentials: "include",
        signal: controller.signal,
      });
      const payload: unknown = await response.json().catch(() => undefined);

      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
            ? payload.error
            : `Sync failed: ${response.status}`;
        throw new Error(message);
      }

      const parsed = parseSyncStatusReport(payload);

      if (!parsed) {
        throw new Error("The server returned an unrecognised sync status payload.");
      }

      setReport(parsed);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Unable to run sync.");
    } finally {
      window.clearTimeout(timeout);
      setRunning(false);
    }
  }

  if (!report?.peers.length) {
    return error ? <p className="form-error">{error}</p> : null;
  }

  return (
    <div className="sync-status">
      <div className="panel-heading">
        <p className="eyebrow">Status (saved peers)</p>
        <div className="moderation-actions">
          <button className="ghost-button" disabled={running} onClick={() => setReloadKey((key) => key + 1)} type="button">
            Refresh
          </button>
          <button disabled={running || !report.enabled} onClick={() => void runNow()} type="button">
            {running ? "Syncing…" : "Sync now"}
          </button>
        </div>
      </div>
      <ul className="moderation-list">
        {report.peers.map((peer) => (
          <li className="moderation-row sync-peer" key={peer.url}>
            <div className="moderation-name">
              <strong>{peer.label ?? peer.url}</strong>
              <span>
                {peer.status?.lastError
                  ? `Error: ${peer.status.lastError}`
                  : peer.status?.lastSuccessAt
                    ? `Last synced ${displayTime(peer.status.lastSuccessAt)} · ${peer.status.imported} message(s) imported`
                    : "Not synced yet"}
              </span>
            </div>
          </li>
        ))}
      </ul>
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}

/**
 * Sends an admin channel create/update request and returns the validated channel the server echoes
 * back. Throws with the server's error message (or a status fallback) on failure.
 */
async function requestChannel(method: "POST" | "PATCH", path: string, body: unknown): Promise<Channel> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(apiUrl(path), {
      method,
      credentials: "include",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify(body),
    });
    const payload: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      const message =
        payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
          ? payload.error
          : `Request failed: ${response.status}`;
      throw new Error(message);
    }

    const parsed = ChannelSchema.safeParse(payload);

    if (!parsed.success) {
      throw new Error("The server returned an unrecognised channel payload.");
    }

    return parsed.data;
  } finally {
    window.clearTimeout(timeout);
  }
}

/**
 * Admin-only channel management: create public channels and rename/archive existing ones. Channels
 * are created public + discoverable (private channels need a membership model that does not exist
 * yet). Fetches its own full list from `/api/admin/channels` so archived channels remain visible
 * and restorable here even though they are hidden from the sidebar. The server is the enforcer.
 */
function AdminChannelsPanel({
  currentUser,
  onChannelUpsert,
}: {
  currentUser: User;
  onChannelUpsert: (channels: Channel[]) => void;
}) {
  const [adminChannels, setAdminChannels] = useState<Channel[]>([]);
  const [listError, setListError] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [allowPosting, setAllowPosting] = useState<ChannelPostingPolicy>("everyone");
  const [allowReplies, setAllowReplies] = useState(true);
  const [isPrivate, setIsPrivate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string>();

  /** Upsert a channel into the local admin list (preserving order) and the sidebar in one step. */
  const applyChannel = useCallback(
    (channel: Channel) => {
      setAdminChannels((previous) => {
        const next = new Map(previous.map((entry) => [entry.id, entry]));
        next.set(channel.id, channel);
        return Array.from(next.values());
      });
      onChannelUpsert([channel]);
    },
    [onChannelUpsert],
  );

  useEffect(() => {
    if (!currentUser.isAdmin) {
      return;
    }

    let active = true;

    fetchJson<unknown>("/api/admin/channels")
      .then((payload) => {
        if (!active) {
          return;
        }

        const list = Array.isArray(payload)
          ? payload.flatMap((item) => {
              const parsed = ChannelSchema.safeParse(item);
              return parsed.success ? [parsed.data] : [];
            })
          : [];
        setAdminChannels(list);
        setLoaded(true);
      })
      .catch((error: unknown) => {
        if (active) {
          setListError(error instanceof Error ? error.message : "Unable to load channels.");
        }
      });

    return () => {
      active = false;
    };
  }, [currentUser.isAdmin]);

  async function create(): Promise<void> {
    if (!name.trim()) {
      return;
    }

    setCreating(true);
    setCreateError(undefined);

    try {
      const channel = await requestChannel("POST", "/api/channels", {
        name: name.trim(),
        description: description.trim() || undefined,
        ...(isPrivate ? { visibility: "private" } : {}),
        allowPosting,
        allowReplies,
      });
      applyChannel(channel);
      setName("");
      setDescription("");
      setAllowPosting("everyone");
      setAllowReplies(true);
      setIsPrivate(false);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "Unable to create the channel.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="settings-grid">
      <div className="profile-panel">
        <div>
          <p className="eyebrow">Channels</p>
          <h2>Create a channel</h2>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <label>
            Name
            <input
              disabled={creating}
              maxLength={80}
              onInput={(event) => setName(event.currentTarget.value)}
              placeholder="e.g. Logistics"
              value={name}
            />
          </label>
          <label>
            Description (optional)
            <input
              disabled={creating}
              maxLength={280}
              onInput={(event) => setDescription(event.currentTarget.value)}
              value={description}
            />
          </label>
          <label>
            Who can post
            <select
              disabled={creating}
              onInput={(event) =>
                setAllowPosting(event.currentTarget.value === "admins" ? "admins" : "everyone")
              }
              value={allowPosting}
            >
              <option value="everyone">Everyone</option>
              <option value="admins">Admins only</option>
            </select>
          </label>
          <label className="admin-toggle">
            <input
              checked={allowReplies}
              disabled={creating}
              onInput={(event) => setAllowReplies(event.currentTarget.checked)}
              type="checkbox"
            />
            Allow threaded replies
          </label>
          <label className="admin-toggle">
            <input
              checked={isPrivate}
              disabled={creating}
              onInput={(event) => setIsPrivate(event.currentTarget.checked)}
              type="checkbox"
            />
            Private (invite-only; you start as the only member)
          </label>
          <div className="profile-actions">
            <button disabled={creating || !name.trim()} type="submit">
              {creating ? "Creating…" : "Create channel"}
            </button>
          </div>
          {createError ? <p className="form-error">{createError}</p> : null}
        </form>
      </div>
      <div className="profile-panel">
        <div>
          <p className="eyebrow">Channels</p>
          <h2>Existing channels</h2>
        </div>
        {listError ? <p className="form-error">{listError}</p> : null}
        {!loaded && !listError ? <p className="form-note">Loading channels…</p> : null}
        {loaded && adminChannels.length === 0 ? (
          <p className="form-note">No channels yet. Create one above.</p>
        ) : null}
        {adminChannels.length > 0 ? (
          <ul className="admin-channel-list">
            {adminChannels.map((channel) => (
              <AdminChannelRow channel={channel} key={channel.id} onApply={applyChannel} />
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One row in the admin channel list: rename the channel or archive/restore it. Holds its own draft
 * name so editing one channel never disturbs another.
 */
function AdminChannelRow({
  channel,
  onApply,
}: {
  channel: Channel;
  onApply: (channel: Channel) => void;
}) {
  const [name, setName] = useState(channel.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const trimmedName = name.trim();
  const renameDisabled = busy || !trimmedName || trimmedName === channel.name;

  async function patch(update: Record<string, unknown>): Promise<void> {
    setBusy(true);
    setError(undefined);

    try {
      const updated = await requestChannel("PATCH", `/api/channels/${channel.id}`, update);
      onApply(updated);
      setName(updated.name);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to update the channel.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={channel.archived ? "admin-channel archived" : "admin-channel"}>
      <div className="admin-channel-main">
        <input
          aria-label={`Channel name for ${channel.name}`}
          disabled={busy}
          maxLength={80}
          onInput={(event) => setName(event.currentTarget.value)}
          value={name}
        />
        <span className="admin-channel-meta">
          {channel.allowPosting === "admins" ? "Admins post" : "Open posting"}
          {channel.visibility === "private" ? " · Private" : ""}
          {channel.archived ? " · Archived" : ""}
        </span>
      </div>
      <div className="admin-channel-actions">
        <button disabled={renameDisabled} onClick={() => void patch({ name: trimmedName })} type="button">
          Rename
        </button>
        <button
          className={channel.archived ? undefined : "danger-button"}
          disabled={busy}
          onClick={() => void patch({ archived: !channel.archived })}
          type="button"
        >
          {channel.archived ? "Restore" : "Archive"}
        </button>
      </div>
      {error ? <p className="form-error">{error}</p> : null}
    </li>
  );
}
