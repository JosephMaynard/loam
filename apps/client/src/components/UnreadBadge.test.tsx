import type { VNode } from "preact";
import { render } from "preact";
import { afterEach, describe, expect, it } from "vitest";

import { UnreadBadge } from "./UnreadBadge";

// Rendered-component tests: mount real Preact components into jsdom and assert on the resulting DOM.

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

describe("UnreadBadge", () => {
  it("renders nothing when there is nothing unread", () => {
    expect(mount(<UnreadBadge count={0} />).querySelector(".unread-badge")).toBeNull();
    expect(mount(<UnreadBadge count={-3} />).querySelector(".unread-badge")).toBeNull();
  });

  it("shows the exact count with an accessible label when unread", () => {
    const badge = mount(<UnreadBadge count={7} />).querySelector(".unread-badge");
    expect(badge?.textContent).toBe("7");
    expect(badge?.getAttribute("aria-label")).toBe("7 unread");
  });

  it("caps the visible label at 99+ but keeps the true count in the label", () => {
    const badge = mount(<UnreadBadge count={128} />).querySelector(".unread-badge");
    expect(badge?.textContent).toBe("99+");
    expect(badge?.getAttribute("aria-label")).toBe("128 unread");
  });

  it("shows 99 (not 99+) at the boundary", () => {
    expect(mount(<UnreadBadge count={99} />).querySelector(".unread-badge")?.textContent).toBe("99");
  });
});
