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
 * whether two codes sit side by side (a screen wider than tall) or stack.
 */
export function displayCodeSize(count: 1 | 2, width: number, height: number): { size: number; sideBySide: boolean } {
  const usableHeight = height - HEADING_HEIGHT - EXIT_HEIGHT - PAD * 2;
  const sideBySide = count === 2 && width > height;
  const perCodeWidth = sideBySide ? (width - PAD * 3) / 2 : width - PAD * 2;
  const perCodeHeight =
    sideBySide || count === 1 ? usableHeight - CODE_CAPTION_HEIGHT : usableHeight / 2 - CODE_CAPTION_HEIGHT;
  return { size: Math.max(MIN_SIZE, Math.floor(Math.min(perCodeWidth, perCodeHeight))), sideBySide };
}
