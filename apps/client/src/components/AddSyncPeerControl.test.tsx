import type { VNode } from "preact";
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it } from "vitest";

import { AddSyncPeerControl } from "./AddSyncPeerControl";

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

describe("AddSyncPeerControl", () => {
  it("keeps the add button disabled until a valid http(s) URL is entered", () => {
    const host = mount(<AddSyncPeerControl disabled={false} onAdd={() => {}} />);
    const button = host.querySelector("button") as HTMLButtonElement;
    const urlInput = host.querySelector("input") as HTMLInputElement;

    expect(button.disabled).toBe(true);

    act(() => {
      urlInput.value = "not-a-url";
      urlInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(button.disabled).toBe(true);

    act(() => {
      urlInput.value = "http://192.168.0.10:3000";
      urlInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(button.disabled).toBe(false);
  });

  it("emits the trimmed URL (and optional label) then clears the fields", () => {
    const added: { url: string; label?: string }[] = [];
    const host = mount(<AddSyncPeerControl disabled={false} onAdd={(peer) => added.push(peer)} />);
    const [urlInput, labelInput] = Array.from(host.querySelectorAll("input")) as HTMLInputElement[];
    const button = host.querySelector("button") as HTMLButtonElement;

    act(() => {
      urlInput.value = "http://192.168.0.10:3000/";
      urlInput.dispatchEvent(new Event("input", { bubbles: true }));
      labelInput.value = "  Kitchen Pi  ";
      labelInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    act(() => {
      button.click();
    });

    expect(added).toEqual([{ url: "http://192.168.0.10:3000", label: "Kitchen Pi" }]);
    expect(urlInput.value).toBe("");
    expect(labelInput.value).toBe("");
  });

  it("stays disabled entirely when the control is disabled", () => {
    const host = mount(<AddSyncPeerControl disabled onAdd={() => {}} />);
    for (const input of Array.from(host.querySelectorAll("input"))) {
      expect((input as HTMLInputElement).disabled).toBe(true);
    }
    expect((host.querySelector("button") as HTMLButtonElement).disabled).toBe(true);
  });
});
