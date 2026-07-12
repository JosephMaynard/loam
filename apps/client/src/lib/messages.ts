/**
 * Message-list ordering helpers. The client keeps its whole message history in one array sorted by
 * `createdAt`; these functions preserve that invariant while merging incoming messages cheaply.
 */
import type { Message } from "@loam/schema";

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
