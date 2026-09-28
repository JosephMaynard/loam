import { render } from "preact";
import { useState } from "preact/hooks";
import { afterEach, describe, expect, it } from "vitest";

import { ReportDialog } from "./ReportDialog";

const mounted: HTMLDivElement[] = [];

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

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button className="trigger" onClick={() => setOpen(true)} type="button">
        Report
      </button>
      {open ? <ReportDialog onClose={() => setOpen(false)} targetId="m1" targetType="message" /> : null}
    </div>
  );
}

function press(target: Element, key: string, shiftKey = false): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, shiftKey }));
}

describe("ReportDialog focus handling (review 2026-09-25)", () => {
  it("traps Tab inside the dialog and returns focus to the trigger on close", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    mounted.push(container);
    render(<Harness />, container);

    const trigger = container.querySelector<HTMLButtonElement>(".trigger")!;
    trigger.focus();
    trigger.click();
    await tick();

    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(document.activeElement).toBe(dialog);

    const focusables = Array.from(dialog.querySelectorAll<HTMLElement>("button, select, textarea"));
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;

    last.focus();
    press(last, "Tab");
    expect(document.activeElement).toBe(first); // wraps forward

    first.focus();
    press(first, "Tab", true);
    expect(document.activeElement).toBe(last); // wraps backward

    press(dialog, "Escape");
    await tick();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
