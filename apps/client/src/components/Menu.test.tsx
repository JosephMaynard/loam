import type { VNode } from "preact";
import { render } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Menu, type MenuItem } from "./Menu";

// Rendered-component tests: mount real Preact components into jsdom and assert on the resulting DOM.

const mounted: HTMLDivElement[] = [];

function mount(element: VNode): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  render(element, container);
  mounted.push(container);
  return container;
}

/** Let Preact flush its batched state update (it re-renders on a microtask, not synchronously). */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  for (const container of mounted) {
    render(null, container);
    container.remove();
  }
  mounted.length = 0;
  vi.unstubAllGlobals();
});

/** Three items: an ordinary one, a disabled one, and a destructive one. */
function items(): { list: MenuItem[]; reply: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> } {
  const reply = vi.fn();
  const remove = vi.fn();
  return {
    list: [
      { label: "Reply", onSelect: reply },
      { label: "Edit", onSelect: vi.fn(), disabled: true },
      { label: "Delete", onSelect: remove, danger: true },
    ],
    reply,
    remove,
  };
}

/** Make `matchMedia` report a phone-width screen (or not). */
function stubPhone(isPhone: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: isPhone && query.includes("max-width"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

/** Open the menu by clicking its trigger. */
async function open(root: HTMLElement): Promise<HTMLButtonElement> {
  const trigger = root.querySelector<HTMLButtonElement>(".menu-trigger")!;
  trigger.focus();
  trigger.click();
  await tick();
  return trigger;
}

describe("Menu", () => {
  it("renders a labelled kebab trigger that advertises its popup", () => {
    const root = mount(<Menu items={items().list} label="More actions" />);
    const trigger = root.querySelector<HTMLButtonElement>(".menu-trigger")!;

    expect(trigger.getAttribute("aria-label")).toBe("More actions");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.querySelector("svg")).not.toBeNull();
    expect(root.querySelector('[role="menu"]')).toBeNull();
  });

  it("opens a popover menu on wide screens with focus on the first item", async () => {
    stubPhone(false);
    const root = mount(<Menu items={items().list} label="More actions" />);
    const trigger = await open(root);

    const menu = root.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu.classList.contains("menu-popover")).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-controls")).toBe(menu.id);
    expect(Array.from(menu.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent)).toEqual([
      "Reply",
      "Edit",
      "Delete",
    ]);
    expect(document.activeElement?.textContent).toBe("Reply");
    expect(root.querySelector(".menu-item.is-danger")?.textContent).toBe("Delete");
  });

  it("moves with the arrow keys, skipping disabled items and wrapping", async () => {
    stubPhone(false);
    const root = mount(<Menu items={items().list} label="More actions" />);
    await open(root);
    const menu = root.querySelector<HTMLElement>('[role="menu"]')!;

    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement?.textContent).toBe("Delete");
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement?.textContent).toBe("Reply");
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(document.activeElement?.textContent).toBe("Delete");
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(document.activeElement?.textContent).toBe("Reply");
  });

  it("runs the chosen item's action, closes, and refocuses the trigger", async () => {
    stubPhone(false);
    const { list, remove } = items();
    const root = mount(<Menu items={list} label="More actions" />);
    const trigger = await open(root);

    Array.from(root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((item) => item.textContent === "Delete")!
      .click();
    await tick();

    expect(remove).toHaveBeenCalledTimes(1);
    expect(root.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on Escape (focus back on the trigger) and on an outside press", async () => {
    stubPhone(false);
    const root = mount(<Menu items={items().list} label="More actions" />);
    const trigger = await open(root);

    root
      .querySelector<HTMLElement>('[role="menu"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    expect(root.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await open(root);
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await tick();
    expect(root.querySelector('[role="menu"]')).toBeNull();
  });

  it("opens as a bottom sheet dialog on phones", async () => {
    stubPhone(true);
    const { list, reply } = items();
    const root = mount(<Menu items={list} label="More actions" />);
    const trigger = await open(root);

    const sheet = root.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(sheet).not.toBeNull();
    expect(root.querySelector(".dialog-backdrop")?.classList.contains("is-sheet")).toBe(true);
    expect(sheet.querySelector('[role="menu"]')).not.toBeNull();
    expect(document.activeElement?.textContent).toBe("Reply");

    (document.activeElement as HTMLButtonElement).click();
    await tick();
    expect(reply).toHaveBeenCalledTimes(1);
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
