import type { VNode } from "preact";
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it } from "vitest";

import { NodeLinkControl } from "./NodeLinkControl";

const mounted: HTMLDivElement[] = [];

function mount(element: VNode): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  render(element, container);
  mounted.push(container);
  return container;
}

afterEach(() => {
  for (const container of mounted) {
    render(null, container);
    container.remove();
  }
  mounted.length = 0;
});

describe("NodeLinkControl", () => {
  it("renders nothing without a join URL", () => {
    expect(mount(<NodeLinkControl />).querySelector("button")).toBeNull();
  });

  it("reveals the node address and a QR when opened", () => {
    const host = mount(<NodeLinkControl joinUrl="http://192.168.0.10:3000" />);
    expect(host.querySelector(".invite-panel")).toBeNull();

    act(() => {
      host.querySelector("button")?.click();
    });

    expect(host.textContent).toContain("http://192.168.0.10:3000");
    expect(host.querySelector(".invite-qr svg")).not.toBeNull();
  });
});
