import type { VNode } from "preact";
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ERROR_BANNER_AUTO_DISMISS_MS, ErrorBanner } from "./ErrorBanner";

const mounted: HTMLDivElement[] = [];

function mount(element: VNode): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  // `act` flushes effects synchronously (Preact otherwise defers them to after paint).
  act(() => {
    render(element, container);
  });
  mounted.push(container);
  return container;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const container of mounted) {
    render(null, container);
    container.remove();
  }
  mounted.length = 0;
  vi.useRealTimers();
});

describe("ErrorBanner (review 2026-09-25)", () => {
  it("is announced and can be dismissed with its labelled button", () => {
    const onDismiss = vi.fn();
    const host = mount(<ErrorBanner message="Unable to send the message." onDismiss={onDismiss} transient={false} />);
    const banner = host.querySelector(".connection-error")!;
    expect(banner.getAttribute("role")).toBe("alert");
    expect(banner.textContent).toContain("Unable to send the message.");

    const dismiss = host.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!;
    dismiss.click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("a transient (action) error dismisses itself", () => {
    const onDismiss = vi.fn();
    mount(<ErrorBanner message="Unable to edit the message." onDismiss={onDismiss} transient />);
    vi.advanceTimersByTime(ERROR_BANNER_AUTO_DISMISS_MS - 1);
    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("a persistent (connectivity) error stays until dismissed", () => {
    const onDismiss = vi.fn();
    mount(<ErrorBanner message="Unable to reach the LOAM server." onDismiss={onDismiss} transient={false} />);
    vi.advanceTimersByTime(10 * ERROR_BANNER_AUTO_DISMISS_MS);
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
