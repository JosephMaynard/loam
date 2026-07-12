/**
 * Message-list ordering helpers. The client keeps its whole message history in one array sorted by
 * `createdAt`; these functions preserve that invariant while merging incoming messages cheaply.
 */
import type { Message } from "@loam/schema";
import type { Conversation } from "./protocol";

/** Aggregated reaction bucket for one emoji on a target message: its count and whether the current user reacted. */
export type ReactionSummary = {
  reaction: string;
  count: number;
  active: boolean;
};

/** Ascending sort comparator by creation time — the canonical order of the message history. */
export function compareCreatedAt(left: Message, right: Message): number {
  return left.createdAt - right.createdAt;
}

/**
 * Reference merge: dedupe by id (incoming wins), then a stable sort by `createdAt`. Byte-for-byte the
 * old `new Map(...).set(...)` + `Array.from(...).sort(compareCreatedAt)` behaviour, used as the exact
 * fallback whenever the fast path can't guarantee it reproduces this ordering.
 */
function mergeMessagesBySort(previous: Message[], incoming: Message[]): Message[] {
  const next = new Map(previous.map((message) => [message.id, message]));

  for (const message of incoming) {
    next.set(message.id, message);
  }

  return Array.from(next.values()).sort(compareCreatedAt);
}

/**
 * The insertion index that keeps `sorted` ordered by `createdAt` when a new message is added — the
 * upper bound (first index whose `createdAt` is strictly greater), so a new item lands *after* any
 * existing item sharing its timestamp. That matches the reference algorithm's stable sort, where a
 * freshly appended item follows the earlier ones for an equal key.
 */
