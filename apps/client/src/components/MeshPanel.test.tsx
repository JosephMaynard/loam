import type { LoamConfig } from "@loam/schema";
import type { VNode } from "preact";
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it } from "vitest";

import { MeshPanel } from "./MeshPanel";

type MeshConfig = LoamConfig["mesh"];

const mounted: HTMLDivElement[] = [];

const baseMesh: MeshConfig = {
  enabled: false,
  relay: false,
  ttlMs: 86_400_000,
  hopLimit: 8,
  maxCarried: 1000,
  maxContacts: 500,
};

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

describe("MeshPanel", () => {
  it("emits an enabled toggle and disables the tuning inputs while mesh is off", () => {
    const updates: Partial<MeshConfig>[] = [];
    const host = mount(<MeshPanel mesh={baseMesh} onChange={(update) => updates.push(update)} saving={false} />);

    const checkboxes = Array.from(host.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    const numbers = Array.from(host.querySelectorAll('input[type="number"]')) as HTMLInputElement[];
    // Relay + all numeric inputs are gated on mesh.enabled.
    expect(checkboxes[1].disabled).toBe(true);
    for (const input of numbers) {
      expect(input.disabled).toBe(true);
    }

    act(() => {
      checkboxes[0].checked = true;
      checkboxes[0].dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(updates).toEqual([{ enabled: true }]);
  });

  it("clamps an out-of-range hop limit before emitting it", () => {
    const updates: Partial<MeshConfig>[] = [];
    const host = mount(
      <MeshPanel mesh={{ ...baseMesh, enabled: true }} onChange={(update) => updates.push(update)} saving={false} />,
    );

    // The second number input is the hop-limit field (TTL is first).
    const hopInput = (host.querySelectorAll('input[type="number"]')[1]) as HTMLInputElement;
    act(() => {
      hopInput.value = "99";
      hopInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(updates).toEqual([{ hopLimit: 16 }]);
  });
});
