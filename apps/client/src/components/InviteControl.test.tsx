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
  delete (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView;
});

describe("InviteControl", () => {
  it("renders nothing without a join URL", () => {
    expect(mount(<InviteControl />).querySelector(".invite-control")).toBeNull();
  });

  it("starts closed: a trigger button, no modal", () => {
    const root = mount(<InviteControl joinUrl="http://192.168.0.5:3000" />);
    expect(root.querySelector("button")).not.toBeNull();
    expect(root.querySelector(".invite-modal-backdrop")).toBeNull();
  });

  it("opens a modal with the join URL and its QR, then closes via the close button", async () => {
    const root = mount(<InviteControl joinUrl="http://192.168.0.5:3000" />);
    const toggle = root.querySelector("button");

    toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();

    const modal = root.querySelector(".invite-modal");
    expect(modal).not.toBeNull();
    expect(root.querySelector(".invite-modal-url")?.textContent).toBe("http://192.168.0.5:3000");
    // The QR is rendered as inline SVG markup, not an external asset, and hidden from assistive tech
    // (the URL text is the accessible content).
    expect(root.querySelector(".invite-modal-qr svg")).not.toBeNull();
    expect(root.querySelector(".invite-modal-qr")?.getAttribute("aria-hidden")).toBe("true");
    expect(modal?.getAttribute("role")).toBe("dialog");
    expect(modal?.getAttribute("aria-modal")).toBe("true");

    const close = root.querySelector(".close-button");
    close?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();

    expect(root.querySelector(".invite-modal-backdrop")).toBeNull();
  });

  it("closes when the backdrop is clicked", async () => {
    const root = mount(<InviteControl joinUrl="http://192.168.0.5:3000" />);
    root.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();

    const backdrop = root.querySelector(".invite-modal-backdrop");
    expect(backdrop).not.toBeNull();
    backdrop?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();

    expect(root.querySelector(".invite-modal-backdrop")).toBeNull();
  });

  it("closes on Escape", async () => {
    const root = mount(<InviteControl joinUrl="http://192.168.0.5:3000" />);
    root.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();

    expect(root.querySelector(".invite-modal-backdrop")).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await tick();

    expect(root.querySelector(".invite-modal-backdrop")).toBeNull();
  });

  it("does not show the Wi-Fi hotspot button in a plain browser (no native bridge)", async () => {
    const root = mount(<InviteControl joinUrl="http://192.168.0.5:3000" />);
    root.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();

    expect(root.querySelector(".invite-modal-wifi")).toBeNull();
  });

  it("shows a Wi-Fi hotspot button that posts loam-open-share when the native bridge is present", async () => {
    const postMessage: string[] = [];
    (window as unknown as { ReactNativeWebView: { postMessage: (message: string) => void } }).ReactNativeWebView = {
      postMessage: (message: string) => postMessage.push(message),
    };

    const root = mount(<InviteControl joinUrl="http://192.168.0.5:3000" />);
    root.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();

    const wifiSection = root.querySelector(".invite-modal-wifi");
    expect(wifiSection).not.toBeNull();
    const wifiButton = wifiSection?.querySelector("button");
    expect(wifiButton).not.toBeNull();

    wifiButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();

    expect(postMessage).toEqual([JSON.stringify({ type: "loam-open-share" })]);
  });
});
