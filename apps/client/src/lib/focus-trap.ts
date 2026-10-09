/** What Tab can land on inside a modal. */
const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Whether `element` (or an ancestor up to `boundary`) is hidden from the tab order: the `hidden` attribute,
 * `display: none` or `visibility: hidden`. A browser skips these on a real Tab, so the trap must skip them too,
 * or it would "wrap" focus onto a control nobody can see (a collapsed section, a panel the CSS hides at this
 * width). `offsetParent` is not used: it is unreliable for fixed-position panels and absent in test DOMs.
 */
function isHiddenWithin(element: HTMLElement, boundary: HTMLElement): boolean {
  let node: HTMLElement | null = element;
  while (node && node !== boundary) {
    if (node.hidden) {
      return true;
    }
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") {
      return true;
    }
    node = node.parentElement;
  }
  return false;
}

/** The elements inside `dialog` a Tab press can reach, in document order. */
export function tabbableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => !element.hasAttribute("disabled") && !isHiddenWithin(element, dialog),
  );
}

/**
 * Keep Tab / Shift+Tab cycling inside `dialog` (an `aria-modal` dialog, whose focus must not wander behind
 * it). Call from the dialog's `keydown` handler; any other key is ignored.
 */
export function trapFocus(dialog: HTMLElement | null, event: KeyboardEvent): void {
  if (event.key !== "Tab" || !dialog) {
    return;
  }
  const focusable = tabbableElements(dialog);
  if (!focusable.length) {
    event.preventDefault();
    return;
  }
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === dialog)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}
