import type { Channel, Message, MessageAttachment, User } from "@loam/schema";
import type { VNode } from "preact";
import { render } from "preact";
import { LocationProvider } from "preact-iso";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseBlockList, withoutBlockedAuthors, withoutBlockedReactions } from "../lib/blocks";
import type { Conversation } from "../lib/protocol";
import { BlockedUsersPanel } from "./BlockedUsersPanel";
import { ConversationView, type ConversationViewProps } from "./ConversationView";

// User blocking (docs/30 B3): the DM banner + disabled composer, the collapsed channel placeholder, and
// the Settings list. DM refusal itself is server-side (apps/server/src/blocks.test.ts).

const mounted: HTMLDivElement[] = [];

function mount(element: VNode): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  render(<LocationProvider>{element}</LocationProvider>, container);
  mounted.push(container);
  return container;
}

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
});

const me: User = { id: "user.me", displayName: "Me", type: "human", isAdmin: false, createdAt: 1, ephemeral: true };
const troll: User = { id: "user.troll", displayName: "Troll", type: "human", isAdmin: false, createdAt: 1, ephemeral: true };
const friend: User = { id: "user.friend", displayName: "Friend", type: "human", isAdmin: false, createdAt: 1, ephemeral: true };
const bot: User = { id: "llm.bot", displayName: "Assistant", type: "bot", isAdmin: false, createdAt: 1, ephemeral: false };
const general = { id: "general", name: "general", visibility: "public", createdAt: 1 } as Channel;

const GENERAL: Conversation = { kind: "channel", id: "general" };
const BLOCKED = new Set([troll.id]);

function post(id: string, authorId: string, body = `body of ${id}`): Message {
  return { id, type: "channelPost", channelId: "general", authorId, body, createdAt: 100 } as Message;
}

function reaction(id: string, authorId: string, targetMessageId: string, emoji = "👍"): Message {
  return { id, type: "reaction", authorId, targetMessageId, reaction: emoji, createdAt: 101 } as Message;
}

function dm(id: string, authorId: string, recipientUserId: string): Message {
  return { id, type: "dm", authorId, recipientUserId, body: `dm ${id}`, createdAt: 100 } as Message;
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
    users: [me, troll, friend, bot],
    usersById: new Map([me, troll, friend, bot].map((user) => [user.id, user])),
    ...overrides,
  };
  return <ConversationView {...props} />;
}

function buttonNamed(host: HTMLElement, name: string): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === name);
}

describe("channel content from a blocked user", () => {
  it("collapses their post to a placeholder (no name, body or avatar) that reveals on tap", async () => {
    const host = mount(
      view({ blockedUserIds: BLOCKED, messages: [post("p1", troll.id, "nasty words"), post("p2", friend.id, "hello")] }),
    );

    const list = host.querySelector(".conversation .message-list")!;
    expect(list.textContent).not.toContain("nasty words");
    expect(list.textContent).not.toContain("Troll");
    expect(list.textContent).toContain("Message from a blocked user");
    expect(list.textContent).toContain("hello");
    expect(list.querySelectorAll(".message-blocked .avatar").length).toBe(0);

    buttonNamed(host, "Show")!.click();
    await tick();
    expect(list.textContent).toContain("nasty words");
  });

  it("shows everything when nobody is blocked", () => {
    const host = mount(view({ messages: [post("p1", troll.id, "normal words")] }));
    expect(host.textContent).toContain("normal words");
    expect(host.querySelector(".message-blocked")).toBeNull();
  });

  it("stops counting their reactions", () => {
    const messages = [post("p1", friend.id), reaction("r1", troll.id, "p1", "💩"), reaction("r2", friend.id, "p1", "👍")];
    const host = mount(view({ blockedUserIds: BLOCKED, messages }));
    const counts = Array.from(host.querySelectorAll(".reaction")).map((node) => node.textContent);
    expect(counts).toEqual(["👍 1"]);
  });

  it("collapses their replies in an open thread too", () => {
    const reply = {
      id: "r1",
      type: "channelReply",
      channelId: "general",
      parentMessageId: "p1",
      authorId: troll.id,
      body: "reply from troll",
      createdAt: 102,
    } as Message;
    const host = mount(
      view({
        blockedUserIds: BLOCKED,
        conversation: { kind: "channel", id: "general", threadId: "p1" },
        messages: [post("p1", friend.id), reply],
      }),
    );
    const thread = host.querySelector(".thread-panel")!;
    expect(thread.textContent).not.toContain("reply from troll");
    expect(thread.textContent).toContain("Message from a blocked user");
  });

  it("leaves their replies out of a post's reply count", () => {
    const reply = (id: string, authorId: string): Message =>
      ({ id, type: "channelReply", channelId: "general", parentMessageId: "p1", authorId, body: id, createdAt: 102 }) as Message;
    const messages = [post("p1", friend.id), reply("r1", troll.id), reply("r2", troll.id), reply("r3", friend.id)];

    const blocked = mount(view({ blockedUserIds: BLOCKED, messages }));
    expect(blocked.querySelector(".conversation .message-list")!.textContent).toContain("1 reply");

    const unblocked = mount(view({ messages }));
    expect(unblocked.querySelector(".conversation .message-list")!.textContent).toContain("3 replies");
  });
});

