import type { Message, User } from "@loam/schema";
import type { VNode } from "preact";
import { render } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MessageItem } from "./MessageItem";

// Rendered-component tests: mount real Preact components into jsdom and assert on the resulting DOM.

const mounted: HTMLDivElement[] = [];

function mount(element: VNode): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  render(element, container);
  mounted.push(container);
  return container;
}

/** Let Preact flush its batched state update (it re-renders on a microtask, not synchronously). */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  for (const container of mounted) {
    render(null, container);
    container.remove();
  }
  mounted.length = 0;
});

const currentUser: User = {
  id: "user.me",
  displayName: "Me",
  type: "human",
  isAdmin: false,
  createdAt: 1,
  ephemeral: true,
};

const author: User = {
  id: "user.author",
  displayName: "Ada Lovelace",
  type: "human",
  isAdmin: false,
  createdAt: 1,
  ephemeral: true,
};

/** A minimal channel-post message; only the fields MessageItem reads need to be real. */
function post(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg.1",
    type: "channelPost",
    channelId: "channel.general",
    authorId: "user.author",
    body: "hello **world**",
    createdAt: Date.now(),
    ...overrides,
  } as Message;
}

const noop = {
  onDelete: () => {},
  onEdit: async () => true,
  onReact: async () => {},
};

describe("MessageItem", () => {
  it("renders the author name and the markdown-rendered body", () => {
    const host = mount(
      <MessageItem
        currentUser={currentUser}
        message={post()}
        reactions={[]}
        usersById={new Map([[author.id, author]])}
        {...noop}
      />,
    );

    expect(host.querySelector(".message-meta strong")?.textContent).toBe("Ada Lovelace");
    const body = host.querySelector(".markdown-body");
    expect(body?.textContent).toContain("hello");
    // Markdown is rendered to HTML, so the emphasis becomes a <strong> element.
    expect(body?.querySelector("strong")?.textContent).toBe("world");
  });

  it("offers no delete control for another user's message when not admin", () => {
    const host = mount(
      <MessageItem
        currentUser={currentUser}
        message={post()}
        reactions={[]}
        usersById={new Map([[author.id, author]])}
        {...noop}
      />,
    );

    expect(host.querySelector(".message-delete")).toBeNull();
    expect(host.querySelector(".message-edit-button")).toBeNull();
  });

  it("offers edit and delete controls on the current user's own message", () => {
    const host = mount(
      <MessageItem
        currentUser={currentUser}
        message={post({ authorId: currentUser.id })}
        reactions={[]}
        usersById={new Map([[currentUser.id, currentUser]])}
        {...noop}
      />,
    );

    expect(host.querySelector(".message-delete")).not.toBeNull();
    expect(host.querySelector(".message-edit-button")).not.toBeNull();
  });

  it("fires onReact when a quick reaction is clicked", async () => {
    const onReact = vi.fn(async () => {});
    const host = mount(
      <MessageItem
        currentUser={currentUser}
        message={post()}
        reactions={[]}
        usersById={new Map([[author.id, author]])}
        {...noop}
        onReact={onReact}
      />,
    );

    const quick = host.querySelector(".quick-reaction") as HTMLButtonElement;
    expect(quick).not.toBeNull();
    quick.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();

    expect(onReact).toHaveBeenCalledWith("msg.1", quick.textContent?.trim());
  });

  it("invokes onOpenThread with the reply affordance when provided", () => {
    const onOpenThread = vi.fn();
    const host = mount(
      <MessageItem
        currentUser={currentUser}
        message={post()}
        onOpenThread={onOpenThread}
        reactions={[]}
        replyCount={2}
        usersById={new Map([[author.id, author]])}
        {...noop}
      />,
    );

    const threadButton = host.querySelector(".thread-button") as HTMLButtonElement;
    expect(threadButton).not.toBeNull();
    threadButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onOpenThread).toHaveBeenCalledWith("msg.1");
  });
});
