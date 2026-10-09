/**
 * Message-list ordering helpers. The client keeps its whole message history in one array sorted by
 * `createdAt`; these functions preserve that invariant while merging incoming messages cheaply.
 */
import type { Message } from "@loam/schema";
import { graphemes } from "./graphemes";
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

/** Matches a single Unicode code point tagged `Extended_Pictographic` — the property Unicode uses to
 * mark emoji-capable characters (independent of `Emoji_Presentation`, so text-style pictographs like
 * a bare `#` are excluded while heart/keycap/flag base characters are included). */
const EMOJI_CODE_POINT = /\p{Extended_Pictographic}/u;

/**
 * Whether `body`, trimmed, is nothing but 1 to 3 emoji and no other text — the WhatsApp-style "jumbo
 * emoji" rule (render big, no bubble). Counts by *grapheme cluster* ({@link graphemes}) so a
 * multi-codepoint emoji — a ZWJ sequence like a family emoji, a skin-tone modifier, or a
 * variation-selector pair — counts as a single emoji rather than one per code point. Every
 * non-whitespace cluster must contain an `Extended_Pictographic` code point (checked with
 * {@link EMOJI_CODE_POINT}); a single cluster of plain text (even mixed into an otherwise-emoji
 * body, e.g. `"hi 😀"`) disqualifies the whole message.
 *
 * @param body - The message body to test (untrimmed is fine — leading/trailing whitespace is ignored).
 * @returns `true` when the body is 1-3 emoji and nothing else.
 */
