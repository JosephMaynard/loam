import type { VNode } from "preact";
import { render } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SearchResult } from "./SearchResult";

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

describe("SearchResult", () => {
  it("renders the author, context, time, and body", () => {
    const host = mount(
      <SearchResult
        authorName="calm.copper.owl"
        body="meet at the water point"
        contextLabel="#logistics"
        onOpen={() => undefined}
        time="09:41"
      />,
    );

    expect(host.textContent).toContain("calm.copper.owl");
    expect(host.textContent).toContain("#logistics");
    expect(host.textContent).toContain("09:41");
    expect(host.textContent).toContain("meet at the water point");
  });

  it("marks the body as bidirectional-auto so RTL text renders correctly", () => {
    const host = mount(
      <SearchResult
        authorName="a"
        body="مرحبا بالجميع"
        contextLabel="#general"
        onOpen={() => undefined}
        time="09:41"
      />,
    );

    expect(host.querySelector(".search-result-body")?.getAttribute("dir")).toBe("auto");
  });

  it("invokes onOpen when the row is clicked", () => {
    const onOpen = vi.fn();
    const host = mount(
      <SearchResult authorName="a" body="b" contextLabel="#c" onOpen={onOpen} time="09:41" />,
    );

    host.querySelector("button")?.click();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
