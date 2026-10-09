import type { Channel, Message, MessageAttachment, User } from "@loam/schema";
import type { VNode } from "preact";
import { render } from "preact";
import { LocationProvider } from "preact-iso";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Conversation } from "../lib/protocol";
import { installViewportSync } from "../lib/viewport";
import { ConversationView, type ConversationViewProps } from "./ConversationView";

// Pre-release review 2026-09-25: everything conversation-scoped (composer draft, pending/in-flight
// attachments, location draft, report dialogs, thread reply drafts) must NOT follow the user into the
// next conversation — one Enter used to post a DM draft or a private photo into a public channel.

const mounted: HTMLDivElement[] = [];

function mount(element: VNode): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  render(<LocationProvider>{element}</LocationProvider>, container);
  mounted.push(container);
  return container;
}

function rerender(container: HTMLDivElement, element: VNode): void {
  render(<LocationProvider>{element}</LocationProvider>, container);
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function typeInto(field: HTMLTextAreaElement | HTMLInputElement, text: string): void {
  field.value = text;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

afterEach(() => {
  for (const container of mounted) {
    render(null, container);
    container.remove();
  }
  mounted.length = 0;
});

const me: User = { id: "user.me", displayName: "Me", type: "human", isAdmin: false, createdAt: 1, ephemeral: true };
const peer: User = { id: "user.peer", displayName: "Ada", type: "human", isAdmin: false, createdAt: 1, ephemeral: true };
const general = { id: "general", name: "general", visibility: "public", createdAt: 1 } as Channel;

const GENERAL: Conversation = { kind: "channel", id: "general" };
const DM: Conversation = { kind: "dm", id: peer.id };

function post(id: string, authorId = peer.id): Message {
  return { id, type: "channelPost", channelId: "general", authorId, body: `body of ${id}`, createdAt: 100 } as Message;
}

function dmMessage(id: string): Message {
  return { id, type: "dm", recipientUserId: me.id, authorId: peer.id, body: `dm ${id}`, createdAt: 100 } as Message;
}

function view(overrides: Partial<ConversationViewProps>): VNode {
  const props: ConversationViewProps = {
    allowAttachments: true,
    allowLocationSharing: true,
    channels: [general],
    conversation: GENERAL,
    currentUser: me,
    messages: [],
    onChannelUpsert: () => {},
    onDelete: () => {},
    onEdit: async () => true,
    onLeftChannel: () => {},
    onReact: async () => {},
    onSend: async () => {},
    onThreadReply: async () => {},
    onTyping: () => {},
    onUploadAttachment: async () => ({ id: "att", mimeType: "image/webp", width: 1, height: 1 }) as MessageAttachment,
    typers: [],
    users: [me, peer],
    usersById: new Map([
      [me.id, me],
      [peer.id, peer],
    ]),
    ...overrides,
  };
  return <ConversationView {...props} />;
}

function composerText(host: HTMLElement): HTMLTextAreaElement {
  return host.querySelector<HTMLTextAreaElement>(".conversation .composer textarea")!;
}

describe("ConversationView is scoped per conversation", () => {
  it("a typed DM draft does not survive switching to a public channel", async () => {
    const onSend = vi.fn(async () => {});
    const host = mount(view({ conversation: DM, messages: [dmMessage("d1")], onSend }));
    typeInto(composerText(host), "private note for Ada only");
    await tick();

    rerender(host, view({ conversation: GENERAL, messages: [post("p1")], onSend }));
    await tick();

    expect(composerText(host).value).toBe("");
    expect(host.querySelector<HTMLButtonElement>(".conversation .composer-send")!.disabled).toBe(true);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("an attachment upload that finishes after the switch is not attached to the new conversation", async () => {
    let finishUpload: (attachment: MessageAttachment) => void = () => {};
    const onUploadAttachment = vi.fn(
      () =>
        new Promise<MessageAttachment>((resolve) => {
          finishUpload = resolve;
        }),
    );
    const host = mount(view({ conversation: DM, onUploadAttachment }));
    const input = host.querySelector<HTMLInputElement>('.conversation input[type="file"]')!;
    const photo = new File(["x"], "private-photo.png", { type: "image/png" });
    Object.defineProperty(input, "files", { value: [photo], configurable: true });
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    expect(host.querySelector(".attachment-chip")?.textContent).toContain("private-photo.png");

    rerender(host, view({ conversation: GENERAL, onUploadAttachment }));
    await tick();
    finishUpload({ id: "att.private", mimeType: "image/png", width: 1, height: 1 } as MessageAttachment);
    await tick();

    expect(host.querySelector(".attachment-chip")).toBeNull();
    expect(host.querySelector<HTMLButtonElement>(".conversation .composer-send")!.disabled).toBe(true);
  });

  it("a location draft does not carry over", async () => {
    const host = mount(view({ conversation: DM }));
    host.querySelector<HTMLButtonElement>(".composer-location-toggle")!.click();
    await tick();
    typeInto(host.querySelector<HTMLInputElement>(".composer-location-label")!, "my tent, row 4");
    await tick();

    rerender(host, view({ conversation: GENERAL }));
    await tick();

    expect(host.querySelector(".composer-location-label")).toBeNull();
  });

  it("an open message report dialog does not follow into the next conversation", async () => {
    const host = mount(view({ conversation: GENERAL, messages: [post("p1")] }));
    // The ⋮ button opens the message's actions sheet (the same one the time opens); Report is in it.
    host.querySelector<HTMLButtonElement>(".message-more")!.click();
    await tick();
    Array.from(host.querySelectorAll<HTMLButtonElement>(".message-sheet .menu-item"))
      .find((item) => item.textContent === "Report")!
      .click();
    await tick();
    expect(host.querySelector(".report-dialog")).not.toBeNull();

    rerender(host, view({ conversation: { kind: "channel", id: "other" }, channels: [general], messages: [] }));
    await tick();
    expect(host.querySelector(".report-dialog")).toBeNull();
  });

  it("a thread reply draft does not carry from one thread into another", async () => {
    const messages = [post("p1"), post("p2")];
    const host = mount(view({ conversation: { kind: "channel", id: "general", threadId: "p1" }, messages }));
    const threadComposer = (): HTMLTextAreaElement => host.querySelector<HTMLTextAreaElement>(".thread-panel .composer textarea")!;
    typeInto(threadComposer(), "reply meant for p1");
    await tick();

    rerender(host, view({ conversation: { kind: "channel", id: "general", threadId: "p2" }, messages }));
    await tick();
    expect(threadComposer().value).toBe("");
  });

  it("keeps the draft while staying in the same conversation (opening a thread doesn't reset it)", async () => {
    const messages = [post("p1")];
    const host = mount(view({ conversation: GENERAL, messages }));
    typeInto(composerText(host), "still typing");
    await tick();

    rerender(host, view({ conversation: { kind: "channel", id: "general", threadId: "p1" }, messages }));
    await tick();
    expect(composerText(host).value).toBe("still typing");
  });
});

describe("ConversationView not-found state", () => {
  it("shows 'not available' instead of the list and composer when the server 404'd the conversation", () => {
    const host = mount(view({ conversation: { kind: "channel", id: "ghost" }, notFound: true }));
    expect(host.querySelector(".conversation-not-found")?.textContent).toContain("Conversation not available");
    expect(host.querySelector(".composer")).toBeNull();
  });
});

describe("mobile back controls have an accessible name", () => {
  it("labels the header back link and the thread back button", () => {
    const host = mount(view({ conversation: { kind: "channel", id: "general", threadId: "p1" }, messages: [post("p1")] }));
    const backs = Array.from(host.querySelectorAll(".mobile-back"));
    expect(backs.length).toBe(2);
    for (const back of backs) {
      expect(back.getAttribute("aria-label")).toBe("Back");
    }
  });
});

describe("the conversation header", () => {
  it("keeps DM actions in the overflow menu: the title is never crowded by buttons", async () => {
    const host = mount(view({ conversation: DM, onSetBlocked: async () => {} }));
    const header = host.querySelector(".conversation .screen-header")!;
    expect(header.querySelector(".screen-title")?.textContent).toBe("Ada");
    // No raw user id under the name (it meant nothing to people); "Online" appears only while connected.
    expect(header.textContent).not.toContain(peer.id);
    // Only the back link and the ⋮ trigger are buttons/links in the header.
    expect(header.querySelectorAll(".screen-header-actions button").length).toBe(1);

    header.querySelector<HTMLButtonElement>(".menu-trigger")!.click();
    await tick();
    const labels = Array.from(host.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent);
    expect(labels).toEqual(["Search messages", "Report this user", "Block"]);
  });

  it("shows Online in a DM header when the peer is connected", () => {
    const host = mount(view({ conversation: DM, onlineUserIds: new Set([peer.id]) }));
    expect(host.querySelector(".conversation .screen-subtitle")?.textContent).toContain("Online");
    expect(host.querySelector(".conversation .screen-header .presence-dot")).not.toBeNull();
  });

  it("offers a Members button (with the count) for a private channel, opening the members dialog", async () => {
    const secret = {
      id: "secret",
      name: "secret",
      visibility: "private",
      ownerUserId: me.id,
      memberUserIds: [me.id, peer.id],
      createdAt: 1,
    } as Channel;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("[]", { status: 200 }));
    const host = mount(view({ channels: [general, secret], conversation: { kind: "channel", id: "secret" } }));
    const button = host.querySelector<HTMLButtonElement>(".members-button")!;
    expect(button.textContent).toContain("2");
    button.click();
    await tick();
    expect(host.querySelector(".members-dialog")?.getAttribute("role")).toBe("dialog");
    fetchMock.mockRestore();
  });
});

describe("the message list", () => {
  it("groups consecutive messages: one avatar and name for the group", () => {
    const messages = [post("p1"), { ...post("p2"), createdAt: 160 } as Message, { ...post("p3", me.id), createdAt: 200 } as Message];
    const host = mount(view({ messages }));
    const items = Array.from(host.querySelectorAll(".conversation .message"));
    expect(items.map((item) => [item.classList.contains("group-first"), item.classList.contains("group-last")])).toEqual([
      [true, false],
      [false, true],
      [true, true],
    ]);
    expect(host.querySelectorAll(".conversation .message-author").length).toBe(1);
    expect(host.querySelectorAll(".conversation .message-gutter .avatar").length).toBe(1);
  });

  it("shows the typing indicator inside the list area, as a live region", () => {
    const host = mount(view({ typers: ["Ada"] }));
    const indicator = host.querySelector(".message-list-wrap .typing-indicator")!;
    expect(indicator.getAttribute("aria-live")).toBe("polite");
    expect(indicator.textContent).toContain("Ada is typing");
    // Never a sibling of the composer (it can't push the composer off screen).
    expect(host.querySelector(".conversation > .typing-indicator")).toBeNull();
  });

  /** Give the list fake scroll metrics (jsdom has no layout) and record programmatic scrolls. */
  function fakeScroller(list: HTMLElement, metrics: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
    Object.defineProperty(list, "scrollHeight", { configurable: true, get: () => metrics.scrollHeight });
    Object.defineProperty(list, "clientHeight", { configurable: true, get: () => metrics.clientHeight });
    Object.defineProperty(list, "scrollTop", {
      configurable: true,
      get: () => metrics.scrollTop,
      set: (value: number) => {
        metrics.scrollTop = Math.min(value, metrics.scrollHeight - metrics.clientHeight);
      },
    });
    return metrics;
  }

  it("follows new messages at the bottom, but offers a 'new messages' pill after scrolling up", async () => {
    const first = [post("p1")];
    const host = mount(view({ messages: first }));
    const list = host.querySelector<HTMLElement>(".conversation .message-list")!;
    const metrics = fakeScroller(list, { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });

    // At the bottom: a new message keeps it pinned.
    metrics.scrollHeight = 1100;
    rerender(host, view({ messages: [...first, { ...post("p2"), createdAt: 200 } as Message] }));
    await tick();
    expect(metrics.scrollTop).toBe(700);
    expect(host.querySelector(".new-messages-pill")).toBeNull();

    // Scrolled up to read history: new messages don't yank the view; a pill appears instead.
    metrics.scrollTop = 100;
    list.dispatchEvent(new Event("scroll"));
    metrics.scrollHeight = 1200;
    rerender(host, view({ messages: [...first, { ...post("p2"), createdAt: 200 } as Message, { ...post("p3"), createdAt: 300 } as Message] }));
    await tick();
    expect(metrics.scrollTop).toBe(100);
    const pill = host.querySelector<HTMLButtonElement>(".new-messages-pill")!;
    expect(pill.textContent).toContain("New messages");

    pill.click();
    await tick();
    expect(metrics.scrollTop).toBe(800);
    expect(host.querySelector(".new-messages-pill")).toBeNull();
  });

  it("re-pins to the bottom when the keyboard shrinks the viewport", async () => {
    const visual = Object.assign(new EventTarget(), { height: 700, offsetTop: 0, scale: 1 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: visual });
    const stop = installViewportSync(window);
    const host = mount(view({ messages: [post("p1")] }));
    const list = host.querySelector<HTMLElement>(".conversation .message-list")!;
    const metrics = fakeScroller(list, { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });

    // The keyboard opens: the list gets shorter, so the old scrollTop no longer reaches the end.
    metrics.clientHeight = 200;
    visual.height = 400;
    visual.dispatchEvent(new Event("resize"));
    expect(metrics.scrollTop).toBe(800);

    stop();
    Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined });
  });
});
