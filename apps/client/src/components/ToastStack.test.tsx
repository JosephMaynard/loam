import type { VNode } from "preact";
import { render } from "preact";
import { LocationProvider } from "preact-iso";
import { afterEach, describe, expect, it, vi } from "vitest";

import { groupToasts, ToastStack, type ToastItem } from "./ToastStack";

const mounted: HTMLDivElement[] = [];

function mount(element: VNode): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  render(<LocationProvider>{element}</LocationProvider>, container);
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

function channelToast(id: string, body: string, channel = "general"): ToastItem {
  return {
    id,
    title: `Bob · #${channel}`,
    body,
    route: `/channel/${channel}`,
    place: `#${channel}`,
    author: "Bob",
  };
}

describe("groupToasts", () => {
  it("keeps one group per conversation, newest conversation last, at most two", () => {
    const groups = groupToasts([
      channelToast("1", "a", "one"),
      channelToast("2", "b", "two"),
      channelToast("3", "c", "three"),
      channelToast("4", "d", "one"),
    ]);

    expect(groups.map((group) => group.route)).toEqual(["/channel/three", "/channel/one"]);
    expect(groups[1]!.items.map((item) => item.id)).toEqual(["1", "4"]);
  });
});

describe("ToastStack", () => {
  it("coalesces a burst in one conversation into a single counted toast", () => {
    const host = mount(
      <ToastStack
        onDismiss={() => {}}
        toasts={[channelToast("1", "first"), channelToast("2", "second"), channelToast("3", "third")]}
      />,
    );

    const toasts = host.querySelectorAll(".toast");
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.querySelector(".toast-title")?.textContent).toBe("3 new messages in #general");
    expect(toasts[0]!.querySelector(".toast-body")?.textContent).toBe("Bob: third");
  });

  it("shows a single message as before", () => {
    const host = mount(<ToastStack onDismiss={() => {}} toasts={[channelToast("1", "hello")]} />);

    expect(host.querySelector(".toast-title")?.textContent).toBe("Bob · #general");
    expect(host.querySelector(".toast-body")?.textContent).toBe("hello");
  });

  it("dismisses every message of a group when tapped", () => {
    const onDismiss = vi.fn();
    const host = mount(
      <ToastStack onDismiss={onDismiss} toasts={[channelToast("1", "first"), channelToast("2", "second")]} />,
    );

    (host.querySelector(".toast") as HTMLButtonElement).click();
    expect(onDismiss.mock.calls.map(([id]) => id)).toEqual(["1", "2"]);
  });
});
