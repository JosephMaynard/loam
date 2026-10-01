import type { VNode } from "preact";
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { THEME_STORAGE_KEY } from "../lib/theme";
import { AppearancePanel } from "./AppearancePanel";

const mounted: HTMLDivElement[] = [];

function mount(element: VNode): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  render(element, container);
  mounted.push(container);
  return container;
}

function radios(host: HTMLElement): HTMLInputElement[] {
  return [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  for (const container of mounted) {
    render(null, container);
    container.remove();
  }
  mounted.length = 0;
});

describe("AppearancePanel", () => {
  it("offers System, Light and Dark, labelled by the card title, with System selected by default", () => {
    const host = mount(<AppearancePanel />);
    expect(radios(host).map((radio) => radio.value)).toEqual(["system", "light", "dark"]);
    expect(radios(host).find((radio) => radio.checked)?.value).toBe("system");
    const group = host.querySelector("fieldset")!;
    expect(document.getElementById(group.getAttribute("aria-labelledby")!)?.textContent).toBe("Appearance");
  });

  it("starts from the saved preference", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    const host = mount(<AppearancePanel />);
    expect(radios(host).find((radio) => radio.checked)?.value).toBe("dark");
  });

  it("applies and saves a choice at once", () => {
    const host = mount(<AppearancePanel />);
    const light = radios(host).find((radio) => radio.value === "light")!;
    act(() => {
      light.checked = true;
      light.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(radios(host).find((radio) => radio.checked)?.value).toBe("light");
  });
});
