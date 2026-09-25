/** What Tab can land on inside a modal. */
const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Keep Tab / Shift+Tab cycling inside `dialog` (an `aria-modal` dialog, whose focus must not wander behind
 * it). Call from the dialog's `keydown` handler; any other key is ignored.
 */
export function trapFocus(dialog: HTMLElement | null, event: KeyboardEvent): void {
  if (event.key !== "Tab" || !dialog) {
    return;
  }
  const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => !element.hasAttribute("disabled"),
  );
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
