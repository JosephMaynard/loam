import type { VNode } from "preact";
import { render } from "preact";
import { afterEach, describe, expect, it } from "vitest";

import { GettingStartedPanel } from "./GettingStartedPanel";

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

describe("GettingStartedPanel", () => {
  it("renders the five-step checklist and the operator-guide link", () => {
    const host = mount(<GettingStartedPanel />);

    expect(host.querySelector(".getting-started")).not.toBeNull();
    expect(host.querySelectorAll(".getting-started-steps li")).toHaveLength(5);
    const link = host.querySelector("a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toContain("docs/12-operators-guide.md");
    expect(link.getAttribute("rel")).toBe("noreferrer");
    expect(link.getAttribute("target")).toBe("_blank");
  });
});
