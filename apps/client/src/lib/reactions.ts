/**
 * The reactions a message offers, and the "any emoji" pick.
 *
 * There is no web API to open the device's emoji picker, so "any emoji" is a small text field: the user
 * opens their keyboard's emoji tab (or the desktop shortcut) and picks one, and {@link firstEmoji} takes it.
 * The server accepts only a single emoji (`isReactionEmoji` in `@loam/schema`). The last few picks are
 * remembered on this device so a favourite is one tap afterwards; they are cleared by a wipe and by an
 * identity change, like the other per-user leftovers in localStorage.
 */
import { isReactionEmoji } from "@loam/schema";

import { graphemes } from "./graphemes";

/** One-tap reactions on the desktop hover toolbar. */
export const QUICK_REACTIONS = ["👍", "👎", "❤️", "😂", "✅"];

/** The touch sheet's grid: three rows of five, rendered in this order. */
export const SHEET_REACTIONS = [
  "👍", "👎", "❤️", "🙏", "🤞",
  "😂", "😊", "😮", "😢", "😩",
  "😠", "😐", "🤔", "🎉", "✅",
];

export const RECENT_REACTIONS_KEY = "loam.recentReactions";

/** How many picks are remembered: with the "+" tile they fill one more row of the grid. */
export const MAX_RECENT_REACTIONS = 4;

/**
 * The first emoji in `text`, or `undefined` when it holds none. Walks grapheme clusters, so a skin-tone,
 * flag or ZWJ sequence comes back whole; anything typed before the emoji is skipped.
 *
 * @param text - What the user put in the emoji field.
 */
export function firstEmoji(text: string): string | undefined {
  return graphemes(text).find((segment) => isReactionEmoji(segment));
}

/** The remembered picks, newest first: never one already in the sheet, never anything but an emoji. */
export function readRecentReactions(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_REACTIONS_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed
          .filter((value): value is string => typeof value === "string" && isReactionEmoji(value))
          .filter((value) => !SHEET_REACTIONS.includes(value))
          .slice(0, MAX_RECENT_REACTIONS)
      : [];
  } catch {
    return [];
  }
}

/**
 * Remember a pick from the emoji field (moved to the front if already there). One already in the sheet
 * isn't stored. Best-effort: blocked storage just won't remember it.
 *
 * @param emoji - The reaction just sent.
 * @returns The updated list, newest first.
 */
export function rememberReaction(emoji: string): string[] {
  const current = readRecentReactions();

  if (SHEET_REACTIONS.includes(emoji) || !isReactionEmoji(emoji)) {
    return current;
  }

  const next = [emoji, ...current.filter((value) => value !== emoji)].slice(0, MAX_RECENT_REACTIONS);
  try {
    localStorage.setItem(RECENT_REACTIONS_KEY, JSON.stringify(next));
  } catch {
    // Nothing to do: the pick just isn't remembered.
  }
  return next;
}

/** Forget the remembered picks (wipe, identity change). */
export function clearRecentReactions(): void {
  try {
    localStorage.removeItem(RECENT_REACTIONS_KEY);
  } catch {
    // Nothing durable to clear.
  }
}
