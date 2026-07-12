import {
  AdminBootstrapStrategySchema,
  ChannelSchema,
  JoinPolicySchema,
  LoamConfigSchema,
  LocaleSchema,
  MeshContactSchema,
  MeshIdentityCardSchema,
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
  type MeshContact,
  type MeshIdentityCard,
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
import {
  deleteRecord,
  destroyDatabase,
  getAllRecords,
  markLocalStoreWiped,
  putRecord,
  putRecords,
} from "./lib/local-store";
import { parseMessageResponse, parseRoute, parseSocketEvent, type Conversation } from "./lib/protocol";
import { renderMarkdown } from "./lib/markdown";
import {
  apiUrl,
  encryptedFetch,
  ensureSession,
  fingerprint,
  getHostKeyMismatch,
  isSessionQrVerified,
  joinQrUrl,
  openWsFrame,
  SERVER_URL_KEY,
  TransportNeedsQrError,
  wsUrl,
} from "./lib/transport";
import {
  LOCALE_LABELS,
  RTL_LOCALES,
  errorText,
  getActiveLocale,
  icuLocale,
  isLocaleLoaded,
  loadLocale,
  resolveLocale,
  setActiveLocale,
  t,
} from "./i18n";
import { safeQrSvg } from "./lib/qr";

type Config = {
  /** The node's build version, shown in the join/settings footer. Absent on very old nodes. */
  version?: string;
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
// Opportunistic-mesh (docs/16) `ttlMs` bounds, mirrored from `MeshConfigSchema` in @loam/schema —
// the admin panel edits the value in hours, so these are the ms bounds converted for display/clamp.
const MESH_TTL_MS_MIN = 60_000;
const MESH_TTL_MS_MAX = 7 * 24 * 3_600_000;
const MESH_TTL_HOURS_MIN = MESH_TTL_MS_MIN / 3_600_000;
const MESH_TTL_HOURS_MAX = MESH_TTL_MS_MAX / 3_600_000;

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

/**
 * GET a JSON endpoint through the transport-encryption wrapper (a byte-for-byte passthrough when no
 * session is active — see `encryptedFetch`). Used for every content endpoint; `/api/config` is
 * deliberately NOT routed through this (see `fetchConfigJson`) — it must stay readable before any
 * transport session exists and must never be re-encrypted on a later refetch.
 */
async function fetchJson<T>(path: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await encryptedFetch("GET", path, undefined, { signal: controller.signal });

    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => undefined);
      throw new Error(errorText(payload, t("common.requestFailed", { status: response.status })));
    }

    return response.json() as Promise<T>;
  } finally {
    window.clearTimeout(timeout);
  }
}

/**
 * GET `/api/config` as a plain, unencrypted fetch — the transport bootstrap path (docs/08). It
 * identifies the session and advertises `transportEncryption`/`transportPublicKey`, so it must be
 * readable before a transport session exists, and it is refetched on every reconnect/resync
 * regardless of whether a session is later established, so it always bypasses `encryptedFetch`.
 */
