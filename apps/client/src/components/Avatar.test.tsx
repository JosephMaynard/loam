import type { UserAvatar } from "@loam/schema";
import type { VNode } from "preact";
import { render } from "preact";
import { afterEach, describe, expect, it } from "vitest";

import { Avatar } from "./Avatar";

// Rendered-component tests: mount real Preact components into jsdom and assert on the resulting DOM.
// This is the harness the plain-TS lib tests could not exercise (they have no JSX). See vitest.config.ts.

const mounted: HTMLDivElement[] = [];

/** Render an element into a fresh attached container, tracked for teardown, and return it for querying. */
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

describe("Avatar", () => {
  it("renders an <img> pointing at the avatar image path for an uploaded image", () => {
    const avatar: UserAvatar = { kind: "image", imageId: "img_abc", mimeType: "image/png" };
    const root = mount(<Avatar id="user.1" avatar={avatar} />);

    const image = root.querySelector("img");
    expect(image).not.toBeNull();
    expect(image?.getAttribute("src")).toBe("/api/avatars/img_abc.png");
    // The image branch must not also inject generated avatar markup.
    expect(root.querySelector("svg")).toBeNull();
  });

  it("maps the mime type to the right file extension", () => {
    const jpeg = mount(<Avatar id="user.1" avatar={{ kind: "image", imageId: "img_j", mimeType: "image/jpeg" }} />);
    expect(jpeg.querySelector("img")?.getAttribute("src")).toBe("/api/avatars/img_j.jpg");

    const webp = mount(<Avatar id="user.1" avatar={{ kind: "image", imageId: "img_w", mimeType: "image/webp" }} />);
    expect(webp.querySelector("img")?.getAttribute("src")).toBe("/api/avatars/img_w.webp");
  });

  it("renders generated avatar markup when there is no uploaded image", () => {
    const root = mount(<Avatar id="user.1" />);

    // generateAvatar produces inline SVG injected via dangerouslySetInnerHTML.
    expect(root.querySelector("svg")).not.toBeNull();
    expect(root.querySelector("img")).toBeNull();
  });

  it("marks the wrapper aria-hidden and merges the base and custom classes", () => {
    const root = mount(<Avatar id="user.1" className="nav-avatar" />);
    const wrapper = root.firstElementChild;

    expect(wrapper?.getAttribute("aria-hidden")).toBe("true");
    expect(wrapper?.classList.contains("avatar")).toBe(true);
    expect(wrapper?.classList.contains("nav-avatar")).toBe(true);
  });

  it("derives the generated avatar from the seed, so the id is only a fallback", () => {
    // Same seed but different ids → identical markup (seed wins over id).
    const seeded = mount(<Avatar id="user.1" avatar={{ seed: "shared-seed" }} />).innerHTML;
    const sameSeed = mount(<Avatar id="user.999" avatar={{ seed: "shared-seed" }} />).innerHTML;
    expect(sameSeed).toBe(seeded);

    // A different seed → different markup.
    const otherSeed = mount(<Avatar id="user.1" avatar={{ seed: "other-seed" }} />).innerHTML;
    expect(otherSeed).not.toBe(seeded);
  });
});