function upperBoundByCreatedAt(sorted: Message[], createdAt: number): number {
  let low = 0;
  let high = sorted.length;

  while (low < high) {
    const mid = (low + high) >>> 1;

    if (sorted[mid].createdAt <= createdAt) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

/**
 * Merge incoming messages into an already-sorted history, returning a NEW sorted array with the exact
 * same ordering and dedupe-by-id semantics as a full re-sort — but without paying for one in the
 * common cases. `previous` MUST already be sorted by `compareCreatedAt`.
 *
 * - An incoming id that matches an existing message replaces it in place (a `messageUpdated` for an
 *   edit or a streaming delta keeps its position, since `createdAt` is unchanged).
 * - A brand-new id is spliced in at its sorted position (an append when it is the newest, which is
 *   the hot path for live traffic).
 * - The rare case where an existing id's `createdAt` actually changed falls back to the reference
 *   sort, so correctness never depends on the fast path.
 *
 * @param previous - The current history, sorted ascending by `createdAt`.
 * @param incoming - Messages to upsert (new or updated).
 * @returns A new array, sorted ascending by `createdAt`, with incoming entries winning by id.
 */
export function mergeMessagesInOrder(previous: Message[], incoming: Message[]): Message[] {
  if (incoming.length === 0) {
    return previous.slice();
  }

  const indexById = new Map<string, number>();

  for (let index = 0; index < previous.length; index += 1) {
    indexById.set(previous[index].id, index);
  }

  // A changed timestamp on an existing message can move it anywhere; defer to the exact reference
  // algorithm rather than reason about the shift. (Edits keep createdAt, so this is effectively never
  // hit — it just keeps the fast path provably safe.)
  for (const message of incoming) {
    const at = indexById.get(message.id);

    if (at !== undefined && previous[at].createdAt !== message.createdAt) {
      return mergeMessagesBySort(previous, incoming);
    }
  }

  const result = previous.slice();
  const newItems: Message[] = [];

  // Phase 1: in-place replacements keep length and order, so indices from `indexById` stay valid.
  for (const message of incoming) {
    const at = indexById.get(message.id);

    if (at === undefined) {
      newItems.push(message);
    } else {
      result[at] = message;
    }
  }

  if (newItems.length === 0) {
    return result;
  }

  // Phase 2: insert genuinely new messages. Sort them by createdAt (stable, so incoming order is kept
  // for equal timestamps) and splice each at its upper bound — reproducing the reference ordering.
  newItems.sort(compareCreatedAt);

  for (const message of newItems) {
    result.splice(upperBoundByCreatedAt(result, message.createdAt), 0, message);
  }

  return result;
}

/**
 * Whether a message belongs to a conversation (channel or DM) from `currentUserId`'s perspective.
 *
 * @param message - The message to test.
 * @param conversation - The conversation scope (channel or DM).
 * @param currentUserId - The signed-in user's id (used to resolve DM direction).
 * @returns `true` when the message is in scope for the conversation.
 */
export function isConversationMessage(
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

/**
 * All messages belonging to a conversation — its posts/replies (or DMs) plus any reactions targeting
 * those messages — sorted ascending by `createdAt`.
 *
 * @param allMessages - The full message history.
 * @param conversation - The conversation scope (channel or DM).
 * @param currentUserId - The signed-in user's id (used to resolve DM direction).
 * @returns The in-scope messages and their reactions, sorted by creation time.
 */
export function conversationMessages(
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

/**
 * The top-level (non-reply) messages of a conversation — channel posts for a channel, DMs for a DM —
 * sorted ascending by `createdAt`.
 *
 * @param messages - Messages already scoped to the conversation.
 * @param conversation - The conversation scope (channel or DM).
 * @returns The top-level messages, sorted by creation time.
 */
export function topLevelMessages(messages: Message[], conversation: Conversation): Message[] {
  return messages
    .filter((message) => {
      if (conversation.kind === "channel") {
        return message.type === "channelPost";
      }

      return message.type === "dm";
    })
    .sort(compareCreatedAt);
}

/**
 * The replies to a given parent message — channel replies with a matching `parentMessageId` — sorted
 * ascending by `createdAt`.
 *
 * @param messages - Messages to scan (the whole conversation, or an already-grouped per-parent slice).
 * @param parentMessageId - The parent message id to match.
 * @returns The matching replies, sorted by creation time.
 */
export function repliesFor(messages: Message[], parentMessageId: string): Message[] {
  return messages
    .filter((message) => message.type === "channelReply" && message.parentMessageId === parentMessageId)
    .sort(compareCreatedAt);
}

/**
 * Aggregate the reactions targeting a message into per-emoji buckets, sorted by count descending then
 * emoji locale order.
 *
 * @param messages - Messages to scan (the whole conversation, or an already-grouped per-target slice).
 * @param targetMessageId - The target message id to aggregate reactions for.
 * @param currentUserId - The signed-in user's id (marks a bucket `active` when they reacted).
 * @returns One `ReactionSummary` per distinct emoji, sorted by count desc then reaction.
 */
export function reactionSummary(
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
 * Groups channel replies by parent message id so a conversation render can look up a message's
 * replies in O(1) instead of every message rescanning the full conversation with `repliesFor`.
 * Pass the resulting per-parent slice back through `repliesFor` (its filter becomes a no-op on an
 * already-grouped slice) to keep the exact same sort order and output.
 *
 * @param messages - All messages in the current conversation scope.
 * @returns A map from parent message id to its (unsorted) reply messages.
 */
export function groupRepliesByParent(messages: Message[]): Map<string, Message[]> {
  const grouped = new Map<string, Message[]>();

  for (const message of messages) {
    if (message.type !== "channelReply") {
      continue;
    }

    const existing = grouped.get(message.parentMessageId);

    if (existing) {
      existing.push(message);
    } else {
      grouped.set(message.parentMessageId, [message]);
    }
  }

  return grouped;
}

/**
 * Groups reaction messages by target message id so a conversation render can look up a message's
 * reactions in O(1) instead of every message rescanning the full conversation with
 * `reactionSummary`. Pass the resulting per-target slice back through `reactionSummary` (its filter
 * becomes a no-op on an already-grouped slice) to keep the exact same aggregation and sort order.
 *
 * @param messages - All messages in the current conversation scope.
 * @returns A map from target message id to its reaction messages.
 */
export function groupReactionsByTarget(messages: Message[]): Map<string, Message[]> {
  const grouped = new Map<string, Message[]>();

  for (const message of messages) {
    if (message.type !== "reaction") {
      continue;
    }

    const existing = grouped.get(message.targetMessageId);

    if (existing) {
      existing.push(message);
    } else {
      grouped.set(message.targetMessageId, [message]);
    }
  }

  return grouped;
}

/**
 * The conversation key a message belongs to from `currentUserId`'s perspective. Reactions have no
 * conversation of their own, so they return `undefined` (they never drive unread/toasts).
 *
 * @param message - The message to classify.
 * @param currentUserId - The signed-in user's id (used to resolve the DM peer).
 * @returns The `channel:<id>` / `dm:<peerId>` key, or `undefined` for reactions.
 */
export function messageConversationKey(message: Message, currentUserId: string): string | undefined {
  if (message.type === "channelPost" || message.type === "channelReply") {
    return `channel:${message.channelId}`;
  }

  if (message.type === "dm") {
    const peer = message.authorId === currentUserId ? message.recipientUserId : message.authorId;
    return `dm:${peer}`;
  }

  return undefined;
}
