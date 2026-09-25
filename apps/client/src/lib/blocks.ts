/**
 * The signed-in user's block list (docs/30 B3). The server owns it and refuses DMs across a block; the
 * client keeps a copy IN MEMORY ONLY (never IndexedDB, so a wipe or identity change has nothing on disk to
 * purge) and uses it to hide a blocked person's channel posts, replies, reactions, typing and toasts.
 */
import { UserBlockListSchema, type Message } from "@loam/schema";

import { fetchJson, requestJson } from "./api";

/** Parse a block-list response into a set of ids (an unrecognisable payload reads as "no blocks"). */
export function parseBlockList(payload: unknown): ReadonlySet<string> {
  const parsed = UserBlockListSchema.safeParse(payload);
  return new Set(parsed.success ? parsed.data.blockedUserIds : []);
}

/** `GET /api/users/me/blocks`. */
export async function fetchBlockList(): Promise<ReadonlySet<string>> {
  return parseBlockList(await fetchJson<unknown>("/api/users/me/blocks"));
}

/** Block (`PUT`) or unblock (`DELETE`) `userId`; resolves to the server's updated list. */
export async function setUserBlocked(userId: string, blocked: boolean): Promise<ReadonlySet<string>> {
  const payload = await requestJson<unknown>(
    blocked ? "PUT" : "DELETE",
    `/api/users/me/blocks/${encodeURIComponent(userId)}`,
  );
  return parseBlockList(payload);
}

/**
 * Drop reactions authored by blocked users. Their posts and replies stay in the list (rendered as a
 * collapsed "blocked user" placeholder); a reaction has no body to collapse, so it just doesn't count.
 * Returns the same array when nothing is blocked, so memoised consumers don't recompute.
 */
export function withoutBlockedReactions(messages: Message[], blockedUserIds: ReadonlySet<string>): Message[] {
  if (!blockedUserIds.size) {
    return messages;
  }
  return messages.filter((message) => message.type !== "reaction" || !blockedUserIds.has(message.authorId));
}

/**
 * Messages that should still raise attention (unread badges, toasts): everything except content from a
 * blocked user. Returns the same array when nothing is blocked.
 */
export function withoutBlockedAuthors(messages: Message[], blockedUserIds: ReadonlySet<string>): Message[] {
  if (!blockedUserIds.size) {
    return messages;
  }
  return messages.filter((message) => !blockedUserIds.has(message.authorId));
}
