import type { LoamConfig } from "@loam/schema";
import type { VNode } from "preact";
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it } from "vitest";

import { LlmPanel } from "./LlmPanel";

type OllamaConfig = LoamConfig["llm"]["ollama"];
type OnDeviceConfig = LoamConfig["llm"]["onDevice"];

const mounted: HTMLDivElement[] = [];

const ollama: OllamaConfig = {
  enabled: false,
  baseUrl: "http://localhost:11434",
  model: "llama3",
  botId: "user.bot",
  botDisplayName: "Assistant",
};

const onDevice: OnDeviceConfig = { enabled: false } as OnDeviceConfig;

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

describe("LlmPanel", () => {
  it("seeds the Ollama fields and funnels a model edit through onOllamaChange", () => {
    const updates: Partial<OllamaConfig>[] = [];
    const host = mount(
      <LlmPanel
        onDevice={onDevice}
        ollama={ollama}
        onOllamaChange={(update) => updates.push(update)}
        onOnDeviceChange={() => {}}
        saving={false}
      />,
    );

    const inputs = Array.from(host.querySelectorAll('input:not([type="checkbox"])')) as HTMLInputElement[];
    // Base URL, model, bot name in order.
    expect(inputs[0].value).toBe("http://localhost:11434");
    expect(inputs[1].value).toBe("llama3");

    act(() => {
      inputs[1].value = "phi3";
      inputs[1].dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(updates).toEqual([{ model: "phi3" }]);
  });

  it("keeps the on-device model input disabled until on-device is enabled", () => {
    const host = mount(
      <LlmPanel
        onDevice={onDevice}
        ollama={ollama}
        onOllamaChange={() => {}}
        onOnDeviceChange={() => {}}
        saving={false}
      />,
    );

    const inputs = Array.from(host.querySelectorAll('input:not([type="checkbox"])')) as HTMLInputElement[];
    // The on-device model field is the last text input.
    expect(inputs[inputs.length - 1].disabled).toBe(true);
  });
});
