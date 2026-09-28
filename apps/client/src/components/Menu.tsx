import type { ComponentChildren } from "preact";
import { useId, useLayoutEffect, useRef, useState } from "preact/hooks";

import { Dialog } from "./Dialog";
import { IconMore } from "./icons";

/** The breakpoint below which a menu opens as a bottom sheet (matches `--bp-tablet` in DESIGN.md). */
const SHEET_QUERY = "(max-width: 719.98px)";

export interface MenuItem {
  label: string;
  icon?: ComponentChildren;
  onSelect: () => void;
  /** Destructive action: shown in the danger colour. */
  danger?: boolean;
  disabled?: boolean;
}

export interface MenuProps {
  items: MenuItem[];
  /** Accessible name of the trigger button (and the sheet's heading on phones), e.g. "More actions". */
  label: string;
  /** Trigger content; defaults to the vertical kebab icon. */
  trigger?: ComponentChildren;
  /** Extra class on the trigger button (it is always `.btn.btn-icon.btn-ghost.menu-trigger`). */
  triggerClassName?: string;
  /** Force a layout; by default phones get a sheet and wider screens a popover. */
  presentation?: "auto" | "sheet" | "popover";
}

/** Whether this screen should get the bottom-sheet presentation. */
function prefersSheet(presentation: MenuProps["presentation"]): boolean {
  if (presentation === "sheet" || presentation === "popover") {
    return presentation === "sheet";
  }
  return typeof window !== "undefined" && !!window.matchMedia?.(SHEET_QUERY).matches;
}

/**
 * An overflow ("kebab") menu: a trigger button that opens a `role="menu"` list of actions.
 *
 * On phones the list opens in a bottom sheet (`Dialog`) with large rows; on wider screens it is a popover
 * anchored under the trigger (fixed-positioned, so a scrolling ancestor can't clip it, and flipped above the
 * trigger when there's no room below). Keyboard: Enter/Space/ArrowDown open it on the first item, arrows
 * and Home/End move, Escape closes and returns focus to the trigger, Tab closes. A tap outside closes it.
 * Choosing an item closes the menu first, then runs `onSelect`, so an action that opens its own dialog
 * gets focus handed over cleanly.
 */
export function Menu({ items, label, presentation = "auto", trigger, triggerClassName }: MenuProps) {
  const [open, setOpen] = useState<false | "sheet" | "popover">(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = `menu-${useId()}`;

  function openMenu(): void {
    setOpen(prefersSheet(presentation) ? "sheet" : "popover");
  }

  function close(returnFocus: boolean): void {
    setOpen(false);
    if (returnFocus) {
      triggerRef.current?.focus();
    }
  }

  function select(item: MenuItem): void {
    if (item.disabled) {
      return;
    }
    close(true);
    item.onSelect();
  }

  const triggerClasses = ["btn", "btn-icon", "btn-ghost", "menu-trigger", triggerClassName].filter(Boolean).join(" ");

  return (
    <>
      <button
        aria-controls={open ? menuId : undefined}
        aria-expanded={open ? "true" : "false"}
        aria-haspopup="menu"
        aria-label={label}
        className={triggerClasses}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            openMenu();
          }
        }}
        ref={triggerRef}
        title={label}
        type="button"
      >
        {trigger ?? <IconMore />}
      </button>
      {open === "sheet" ? (
        // The Dialog restores focus to the trigger itself when it unmounts.
        <Dialog
          className="menu-sheet"
          hideTitle
          onClose={() => setOpen(false)}
          returnFocusTo={triggerRef}
          title={label}
          variant="sheet"
        >
          <MenuList id={menuId} items={items} label={label} onClose={() => setOpen(false)} onSelect={select} />
        </Dialog>
      ) : open === "popover" ? (
        <MenuPopover
          anchor={triggerRef.current}
          id={menuId}
          items={items}
          label={label}
          onClose={close}
          onSelect={select}
        />
      ) : null}
    </>
  );
}

interface MenuListProps {
  id: string;
  items: MenuItem[];
  label: string;
  onClose: (returnFocus: boolean) => void;
  onSelect: (item: MenuItem) => void;
  className?: string;
  style?: Record<string, string>;
  listRef?: { current: HTMLDivElement | null };
}

/**
 * The `role="menu"` list itself, shared by both presentations. Focus moves to the first enabled item on
 * mount (roving: only the focused item is in the Tab order).
 */
