import type { VNode } from "preact";
import { render } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MessageComposer } from "./MessageComposer";

// Rendered-component tests: mount real Preact components into jsdom and drive the composer's DOM.

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

/** Set a textarea/input value the way Preact's controlled inputs expect, then fire an input event. */
function typeInto(field: HTMLTextAreaElement | HTMLInputElement, text: string): void {
  field.value = text;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

afterEach(() => {
  for (const container of mounted) {
    render(null, container);
    container.remove();
  }
  mounted.length = 0;
});

describe("MessageComposer", () => {
  it("keeps the send button disabled while the composer is empty", () => {
    const host = mount(<MessageComposer label="Message" onSend={async () => {}} placeholder="Say something" />);

    const send = host.querySelector("button[type='submit']") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
  });

  it("submits the trimmed body via onSend and clears the textarea", async () => {
    const onSend = vi.fn(async () => {});
    const host = mount(<MessageComposer label="Message" onSend={onSend} placeholder="Say something" />);

    const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
    typeInto(textarea, "  hello world  ");
    await tick();

    const send = host.querySelector("button[type='submit']") as HTMLButtonElement;
    expect(send.disabled).toBe(false);

    const form = host.querySelector("form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await tick();

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("hello world", undefined, undefined);
  });

  it("shows the location toggle only when location sharing is allowed", async () => {
    const withoutLocation = mount(<MessageComposer label="Message" onSend={async () => {}} placeholder="Say something" />);
    expect(withoutLocation.querySelector(".composer-location-toggle")).toBeNull();

    const withLocation = mount(
      <MessageComposer allowLocationSharing label="Message" onSend={async () => {}} placeholder="Say something" />,
    );
    const toggle = withLocation.querySelector(".composer-location-toggle") as HTMLButtonElement;
    expect(toggle).not.toBeNull();

    // Toggling opens the coordinate/label form.
    expect(withLocation.querySelector(".composer-location-form")).toBeNull();
    toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(withLocation.querySelector(".composer-location-form")).not.toBeNull();
  });

  it("sends a location-only message when the toggle form has a label", async () => {
    const onSend = vi.fn(async () => {});
    const host = mount(
      <MessageComposer allowLocationSharing label="Message" onSend={onSend} placeholder="Say something" />,
    );

    (host.querySelector(".composer-location-toggle") as HTMLButtonElement).dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await tick();

    const labelInput = host.querySelector(".composer-location-label") as HTMLInputElement;
    typeInto(labelInput, "north gate");
    await tick();

    const send = host.querySelector("button[type='submit']") as HTMLButtonElement;
    expect(send.disabled).toBe(false);

    (host.querySelector("form") as HTMLFormElement).dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await tick();

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("", undefined, { label: "north gate" });
  });
});
