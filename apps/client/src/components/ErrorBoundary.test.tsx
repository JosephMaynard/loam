import { render } from "preact";
import { LocationProvider, useLocation } from "preact-iso";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseRoute } from "../lib/protocol";
import { ErrorBoundary } from "./ErrorBoundary";

const mounted: HTMLDivElement[] = [];

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  for (const container of mounted) {
    render(null, container);
    container.remove();
  }
  mounted.length = 0;
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

/** Renders the current path, and throws while `explode` says so — like a component hitting a render bug. */
function Screen({ explode }: { explode: (path: string) => boolean }) {
  const { path } = useLocation();
  if (explode(path)) {
    throw new Error(`render failed on ${path}`);
  }
  return <p className="screen">{path}</p>;
}

describe("ErrorBoundary (review 2026-09-25)", () => {
  it("shows a recoverable error screen instead of a blank page, and 'Go to channels' recovers", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    window.history.replaceState(null, "", "/broken");
    const container = document.createElement("div");
    document.body.appendChild(container);
    mounted.push(container);

    render(
      <ErrorBoundary>
        <LocationProvider>
          <Screen explode={(path) => path === "/broken"} />
        </LocationProvider>
      </ErrorBoundary>,
      container,
    );
    await tick();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Something went wrong");
    expect(container.querySelector(".screen")).toBeNull();

    const home = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Go to channels")!;
    home.click();
    await tick();

    expect(window.location.pathname).toBe("/channels");
    expect(container.querySelector(".screen")?.textContent).toBe("/channels");
  });

  it("parseRoute no longer throws on malformed percent-encoding (the crash this used to cause)", () => {
    expect(() => parseRoute("/dm/%E0%A4%A")).not.toThrow();
  });
});
