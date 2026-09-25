/**
 * The signed-in user's block list (docs/30 B3). The server owns it and refuses DMs across a block; the
 * client uses its copy to hide a blocked person's channel posts, replies, reactions, typing and toasts.
 *
 * The copy is also cached in IndexedDB (the `sync` store, tagged with the identity it belongs to), so a cold
 * or offline boot hides blocked authors' cached posts from the first render instead of showing them — and
 * counting them unread — until the fetch lands (pre-release review 2026-09-25). A wipe deletes the database
 * and an identity change clears every store, so the cache never outlives the identity it belongs to.
 */
import { UserBlockListSchema, type Message } from "@loam/schema";

import { fetchJson, requestJson } from "./api";
import { putRecord } from "./local-store";

/** The `sync`-store record the block list is cached under. */
export const BLOCK_LIST_RECORD_ID = "blockList";

/** The cached block list: whose it is, and who they blocked. */
interface CachedBlockList {
  id: typeof BLOCK_LIST_RECORD_ID;
  userId: string;
  blockedUserIds: string[];
}

/**
 * The cached block list among the hydrated `sync` records, if it belongs to `userId` (the identity the
 * server last confirmed). Anything else — no record, another identity's, a malformed one — reads as
 * "nothing cached".
 */
export function cachedBlockListFor(records: readonly { id: string }[], userId: string | undefined): ReadonlySet<string> | undefined {
  const record = records.find((entry) => entry.id === BLOCK_LIST_RECORD_ID) as Partial<CachedBlockList> | undefined;
  if (!record || userId === undefined || record.userId !== userId || !Array.isArray(record.blockedUserIds)) {
    return undefined;
  }
  return new Set(record.blockedUserIds.filter((id): id is string => typeof id === "string"));
}

/** Cache `userId`'s block list (best effort — a failed write just means the next cold boot waits for the
 * fetch, as before). */
export async function persistBlockList(userId: string, blockedUserIds: ReadonlySet<string>): Promise<void> {
  const record: CachedBlockList = { id: BLOCK_LIST_RECORD_ID, userId, blockedUserIds: [...blockedUserIds] };
  await putRecord("sync", record).catch(() => undefined);
}

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
