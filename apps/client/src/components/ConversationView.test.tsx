import type { Channel, Message, MessageAttachment, User } from "@loam/schema";
import type { VNode } from "preact";
import { render } from "preact";
import { LocationProvider } from "preact-iso";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Conversation } from "../lib/protocol";
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
    host.querySelector<HTMLButtonElement>(".message-report")!.click();
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
