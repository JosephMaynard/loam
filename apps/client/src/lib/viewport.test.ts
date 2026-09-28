import { afterEach, describe, expect, it, vi } from "vitest";

import { installViewportSync, onViewportResize } from "./viewport";

/** A stand-in for `window.visualViewport`: an event target with a settable height/offset/scale. */
class FakeVisualViewport extends EventTarget {
  height = 700;
  offsetTop = 0;
  scale = 1;
}

/** Install a fake visual viewport on the jsdom window and return it. */
function stubVisualViewport(): FakeVisualViewport {
  const visual = new FakeVisualViewport();
  Object.defineProperty(window, "visualViewport", { configurable: true, value: visual });
  return visual;
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined });
  document.documentElement.style.removeProperty("--vvh");
  document.documentElement.style.removeProperty("--vv-top");
  vi.restoreAllMocks();
});

/** The `--vvh` value currently written on `:root`. */
function vvh(): string {
  return document.documentElement.style.getPropertyValue("--vvh");
}

describe("installViewportSync", () => {
  it("writes the visual viewport height to --vvh on install and on every resize", () => {
    const visual = stubVisualViewport();
    cleanups.push(installViewportSync(window));
    expect(vvh()).toBe("700px");

    // The keyboard opens: the visual viewport shrinks.
    visual.height = 412.4;
    visual.dispatchEvent(new Event("resize"));
    expect(vvh()).toBe("412px");
  });

  it("mirrors the visual viewport's top offset into --vv-top", () => {
    const visual = stubVisualViewport();
    cleanups.push(installViewportSync(window));
    visual.offsetTop = 120;
    visual.dispatchEvent(new Event("scroll"));
    expect(document.documentElement.style.getPropertyValue("--vv-top")).toBe("120px");
  });

  it("falls back to window.innerHeight without a visual viewport", () => {
    Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined });
    cleanups.push(installViewportSync(window));
    expect(vvh()).toBe(`${window.innerHeight}px`);
  });

  it("ignores a pinch-zoomed visual viewport (sizes to the layout viewport instead)", () => {
    const visual = stubVisualViewport();
    visual.scale = 2;
    visual.height = 350;
    cleanups.push(installViewportSync(window));
    expect(vvh()).toBe(`${window.innerHeight}px`);
  });

  it("snaps a scrolled document back to the top", () => {
    stubVisualViewport();
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    cleanups.push(installViewportSync(window));
    expect(scrollTo).not.toHaveBeenCalled();

    Object.defineProperty(window, "scrollY", { configurable: true, value: 180 });
    window.dispatchEvent(new Event("scroll"));
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
  });

  it("stops listening once uninstalled", () => {
    const visual = stubVisualViewport();
    const uninstall = installViewportSync(window);
    uninstall();

    visual.height = 300;
    visual.dispatchEvent(new Event("resize"));
    expect(vvh()).toBe("700px");
  });
});

describe("onViewportResize", () => {
  it("notifies subscribers only when the rounded height changes, until they unsubscribe", () => {
    const visual = stubVisualViewport();
    const heights: number[] = [];
    const unsubscribe = onViewportResize((height) => heights.push(height));
    cleanups.push(unsubscribe);
    cleanups.push(installViewportSync(window));
    expect(heights).toEqual([700]);

    visual.height = 700.2; // rounds to the same height: no notification
    visual.dispatchEvent(new Event("resize"));
    visual.height = 420;
    visual.dispatchEvent(new Event("resize"));
    expect(heights).toEqual([700, 420]);

    unsubscribe();
    visual.height = 500;
    visual.dispatchEvent(new Event("resize"));
    expect(heights).toEqual([700, 420]);
  });
});
