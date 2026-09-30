import type { Message, User } from "@loam/schema";
import { describe, expect, it } from "vitest";

import { dmConversationPeers, inboxUnreadPeers } from "./dm-inbox";

function user(id: string, type: User["type"] = "human"): User {
  return { id, displayName: id, type, isAdmin: false, createdAt: 1, ephemeral: true };
}

function dm(id: string, authorId: string, recipientUserId: string, createdAt: number): Message {
  return { id, type: "dm", authorId, recipientUserId, body: "hi", createdAt } as Message;
}

const me = user("user.me");
const ada = user("user.ada");
const bob = user("user.bob");
const cy = user("user.cy");
const bot = user("llm.assistant", "bot");
const roster = [me, ada, bob, cy, bot];

describe("dmConversationPeers", () => {
  it("lists everyone but me when the node has no inbox", () => {
    expect(dmConversationPeers(roster, me.id, undefined, []).map((u) => u.id)).toEqual([ada.id, bob.id, cy.id, bot.id]);
  });

  it("lists only real conversations, newest activity first, from the inbox and local DMs, then bots", () => {
    const inbox = [
      { userId: bob.id, lastMessageAt: 50, lastAuthorId: bob.id },
      { userId: ada.id, lastMessageAt: 10, lastAuthorId: me.id },
    ];
    // A newer DM with Ada held locally (arrived live) outranks Bob's inbox entry.
    const messages = [dm("m1", ada.id, me.id, 90)];
    expect(dmConversationPeers(roster, me.id, inbox, messages).map((u) => u.id)).toEqual([ada.id, bob.id, bot.id]);
  });

  it("keeps the open DM listed even before its first message", () => {
    expect(dmConversationPeers(roster, me.id, [], [], cy.id).map((u) => u.id)).toEqual([cy.id, bot.id]);
  });

  it("drops inbox entries for people no longer on the roster", () => {
    const inbox = [{ userId: "user.gone", lastMessageAt: 5, lastAuthorId: "user.gone" }];
    expect(dmConversationPeers(roster, me.id, inbox, []).map((u) => u.id)).toEqual([bot.id]);
  });
});

describe("inboxUnreadPeers", () => {
  const inbox = [
    { userId: ada.id, lastMessageAt: 100, lastAuthorId: ada.id },
    { userId: bob.id, lastMessageAt: 100, lastAuthorId: me.id },
    { userId: cy.id, lastMessageAt: 100, lastAuthorId: cy.id },
  ];

  it("flags a peer whose latest message is theirs, unread, and not yet counted locally", () => {
    const hints = inboxUnreadPeers(inbox, me.id, { [`dm:${cy.id}`]: 100 }, new Map(), new Set());
    // Ada: theirs and newer than the (absent) marker. Bob: my own message. Cy: already read.
    expect([...hints]).toEqual([ada.id]);
  });

  it("leaves it to the real count once loaded, and skips blocked people", () => {
    expect([...inboxUnreadPeers(inbox, me.id, {}, new Map([[`dm:${ada.id}`, 2]]), new Set())]).toEqual([cy.id]);
    expect([...inboxUnreadPeers(inbox, me.id, {}, new Map(), new Set([ada.id, cy.id]))]).toEqual([]);
  });
});
