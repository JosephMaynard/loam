import type { VNode } from "preact";
import { render } from "preact";
import { afterEach, describe, expect, it } from "vitest";

import { AvatarImageEditor } from "./AvatarImageEditor";

// Rendered-component tests: mount real Preact components into jsdom and assert on the resulting DOM.
// A full canvas exercise is impractical in jsdom, so this covers the shell: controls render, and the
// crop actions stay disabled until an image is chosen.

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

describe("AvatarImageEditor", () => {
  it("renders the crop canvas and the choose/zoom/rotate controls", () => {
    const host = mount(<AvatarImageEditor disabled={false} onUpload={async () => {}} />);

    expect(host.querySelector("canvas.avatar-crop-canvas")).not.toBeNull();
    expect(host.querySelector("input[type='file']")).not.toBeNull();

    const rangeInputs = host.querySelectorAll("input[type='range']");
    expect(rangeInputs.length).toBe(2);

    const buttons = host.querySelectorAll("button");
    expect(buttons.length).toBe(2);
  });

  it("keeps the crop actions disabled until an image is chosen", () => {
    const host = mount(<AvatarImageEditor disabled={false} onUpload={async () => {}} />);

    const buttons = Array.from(host.querySelectorAll("button"));
    // The first button chooses an image (enabled); the second uses the crop and stays disabled with no image.
    expect(buttons[0]?.disabled).toBe(false);
    expect(buttons[1]?.disabled).toBe(true);

    for (const range of Array.from(host.querySelectorAll("input[type='range']"))) {
      expect((range as HTMLInputElement).disabled).toBe(true);
    }
  });

  it("disables every control when the editor is disabled", () => {
    const host = mount(<AvatarImageEditor disabled onUpload={async () => {}} />);

    for (const button of Array.from(host.querySelectorAll("button"))) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    for (const range of Array.from(host.querySelectorAll("input[type='range']"))) {
      expect((range as HTMLInputElement).disabled).toBe(true);
    }
  });
});
