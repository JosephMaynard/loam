/**
 * Chat-style grouping for a message list: consecutive messages from the same author, close together in
 * time and on the same local day, read as one block (one avatar, one name, tight spacing, one tail), the
 * way WhatsApp, Signal and Telegram draw them. Pure, so the list component stays a thin renderer.
 */
import type { Message } from "@loam/schema";

import { dayKey } from "./dates";

/** Messages further apart than this start a new group even from the same author (5 minutes). */
export const GROUP_WINDOW_MS = 5 * 60 * 1000;

/** One message plus where it sits in its group and whether a day divider goes above it. */
export interface GroupedMessage {
  message: Message;
  /** First message of its group: carries the avatar and author name, and the wider gap above. */
  first: boolean;
  /** Last message of its group: carries the bubble tail and the thread affordance. */
  last: boolean;
  /** The first message of a new local calendar day (a day divider goes above it). */
  newDay: boolean;
}

export interface GroupOptions {
  /** Maximum gap between two messages of one group (default `GROUP_WINDOW_MS`). */
  windowMs?: number;
  /**
   * Messages that must stand alone (never joined to a neighbour), e.g. a blocked author's collapsed
   * placeholder: revealing one must show its own avatar and name rather than borrow a neighbour's.
   */
  isolate?: (message: Message) => boolean;
}

/**
 * Whether `next` continues the group that `previous` belongs to.
 *
 * @param previous - The message directly above.
 * @param next - The message being placed.
 * @param options - Window and isolation rules.
 */
function continuesGroup(previous: Message, next: Message, options: GroupOptions): boolean {
  const windowMs = options.windowMs ?? GROUP_WINDOW_MS;

  if (options.isolate?.(previous) || options.isolate?.(next)) {
    return false;
  }

  return (
    previous.authorId === next.authorId &&
    next.createdAt - previous.createdAt >= 0 &&
    next.createdAt - previous.createdAt <= windowMs &&
    dayKey(previous.createdAt) === dayKey(next.createdAt)
  );
}

/**
 * Annotate an already-sorted list of top-level messages (or one thread's replies) with group
 * boundaries and day breaks.
 *
 * @param messages - Messages in display order (ascending `createdAt`).
 * @param options - Window and isolation rules.
 * @returns One entry per input message, in the same order.
 */
export function groupMessages(messages: readonly Message[], options: GroupOptions = {}): GroupedMessage[] {
  const result: GroupedMessage[] = [];

  messages.forEach((message, index) => {
    const previous = messages[index - 1];
    const next = messages[index + 1];

    result.push({
      message,
      first: !previous || !continuesGroup(previous, message, options),
      last: !next || !continuesGroup(message, next, options),
      newDay: !previous || dayKey(previous.createdAt) !== dayKey(message.createdAt),
    });
  });

  return result;
}
