import { render, type ComponentChild } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ErrorBoundary } from "./ErrorBoundary";
import { lazyView } from "./LazyView";

const mounted: HTMLDivElement[] = [];

/** Lets pending promises settle and flushes the effects and renders they schedule. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function mount(node: ComponentChild): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  mounted.push(container);
  act(() => {
    render(node, container);
  });
  return container;
}

afterEach(() => {
  for (const container of mounted) {
    render(null, container);
    container.remove();
  }
  mounted.length = 0;
  vi.restoreAllMocks();
});

function Greeting({ name }: { name: string }) {
  return <p className="greeting">Hello {name}</p>;
}

describe("lazyView", () => {
  it("renders nothing until the chunk arrives, then the screen with its props", async () => {
    let resolve!: (component: typeof Greeting) => void;
    const load = vi.fn(() => new Promise<typeof Greeting>((done) => (resolve = done)));
    const Lazy = lazyView(load);

    const container = mount(<Lazy name="Ada" />);
    expect(container.innerHTML).toBe("");

    resolve(Greeting);
    await settle();
    expect(container.querySelector(".greeting")?.textContent).toBe("Hello Ada");
  });

  it("loads the chunk once and renders a later mount straight away", async () => {
    const load = vi.fn(() => Promise.resolve(Greeting));
    const Lazy = lazyView(load);

    mount(<Lazy name="first" />);
    await settle();
    const second = mount(<Lazy name="second" />);

    expect(second.querySelector(".greeting")?.textContent).toBe("Hello second");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("hands a failed load to the error boundary, and a later mount tries again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const load = vi
      .fn<() => Promise<typeof Greeting>>()
      .mockRejectedValueOnce(new Error("chunk fetch failed"))
      .mockResolvedValueOnce(Greeting);
    const Lazy = lazyView(load);

    const failed = mount(
      <ErrorBoundary>
        <Lazy name="Ada" />
      </ErrorBoundary>,
    );
    await settle();
    expect(failed.querySelector('[role="alert"]')).not.toBeNull();

    const retried = mount(<Lazy name="Ada" />);
    await settle();
    expect(retried.querySelector(".greeting")?.textContent).toBe("Hello Ada");
    expect(load).toHaveBeenCalledTimes(2);
  });
});
