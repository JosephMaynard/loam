/**
 * Shrink a wrapped text bubble to its widest line.
 *
 * CSS can't shrink-wrap wrapped text: once a message wraps, its bubble takes the whole available width
 * even when every line is much shorter, leaving a band of empty bubble at the end of each line. This
 * measures the laid-out lines (a Range's client rects) and sets the bubble's width to the widest — counting
 * the inline time stamp that sits at the end of the last line (`.message-stamp`, whose space the
 * `::after` spacer reserves) — so the lines break exactly as before, just without the empty band.
 *
 * One shared ResizeObserver re-fits every tracked bubble when its column changes width (window resize, the
 * thread panel opening), since the natural line breaks change with it.
 */

/** px the reserved stamp space adds before the time (`padding-inline-start` of the `::after` spacer). */
const STAMP_GAP = 10;

/** Re-fit `bubble` now: clear any width it was given, measure its lines, narrow it if they leave slack. */
export function fitBubble(bubble: HTMLElement): void {
  bubble.style.width = "";
  const content = bubble.querySelector<HTMLElement>(":scope > .markdown-body, :scope > .message-removed");
  if (!content) {
    return;
  }

  const range = bubble.ownerDocument.createRange();
  range.selectNodeContents(content);
  const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
  if (!rects.length) {
    return;
  }
  // A single line is already as narrow as it can be.
  const tops = new Set(rects.map((rect) => Math.round(rect.top)));
  if (tops.size < 2) {
    return;
  }

  const rtl = getComputedStyle(bubble).direction === "rtl";
  const box = content.getBoundingClientRect();
  const stamp = bubble.querySelector<HTMLElement>(":scope > .message-stamp");
  const stampWidth = stamp ? stamp.getBoundingClientRect().width + STAMP_GAP : 0;
  const lastBottom = Math.max(...rects.map((rect) => rect.bottom));
  const lastLine = rects.filter((rect) => rect.bottom > lastBottom - 1);

  // How far the furthest line (including the time on the last one) reaches from the content's start edge.
  const reach = rtl
    ? Math.max(
        ...rects.map((rect) => box.right - rect.left),
        Math.max(...lastLine.map((rect) => box.right - rect.left)) + stampWidth,
      )
    : Math.max(
        ...rects.map((rect) => rect.right - box.left),
        Math.max(...lastLine.map((rect) => rect.right - box.left)) + stampWidth,
      );
  const slack = box.width - reach;
  if (slack > 2) {
    // +1 px of headroom so sub-pixel rounding never re-wraps a line.
    bubble.style.width = `${Math.ceil(bubble.getBoundingClientRect().width - slack) + 1}px`;
  }
}

const fitters = new Map<Element, Set<HTMLElement>>();
let observer: ResizeObserver | undefined;

/**
 * Keep `bubble` fitted: fit it now, and again whenever the element it sits in (`column`) changes width.
 * Returns a function that stops tracking it and releases its width. A no-op without ResizeObserver.
 */
export function trackBubbleFit(bubble: HTMLElement, column: Element): () => void {
  if (typeof ResizeObserver === "undefined") {
    return () => undefined;
  }
  observer ??= new ResizeObserver((entries) => {
    for (const entry of entries) {
      for (const tracked of fitters.get(entry.target) ?? []) {
        fitBubble(tracked);
      }
    }
  });

  let bubbles = fitters.get(column);
  if (!bubbles) {
    bubbles = new Set();
    fitters.set(column, bubbles);
    observer.observe(column);
  }
  bubbles.add(bubble);
  fitBubble(bubble);

  return () => {
    bubble.style.width = "";
    const set = fitters.get(column);
    set?.delete(bubble);
    if (set && !set.size) {
      fitters.delete(column);
      observer?.unobserve(column);
    }
  };
}