export function isJumboEmoji(body: string): boolean {
  const trimmed = body.trim();

  if (!trimmed) {
    return false;
  }

  let emojiCount = 0;

  for (const segment of graphemes(trimmed)) {
    if (/^\s+$/.test(segment)) {
      continue;
    }

    if (!EMOJI_CODE_POINT.test(segment)) {
      return false;
    }

    emojiCount += 1;

    if (emojiCount > 3) {
      return false;
    }
  }

  return emojiCount >= 1 && emojiCount <= 3;
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

/**
 * Reconcile the cached messages with an authoritative full snapshot of one conversation: prune cached
 * conversation messages (and reactions targeting them) that the server no longer has, then merge the
 * snapshot in. The ONLY guard against pruning a legitimate message is `preFetchIds` — a message sent or
 * received while the request was in flight was not held when it started, so it is never prunable. A
 * message held before the request began and absent from the full snapshot IS a deletion, however new it
 * is. (A "never prune anything newer than the snapshot's newest entry" guard would keep a deleted
 * NEWEST message alive forever.)
 *
 * @param previous - Every cached message (all conversations).
 * @param conversation - The conversation the snapshot covers.
 * @param serverMessages - The server's full snapshot of that conversation.
 * @param preFetchIds - Ids of the messages held when the request started.
 * @param currentUserId - The signed-in user's id (used to resolve DM direction).
 * @returns The merged, ordered message list and the ids pruned from it.
 */
export function reconcileConversationSnapshot(
  previous: Message[],
  conversation: Conversation,
  serverMessages: Message[],
  preFetchIds: Set<string>,
  currentUserId: string,
  liveChanges: LiveChanges = NO_LIVE_CHANGES,
): { messages: Message[]; prunedIds: string[]; applied: Message[] } {
  const serverIds = new Set(serverMessages.map((message) => message.id));
  const conversationIds = new Set(
    previous
      .filter((message) => isConversationMessage(message, conversation, currentUserId))
      .map((message) => message.id),
  );
  const prunedIds: string[] = [];
  const next = new Map<string, Message>();

  for (const message of previous) {
    const inConversation =
      isConversationMessage(message, conversation, currentUserId) ||
      (message.type === "reaction" && conversationIds.has(message.targetMessageId));

    if (inConversation && !serverIds.has(message.id) && preFetchIds.has(message.id)) {
      prunedIds.push(message.id);
      continue;
    }

    next.set(message.id, message);
  }

  // The snapshot was taken when the request was served; a live `messageDeleted`/`messageUpdated` that
  // arrived while it was in flight is NEWER than it. Never resurrect a
  // message deleted since the fetch began, and keep a live edit/stream update over the snapshot's copy
  // unless the snapshot carries a strictly newer edit.
  const applied: Message[] = [];
  for (const message of serverMessages) {
    if (liveChanges.deletedIds.has(message.id)) {
      continue;
    }
    const local = next.get(message.id);
    if (local && liveChanges.updatedIds.has(message.id) && editedAtOf(message) <= editedAtOf(local)) {
      continue;
    }
    next.set(message.id, message);
    applied.push(message);
  }

  return { messages: Array.from(next.values()).sort(compareCreatedAt), prunedIds, applied };
}

/** A message's last-edit time (0 when never edited, or for arms that can't be edited). */
function editedAtOf(message: Message): number {
  return "editedAt" in message && typeof message.editedAt === "number" ? message.editedAt : 0;
}

/** Ids a live event deleted or updated since a given `LiveChangeJournal.mark()`. */
export type LiveChanges = { deletedIds: ReadonlySet<string>; updatedIds: ReadonlySet<string> };

const NO_LIVE_CHANGES: LiveChanges = { deletedIds: new Set(), updatedIds: new Set() };

/**
 * Remembers which message ids live socket events deleted or updated, so a conversation-history snapshot
 * that was requested BEFORE those events (and so predates them) can't undo them when it lands. A fetch
 * takes a `mark()` when it starts and asks `since(mark)` when it reconciles. Entries older than
 * `retentionMs` are dropped — far longer than any request can be in flight (10s timeout).
 */
export class LiveChangeJournal {
  private seq = 0;
  private readonly deleted = new Map<string, { seq: number; at: number }>();
  private readonly updated = new Map<string, { seq: number; at: number }>();

  private readonly retentionMs: number;
  private readonly now: () => number;

  constructor(retentionMs = 60_000, now: () => number = () => Date.now()) {
    this.retentionMs = retentionMs;
    this.now = now;
  }

  /** A position to compare later changes against (call when a fetch starts). */
  mark(): number {
    return this.seq;
  }

  recordDeleted(id: string): void {
    this.record(this.deleted, id);
  }

  recordUpdated(id: string): void {
    this.record(this.updated, id);
  }

  /** The ids deleted / updated after `mark`. */
  since(mark: number): LiveChanges {
    const pick = (map: Map<string, { seq: number }>): Set<string> =>
      new Set([...map].filter(([, entry]) => entry.seq > mark).map(([id]) => id));
    return { deletedIds: pick(this.deleted), updatedIds: pick(this.updated) };
  }

  private record(map: Map<string, { seq: number; at: number }>, id: string): void {
    this.seq += 1;
    const now = this.now();
    // Re-insert so iteration order stays oldest-first, which lets the prune stop at the first fresh entry.
    map.delete(id);
    map.set(id, { seq: this.seq, at: now });
    for (const target of [this.deleted, this.updated]) {
      for (const [key, entry] of target) {
        if (now - entry.at <= this.retentionMs) {
          break;
        }
        target.delete(key);
      }
    }
  }
}

/**
 * The newest `createdAt` among a conversation's messages (reactions excluded — they never count as
 * unread) — the conversation's read marker once it has been on screen. Server-assigned timestamps, so
 * unlike the client's own clock it compares correctly with the `createdAt` of later messages (a
 * `Date.now()` marker from a clock running ahead would hide genuinely new messages).
 */
export function newestMessageTimestamp(messages: Message[]): number | undefined {
  let newest: number | undefined;
  for (const message of messages) {
    if (message.type !== "reaction" && (newest === undefined || message.createdAt > newest)) {
      newest = message.createdAt;
    }
  }
  return newest;
}

/**
 * Unread (non-own) posts/replies/DMs per conversation key: those created after the conversation's read
 * marker (see `newestMessageTimestamp`). Reactions never count.
 */
export function countUnreadByConversation(
  messages: Message[],
  lastReadByConversation: Record<string, number>,
  currentUserId: string,
): Map<string, number> {
  const counts = new Map<string, number>();

  for (const message of messages) {
    if (message.authorId === currentUserId) {
      continue;
    }

    const key = messageConversationKey(message, currentUserId);

    if (key && message.createdAt > (lastReadByConversation[key] ?? 0)) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  return counts;
}

/**
 * How many posts/replies (or DMs) of one conversation the on-disk cache keeps: the newest this many, plus
 * the root post of every kept reply (see `messageCacheOverflow`). Older ones stay available from the node; a
 * device that never reloads a 20 000-message channel into IndexedDB boots faster and leaves less behind.
 */
export const MESSAGE_CACHE_LIMIT_PER_CONVERSATION = 500;

/**
 * The ids the on-disk cache must NOT hold: for every conversation, everything but its newest `limit`
 * posts/replies/DMs, plus the reactions targeting those (a reaction has no conversation of its own and would
 * otherwise outlive its target). The in-memory history is left alone; this only decides what is written to
 * and kept in IndexedDB.
 *
 * Threads are kept whole from the top: a root post whose reply is kept is kept too, however old the root is,
 * so a busy thread may push a conversation a few messages over the cap. The conversation view reaches a reply
 * only through its root (`topLevelMessages` + `groupRepliesByParent`), so a cached reply without its root
 * would be an unreachable orphan on disk. The rule runs the other way as well: a root is evicted once every
 * reply under it is, and its reactions go with it like any evicted message's. Replies are one level deep (the
 * node refuses a reply to a reply), so a kept reply protects exactly its root.
 *
 * @param messages - The whole in-memory history (any order).
 * @param currentUserId - The signed-in user's id (resolves which DM a message belongs to).
 * @param limit - Messages kept per conversation.
 * @returns The ids past the cap.
 */
export function messageCacheOverflow(
  messages: Message[],
  currentUserId: string,
  limit = MESSAGE_CACHE_LIMIT_PER_CONVERSATION,
): Set<string> {
  const byConversation = new Map<string, Message[]>();

  for (const message of messages) {
    const key = messageConversationKey(message, currentUserId);

    if (key === undefined) {
      continue;
    }

    const bucket = byConversation.get(key);

    if (bucket) {
      bucket.push(message);
    } else {
      byConversation.set(key, [message]);
    }
  }

  const overflow = new Set<string>();

  for (const bucket of byConversation.values()) {
    if (bucket.length <= limit) {
      continue;
    }

    // Oldest first, so the ones to drop are at the front. The history is normally already in this order.
    bucket.sort(compareCreatedAt);

    for (let index = 0; index < bucket.length - limit; index += 1) {
      overflow.add(bucket[index]!.id);
    }
  }

  if (overflow.size === 0) {
    return overflow;
  }

  // A kept reply keeps its root. Roots are posts, never replies, so taking one out of the overflow changes no
  // reply's verdict and a single pass is exact.
  for (const message of messages) {
    if (message.type === "channelReply" && !overflow.has(message.id)) {
      overflow.delete(message.parentMessageId);
    }
  }

  for (const message of messages) {
    if (message.type === "reaction" && overflow.has(message.targetMessageId)) {
      overflow.add(message.id);
    }
  }

  return overflow;
}

/**
 * Cached messages whose conversation the node no longer lists for this user: posts/replies in a channel
 * absent from `/api/channels` (deleted, or access revoked while this device was away) and DMs with a partner
 * absent from `/api/dms` (every message of that conversation is gone from the node), plus the reactions
 * targeting any of them. Either list may be `undefined` while it is unknown (the inbox has not answered, or
 * an older node has none): that kind of conversation is then left alone.
 *
 * @param messages - The in-memory history.
 * @param channelIds - The channel ids the node returned, or `undefined` when unknown.
 * @param dmPeerIds - The DM partners the node's inbox returned, or `undefined` when unknown.
 * @param currentUserId - The signed-in user's id (resolves the DM partner).
 * @returns The ids to drop.
 */
export function staleConversationMessageIds(
  messages: Message[],
  channelIds: ReadonlySet<string> | undefined,
  dmPeerIds: ReadonlySet<string> | undefined,
  currentUserId: string,
): Set<string> {
  const stale = new Set<string>();

  for (const message of messages) {
    if (message.type === "channelPost" || message.type === "channelReply") {
      if (channelIds && !channelIds.has(message.channelId)) {
        stale.add(message.id);
      }
    } else if (message.type === "dm" && dmPeerIds) {
      const peer = message.authorId === currentUserId ? message.recipientUserId : message.authorId;

      if (!dmPeerIds.has(peer)) {
        stale.add(message.id);
      }
    }
  }

  if (stale.size) {
    for (const message of messages) {
      if (message.type === "reaction" && stale.has(message.targetMessageId)) {
        stale.add(message.id);
      }
    }
  }

  return stale;
}
