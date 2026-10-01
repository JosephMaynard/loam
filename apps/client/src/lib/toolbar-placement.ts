/**
 * Where a message's hover toolbar goes (desktop), so it never covers the author's name or the text.
 *
 * In order of preference:
 *  1. **Beside** the bubble's top, on the side away from the avatar (after someone else's message, before
 *     your own), if it fits inside the conversation.
 *  2. **Over** the bubble's top-end corner, as it used to, slid sideways to stay inside the conversation.
 *  3. If that would cover the author's name above the bubble, **lifted above the name** instead.
 *  4. If the list's top edge leaves no room above (the toolbar would be clipped), **under** the bubble's
 *     bottom-end corner; as a last resort, clamped inside the list.
 *
 * Rects are viewport rects (`getBoundingClientRect`); the answer is the toolbar's top-left corner in the
 * same coordinates. Pure, so it's testable without layout.
 */

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A small gap between the toolbar and what it sits next to. */
const GAP = 4;
/** How far the "over" toolbar may overlap the bubble's own top (just its padding, never the first line). */
const OVERLAP = 4;

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function placeToolbar({
  bubble,
  bounds,
  mine,
  name,
  rtl,
  toolbar,
}: {
  bubble: Box;
  /** The area the toolbar must stay inside (the scrolling message list). */
  bounds: Box;
  mine: boolean;
  /** The author's name above the bubble, when shown: the text's own extent, not its full-width row. */
  name?: Box;
  rtl: boolean;
  toolbar: { width: number; height: number };
}): { left: number; top: number } {
  const { width, height } = toolbar;

  // 1. Beside: after the bubble for someone else's message, before it for your own (mirrored in RTL).
  const after = mine === rtl;
  const besideLeft = after ? bubble.right + GAP : bubble.left - GAP - width;
  if (besideLeft >= bounds.left && besideLeft + width <= bounds.right) {
    return { left: besideLeft, top: bubble.top };
  }

  // 2. Over the top-end corner (right in LTR, left in RTL), kept inside the bounds.
  const endLeft = rtl ? bubble.left + GAP : bubble.right - GAP - width;
  const left = clamp(endLeft, bounds.left, bounds.right - width);
  const fitsVertically = (top: number): boolean => top >= bounds.top && top + height <= bounds.bottom;
  const overTop = bubble.top - height + OVERLAP;
  const over: Box = { left, top: overTop, right: left + width, bottom: overTop + height };
  const coversName = !!name && overlaps(over, name);

  if (!coversName && fitsVertically(overTop)) {
    return { left, top: overTop };
  }
  // 3. Not over the name: lift above it (a gap clear, so rounding can't leave them touching)...
  if (coversName) {
    const liftedTop = name!.top - height - GAP;
    if (fitsVertically(liftedTop)) {
      return { left, top: liftedTop };
    }
  }
  // 4. ...and when there's no room above (the list's top edge would clip it), under the bubble's
  // bottom-end corner instead; failing even that, as close as the list allows.
  const underTop = bubble.bottom - OVERLAP;
  if (fitsVertically(underTop)) {
    return { left, top: underTop };
  }
  return { left, top: clamp(overTop, bounds.top, bounds.bottom - height) };
}