async function fetchConfigJson(timeoutMs = REQUEST_TIMEOUT_MS): Promise<Config> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(apiUrl("/api/config"), {
      credentials: "include",
      signal: controller.signal,
    });

    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => undefined);
      throw new Error(errorText(payload, t("common.requestFailed", { status: response.status })));
    }

    return response.json() as Promise<Config>;
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
  // Node UI locale (via icuLocale), so times read in the same language as the rest of the chrome.
  return new Intl.DateTimeFormat(icuLocale(getActiveLocale()), {
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
    const response = await encryptedFetch(method, path, body, { signal: controller.signal });
    const payload: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      const message = errorText(payload, `Request failed: ${response.status}`);
      throw new Error(message);
    }

    const parsed = UserSchema.safeParse(payload);

    if (!parsed.success) {
      throw new Error(t("app.userUnrecognised"));
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
    routeState.screen === "search" ||
    routeState.screen === "mesh"
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
  // Set when this node requires transport encryption (docs/08) but no host public key is available
  // from a scanned join QR — there is no safe way to talk to it, so the app renders a gate instead.
  const [needsQr, setNeedsQr] = useState(false);
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
        (message.type !== "reaction" && message.type !== "sealed" && message.attachments?.length
          ? t("toast.imageFallback")
          : "");
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
      if (!window.confirm(t("confirm.deleteMessage"))) {
        return;
      }

      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await encryptedFetch(
          "DELETE",
          `/api/messages/${encodeURIComponent(messageId)}`,
          undefined,
          { signal: controller.signal },
        );

        if (!response.ok) {
          const payload: unknown = await response.json().catch(() => undefined);
          const message = errorText(payload, `Delete failed: ${response.status}`);
          throw new Error(message);
        }

        // The server broadcasts messageDeleted for the message and any cascaded replies/reactions;
        // remove the target immediately for snappy feedback (the rest arrive over the socket).
        removeMessage(messageId);
      } catch (error) {
        setError(error instanceof Error ? error.message : t("app.deleteError"));
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
        const response = await encryptedFetch(
          "PATCH",
          `/api/messages/${encodeURIComponent(messageId)}`,
          { body: trimmed },
          { signal: controller.signal },
        );
        const payload: unknown = await response.json().catch(() => undefined);

        if (!response.ok) {
          const message = errorText(payload, `Edit failed: ${response.status}`);
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
        setError(error instanceof Error ? error.message : t("app.editError"));
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
        const response = await encryptedFetch(
          "POST",
          "/api/channels",
          { name: trimmed, ...(visibility === "private" ? { visibility } : {}) },
          { signal: controller.signal },
        );
        const payload: unknown = await response.json().catch(() => undefined);

        if (!response.ok) {
          const message = errorText(payload, `Couldn't create the channel: ${response.status}`);
          throw new Error(message);
        }

        const parsed = ChannelSchema.safeParse(payload);
        if (parsed.success) {
          upsertChannels([parsed.data]);
          location.route(`/channel/${encodeURIComponent(parsed.data.id)}`);
        }
        return true;
      } catch (error) {
        setError(error instanceof Error ? error.message : t("admin.channelCreateError"));
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
    // Latch the local store so any in-flight fetch that resolves after this can't rebuild the DB we
    // are about to delete (docs/15 #4).
    markLocalStoreWiped();
    // A device wipe must also drop the server session, or the HttpOnly identity cookie (which JS
    // can't clear) survives and a reload re-hydrates the wiped identity. A node kill switch already
    // invalidated every session server-side, so only the device scope needs this (docs/15 #4).
    if (scope === "device") {
      // Bound it with the standard timeout so a hung/unreachable server can't stall the wipe — the
      // local purge below is the part that actually matters and must always run (docs/15 #4).
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      await fetch(apiUrl("/api/session/end"), { method: "POST", credentials: "include", signal: controller.signal })
        .catch(() => {
          // best effort — the local purge below still runs
        })
        .finally(() => window.clearTimeout(timeout));
    }
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
        const response = await encryptedFetch("POST", "/api/messages", request, {
          signal: controller.signal,
        });

        if (!response.ok) {
          // Localize a server error code when present (e.g. dms_disabled), else a generic message.
          const errorPayload: unknown = await response.json().catch(() => undefined);
          throw new Error(errorText(errorPayload, t("common.requestFailed", { status: response.status })));
        }

        let payload: unknown;

        try {
          payload = await response.json();
        } catch (error) {
          throw new Error(t("app.sendInvalidJson"), { cause: error });
        }

        const result = parseMessageResponse(payload);

        if (!result) {
          throw new Error(t("app.sendInvalidPayload"));
        }

        if (result.message) {
          upsertMessages([result.message]);
        }

        if (result.deletedMessageId) {
          removeMessage(result.deletedMessageId);
        }
      } catch (error) {
        // Surface the failure (matching editMessage/deleteMessage) so a send/reaction that fails
        // isn't silent, then re-throw so the composer keeps the unsent text for a retry.
        setError(error instanceof Error ? error.message : t("app.sendError"));
        throw error;
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
        const response = await encryptedFetch("PATCH", "/api/users/me", request, {
          signal: controller.signal,
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
        const response = await encryptedFetch("POST", "/api/admin/claim", { secret }, {
          signal: controller.signal,
        });
        const payload: unknown = await response.json().catch(() => undefined);

        if (!response.ok) {
          const message = errorText(payload, `Admin claim failed: ${response.status}`);
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
      const response = await encryptedFetch(
        "POST",
        "/api/attachments",
        {
          mimeType: prepared.blob.type || "image/png",
          data: btoa(binary),
          width: prepared.width,
          height: prepared.height,
        },
        { signal: controller.signal },
      );
      const payload: unknown = await response.json().catch(() => undefined);

      if (!response.ok) {
        const message = errorText(payload, `Attachment upload failed: ${response.status}`);
        throw new Error(message);
      }

      const parsed = MessageAttachmentSchema.safeParse(payload);

      if (!parsed.success) {
        throw new Error(t("app.attachmentUnrecognised"));
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
        const response = await encryptedFetch(
          "PUT",
          "/api/users/me/avatar-image",
          { mimeType: blob.type || "image/png", data: btoa(binary) },
          { signal: controller.signal },
        );

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

  // Only English is bundled; other languages are code-split and fetched on demand. Load the node's
  // locale when it changes and bump `localeTick` on completion so the tree re-renders in the newly
  // loaded language (until then `t()` returns English — no blank UI, at most a brief English flash on
  // a non-English node's first paint). English needs no fetch.
  const [, setLocaleTick] = useState(0);
  useEffect(() => {
    if (isLocaleLoaded(locale)) {
      return;
    }

    let active = true;
    void loadLocale(locale).then(() => {
      if (active) {
        setLocaleTick((tick) => tick + 1);
      }
    });

    return () => {
      active = false;
    };
  }, [locale]);

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
    fetchConfigJson()
      .then(async (nextConfig) => {
        if (!active) {
          return;
        }

        // Establish (or refresh) the transport session BEFORE any content request or WebSocket open
        // (docs/08) — `config`/`currentUser` only get set once this resolves, so the WS-open effect
        // (keyed on `config?.currentUser.id`) and the channels/users fetch below never race ahead of it.
        try {
          await ensureSession(nextConfig.networkConfig.transportEncryption, nextConfig.networkConfig.transportPublicKey);
        } catch (sessionError) {
          if (sessionError instanceof TransportNeedsQrError) {
            // `required` mode with no host key available (no QR scanned, none cached): there is no
            // safe way to talk to this node — gate the whole app instead of falling back to plaintext.
            setNeedsQr(true);
            return;
          }

          if (nextConfig.networkConfig.transportEncryption !== "optional") {
            // `required` mode where a key WAS available but the handshake itself failed (e.g. the
            // node is unreachable) — treat like any other boot failure (below) rather than silently
            // degrading to an unencrypted session.
            throw sessionError;
          }

          // `optional` mode: proceed without a session (plaintext) rather than stranding the user.
        }

        if (!active) {
          return;
        }

        setNeedsQr(false);
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

        setError(nextError instanceof Error ? nextError.message : t("app.serverUnreachable"));
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

    // Wait until config has loaded before fetching conversation messages. The boot effect awaits
    // ensureSession() before setConfig(), so `config` being set means the transport session (if any)
    // is established — a deep-link/reload landing straight on a channel/DM must not fire this content
    // request before the handshake, which would 401 under `required` mode or go out in plaintext under
    // `optional` (docs/08). Once config arrives the effect re-runs.
    if (!config) {
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

        setError(nextError instanceof Error ? nextError.message : t("app.messagesLoadError"));
      });

    return () => {
      active = false;
    };
  }, [activeConversation?.id, activeConversation?.kind, config, currentUser.id, reconcileConversationMessages, syncTick]);

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
        void connectWebSocket();
      }, delay);
    }

    async function connectWebSocket(): Promise<void> {
      if (disposed) {
        return;
      }

      socketAttempt += 1;
      const attempt = socketAttempt;

      // A reconnect (anything past the first attempt) may follow the transport session having
      // expired or been invalidated server-side (TTL, kill-switch key rotation, node restart) — the
      // module-scoped session in transport.ts only ever gets refreshed by a REST call's own
      // decrypt-failure/401 retry, which the WebSocket path never triggers. Without refreshing here,
      // `wsUrl` would keep sending a dead `?enc=<sid>`: under `required` mode the server refuses the
      // connection outright (an unrecoverable reconnect loop), and under `optional` mode the socket
      // opens unsealed while the client still expects sealed frames, so every inbound frame fails to
      // decrypt and is silently dropped (docs/08). Best-effort: on any failure, fall through and try
      // to connect anyway — the existing reconnect loop already handles a connection that still can't
      // succeed.
      if (attempt > 1 && config) {
        await ensureSession(
          config.networkConfig.transportEncryption,
          config.networkConfig.transportPublicKey,
        ).catch(() => undefined);

        if (disposed || attempt !== socketAttempt) {
          return;
        }
      }

      const nextSocket = new WebSocket(wsUrl(socketUrl));
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

        const raw = openWsFrame(event.data);

        if (raw === null) {
          // A decrypt failure (or, off-mode, never) — drop the frame rather than crash the parser.
          return;
        }

        const payload = parseSocketEvent(raw);

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

    void connectWebSocket();

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

  if (needsQr) {
    return (
      <main className="wiped-screen">
        <div>
          <p className="brand-title">LOAM</p>
          <h1>{t("gate.needsQrTitle")}</h1>
          <p>{t("gate.needsQrBody")}</p>
        </div>
      </main>
    );
  }

  if (wiped) {
    return (
      <main className="wiped-screen">
        <div>
          <p className="brand-title">LOAM</p>
          {wipeScope === "device" ? (
            <>
              <h1>{t("gate.deviceWipedTitle")}</h1>
              <p>{t("gate.deviceWipedBody")}</p>
            </>
          ) : (
            <>
              <h1>{t("gate.disconnectedTitle")}</h1>
              <p>{t("gate.disconnectedBody")}</p>
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
          <h1>{t("gate.bannedTitle")}</h1>
          <p>{t("gate.bannedBody")}</p>
        </div>
      </main>
    );
  }

  if (currentUser.pending) {
    return (
      <main className="wiped-screen">
        <div>
          <p className="brand-title">LOAM</p>
          <h1>{t("gate.pendingTitle")}</h1>
          <p>{t("gate.pendingBody")}</p>
          <p className="gate-status">
            {t("gate.connection", {
              status:
                connection === "live"
                  ? t("sidebar.statusLive")
                  : connection === "offline"
                    ? t("sidebar.statusOffline")
                    : t("sidebar.statusConnecting"),
            })}
          </p>
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
        showMesh={!!config?.networkConfig.enableMesh}
        transportPublicKey={config?.networkConfig.transportPublicKey}
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
      ) : routeState.screen === "mesh" && config?.networkConfig.enableMesh ? (
        <MeshView />
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
  showMesh: boolean;
  transportPublicKey?: string;
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
  showMesh,
  transportPublicKey,
  unreadByConversation,
  users,
}: SidebarProps) {
  const peers = users.filter((user) => user.id !== currentUser.id);
  const showPeople = canModerate(currentUser) || canGreet(currentUser);
  // Encode the host's transport public key into the invite QR (docs/08) so a scanner learns it
  // out-of-band → MITM-resistant handshake; the displayed URL text (inside InviteControl) stays plain.
  const inviteQrUrl = joinUrl ? joinQrUrl(joinUrl, transportPublicKey) : undefined;

  return (
    <aside className="sidebar">
      <div className="brand-row">
        <img src={loamMark} alt="" className="brand-mark" />
        <div>
          {/* The operator-chosen network name is the headline; LOAM stays as the mark. */}
          <p className="brand-title" title={nodeName}>
            {nodeName ?? "LOAM"}
          </p>
          <p className={`status-pill status-${connection}`}>
            {connection === "live"
              ? t("sidebar.statusLive")
              : connection === "offline"
                ? t("sidebar.statusOffline")
                : t("sidebar.statusConnecting")}
          </p>
        </div>
      </div>

      <section className="nav-section">
        <h2>{t("sidebar.channels")}</h2>
        <nav aria-label={t("sidebar.channels")}>
          {channels.map((channel) => (
            <NavLink
              active={activeConversation?.kind === "channel" && activeConversation.id === channel.id}
              href={`/channel/${encodeURIComponent(channel.id)}`}
              key={channel.id}
            >
              <span aria-label={channel.visibility === "private" ? t("members.eyebrow") : undefined} className="nav-glyph">
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
        <h2>{t("sidebar.dms")}</h2>
        <nav aria-label={t("sidebar.dms")}>
          {peers.map((user) => (
            <NavLink
              active={activeConversation?.kind === "dm" && activeConversation.id === user.id}
              href={`/dm/${encodeURIComponent(user.id)}`}
              key={user.id}
            >
              <span className="presence-anchor">
                <Avatar avatar={user.avatar} id={user.id} />
                {onlineUserIds.has(user.id) ? (
                  <span aria-label={t("sidebar.online")} className="presence-dot" title={t("sidebar.online")} />
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
          {t("sidebar.searchMessages")}
        </NavLink>
        {canGreet(currentUser) ? <InviteControl joinUrl={joinUrl} qrUrl={inviteQrUrl} /> : null}
        {showPeople ? (
          <NavLink active={false} href="/people">
            <span className="nav-glyph">☺</span>
            {t("people.title")}
          </NavLink>
        ) : null}
        {showMesh ? (
          <NavLink active={false} href="/mesh">
            <span className="nav-glyph">✉</span>
            {t("sidebar.meshMail")}
          </NavLink>
        ) : null}
        {currentUser.isAdmin ? (
          <NavLink active={false} href="/admin">
            <span className="nav-glyph">⚙</span>
            {t("admin.eyebrow")}
          </NavLink>
        ) : null}
        <NavLink active={false} href="/settings">
          <span className="nav-glyph">⌁</span>
          {t("sidebar.settings")}
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
        {t("newChannel.new")}
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
        aria-label={t("newChannel.nameAria")}
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        disabled={creating}
        maxLength={80}
        onInput={(event) => setName(event.currentTarget.value)}
        placeholder={t("newChannel.namePlaceholder")}
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
          {t("newChannel.private")}
        </label>
      ) : null}
      <div className="new-channel-actions">
        <button disabled={creating || !name.trim()} type="submit">
          {creating ? t("admin.creating") : t("newChannel.create")}
        </button>
        <button
          disabled={creating}
          onClick={() => {
            setOpen(false);
            setName("");
          }}
          type="button"
        >
          {t("common.cancel")}
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

  async function transfer(userId: string): Promise<void> {
    if (!window.confirm(t("members.transferConfirm"))) {
      return;
    }

    setBusy(true);
    setError(undefined);

    try {
      const updated = await requestChannel(
        "POST",
        `/api/channels/${encodeURIComponent(channel.id)}/transfer`,
        { userId },
      );
      onChannelUpsert([updated]);
    } catch (transferError) {
      setError(transferError instanceof Error ? transferError.message : t("members.transferError"));
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
      const response = await encryptedFetch(
        "DELETE",
        `/api/channels/${encodeURIComponent(channel.id)}/members/${encodeURIComponent(userId)}`,
        undefined,
        { signal: controller.signal },
      );

      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => undefined);
        const message = errorText(payload, t("common.requestFailed", { status: response.status }));
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
                  <button className="ghost-button" disabled={busy} onClick={() => void transfer(member.id)} type="button">
                    {t("members.makeOwner")}
                  </button>
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
        {message.type !== "reaction" && message.type !== "sealed" && message.attachments?.length ? (
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
              onClick={() => void onReact(message.id, reaction.reaction).catch(() => {})}
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
              onClick={() => void onReact(message.id, reaction).catch(() => {})}
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
    } catch {
      // onSend surfaces its own error (setError); keep the composer text so the user can retry
      // instead of losing what they typed (and don't leave the rejection unhandled).
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
        reject(new Error(t("avatarEditor.tooLarge")));
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
      setError(t("avatarEditor.invalidType"));
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
          reject(new Error(t("avatarEditor.loadError")));
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
        setError(nextError instanceof Error ? nextError.message : t("avatarEditor.loadError"));
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
      setError(nextError instanceof Error ? nextError.message : t("avatarEditor.uploadError"));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="avatar-editor">
      <canvas
        aria-label={t("avatarEditor.cropPreview")}
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
          {t("avatarEditor.chooseImage")}
        </button>
        <button disabled={disabled || uploading || !hasImage} onClick={() => void upload()} type="button">
          {uploading ? t("avatarEditor.uploading") : t("avatarEditor.useCropped")}
        </button>
      </div>
      <label>
        {t("avatarEditor.zoom")}
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
        {t("avatarEditor.rotate")}
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
      setError(searchError instanceof Error ? searchError.message : t("search.error"));
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
      return t("search.dmWith", { name: usersById.get(peerId)?.displayName ?? generateDisplayName(peerId) });
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
          <p className="eyebrow">{t("search.eyebrow")}</p>
          <h1>{t("search.title")}</h1>
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
            {t("sidebar.searchMessages")}
          </label>
          <input
            dir="auto"
            disabled={searching}
            id={searchInputId}
            maxLength={200}
            onInput={(event) => setQuery(event.currentTarget.value)}
            placeholder={t("search.placeholder")}
            type="search"
            value={query}
          />
          <button disabled={searching || !query.trim()} type="submit">
            {searching ? t("search.searching") : t("search.button")}
          </button>
        </form>
        {error ? <p className="form-error">{error}</p> : null}
        {results && !results.length ? <p className="form-note">{t("search.noResults")}</p> : null}
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
 * Parse a `GET /api/mesh/contacts` payload into validated contacts, dropping any entries that fail
 * the schema (mirrors `parseUserList`).
 */
function parseMeshContactList(payload: unknown): MeshContact[] {
  return Array.isArray(payload)
    ? payload.flatMap((item) => {
        const parsed = MeshContactSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
}

/**
 * Mesh mail (opportunistic-mesh sealed mailbox — docs/16). Only rendered when
 * `networkConfig.enableMesh` is on. Three panels: this user's own shareable mesh identity card (QR +
 * copy, so someone else can add them as a contact), a paste-a-card form to add a contact, and the
 * contact list with a per-contact compose box for sending sealed mail (delivered to the recipient as
 * an ordinary DM once opened — there is no separate "inbox" here).
 */
function MeshView() {
  const [card, setCard] = useState<MeshIdentityCard>();
  const [cardLoading, setCardLoading] = useState(true);
  const [cardError, setCardError] = useState<string>();
  const [copied, setCopied] = useState(false);

  const [contacts, setContacts] = useState<MeshContact[]>();
  const [contactsError, setContactsError] = useState<string>();
  const [contactsReloadKey, setContactsReloadKey] = useState(0);

  const [addValue, setAddValue] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string>();
  const [addSuccess, setAddSuccess] = useState<string>();

  const [selectedMeshId, setSelectedMeshId] = useState<string>();
  const [composeBody, setComposeBody] = useState("");
  const [composeBusy, setComposeBusy] = useState(false);
  const [composeError, setComposeError] = useState<string>();
  const [composeSuccess, setComposeSuccess] = useState<string>();

  const addContactId = useId();

  useEffect(() => {
    let active = true;
    setCardLoading(true);
    setCardError(undefined);

    fetchJson<unknown>("/api/mesh/identity")
      .then((payload) => {
        if (!active) {
          return;
        }

        const parsed = MeshIdentityCardSchema.safeParse(payload);
        if (!parsed.success) {
          setCardError(t("mesh.myCardUnrecognised"));
          return;
        }

        setCard(parsed.data);
      })
      .catch((error: unknown) => {
        if (active) {
          setCardError(error instanceof Error ? error.message : t("mesh.myCardLoadError"));
        }
      })
      .finally(() => {
        if (active) {
          setCardLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setContactsError(undefined);

    fetchJson<unknown>("/api/mesh/contacts")
      .then((payload) => {
        if (active) {
          setContacts(parseMeshContactList(payload));
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setContactsError(error instanceof Error ? error.message : t("mesh.contactsLoadError"));
        }
      });

    return () => {
      active = false;
    };
  }, [contactsReloadKey]);

  const cardJson = useMemo(() => (card ? JSON.stringify(card) : undefined), [card]);
  const qrSvg = useMemo(() => safeQrSvg(cardJson, "#16271f"), [cardJson]);

  // Clear the "Copied" flash timer on unmount (the file's cleanup discipline; Preact tolerates a
  // late setState but we match the surrounding effects).
  const copyTimerRef = useRef<number>();
  useEffect(() => () => window.clearTimeout(copyTimerRef.current), []);

  async function copyCard(): Promise<void> {
    if (!cardJson) {
      return;
    }

    try {
      await navigator.clipboard.writeText(cardJson);
      setCopied(true);
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard is unavailable on insecure-context browsers — which is the norm on LOAM's plain-HTTP
      // LAN. The card is also rendered as a visible, selectable read-only field below, so the user can
      // still copy it by hand; this button is a convenience only.
    }
  }

  async function addContact(): Promise<void> {
    let parsedBody: unknown;

    try {
      parsedBody = JSON.parse(addValue);
    } catch {
      setAddError(t("mesh.addContactInvalidJson"));
      return;
    }

    setAddBusy(true);
    setAddError(undefined);
    setAddSuccess(undefined);

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await encryptedFetch("POST", "/api/mesh/contacts", parsedBody, {
        signal: controller.signal,
      });
      const payload: unknown = await response.json().catch(() => undefined);

      if (!response.ok) {
        throw new Error(errorText(payload, t("mesh.addContactError")));
      }

      setAddValue("");
      setAddSuccess(t("mesh.addContactSuccess"));
      setContactsReloadKey((key) => key + 1);
    } catch (error) {
      setAddError(error instanceof Error ? error.message : t("mesh.addContactError"));
    } finally {
      window.clearTimeout(timeout);
      setAddBusy(false);
    }
  }

  function selectContact(meshId: string): void {
    setSelectedMeshId((current) => (current === meshId ? undefined : meshId));
    setComposeBody("");
    setComposeError(undefined);
    setComposeSuccess(undefined);
  }

  async function sendMail(): Promise<void> {
    const toMeshId = selectedMeshId;
    const body = composeBody.trim();

    if (!toMeshId || !body) {
      return;
    }

    setComposeBusy(true);
    setComposeError(undefined);
    setComposeSuccess(undefined);

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await encryptedFetch("POST", "/api/mesh/messages", { toMeshId, body }, {
        signal: controller.signal,
      });
      const payload: unknown = await response.json().catch(() => undefined);

      if (!response.ok) {
        throw new Error(errorText(payload, t("mesh.composeError")));
      }

      setComposeBody("");
      setComposeSuccess(t("mesh.composeSuccess"));
    } catch (error) {
      setComposeError(error instanceof Error ? error.message : t("mesh.composeError"));
    } finally {
      window.clearTimeout(timeout);
      setComposeBusy(false);
    }
  }

  return (
    <section className="settings-view">
      <header className="conversation-header">
        <NavLink active={false} className="mobile-back" href="/channels">
          ←
        </NavLink>
        <div>
          <p className="eyebrow">{t("mesh.eyebrow")}</p>
          <h1>{t("mesh.title")}</h1>
        </div>
      </header>
      <div className="settings-grid">
        <div className="profile-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">{t("mesh.myCardEyebrow")}</p>
              <h2>{t("mesh.myCardTitle")}</h2>
            </div>
          </div>
          <p className="form-note">{t("mesh.myCardNote")}</p>
          {cardLoading ? <p className="form-note">{t("mesh.myCardLoading")}</p> : null}
          {cardError ? <p className="form-error">{cardError}</p> : null}
          {card ? (
            <>
              {qrSvg ? (
                <div aria-hidden="true" className="invite-qr" dangerouslySetInnerHTML={{ __html: qrSvg }} />
              ) : (
                <p className="form-note">{t("mesh.myCardQrTooLarge")}</p>
              )}
              {/* Visible, selectable copy of the card so a clipboard-less (insecure-context) browser —
                  the norm on LOAM's plain-HTTP LAN — and screen readers (the QR is aria-hidden) can
                  still get it out, mirroring the join-QR panel's URL fallback. */}
              <textarea
                aria-label={t("mesh.myCardTitle")}
                className="mesh-card-text"
                onFocus={(event) => event.currentTarget.select()}
                readOnly
                rows={3}
                value={cardJson}
              />
              <div className="profile-actions">
                <button onClick={() => void copyCard()} type="button">
                  {copied ? t("mesh.copyCardCopied") : t("mesh.copyCard")}
                </button>
              </div>
            </>
          ) : null}
        </div>

        <div className="profile-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">{t("mesh.addContactEyebrow")}</p>
              <h2>{t("mesh.addContactTitle")}</h2>
            </div>
          </div>
          <label className="sr-only" for={addContactId}>
            {t("mesh.addContactTitle")}
          </label>
          <textarea
            dir="auto"
            disabled={addBusy}
            id={addContactId}
            onInput={(event) => setAddValue(event.currentTarget.value)}
            placeholder={t("mesh.addContactPlaceholder")}
            rows={4}
            value={addValue}
          />
          {addError ? <p className="form-error">{addError}</p> : null}
          {addSuccess ? <p className="form-note">{addSuccess}</p> : null}
          <div className="profile-actions">
            <button disabled={addBusy || !addValue.trim()} onClick={() => void addContact()} type="button">
              {addBusy ? t("mesh.addContactAdding") : t("mesh.addContactButton")}
            </button>
          </div>
        </div>

        <div className="profile-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">{t("mesh.contactsEyebrow")}</p>
              <h2>{t("mesh.contactsTitle")}</h2>
            </div>
            <button className="ghost-button" onClick={() => setContactsReloadKey((key) => key + 1)} type="button">
              {t("common.refresh")}
            </button>
          </div>
          {contacts === undefined && !contactsError ? <p className="form-note">{t("mesh.contactsLoading")}</p> : null}
          {contactsError ? <p className="form-error">{contactsError}</p> : null}
          {contacts && contacts.length === 0 ? <p className="form-note">{t("mesh.contactsEmpty")}</p> : null}
          {contacts?.length ? (
            <ul className="moderation-list">
              {contacts.map((contact) => (
                <li className="moderation-row" key={contact.meshId}>
                  <div className="moderation-identity">
                    <div className="moderation-name">
                      <strong>{contact.displayName ?? contact.meshId}</strong>
                      {contact.displayName ? <span>{contact.meshId}</span> : null}
                    </div>
                  </div>
                  <div className="moderation-actions">
                    <button onClick={() => selectContact(contact.meshId)} type="button">
                      {selectedMeshId === contact.meshId ? t("mesh.composeHide") : t("mesh.composeShow")}
                    </button>
                  </div>
                  {selectedMeshId === contact.meshId ? (
                    <div className="mesh-compose">
                      <textarea
                        dir="auto"
                        disabled={composeBusy}
                        onInput={(event) => setComposeBody(event.currentTarget.value)}
                        placeholder={t("mesh.composePlaceholder")}
                        rows={3}
                        value={composeBody}
                      />
                      <p className="form-note">{t("mesh.composeReplyNote")}</p>
                      {composeError ? <p className="form-error">{composeError}</p> : null}
                      {composeSuccess ? <p className="form-note">{composeSuccess}</p> : null}
                      <div className="profile-actions">
                        <button
                          disabled={composeBusy || !composeBody.trim()}
                          onClick={() => void sendMail()}
                          type="button"
                        >
                          {composeBusy ? t("mesh.composeSending") : t("mesh.composeSend")}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
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
  // Encode the host's transport public key into the join QR (docs/08) so a scanner learns it
  // out-of-band → MITM-resistant handshake. The displayed URL text below stays plain.
  const qrSvg = useMemo(
    () =>
      safeQrSvg(
        config?.joinUrl ? joinQrUrl(config.joinUrl, config.networkConfig.transportPublicKey) : undefined,
        "#203f34",
      ),
    [config?.joinUrl, config?.networkConfig.transportPublicKey],
  );
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
          {/* Product name + version — the node's build, not this browser's cache. Deliberately no
              translatable label word so it stays i18n-neutral. */}
          <p className="node-version">LOAM v{config?.version ?? "…"}</p>
          {/* Transport encryption (docs/08): only shown once a session is actually live — `fingerprint()`
              returns undefined off-mode or before the handshake completes. A QR-verified session (the
              host key came from a scanned join QR, out-of-band) is MITM-resistant; a session keyed only
              from the server's advertised config key is not — an attacker on the LAN could have supplied
              that key — so the two are surfaced distinctly rather than both reading as "Encrypted". */}
          {fingerprint() ? (
            <p className="transport-fingerprint">
              {isSessionQrVerified()
                ? t("settings.transportVerifiedLine", { fingerprint: fingerprint() ?? "" })
                : t("settings.transportUnverifiedLine", { fingerprint: fingerprint() ?? "" })}
            </p>
          ) : null}
          {fingerprint() && !isSessionQrVerified() ? (
            <p className="form-note">{t("settings.transportUnverifiedHint")}</p>
          ) : null}
          {getHostKeyMismatch() ? (
            <p className="form-error">{t("settings.transportKeyMismatch")}</p>
          ) : null}
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
            <p className="eyebrow">{t("people.eyebrow")}</p>
            <h1>{t("people.notAuthorizedTitle")}</h1>
          </div>
        </header>
        <p className="form-note">{t("people.notAuthorizedNote")}</p>
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
          <p className="eyebrow">{t("people.eyebrow")}</p>
          <h1>{t("people.title")}</h1>
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
          setLoadError(error instanceof Error ? error.message : t("people.pendingLoadError"));
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
          <p className="eyebrow">{t("people.accessEyebrow")}</p>
          <h2>{t("people.pendingTitle")}</h2>
        </div>
        <button className="ghost-button" onClick={() => setReloadKey((key) => key + 1)} type="button">
          {t("common.refresh")}
        </button>
      </div>
      {loadError ? <p className="form-error">{loadError}</p> : null}
      {!loaded && !loadError ? <p className="form-note">{t("people.pendingLoading")}</p> : null}
      {loaded && pending.length === 0 ? <p className="form-note">{t("people.pendingEmpty")}</p> : null}
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
      setError(requestError instanceof Error ? requestError.message : t("moderation.updateError"));
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
          {t("people.approve")}
        </button>
        <button className="danger-button" disabled={busy} onClick={() => void decide("deny")} type="button">
          {t("people.deny")}
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
          setLoadError(error instanceof Error ? error.message : t("moderation.loadError"));
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
          <p className="eyebrow">{t("moderation.eyebrow")}</p>
          <h2>{t("moderation.heading")}</h2>
        </div>
        <button className="ghost-button" onClick={() => setReloadKey((key) => key + 1)} type="button">
          {t("common.refresh")}
        </button>
      </div>
      {loadError ? <p className="form-error">{loadError}</p> : null}
      {!loaded && !loadError ? <p className="form-note">{t("moderation.loading")}</p> : null}
      {loaded && people.length === 0 ? <p className="form-note">{t("moderation.empty")}</p> : null}
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
      setError(requestError instanceof Error ? requestError.message : t("moderation.updateError"));
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
    if (!window.confirm(t("moderation.promoteConfirm", { name: user.displayName }))) {
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
        <p className="moderation-note">{user.id === currentUser.id ? t("moderation.thatsYou") : t("moderation.adminsProtected")}</p>
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
                {t("moderation.roleModerator")}
              </label>
              <label className="admin-toggle">
                <input
                  checked={roles.has("greeter")}
                  disabled={busy}
                  onInput={(event) => setRole("greeter", event.currentTarget.checked)}
                  type="checkbox"
                />
                {t("moderation.roleGreeter")}
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
              {user.banned ? t("moderation.unban") : t("moderation.ban")}
            </button>
            <button disabled={busy} onClick={() => setModeration({ shadowBanned: !user.shadowBanned })} type="button">
              {user.shadowBanned ? t("moderation.unshadowban") : t("moderation.shadowban")}
            </button>
            {/* Promotion is admin-only and one-way (no demote — see the server route). Offered
                only for a non-banned, non-pending member so the new admin is immediately usable. */}
            {canManageRoles(currentUser) && !user.banned && !user.pending ? (
              <button disabled={busy} onClick={promote} type="button">
                {t("moderation.makeAdmin")}
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
    badges.push({ key: "admin", label: t("moderation.badgeAdmin"), className: "badge-admin" });
  }

  for (const role of user.roles ?? []) {
    badges.push({
      key: `role-${role}`,
      label: role === "moderator" ? t("moderation.roleModerator") : t("moderation.roleGreeter"),
      className: "badge-role",
    });
  }

  if (user.pending) {
    badges.push({ key: "pending", label: t("moderation.badgePending"), className: "badge-pending" });
  }

  if (user.banned) {
    badges.push({ key: "banned", label: t("moderation.badgeBanned"), className: "badge-banned" });
  }

  if (user.shadowBanned) {
    badges.push({ key: "shadow", label: t("moderation.badgeShadow"), className: "badge-shadow" });
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

/** Feature-flag toggle labels, resolved against the active locale at render time. */
function featureFlagLabels(): [keyof FeatureFlags, string][] {
  return [
    ["enablePublicChannels", t("admin.flagPublicChannels")],
    ["enablePrivateChannels", t("admin.flagPrivateChannels")],
    ["enableUserChannels", t("admin.flagUserChannels")],
    ["enableReplies", t("admin.flagReplies")],
    ["enableDMs", t("admin.flagDMs")],
    ["enableReactions", t("admin.flagReactions")],
    ["enableMarkdown", t("admin.flagMarkdown")],
    ["enableAttachments", t("admin.flagAttachments")],
    ["enablePresence", t("admin.flagPresence")],
  ];
}

/** Identity-permission toggle labels, resolved against the active locale at render time. */
function identityLabels(): [keyof IdentityConfig, string][] {
  return [
    ["allowUserDisplayNameEdit", t("admin.identityDisplayName")],
    ["allowUserAvatarEdit", t("admin.identityAvatarEdit")],
    ["allowUserAvatarUpload", t("admin.identityAvatarUpload")],
    ["allowAdminUserEdit", t("admin.identityAdminEdit")],
  ];
}

/**
 * Human-facing summary of what each security profile enforces, resolved against the active locale at
 * render time. A named profile bundles the access, retention, and kill-switch axes (docs/09);
 * `custom` unlocks them for individual editing. Only the axes LOAM enforces today are described —
 * transport encryption / E2EE are future, which is why `open` and `standard` currently apply the
 * same settings.
 */
function securityProfileLabels(): Record<SecurityProfile, { title: string; summary: string }> {
  return {
    open: { title: t("admin.profileOpenTitle"), summary: t("admin.profileOpenSummary") },
    standard: { title: t("admin.profileStandardTitle"), summary: t("admin.profileStandardSummary") },
    hardened: { title: t("admin.profileHardenedTitle"), summary: t("admin.profileHardenedSummary") },
    custom: { title: t("admin.profileCustomTitle"), summary: t("admin.profileCustomSummary") },
  };
}

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
          setLoadError(t("admin.configInvalid"));
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setLoadError(error instanceof Error ? error.message : t("admin.configLoadError"));
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
        llm: { ollama: adminConfig.llm.ollama, onDevice: adminConfig.llm.onDevice },
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
        mesh: adminConfig.mesh,
      };
      const response = await encryptedFetch("PATCH", "/api/admin/config", update, {
        signal: controller.signal,
      });
      const payload: unknown = await response.json().catch(() => undefined);

      if (!response.ok) {
        const message = errorText(payload, t("admin.configUpdateFailed", { status: response.status }));
        throw new Error(message);
      }

      const parsed = LoamConfigSchema.safeParse(payload);

      if (!parsed.success) {
        throw new Error(t("admin.configUnrecognised"));
      }

      setAdminConfig(parsed.data);
      setPassphrase("");
      setPanicToken("");
      setSaved(true);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : t("admin.configSaveError"));
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
        ? { ...previous, llm: { ...previous.llm, ollama: { ...previous.llm.ollama, ...update } } }
        : previous,
    );
  }

  function setOnDevice(update: Partial<LoamConfig["llm"]["onDevice"]>): void {
    setAdminConfig((previous) =>
      previous
        ? { ...previous, llm: { ...previous.llm, onDevice: { ...previous.llm.onDevice, ...update } } }
        : previous,
    );
  }

  function setKillSwitch(update: Partial<LoamConfig["killSwitch"]>): void {
    setAdminConfig((previous) =>
      previous ? { ...previous, killSwitch: { ...previous.killSwitch, ...update } } : previous,
    );
  }

  function setMesh(update: Partial<LoamConfig["mesh"]>): void {
    setAdminConfig((previous) =>
      previous ? { ...previous, mesh: { ...previous.mesh, ...update } } : previous,
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
      const response = await encryptedFetch("POST", "/api/admin/kill-switch", body, {
        signal: controller.signal,
      });

      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => undefined);
        const message = errorText(payload, t("admin.killSwitchFailed", { status: response.status }));
        throw new Error(message);
      }

      // The server also broadcasts a wipe event, but purge directly on HTTP success too so the
      // admin's own browser is cleaned even if its socket is closed (purging twice is harmless).
      await onWiped();
    } catch (error) {
      setFireError(error instanceof Error ? error.message : t("admin.killSwitchError"));
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
            <p className="eyebrow">{t("admin.eyebrow")}</p>
            <h1>{t("people.notAuthorizedTitle")}</h1>
          </div>
        </header>
        <p className="form-note">{t("admin.notAuthorizedNote")}</p>
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
          <p className="eyebrow">{t("admin.eyebrow")}</p>
          <h1>{t("admin.title")}</h1>
        </div>
      </header>
      {loadError ? <p className="form-error">{loadError}</p> : null}
      {!adminConfig && !loadError ? <p className="form-note">{t("admin.loading")}</p> : null}
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
              <p className="eyebrow">{t("admin.gettingStartedEyebrow")}</p>
              <h2>{t("admin.gettingStartedTitle")}</h2>
            </div>
            <ol className="getting-started-steps">
              <li><strong>{t("admin.step1Title")}</strong> — {t("admin.step1Body")}</li>
              <li><strong>{t("admin.step2Title")}</strong> — {t("admin.step2Body")}</li>
              <li><strong>{t("admin.step3Title")}</strong> — {t("admin.step3Body")}</li>
              <li><strong>{t("admin.step4Title")}</strong> — {t("admin.step4Body")}</li>
              <li><strong>{t("admin.step5Title")}</strong> — {t("admin.step5Body")}</li>
            </ol>
            <p className="form-note">
              {t("admin.gettingStartedNoteBefore")}{" "}
              <a href="https://github.com/JosephMaynard/loam/blob/master/docs/12-operators-guide.md" rel="noreferrer" target="_blank">
                {t("admin.gettingStartedGuideLink")}
              </a>{" "}
              {t("admin.gettingStartedNoteAfter")}
            </p>
          </div>
          <div className="profile-panel">
            <div>
              <p className="eyebrow">{t("admin.networkEyebrow")}</p>
              <h2>{t("admin.identityHeading")}</h2>
            </div>
            <label>
              {t("admin.networkName")}
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
            <p className="form-note">{t("admin.networkNameNote")}</p>
            <label>
              {t("admin.language")}
              <select
                disabled={saving}
                onInput={(event) =>
                  setAdminConfig((previous) =>
                    previous
                      ? { ...previous, node: { ...previous.node, locale: LocaleSchema.parse(event.currentTarget.value) } }
                      : previous,
                  )
                }
                value={adminConfig.node.locale}
              >
                {LocaleSchema.options.map((option) => (
                  <option key={option} value={option}>
                    {LOCALE_LABELS[option]}
                  </option>
                ))}
              </select>
            </label>
            <p className="form-note">{t("admin.languageNote")}</p>
          </div>
          <div className="profile-panel">
            <div>
              <p className="eyebrow">{t("settings.securityEyebrow")}</p>
              <h2>{t("admin.profileHeading")}</h2>
            </div>
            <label>
              {t("admin.posture")}
              <select
                disabled={saving}
                onInput={(event) =>
                  setSecurityProfile(SecurityProfileSchema.parse(event.currentTarget.value))
                }
                value={adminConfig.security.profile}
              >
                {SecurityProfileSchema.options.map((profile) => (
                  <option key={profile} value={profile}>
                    {securityProfileLabels()[profile].title}
                  </option>
                ))}
              </select>
            </label>
            <p className="form-note">{securityProfileLabels()[adminConfig.security.profile].summary}</p>
            <label>
              {t("admin.whoCanJoin")}
              <select
                disabled={saving || adminConfig.security.profile !== "custom"}
                onInput={(event) => setJoinPolicy(JoinPolicySchema.parse(event.currentTarget.value))}
                value={adminConfig.access.joinPolicy}
              >
                <option value="open">{t("admin.joinOpen")}</option>
                <option value="approval">{t("admin.joinApproval")}</option>
              </select>
            </label>
            {adminConfig.security.profile !== "custom" ? (
              <p className="form-note">
                {t("admin.axesManaged", {
                  profile: securityProfileLabels()[adminConfig.security.profile].title,
                  custom: securityProfileLabels().custom.title,
                })}
              </p>
            ) : null}
          </div>
          <div className="profile-panel">
            <div>
              <p className="eyebrow">{t("admin.featuresEyebrow")}</p>
              <h2>{t("admin.messagingHeading")}</h2>
            </div>
            {featureFlagLabels().map(([key, label]) => (
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
              <p className="eyebrow">{t("admin.identityEyebrow")}</p>
              <h2>{t("admin.profilesHeading")}</h2>
            </div>
            {identityLabels().map(([key, label]) => (
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
              <p className="eyebrow">{t("admin.llmEyebrow")}</p>
              <h2>{t("admin.llmHeading")}</h2>
            </div>
            <label className="admin-toggle">
              <input
                checked={adminConfig.llm.ollama.enabled}
                disabled={saving}
                onInput={(event) => setOllama({ enabled: event.currentTarget.checked })}
                type="checkbox"
              />
              {t("admin.llmEnable")}
            </label>
            <label>
              {t("admin.llmBaseUrl")}
              <input
                disabled={saving}
                onInput={(event) => setOllama({ baseUrl: event.currentTarget.value })}
                value={adminConfig.llm.ollama.baseUrl}
              />
            </label>
            <label>
              {t("admin.llmModel")}
              <input
                disabled={saving}
                onInput={(event) => setOllama({ model: event.currentTarget.value })}
                value={adminConfig.llm.ollama.model}
              />
            </label>
            <label>
              {t("admin.llmBotName")}
              <input
                disabled={saving}
                maxLength={80}
                onInput={(event) => setOllama({ botDisplayName: event.currentTarget.value })}
                value={adminConfig.llm.ollama.botDisplayName}
              />
            </label>
            <label>
              {t("admin.llmSystemPrompt")}
              <textarea
                disabled={saving}
                onInput={(event) => setOllama({ systemPrompt: event.currentTarget.value || undefined })}
                rows={3}
                value={adminConfig.llm.ollama.systemPrompt ?? ""}
              />
            </label>
            <label className="admin-toggle">
              <input
                checked={adminConfig.llm.onDevice.enabled}
                disabled={saving}
                onInput={(event) => setOnDevice({ enabled: event.currentTarget.checked })}
                type="checkbox"
              />
              {t("admin.llmOnDeviceEnable")}
            </label>
            <label>
              {t("admin.llmOnDeviceModel")}
              <input
                disabled={saving || !adminConfig.llm.onDevice.enabled}
                maxLength={120}
                onInput={(event) => setOnDevice({ model: event.currentTarget.value || undefined })}
                value={adminConfig.llm.onDevice.model ?? ""}
              />
            </label>
            <p className="form-note">{t("admin.llmOnDeviceNote")}</p>
          </div>
          <div className="profile-panel">
            <div>
              <p className="eyebrow">{t("admin.privacyEyebrow")}</p>
              <h2>{t("admin.retentionHeading")}</h2>
            </div>
            <label>
              {t("admin.retentionLabel")}
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
            <p className="form-note">{t("admin.retentionNote")}</p>
          </div>
          <div className="profile-panel">
            <div>
              <p className="eyebrow">{t("admin.safetyEyebrow")}</p>
              <h2>{t("admin.killSwitchHeading")}</h2>
            </div>
            <label className="admin-toggle">
              <input
                checked={adminConfig.killSwitch.enabled}
                disabled={saving || adminConfig.security.profile !== "custom"}
                onInput={(event) => setKillSwitch({ enabled: event.currentTarget.checked })}
                type="checkbox"
              />
              {t("admin.killSwitchEnable")}
            </label>
            <label className="admin-toggle">
              <input
                checked={adminConfig.killSwitch.requireConfirmation}
                disabled={saving || !adminConfig.killSwitch.enabled}
                onInput={(event) => setKillSwitch({ requireConfirmation: event.currentTarget.checked })}
                type="checkbox"
              />
              {t("admin.killSwitchRequireConfirm")}
            </label>
            <label>
              {t("admin.panicToken")}
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
                <p className="form-note">{t("admin.killSwitchWarning")}</p>
                {adminConfig.killSwitch.requireConfirmation ? (
                  <label>
                    {t("admin.killSwitchConfirmBefore")} <strong>wipe</strong> {t("admin.killSwitchConfirmAfter")}
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
                    {firing ? t("settings.wiping") : t("admin.wipeNow")}
                  </button>
                </div>
                {fireError ? <p className="form-error">{fireError}</p> : null}
              </div>
            ) : null}
          </div>
          <div className="profile-panel">
            <div>
              <p className="eyebrow">{t("admin.networkEyebrow")}</p>
              <h2>{t("admin.syncHeading")}</h2>
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
              {t("admin.syncEnable")}
            </label>
            <p className="form-note">{t("admin.syncNote")}</p>
            {adminConfig.sync.enabled ? (
              <label>
                {t("admin.syncTokenLabel")}
                <div className="sync-token-row">
                  <input
                    autoComplete="off"
                    disabled={saving}
                    maxLength={256}
                    onInput={(event) =>
                      setAdminConfig((previous) =>
                        // Keep the raw value, including "" — an empty string is the explicit "clear the
                        // token" signal the server understands. Mapping "" → undefined would be dropped
                        // by JSON.stringify, so a cleared field would never reach the server and the old
                        // token would silently persist.
                        previous
                          ? { ...previous, sync: { ...previous.sync, token: event.currentTarget.value } }
                          : previous,
                      )
                    }
                    placeholder={t("admin.syncTokenPlaceholder")}
                    type="text"
                    value={adminConfig.sync.token ?? ""}
                  />
                  <button
                    className="ghost-button"
                    disabled={saving}
                    onClick={() => {
                      const bytes = crypto.getRandomValues(new Uint8Array(16));
                      const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
                      setAdminConfig((previous) =>
                        previous ? { ...previous, sync: { ...previous.sync, token } } : previous,
                      );
                    }}
                    type="button"
                  >
                    {t("admin.syncTokenGenerate")}
                  </button>
                </div>
              </label>
            ) : null}
            {adminConfig.sync.enabled ? <p className="form-note">{t("admin.syncTokenNote")}</p> : null}
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
                        {t("common.remove")}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="form-note">{t("admin.noPeers")}</p>
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
            <p className="form-note">{t("admin.peerChangesNote")}</p>
            <SyncStatusPanel />
          </div>
          <div className="profile-panel">
            <div>
              <p className="eyebrow">{t("admin.networkEyebrow")}</p>
              <h2>{t("admin.meshHeading")}</h2>
            </div>
            <label className="admin-toggle">
              <input
                checked={adminConfig.mesh.enabled}
                disabled={saving}
                onInput={(event) => setMesh({ enabled: event.currentTarget.checked })}
                type="checkbox"
              />
              {t("admin.meshEnable")}
            </label>
            <p className="form-note">{t("admin.meshNote")}</p>
            <label className="admin-toggle">
              <input
                checked={adminConfig.mesh.relay}
                disabled={saving || !adminConfig.mesh.enabled}
                onInput={(event) => setMesh({ relay: event.currentTarget.checked })}
                type="checkbox"
              />
              {t("admin.meshRelay")}
            </label>
            <label>
              {t("admin.meshLifetimeLabel")}
              <input
                disabled={saving || !adminConfig.mesh.enabled}
                max={MESH_TTL_HOURS_MAX}
                min={MESH_TTL_HOURS_MIN}
                onInput={(event) => {
                  const hours = Number.parseFloat(event.currentTarget.value);
                  if (Number.isFinite(hours)) {
                    setMesh({
                      ttlMs: clamp(Math.round(hours * 3_600_000), MESH_TTL_MS_MIN, MESH_TTL_MS_MAX),
                    });
                  }
                }}
                step="0.5"
                type="number"
                value={String(Math.round((adminConfig.mesh.ttlMs / 3_600_000) * 100) / 100)}
              />
            </label>
            <p className="form-note">{t("admin.meshLifetimeNote")}</p>
            <label>
              {t("admin.meshHopLimitLabel")}
              <input
                disabled={saving || !adminConfig.mesh.enabled}
                max={16}
                min={1}
                onInput={(event) => {
                  const hopLimit = Number.parseInt(event.currentTarget.value, 10);
                  if (Number.isFinite(hopLimit)) {
                    setMesh({ hopLimit: clamp(hopLimit, 1, 16) });
                  }
                }}
                type="number"
                value={String(adminConfig.mesh.hopLimit)}
              />
            </label>
            <label>
              {t("admin.meshMaxCarriedLabel")}
              <input
                disabled={saving || !adminConfig.mesh.enabled}
                max={100_000}
                min={0}
                onInput={(event) => {
                  const maxCarried = Number.parseInt(event.currentTarget.value, 10);
                  if (Number.isFinite(maxCarried)) {
                    setMesh({ maxCarried: clamp(maxCarried, 0, 100_000) });
                  }
                }}
                type="number"
                value={String(adminConfig.mesh.maxCarried)}
              />
            </label>
            <label>
              {t("admin.meshMaxContactsLabel")}
              <input
                disabled={saving || !adminConfig.mesh.enabled}
                max={100_000}
                min={0}
                onInput={(event) => {
                  const maxContacts = Number.parseInt(event.currentTarget.value, 10);
                  if (Number.isFinite(maxContacts)) {
                    setMesh({ maxContacts: clamp(maxContacts, 0, 100_000) });
                  }
                }}
                type="number"
                value={String(adminConfig.mesh.maxContacts)}
              />
            </label>
          </div>
          <div className="profile-panel">
            <div>
              <p className="eyebrow">{t("admin.bootstrapEyebrow")}</p>
              <h2>{t("admin.bootstrapHeading")}</h2>
            </div>
            <label>
              {t("admin.strategy")}
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
                {t("admin.newPassphrase")}
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
            <p className="form-note">{t("admin.bootstrapNote")}</p>
            <div className="profile-actions">
              <button disabled={saving} type="submit">
                {saving ? t("common.saving") : t("admin.saveConfig")}
              </button>
            </div>
            {saved ? <p className="form-note">{t("admin.saved")}</p> : null}
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
        {t("admin.peerUrl")}
        <input
          disabled={disabled}
          onInput={(event) => setUrl(event.currentTarget.value)}
          placeholder="http://192.168.0.10:3000"
          value={url}
        />
      </label>
      <label>
        {t("admin.peerLabel")}
        <input
          disabled={disabled}
          maxLength={80}
          onInput={(event) => setLabel(event.currentTarget.value)}
          placeholder={t("admin.peerLabelPlaceholder")}
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
        {t("admin.addPeer")}
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
          setError(t("admin.syncStatusUnrecognised"));
          return;
        }

        setReport(parsed);
      })
      .catch((loadError: unknown) => {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : t("admin.syncStatusLoadError"));
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
      const response = await encryptedFetch("POST", "/api/admin/sync/run", undefined, {
        signal: controller.signal,
      });
      const payload: unknown = await response.json().catch(() => undefined);

      if (!response.ok) {
        const message = errorText(payload, t("admin.syncFailed", { status: response.status }));
        throw new Error(message);
      }

      const parsed = parseSyncStatusReport(payload);

      if (!parsed) {
        throw new Error(t("admin.syncStatusUnrecognised"));
      }

      setReport(parsed);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : t("admin.syncRunError"));
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
        <p className="eyebrow">{t("admin.syncStatusEyebrow")}</p>
        <div className="moderation-actions">
          <button className="ghost-button" disabled={running} onClick={() => setReloadKey((key) => key + 1)} type="button">
            {t("common.refresh")}
          </button>
          <button disabled={running || !report.enabled} onClick={() => void runNow()} type="button">
            {running ? t("admin.syncing") : t("admin.syncNow")}
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
                  ? t("admin.peerError", { error: peer.status.lastError })
                  : peer.status?.lastSuccessAt
                    ? `${t("admin.peerLastSyncedAt", { time: displayTime(peer.status.lastSuccessAt) })} · ${t("admin.peerImported", { n: peer.status.imported })}`
                    : t("admin.peerNotSynced")}
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
    const response = await encryptedFetch(method, path, body, { signal: controller.signal });
    const payload: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      const message = errorText(payload, t("common.requestFailed", { status: response.status }));
      throw new Error(message);
    }

    const parsed = ChannelSchema.safeParse(payload);

    if (!parsed.success) {
      throw new Error(t("admin.channelUnrecognised"));
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
          setListError(error instanceof Error ? error.message : t("admin.channelsLoadError"));
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
      setCreateError(error instanceof Error ? error.message : t("admin.channelCreateError"));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="settings-grid">
      <div className="profile-panel">
        <div>
          <p className="eyebrow">{t("admin.channelsEyebrow")}</p>
          <h2>{t("admin.createChannelHeading")}</h2>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <label>
            {t("admin.channelName")}
            <input
              disabled={creating}
              maxLength={80}
              onInput={(event) => setName(event.currentTarget.value)}
              placeholder={t("admin.channelNamePlaceholder")}
              value={name}
            />
          </label>
          <label>
            {t("admin.channelDescription")}
            <input
              disabled={creating}
              maxLength={280}
              onInput={(event) => setDescription(event.currentTarget.value)}
              value={description}
            />
          </label>
          <label>
            {t("admin.whoCanPost")}
            <select
              disabled={creating}
              onInput={(event) =>
                setAllowPosting(event.currentTarget.value === "admins" ? "admins" : "everyone")
              }
              value={allowPosting}
            >
              <option value="everyone">{t("admin.postEveryone")}</option>
              <option value="admins">{t("admin.postAdmins")}</option>
            </select>
          </label>
          <label className="admin-toggle">
            <input
              checked={allowReplies}
              disabled={creating}
              onInput={(event) => setAllowReplies(event.currentTarget.checked)}
              type="checkbox"
            />
            {t("admin.allowReplies")}
          </label>
          <label className="admin-toggle">
            <input
              checked={isPrivate}
              disabled={creating}
              onInput={(event) => setIsPrivate(event.currentTarget.checked)}
              type="checkbox"
            />
            {t("admin.channelPrivate")}
          </label>
          <div className="profile-actions">
            <button disabled={creating || !name.trim()} type="submit">
              {creating ? t("admin.creating") : t("admin.createChannel")}
            </button>
          </div>
          {createError ? <p className="form-error">{createError}</p> : null}
        </form>
      </div>
      <div className="profile-panel">
        <div>
          <p className="eyebrow">{t("admin.channelsEyebrow")}</p>
          <h2>{t("admin.existingChannels")}</h2>
        </div>
        {listError ? <p className="form-error">{listError}</p> : null}
        {!loaded && !listError ? <p className="form-note">{t("admin.channelsLoading")}</p> : null}
        {loaded && adminChannels.length === 0 ? (
          <p className="form-note">{t("admin.channelsEmpty")}</p>
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
      setError(requestError instanceof Error ? requestError.message : t("admin.channelUpdateError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={channel.archived ? "admin-channel archived" : "admin-channel"}>
      <div className="admin-channel-main">
        <input
          aria-label={t("admin.channelNameAria", { name: channel.name })}
          disabled={busy}
          maxLength={80}
          onInput={(event) => setName(event.currentTarget.value)}
          value={name}
        />
        <span className="admin-channel-meta">
          {channel.allowPosting === "admins" ? t("admin.metaAdminsPost") : t("admin.metaOpenPosting")}
          {channel.visibility === "private" ? ` · ${t("admin.metaPrivate")}` : ""}
          {channel.archived ? ` · ${t("admin.metaArchived")}` : ""}
        </span>
      </div>
      <div className="admin-channel-actions">
        <button disabled={renameDisabled} onClick={() => void patch({ name: trimmedName })} type="button">
          {t("admin.rename")}
        </button>
        <button
          className={channel.archived ? undefined : "danger-button"}
          disabled={busy}
          onClick={() => void patch({ archived: !channel.archived })}
          type="button"
        >
          {channel.archived ? t("admin.restore") : t("admin.archive")}
        </button>
      </div>
      {error ? <p className="form-error">{error}</p> : null}
    </li>
  );
}
