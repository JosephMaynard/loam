import { render } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PinChangePrompt } from "./PinChangePrompt";

const mounted: HTMLDivElement[] = [];

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
    const container = document.createElement("div");
    document.body.appendChild(container);
    mounted.push(container);
    render(<PinChangePrompt current="🍎🍐🍊" next="🐙🦑🦀" onAccept={onAccept} onReject={onReject} />, container);

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
});
