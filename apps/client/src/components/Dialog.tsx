import type { ComponentChildren } from "preact";
import { useId, useLayoutEffect, useRef, useState } from "preact/hooks";

import { t } from "../i18n";
import { trapFocus } from "../lib/focus-trap";
import { IconClose } from "./icons";

/**
 * Open dialogs, innermost last. Escape and the focus trap act only on the top one, so a menu sheet opened
 * from inside a dialog closes on its own without taking its parent with it.
 */
const openStack: HTMLElement[] = [];

/**
 * Add a dialog's panel to the stack. A dialog normally opens after (so above) the ones already open, but a
 * parent and a nested child that mount in the same commit run their effects child-first, so a panel that
 * CONTAINS an already-registered one goes beneath it.
 */
function pushDialog(panel: HTMLElement): void {
  const nestedIndex = openStack.findIndex((other) => panel.contains(other));
  if (nestedIndex >= 0) {
    openStack.splice(nestedIndex, 0, panel);
  } else {
    openStack.push(panel);
  }
}

/** How far (px) a sheet must be dragged down by its handle before letting go closes it. */
const SHEET_DISMISS_DRAG_PX = 80;

export interface DialogProps {
  /** Called on Escape, a backdrop tap, the close button, or a sheet dragged down. */
  onClose: () => void;
  /** The dialog's heading (rendered as its `h2` and used as its accessible name). */
  title: ComponentChildren;
  /** Keep the heading for screen readers only (e.g. a menu sheet whose rows speak for themselves). */
  hideTitle?: boolean;
  /**
   * `sheet` slides up from the bottom on every screen, `dialog` is always a centred card, and `auto` (the
   * default) is a sheet on phones (< 720px) and a centred card from tablet width up.
   */
  variant?: "sheet" | "dialog" | "auto";
  /** Extra class on the panel (the element with `role="dialog"`). */
  className?: string;
  /** Extra class on the backdrop. */
  backdropClassName?: string;
  /** Show the × button in the header (default true). */
  showClose?: boolean;
  /** Accessible name for the × button (default "Dismiss"). */
  closeLabel?: string;
  /** `alertdialog` for confirmations that interrupt; `dialog` otherwise. */
  role?: "dialog" | "alertdialog";
  /** Id for the heading, when a caller needs to reference it; generated otherwise. */
  titleId?: string;
  children: ComponentChildren;
}

/**
 * LOAM's modal primitive. Accessible by construction: `role="dialog"` + `aria-modal`, labelled by its
 * heading, focus moves to the panel on open, Tab cycles inside it (`lib/focus-trap`), Escape and a backdrop
 * tap close it, and focus returns to whatever had it before (usually the trigger) when it closes.
 *
 * The same markup renders as a bottom sheet (drag handle, safe-area padding, slides up) or a centred card;
 * `variant` picks which, and the switch for `auto` is pure CSS, so it follows rotation without re-rendering.
 * Render it conditionally: mounted = open.
 */
export function Dialog({
  backdropClassName,
  children,
  className,
  closeLabel,
  hideTitle = false,
  onClose,
  role = "dialog",
  showClose = true,
  title,
  titleId,
  variant = "auto",
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const generatedId = useId();
  const headingId = titleId ?? `dialog-title-${generatedId}`;
  // Latest onClose without re-running the open/close effect when a parent passes a fresh closure.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Captured during the first render, before any child can move focus on mount, so it is the trigger.
  const [previouslyFocused] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) {
      return;
    }
    pushDialog(panel);
    // Focus the panel so its heading is announced, unless a child already took focus on mount (a menu
    // sheet focuses its first item; child layout effects run before this one).
    if (!panel.contains(document.activeElement)) {
      panel.focus();
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (openStack[openStack.length - 1] !== panel) {
        return;
      }
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
      } else if (event.key === "Tab") {
        trapFocus(panel, event);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      const index = openStack.indexOf(panel);
      if (index >= 0) {
        openStack.splice(index, 1);
      }
      // Hand focus back to the trigger, unless it has left the page meanwhile.
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, []);

  const dragHandlers = useSheetDrag(panelRef, () => onCloseRef.current());
  const backdropClasses = ["dialog-backdrop", `is-${variant}`, backdropClassName].filter(Boolean).join(" ");
  const panelClasses = ["dialog", className].filter(Boolean).join(" ");

  return (
    <div
      className={backdropClasses}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        aria-labelledby={headingId}
        aria-modal="true"
        className={panelClasses}
        ref={panelRef}
        role={role}
        tabIndex={-1}
      >
        {variant !== "dialog" ? <div aria-hidden="true" className="dialog-handle" {...dragHandlers} /> : null}
        <div className={hideTitle ? "dialog-header sr-only" : "dialog-header"}>
          <h2 className="dialog-title" id={headingId}>
            {title}
          </h2>
          {showClose && !hideTitle ? (
            <button
              aria-label={closeLabel ?? t("common.dismiss")}
              className="btn btn-icon btn-ghost dialog-close close-button"
              onClick={onClose}
              type="button"
            >
              <IconClose />
            </button>
          ) : null}
        </div>
        <div className="dialog-body">{children}</div>
      </div>
    </div>
  );
}

/**
 * Drag-to-dismiss for the sheet's handle: follow the pointer downwards, close past a threshold, spring
 * back otherwise. Pointer events only (no touch/mouse split); a no-op in the centred-card layout, where the
 * handle is hidden by CSS.
 */
function useSheetDrag(panelRef: { current: HTMLDivElement | null }, close: () => void) {
  const startY = useRef<number | undefined>(undefined);
  const offset = useRef(0);

  function setOffset(value: number): void {
    offset.current = value;
    const panel = panelRef.current;
    if (panel) {
      panel.style.transform = value ? `translateY(${value}px)` : "";
    }
  }

  return {
    onPointerDown(event: PointerEvent): void {
      startY.current = event.clientY;
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    },
    onPointerMove(event: PointerEvent): void {
      if (startY.current !== undefined) {
        setOffset(Math.max(0, event.clientY - startY.current));
      }
    },
    onPointerUp(): void {
      const dragged = offset.current;
      startY.current = undefined;
      setOffset(0);
      if (dragged > SHEET_DISMISS_DRAG_PX) {
        close();
      }
    },
    onPointerCancel(): void {
      startY.current = undefined;
      setOffset(0);
    },
  };
}
