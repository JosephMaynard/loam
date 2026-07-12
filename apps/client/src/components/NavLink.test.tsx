import type { VNode } from "preact";
import { render } from "preact";
import { LocationProvider } from "preact-iso";
import { afterEach, describe, expect, it } from "vitest";

import { NavLink } from "./NavLink";

// Rendered-component tests: mount real Preact components into jsdom and assert on the resulting DOM.
// NavLink reads preact-iso's location context, so mounts are wrapped in a LocationProvider.

const mounted: HTMLDivElement[] = [];

function mount(element: VNode): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  render(<LocationProvider>{element}</LocationProvider>, container);
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

describe("NavLink", () => {
  it("renders an anchor with its href and children", () => {
    const host = mount(
      <NavLink active={false} href="/settings">
        Settings
      </NavLink>,
    );

    const anchor = host.querySelector("a") as HTMLAnchorElement;
    expect(anchor.getAttribute("href")).toBe("/settings");
    expect(anchor.textContent).toBe("Settings");
  });

  it("marks itself as the current page and gets the active class when active", () => {
    const host = mount(
      <NavLink active href="/channel/general">
        General
      </NavLink>,
    );

    const anchor = host.querySelector("a") as HTMLAnchorElement;
    expect(anchor.getAttribute("aria-current")).toBe("page");
    expect(anchor.className).toContain("active");
  });

  it("omits aria-current when inactive and honours a className override", () => {
    const host = mount(
      <NavLink active={false} className="mobile-back" href="/channels">
        Back
      </NavLink>,
    );

    const anchor = host.querySelector("a") as HTMLAnchorElement;
    expect(anchor.getAttribute("aria-current")).toBeNull();
    expect(anchor.className).toBe("mobile-back");
  });
});
