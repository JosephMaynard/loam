import type { VNode } from "preact";
import { render } from "preact";
import { useState } from "preact/hooks";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Dialog } from "./Dialog";

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
});

/** A trigger button that opens a Dialog, like every real caller. */
function Harness({ onClose, variant }: { onClose?: () => void; variant?: "sheet" | "dialog" | "auto" }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button className="trigger" onClick={() => setOpen(true)} type="button">
        Open
      </button>
      {open ? (
        <Dialog
          onClose={() => {
            onClose?.();
            setOpen(false);
          }}
          title="Invite someone"
          variant={variant}
        >
          <input aria-label="Name" className="first" />
          <button className="last" type="button">
            Done
          </button>
        </Dialog>
      ) : null}
    </div>
  );
}

/** Open the harness dialog from its (focused) trigger. */
async function openHarness(root: HTMLElement): Promise<HTMLButtonElement> {
  const trigger = root.querySelector<HTMLButtonElement>(".trigger")!;
  trigger.focus();
  trigger.click();
  await tick();
  return trigger;
}

describe("Dialog", () => {
  it("is a labelled modal dialog that takes focus on open", async () => {
    const root = mount(<Harness />);
    await openHarness(root);

    const panel = root.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(panel.getAttribute("aria-modal")).toBe("true");
    const labelId = panel.getAttribute("aria-labelledby")!;
    expect(document.getElementById(labelId)?.textContent).toBe("Invite someone");
    expect(document.activeElement).toBe(panel);
  });

  it("closes on Escape and hands focus back to the trigger", async () => {
    const onClose = vi.fn();
    const root = mount(<Harness onClose={onClose} />);
    const trigger = await openHarness(root);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await tick();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on a backdrop click but not on a click inside the panel", async () => {
    const onClose = vi.fn();
    const root = mount(<Harness onClose={onClose} />);
    await openHarness(root);

    root.querySelector<HTMLElement>(".first")!.click();
    await tick();
    expect(onClose).not.toHaveBeenCalled();

    root.querySelector<HTMLElement>(".dialog-backdrop")!.click();
    await tick();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes from its labelled close button", async () => {
    const onClose = vi.fn();
    const root = mount(<Harness onClose={onClose} />);
    await openHarness(root);

    const close = root.querySelector<HTMLButtonElement>(".dialog-close")!;
    expect(close.getAttribute("aria-label")).toBe("Dismiss");
    close.click();
    await tick();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps Tab inside the dialog", async () => {
    const root = mount(<Harness />);
    await openHarness(root);

    const last = root.querySelector<HTMLButtonElement>(".last")!;
    last.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", cancelable: true }));
    // Wrapped to the first focusable element in the panel (the header's close button).
    expect(document.activeElement).toBe(root.querySelector(".dialog-close"));

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, cancelable: true }));
    expect(document.activeElement).toBe(last);
  });

  it("marks its layout variant on the backdrop and shows the drag handle except as a centred dialog", async () => {
    const sheet = mount(<Harness variant="sheet" />);
    await openHarness(sheet);
    expect(sheet.querySelector(".dialog-backdrop")?.classList.contains("is-sheet")).toBe(true);
    expect(sheet.querySelector(".dialog-handle")).not.toBeNull();

    const card = mount(<Harness variant="dialog" />);
    await openHarness(card);
    expect(card.querySelector(".dialog-backdrop")?.classList.contains("is-dialog")).toBe(true);
    expect(card.querySelector(".dialog-handle")).toBeNull();

    const auto = mount(<Harness />);
    await openHarness(auto);
    expect(auto.querySelector(".dialog-backdrop")?.classList.contains("is-auto")).toBe(true);
  });

  it("lets only the top-most dialog react to Escape", async () => {
    const outerClose = vi.fn();
    const innerClose = vi.fn();
    mount(
      <Dialog onClose={outerClose} title="Outer">
        <Dialog onClose={innerClose} title="Inner">
          <p>Nested</p>
        </Dialog>
      </Dialog>,
    );

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(innerClose).toHaveBeenCalledTimes(1);
    expect(outerClose).not.toHaveBeenCalled();
  });
});
