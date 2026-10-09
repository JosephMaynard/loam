/**
 * Display mode's layout maths (src/components/display-mode.tsx), kept free of React Native so it's
 * testable: how big each join code can be so every code, its caption, the heading and the exit control
 * fit on one screen with no scrolling.
 */

/** Room each code needs besides the code itself: its step title and the text under it. */
export const CODE_CAPTION_HEIGHT = 84;
/** The heading (the network's name). */
export const HEADING_HEIGHT = 56;
/** The press-and-hold exit control. */
export const EXIT_HEIGHT = 72;
/** Side padding (Spacing.four). */
const PAD = 24;
/** Never smaller than this: a phone camera needs a reasonably sized code. */
const MIN_SIZE = 120;

/**
 * The code size for `count` codes on a `width` × `height` screen (safe-area insets already removed), and
 * whether two codes sit side by side or stack: whichever leaves them larger, so a landscape screen and a
 * squarish laptop window (where stacking would overflow) get a row, and a portrait phone a column.
 */
export function displayCodeSize(count: 1 | 2, width: number, height: number): { size: number; sideBySide: boolean } {
  const usableHeight = height - HEADING_HEIGHT - EXIT_HEIGHT - PAD * 2;
  const stacked = Math.min(width - PAD * 2, (count === 1 ? usableHeight : usableHeight / 2) - CODE_CAPTION_HEIGHT);
  if (count === 1) {
    return { size: Math.max(MIN_SIZE, Math.floor(stacked)), sideBySide: false };
  }
  const row = Math.min((width - PAD * 3) / 2, usableHeight - CODE_CAPTION_HEIGHT);
  const sideBySide = row > stacked;
  return { size: Math.max(MIN_SIZE, Math.floor(sideBySide ? row : stacked)), sideBySide };
}
