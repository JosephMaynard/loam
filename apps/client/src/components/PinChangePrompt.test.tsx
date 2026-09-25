import type { VNode } from "preact";
import { render } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PinChangePrompt } from "./PinChangePrompt";

const mounted: HTMLDivElement[] = [];

function mount(element: VNode): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  mounted.push(container);
  render(element, container);
  return container;
}

function press(target: HTMLElement, key: string, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, shiftKey });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  for (const container of mounted) {
    render(null, container);
    container.remove();
  }
  mounted.length = 0;
});

describe("PinChangePrompt (review 2026-09-25)", () => {
  it("shows both fingerprints, focuses the safe choice, and routes each answer", () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    const container = mount(
      <PinChangePrompt current="🍎🍐🍊" matchesNode next="🐙🦑🦀" onAccept={onAccept} onReject={onReject} />,
    );

    expect(container.textContent).toContain("🍎🍐🍊");
    expect(container.textContent).toContain("🐙🦑🦀");
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(document.activeElement?.textContent).toBe("Keep my current key");

    const buttons = Array.from(container.querySelectorAll("button"));
    buttons.find((button) => button.textContent === "Keep my current key")!.click();
    expect(onReject).toHaveBeenCalledTimes(1);
    buttons.find((button) => button.textContent === "Use the new key")!.click();
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it("a link whose key the node doesn't hold offers no Accept and says to rescan at the host", () => {
    const container = mount(
      <PinChangePrompt current="🍎🍐🍊" matchesNode={false} next="🐙🦑🦀" onAccept={() => {}} onReject={() => {}} />,
    );

    expect(container.textContent).toContain("isn't the one this node is using");
    expect(Array.from(container.querySelectorAll("button")).map((button) => button.textContent)).toEqual([
      "Keep my current key",
    ]);
  });

  it("traps Tab / Shift+Tab inside the dialog", () => {
    const container = mount(
      <PinChangePrompt current="🍎" matchesNode next="🐙" onAccept={() => {}} onReject={() => {}} />,
    );
    const [keep, accept] = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));

    accept!.focus();
    expect(press(accept!, "Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(keep);

    expect(press(keep!, "Tab", true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(accept);
  });
});