describe("a DM with someone you blocked", () => {
  it("shows the banner with Unblock and disables the composer", async () => {
    const onSetBlocked = vi.fn(async () => {});
    const host = mount(
      view({
        blockedUserIds: BLOCKED,
        conversation: { kind: "dm", id: troll.id },
        messages: [dm("d1", troll.id, me.id)],
        onSetBlocked,
      }),
    );

    expect(host.querySelector(".blocked-banner")?.textContent).toContain("You blocked this user.");
    // The composer is replaced by its disabled notice — no textarea to type into.
    expect(host.querySelector(".conversation .composer textarea")).toBeNull();
    expect(host.querySelector(".composer-disabled")?.textContent).toContain("Unblock them to send a message");
    // The old conversation stays readable (it's the user's own DM).
    expect(host.querySelector(".message-list")?.textContent).toContain("dm d1");
    // No "Block" button while already blocked; Report stays.
    expect(buttonNamed(host, "Block")).toBeUndefined();
    expect(buttonNamed(host, "Report this user")).toBeDefined();

    buttonNamed(host, "Unblock")!.click();
    await tick();
    expect(onSetBlocked).toHaveBeenCalledWith(troll.id, false);
  });

  it("offers Block beside Report, confirming first", async () => {
    const onSetBlocked = vi.fn(async () => {});
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const host = mount(view({ conversation: { kind: "dm", id: friend.id }, onSetBlocked }));

    expect(host.querySelector(".blocked-banner")).toBeNull();
    expect(host.querySelector(".conversation .composer textarea")).not.toBeNull();
    const block = buttonNamed(host, "Block")!;
    expect(buttonNamed(host, "Report this user")).toBeDefined();

    block.click(); // declined
    expect(onSetBlocked).not.toHaveBeenCalled();
    block.click(); // confirmed
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(String(confirm.mock.calls[0]?.[0])).toContain("Friend");
    expect(onSetBlocked).toHaveBeenCalledWith(friend.id, true);
  });

  it("never offers Block for the assistant bot or a mesh sender", () => {
    const meshSender: User = { ...friend, id: "mesh.abcdefghijklmnopqrstuvwxyz", displayName: "Far away" };
    const botHost = mount(view({ conversation: { kind: "dm", id: bot.id }, onSetBlocked: async () => {} }));
    expect(buttonNamed(botHost, "Block")).toBeUndefined();
    const meshHost = mount(
      view({
        conversation: { kind: "dm", id: meshSender.id },
        onSetBlocked: async () => {},
        usersById: new Map([me, meshSender].map((user) => [user.id, user])),
      }),
    );
    expect(buttonNamed(meshHost, "Block")).toBeUndefined();
  });
});

describe("BlockedUsersPanel (Settings)", () => {
  it("lists blocked people by name — falling back to a generated name — and unblocks", async () => {
    const onSetBlocked = vi.fn(async () => {});
    const host = mount(
      <BlockedUsersPanel
        blockedUserIds={new Set([troll.id, "user.gone"])}
        onSetBlocked={onSetBlocked}
        usersById={new Map([[troll.id, troll]])}
      />,
    );

    const rows = Array.from(host.querySelectorAll(".blocked-users-list li"));
    expect(rows.length).toBe(2);
    expect(rows[0]?.textContent).toContain("Troll");
    expect(rows[1]?.querySelector(".blocked-users-name")?.textContent).not.toBe("");

    rows[0]!.querySelector("button")!.click();
    await tick();
    expect(onSetBlocked).toHaveBeenCalledWith(troll.id, false);
  });

  it("says so when nobody is blocked", () => {
    const host = mount(<BlockedUsersPanel blockedUserIds={new Set()} onSetBlocked={async () => {}} usersById={new Map()} />);
    expect(host.textContent).toContain("You haven't blocked anyone.");
    expect(host.querySelector(".blocked-users-list")).toBeNull();
  });
});

describe("block list helpers", () => {
  it("parses the server's list and treats garbage as empty", () => {
    expect([...parseBlockList({ blockedUserIds: ["user.a", "user.b"] })]).toEqual(["user.a", "user.b"]);
    expect(parseBlockList({ nope: true }).size).toBe(0);
    expect(parseBlockList(undefined).size).toBe(0);
  });

  it("filters blocked authors (all content) and blocked reactions, returning the same array when none are blocked", () => {
    const messages = [post("p1", troll.id), post("p2", friend.id), reaction("r1", troll.id, "p2")];
    expect(withoutBlockedAuthors(messages, new Set())).toBe(messages);
    expect(withoutBlockedReactions(messages, new Set())).toBe(messages);
    expect(withoutBlockedAuthors(messages, BLOCKED).map((message) => message.id)).toEqual(["p2"]);
    expect(withoutBlockedReactions(messages, BLOCKED).map((message) => message.id)).toEqual(["p1", "p2"]);
  });
});
