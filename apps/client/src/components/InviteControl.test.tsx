import type { VNode } from "preact";
import { render } from "preact";
import { afterEach, describe, expect, it } from "vitest";

import { InviteControl } from "./InviteControl";

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

describe("InviteControl", () => {
  it("renders nothing without a join URL", () => {
    expect(mount(<InviteControl />).querySelector(".invite-control")).toBeNull();
  });

  it("starts collapsed: a toggle button, no invite panel", () => {
    const root = mount(<InviteControl joinUrl="http://192.168.0.5:3000" />);
    const toggle = root.querySelector("button");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(root.querySelector(".invite-panel")).toBeNull();
  });

  it("reveals the join URL and its QR when expanded, then hides them again", async () => {
    const root = mount(<InviteControl joinUrl="http://192.168.0.5:3000" />);
    const toggle = root.querySelector("button");

    toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();

    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(root.querySelector(".invite-url")?.textContent).toBe("http://192.168.0.5:3000");
    // The QR is rendered as inline SVG markup, not an external asset, and hidden from assistive tech
    // (the URL text is the accessible content).
    expect(root.querySelector(".invite-qr svg")).not.toBeNull();
    expect(root.querySelector(".invite-qr")?.getAttribute("aria-hidden")).toBe("true");

    toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();

    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(root.querySelector(".invite-panel")).toBeNull();
  });
});