function MenuList({ className, id, items, label, listRef, onClose, onSelect, style }: MenuListProps) {
  const ownRef = useRef<HTMLDivElement>(null);
  const ref = listRef ?? ownRef;

  useLayoutEffect(() => {
    enabledItems(ref.current)[0]?.focus();
  }, []);

  function onKeyDown(event: KeyboardEvent): void {
    const buttons = enabledItems(ref.current);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | undefined;
    if (event.key === "ArrowDown") {
      next = index < 0 ? 0 : (index + 1) % buttons.length;
    } else if (event.key === "ArrowUp") {
      next = index <= 0 ? buttons.length - 1 : index - 1;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = buttons.length - 1;
    } else if (event.key === "Tab") {
      onClose(false);
      return;
    } else if (event.key === "Escape") {
      // Stop here so a Dialog underneath (or the sheet's own Dialog) doesn't also act on it.
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
      return;
    }
    if (next !== undefined && buttons[next]) {
      event.preventDefault();
      buttons[next].focus();
    }
  }

  return (
    <div
      aria-label={label}
      aria-orientation="vertical"
      className={["menu", className].filter(Boolean).join(" ")}
      id={id}
      onKeyDown={onKeyDown}
      ref={ref}
      role="menu"
      style={style}
    >
      {items.map((item) => (
        <button
          aria-disabled={item.disabled ? "true" : undefined}
          className={item.danger ? "menu-item is-danger" : "menu-item"}
          disabled={item.disabled}
          key={item.label}
          onClick={() => onSelect(item)}
          role="menuitem"
          tabIndex={-1}
          type="button"
        >
          {item.icon ? <span className="menu-item-icon">{item.icon}</span> : null}
          <span className="menu-item-label">{item.label}</span>
        </button>
      ))}
    </div>
  );
}

/** The enabled menu items inside a menu element, in order. */
function enabledItems(menu: HTMLElement | null): HTMLButtonElement[] {
  return menu
    ? Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).filter((item) => !item.disabled)
    : [];
}

/**
 * The desktop presentation: the menu list fixed-positioned against the trigger's on-screen rectangle
 * (below it, aligned to its inline-end edge; above it if it would run off the bottom). Closes on an
 * outside pointer press, a scroll, or a resize — the anchor has moved, so the position is stale.
 */
function MenuPopover({
  anchor,
  id,
  items,
  label,
  onClose,
  onSelect,
}: Omit<MenuListProps, "style" | "listRef" | "className"> & { anchor: HTMLElement | null }) {
  const listRef = useRef<HTMLDivElement>(null);
  // Transparent (not `visibility: hidden`, which would make the items unfocusable) until measured.
  const [style, setStyle] = useState<Record<string, string>>({ opacity: "0" });

  useLayoutEffect(() => {
    const menu = listRef.current;
    if (!anchor || !menu) {
      return;
    }
    const rect = anchor.getBoundingClientRect();
    const rtl = getComputedStyle(anchor).direction === "rtl";
    const gap = 4;
    const menuHeight = menu.offsetHeight;
    const below = rect.bottom + gap + menuHeight <= window.innerHeight || rect.top < menuHeight + gap;
    const next: Record<string, string> = {
      top: below ? `${Math.round(rect.bottom + gap)}px` : `${Math.round(rect.top - gap - menuHeight)}px`,
    };
    if (rtl) {
      next.left = `${Math.max(8, Math.round(rect.left))}px`;
    } else {
      next.right = `${Math.max(8, Math.round(window.innerWidth - rect.right))}px`;
    }
    setStyle(next);
  }, [anchor]);

  useLayoutEffect(() => {
    function onPointerDown(event: Event): void {
      const target = event.target as Node | null;
      if (target && (listRef.current?.contains(target) || anchor?.contains(target))) {
        return;
      }
      onClose(false);
    }
    function onViewportChange(event: Event): void {
      // Scrolling inside the menu itself is fine; anything else moved the anchor.
      if (event.type === "scroll" && listRef.current?.contains(event.target as Node)) {
        return;
      }
      onClose(false);
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onViewportChange, true);
    window.addEventListener("resize", onViewportChange);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onViewportChange, true);
      window.removeEventListener("resize", onViewportChange);
    };
  }, [anchor, onClose]);

  return (
    <MenuList
      className="menu-popover"
      id={id}
      items={items}
      label={label}
      listRef={listRef}
      onClose={onClose}
      onSelect={onSelect}
      style={style}
    />
  );
}
