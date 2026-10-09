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

/** Open the actions sheet from the toolbar's ⋮ button and return its action labels (below the reactions). */
async function sheetLabels(host: HTMLElement): Promise<string[]> {
  host.querySelector<HTMLButtonElement>(".message-more")!.click();
  await tick();
  return Array.from(host.querySelectorAll(".message-sheet .menu-item-label")).map((node) => node.textContent ?? "");
}

/** An action (in the open sheet) by its label. */
function sheetItem(host: HTMLElement, label: string): HTMLButtonElement {
  return Array.from(host.querySelectorAll<HTMLButtonElement>(".message-sheet .menu-item")).find(
    (item) => item.textContent === label,
  )!;
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

    expect(host.querySelector(".message-author")?.textContent).toBe("Ada Lovelace");
    const body = host.querySelector(".markdown-body");
    expect(body?.textContent).toContain("hello");
    // Markdown is rendered to HTML, so the emphasis becomes a <strong> element.
    expect(body?.querySelector("strong")?.textContent).toBe("world");
  });

  it("offers no edit or delete for another user's message when not admin — only copy and report", async () => {
    const host = mount(
      <MessageItem
        currentUser={currentUser}
        message={post()}
        onReport={() => {}}
        reactions={[]}
        usersById={new Map([[author.id, author]])}
        {...noop}
      />,
    );

    expect(await sheetLabels(host)).toEqual(["Copy text", "Report"]);
  });

  it("offers edit and delete on the current user's own message, behind the ⋮ button's sheet (no visible icon row)", async () => {
    const host = mount(
      <MessageItem
        currentUser={currentUser}
        message={post({ authorId: currentUser.id })}
        reactions={[]}
        usersById={new Map([[currentUser.id, currentUser]])}
        {...noop}
      />,
    );

    // Nothing but the toolbar's icon buttons is rendered until the sheet opens, and there is no separate
    // popover menu any more: the ⋮ button is a plain button into the one actions sheet.
    expect(host.querySelector(".message-sheet")).toBeNull();
    expect(host.querySelector('[aria-haspopup="menu"]')).toBeNull();
    expect(host.querySelector(".message-more")?.getAttribute("aria-haspopup")).toBe("dialog");
    expect(await sheetLabels(host)).toEqual(["Copy text", "Edit", "Delete"]);
  });

  it("switches to the inline edit form from the sheet, and Escape cancels it", async () => {
    const host = mount(
      <MessageItem
        currentUser={currentUser}
        message={post({ authorId: currentUser.id, body: "draft me" })}
        reactions={[]}
        usersById={new Map([[currentUser.id, currentUser]])}
        {...noop}
      />,
    );

    await sheetLabels(host);
    sheetItem(host, "Edit").click();
    await tick();
    const textarea = host.querySelector<HTMLTextAreaElement>(".message-edit textarea")!;
    expect(textarea.value).toBe("draft me");
    textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    await tick();
    expect(host.querySelector(".message-edit")).toBeNull();
  });

  it("puts the time and the edited tag inside the bubble, and tapping the time opens the actions sheet", async () => {
    const onReact = vi.fn(async () => {});
    const host = mount(
      <MessageItem
        currentUser={currentUser}
        message={post({ editedAt: Date.now() } as Partial<Message>)}
        onReport={() => {}}
        reactions={[]}
        usersById={new Map([[author.id, author]])}
        {...noop}
        onReact={onReact}
      />,
    );

    const bubble = host.querySelector(".message-bubble")!;
    expect(bubble.querySelector(".message-edited")?.textContent).toBe("edited");
    const time = bubble.querySelector<HTMLButtonElement>("button.message-time")!;
    time.click();
    await tick();

    const sheet = host.querySelector<HTMLElement>(".message-sheet")!;
    expect(sheet.getAttribute("role")).toBe("dialog");
    const labels = Array.from(sheet.querySelectorAll(".menu-item-label")).map((node) => node.textContent);
    expect(labels).toEqual(["Copy text", "Report"]);

    sheet.querySelector<HTMLButtonElement>(".sheet-reaction")!.click();
    await tick();
    expect(onReact).toHaveBeenCalledWith("msg.1", "👍");
    expect(host.querySelector(".message-sheet")).toBeNull();
  });

  it("renders text and emoji-only messages where Intl.Segmenter is missing (Chrome 80 to 86)", () => {
    const nativeSegmenter = Intl.Segmenter;
    delete (Intl as { Segmenter?: unknown }).Segmenter;
    try {
      const text = mount(
        <MessageItem currentUser={currentUser} message={post()} reactions={[]} usersById={new Map()} {...noop} />,
      );
      expect(text.querySelector(".markdown-body strong")?.textContent).toBe("world");
      expect(text.querySelector(".jumbo")).toBeNull();

      const emoji = mount(
        <MessageItem
          currentUser={currentUser}
          message={post({ body: "👍🏽 👩‍👩‍👧" } as Partial<Message>)}
          reactions={[]}
          usersById={new Map()}
          {...noop}
        />,
      );
      expect(emoji.querySelector(".jumbo")).not.toBeNull();
    } finally {
      (Intl as { Segmenter?: unknown }).Segmenter = nativeSegmenter;
    }
  });

  it("shows the avatar and name only on the first message of a group", () => {
    const first = mount(
      <MessageItem currentUser={currentUser} message={post()} reactions={[]} usersById={new Map([[author.id, author]])} {...noop} />,
    );
    expect(first.querySelector(".message-gutter .avatar")).not.toBeNull();
    expect(first.querySelector(".message-author")).not.toBeNull();

    const later = mount(
      <MessageItem
        currentUser={currentUser}
        groupFirst={false}
        message={post()}
        reactions={[]}
        usersById={new Map([[author.id, author]])}
        {...noop}
      />,
    );
    expect(later.querySelector(".message-gutter .avatar")).toBeNull();
    expect(later.querySelector(".message-author")).toBeNull();
    // The gutter itself stays, so every bubble in the group lines up.
    expect(later.querySelector(".message-gutter")).not.toBeNull();
  });

  it("never shows the author name when showAuthor is off (a DM)", () => {
    const host = mount(
      <MessageItem
        currentUser={currentUser}
        message={post()}
        reactions={[]}
        showAuthor={false}
        usersById={new Map([[author.id, author]])}
        {...noop}
      />,
    );
    expect(host.querySelector(".message-author")).toBeNull();
  });

  it("renders reactions as pressed/unpressed chips that toggle", async () => {
    const onReact = vi.fn(async () => {});
    const host = mount(
      <MessageItem
        currentUser={currentUser}
        message={post()}
        reactions={[
          { reaction: "👍", count: 2, active: true },
          { reaction: "🎉", count: 1, active: false },
        ]}
        usersById={new Map([[author.id, author]])}
        {...noop}
        onReact={onReact}
      />,
    );
    const chips = Array.from(host.querySelectorAll<HTMLButtonElement>(".reaction-chip"));
    expect(chips.map((chip) => [chip.textContent, chip.getAttribute("aria-pressed")])).toEqual([
      ["👍 2", "true"],
      ["🎉 1", "false"],
    ]);
    chips[0]!.click();
    await tick();
    expect(onReact).toHaveBeenCalledWith("msg.1", "👍");
  });

  it("hides reactions, reply and edit in a read-only (archived) channel", () => {
    const host = mount(
      <MessageItem
        currentUser={currentUser}
        message={post({ authorId: currentUser.id })}
        onOpenThread={() => {}}
        reactions={[]}
        readOnly
        usersById={new Map([[currentUser.id, currentUser]])}
        {...noop}
      />,
    );
    expect(host.querySelector(".quick-reaction")).toBeNull();
    expect(host.querySelector(".message-reply-button")).toBeNull();
    // The ⋮ button is still there (Copy stays useful), but Edit is gone from its sheet.
    expect(host.querySelector(".message-more")).not.toBeNull();
  });

  it("offers no edit in a read-only channel even through the ⋮ button's sheet", async () => {
    const host = mount(
      <MessageItem
        currentUser={currentUser}
        message={post({ authorId: currentUser.id })}
        reactions={[]}
        readOnly
        usersById={new Map([[currentUser.id, currentUser]])}
        {...noop}
      />,
    );
    expect(await sheetLabels(host)).toEqual(["Copy text"]);
  });

  it("offers nothing to react to, reply to, copy or edit on a moderator-removed message", async () => {
    const host = mount(
      <MessageItem
        currentUser={currentUser}
        message={post({ authorId: currentUser.id, meta: { removedByModerator: true } })}
        onOpenThread={() => {}}
        onReport={() => {}}
        reactions={[]}
        usersById={new Map([[currentUser.id, currentUser]])}
        {...noop}
      />,
    );
    expect(host.querySelector(".message-removed")).not.toBeNull();
    expect(host.querySelector(".quick-reaction")).toBeNull();
    expect(host.querySelector(".message-reply-button")).toBeNull();
    expect(host.querySelector(".message-more")).toBeNull();
    expect(host.querySelector(".message-toolbar")).toBeNull();
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

  it("opens the full reaction grid from the toolbar's ⋮ button, which is the only other button there", async () => {
    const host = mount(
      <MessageItem currentUser={currentUser} message={post()} reactions={[]} usersById={new Map()} {...noop} />,
    );

    // No separate smiley: the ⋮ button is the one way into the sheet, so there is one destination to learn.
    expect(host.querySelector('[aria-label="More reactions"]')).toBeNull();
    const toolbarButtons = Array.from(host.querySelectorAll<HTMLButtonElement>(".message-toolbar button"));
    expect(toolbarButtons.filter((button) => !button.classList.contains("quick-reaction"))).toHaveLength(1);

    host.querySelector<HTMLButtonElement>('[aria-label="More actions"]')!.click();
    await tick();

    const tiles = Array.from(host.querySelectorAll<HTMLButtonElement>(".message-sheet .sheet-reaction"));
    // Fifteen emoji, then the "+" tile (no recent picks on a fresh device).
    expect(tiles).toHaveLength(16);
    expect(tiles.slice(0, 5).map((tile) => tile.textContent)).toEqual(["👍", "👎", "❤️", "🙏", "🤞"]);
    expect(tiles[15]!.getAttribute("aria-label")).toBe("Other emoji");
  });

  it("the ⋮ button and the time open the same sheet, with Reply first when the message can be replied to", async () => {
    const onOpenThread = vi.fn();
    function mountOne(): HTMLDivElement {
      return mount(
        <MessageItem
          currentUser={currentUser}
          message={post()}
          onOpenThread={onOpenThread}
          onReport={() => {}}
          reactions={[]}
          usersById={new Map([[author.id, author]])}
          {...noop}
        />,
      );
    }

    const viaMore = mountOne();
    expect(await sheetLabels(viaMore)).toEqual(["Reply in thread", "Copy text", "Report"]);
    expect(viaMore.querySelectorAll(".message-sheet .sheet-reaction").length).toBeGreaterThan(0);

    const viaTime = mountOne();
    viaTime.querySelector<HTMLButtonElement>("button.message-time")!.click();
    await tick();
    expect(Array.from(viaTime.querySelectorAll(".message-sheet .menu-item-label")).map((node) => node.textContent)).toEqual([
      "Reply in thread",
      "Copy text",
      "Report",
    ]);

    // Reply from the sheet reaches the thread like the toolbar's reply button does, and closes the sheet first.
    sheetItem(viaMore, "Reply in thread").click();
    await tick();
    expect(onOpenThread).toHaveBeenCalledWith("msg.1");
    expect(viaMore.querySelector(".message-sheet")).toBeNull();
  });

  it("reacts with any emoji typed into the sheet's emoji field, refuses plain text, and remembers the pick", async () => {
    localStorage.clear();
    const onReact = vi.fn(async () => {});
    const host = mount(
      <MessageItem
        currentUser={currentUser}
        message={post()}
        reactions={[]}
        usersById={new Map()}
        {...noop}
        onReact={onReact}
      />,
    );

    async function openField(): Promise<HTMLInputElement> {
      host.querySelector<HTMLButtonElement>("button.message-time")!.click();
      await tick();
      const more = host.querySelector<HTMLButtonElement>('.sheet-reaction[aria-label="Other emoji"]')!;
      expect(more.getAttribute("aria-expanded")).toBe("false");
      more.click();
      await tick();
      expect(more.getAttribute("aria-expanded")).toBe("true");
      return host.querySelector<HTMLInputElement>(".sheet-emoji-field input")!;
    }

    function type(input: HTMLInputElement, value: string): Promise<void> {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return tick();
    }

    const input = await openField();
    // Focused for the keyboard straight away (after Preact's deferred effect).
    await vi.waitFor(() => expect(document.activeElement).toBe(input));
    await type(input, "lol");
    expect(host.querySelector(".sheet-emoji-field .field-error")?.textContent).toBe(
      "Only an emoji can be used as a reaction.",
    );
    expect(onReact).not.toHaveBeenCalled();

    await type(input, "lol 🦔");
    expect(onReact).toHaveBeenCalledWith("msg.1", "🦔");
    expect(host.querySelector(".message-sheet")).toBeNull();

    // Next time the pick sits right after the "+" tile, one tap away.
    await openField();
    const tiles = Array.from(host.querySelectorAll<HTMLButtonElement>(".message-sheet .sheet-reaction"));
    expect(tiles.map((tile) => tile.textContent).slice(16)).toEqual(["🦔"]);
    localStorage.clear();
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
