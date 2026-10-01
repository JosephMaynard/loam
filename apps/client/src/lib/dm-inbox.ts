import type { DmInbox, Message, User } from "@loam/schema";

/** One entry of `GET /api/dms`. */
export type DmInboxEntry = DmInbox["conversations"][number];

/**
 * Who belongs under "Direct Messages": the people this user has actually exchanged DMs with — from the
 * server's inbox (covers DMs that arrived while this device was away) and from DMs already held here —
 * plus the DM that's open right now and any assistant bot, so it's always findable. Newest activity first;
 * bots without a conversation go last. Without an inbox (an older node that has no `/api/dms`), everyone
 * is listed, as before.
 *
 * @param users - The roster (the current user is skipped).
 * @param inbox - The server's inbox, or undefined when unavailable.
 * @param messages - Messages held locally.
 * @param activeDmId - The peer of the open DM, if any.
 */
export function dmConversationPeers(
  users: User[],
  currentUserId: string,
  inbox: DmInboxEntry[] | undefined,
  messages: Message[],
  activeDmId?: string,
): User[] {
  const peers = users.filter((user) => user.id !== currentUserId);
  if (!inbox) {
    return peers;
  }

  const lastActivity = new Map<string, number>();
  const bump = (userId: string, at: number): void => {
    lastActivity.set(userId, Math.max(lastActivity.get(userId) ?? Number.NEGATIVE_INFINITY, at));
  };
  for (const entry of inbox) {
    bump(entry.userId, entry.lastMessageAt);
  }
  for (const message of messages) {
    if (message.type !== "dm") {
      continue;
    }
    if (message.authorId === currentUserId) {
      bump(message.recipientUserId, message.createdAt);
    } else if (message.recipientUserId === currentUserId) {
      bump(message.authorId, message.createdAt);
    }
  }
  if (activeDmId && !lastActivity.has(activeDmId)) {
    bump(activeDmId, Number.NEGATIVE_INFINITY);
  }

  const withConversation = peers
    .filter((user) => lastActivity.has(user.id))
    .sort((a, b) => lastActivity.get(b.id)! - lastActivity.get(a.id)!);
  const bots = peers.filter((user) => user.type === "bot" && !lastActivity.has(user.id));
  return [...withConversation, ...bots];
}

/**
 * DM partners whose latest message (per the inbox) is theirs, newer than this user's read marker, and not
 * yet held locally — so no unread count can be shown, but the row should still say "new". The count takes
 * over once the conversation is loaded.
 */
export function inboxUnreadPeers(
  inbox: DmInboxEntry[] | undefined,
  currentUserId: string,
  lastReadByConversation: Record<string, number>,
  unreadByConversation: ReadonlyMap<string, number>,
  blockedUserIds: ReadonlySet<string>,
): Set<string> {
  const peers = new Set<string>();
  for (const entry of inbox ?? []) {
    const key = `dm:${entry.userId}`;
    if (
      entry.lastAuthorId !== currentUserId &&
      !blockedUserIds.has(entry.userId) &&
      entry.lastMessageAt > (lastReadByConversation[key] ?? 0) &&
      !(unreadByConversation.get(key) ?? 0)
    ) {
      peers.add(entry.userId);
    }
  }
  return peers;
}

/**
 * The inbox with one partner's entry rebuilt from that DM's full, authoritative history (what
 * `GET /api/dms/:userId` returns): its newest message, or no entry at all once nothing is left — so a
 * deleted DM can't leave an unread dot behind that opening the conversation can't clear.
 */
export function reconcileInboxEntry(
  inbox: DmInboxEntry[],
  peerId: string,
  history: Message[],
  currentUserId: string,
): DmInboxEntry[] {
  let newest: Message | undefined;
  for (const message of history) {
    if (
      message.type === "dm" &&
      ((message.authorId === peerId && message.recipientUserId === currentUserId) ||
        (message.authorId === currentUserId && message.recipientUserId === peerId)) &&
      (!newest || message.createdAt >= newest.createdAt)
    ) {
      newest = message;
    }
  }
  const others = inbox.filter((entry) => entry.userId !== peerId);
  return newest
    ? [...others, { userId: peerId, lastMessageAt: newest.createdAt, lastAuthorId: newest.authorId }]
    : others;
}
