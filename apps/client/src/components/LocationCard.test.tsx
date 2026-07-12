import type { MessageLocation } from "@loam/schema";
import type { VNode } from "preact";
import { render } from "preact";
import { afterEach, describe, expect, it } from "vitest";

import { LocationCard } from "./LocationCard";

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

describe("LocationCard", () => {
  it("renders the label and coordinates, with a geo: link when coords are present", () => {
    const location: MessageLocation = { label: "north gate", lat: 51.5074, lng: -0.1278 };
    const host = mount(<LocationCard location={location} />);

    expect(host.textContent).toContain("north gate");
    expect(host.querySelector(".location-label")?.textContent).toBe("north gate");
    expect(host.textContent).toContain("51.50740");
    expect(host.textContent).toContain("-0.12780");

    const link = host.querySelector("a.location-open-maps");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("geo:51.5074,-0.1278");
  });

  it("falls back to showing the coordinates as the primary label when there is no label", () => {
    const location: MessageLocation = { lat: 10, lng: 20 };
    const host = mount(<LocationCard location={location} />);

    expect(host.querySelector(".location-label")?.textContent).toContain("10.00000");
    expect(host.querySelector(".location-label")?.textContent).toContain("20.00000");
    expect(host.querySelector(".location-coords")).toBeNull();
    expect(host.querySelector("a.location-open-maps")).not.toBeNull();
  });

  it("renders only the label and no geo: link when there are no coordinates", () => {
    const location: MessageLocation = { label: "camp 3" };
    const host = mount(<LocationCard location={location} />);

    expect(host.querySelector(".location-label")?.textContent).toBe("camp 3");
    expect(host.querySelector(".location-coords")).toBeNull();
    expect(host.querySelector("a.location-open-maps")).toBeNull();
  });
});
