import type { VNode } from "preact";
import { render } from "preact";
import { LocationProvider } from "preact-iso";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScreenHeader } from "./ScreenHeader";

// Rendered-component tests: mount real Preact components into jsdom and assert on the resulting DOM.
// The back control is a NavLink, so mounts are wrapped in a LocationProvider.

const mounted: HTMLDivElement[] = [];

function mount(element: VNode): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  render(<LocationProvider>{element}</LocationProvider>, container);
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

describe("ScreenHeader", () => {
  it("renders the title as an h1 with a labelled back link to Home by default", () => {
    const root = mount(<ScreenHeader title="Find messages" />);

    expect(root.querySelector("header.screen-header h1.screen-title")?.textContent).toBe("Find messages");
    const back = root.querySelector<HTMLAnchorElement>("a.mobile-back")!;
    expect(back.getAttribute("href")).toBe("/channels");
    expect(back.getAttribute("aria-label")).toBe("Back");
    expect(root.querySelector(".screen-subtitle")).toBeNull();
    expect(root.querySelector(".screen-header-actions")).toBeNull();
  });

  it("supports a subtitle, a leading node, a custom heading level, and no back control", () => {
    const root = mount(
      <ScreenHeader
        backHref={false}
        headingLevel={2}
        leading={<span className="glyph">#</span>}
        subtitle="Say hello"
        title="general"
      />,
    );

    expect(root.querySelector(".mobile-back")).toBeNull();
    expect(root.querySelector("h2.screen-title")?.textContent).toBe("general");
    expect(root.querySelector(".screen-subtitle")?.textContent).toBe("Say hello");
    expect(root.querySelector(".screen-header-leading .glyph")).not.toBeNull();
  });

  it("uses a button for back when given onBack", () => {
    const onBack = vi.fn();
    const root = mount(<ScreenHeader alwaysShowBack onBack={onBack} title="Thread" />);

    expect(root.querySelector("header")?.classList.contains("show-back")).toBe(true);
    const back = root.querySelector<HTMLButtonElement>("button.mobile-back")!;
    back.click();
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("puts trailing actions and an overflow menu after the title", async () => {
    const block = vi.fn();
    const root = mount(
      <ScreenHeader
        actions={
          <button aria-label="Search" className="btn btn-icon btn-ghost" type="button">
            S
          </button>
        }
        menuItems={[{ label: "Block", onSelect: block }]}
        menuLabel="More actions"
        title="Ada"
      />,
    );

    const actions = root.querySelector(".screen-header-actions")!;
    expect(actions.querySelector('button[aria-label="Search"]')).not.toBeNull();
    const trigger = actions.querySelector<HTMLButtonElement>(".menu-trigger")!;
    expect(trigger.getAttribute("aria-label")).toBe("More actions");

    trigger.click();
    await tick();
    root.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click();
    await tick();
    expect(block).toHaveBeenCalledTimes(1);
  });
});
