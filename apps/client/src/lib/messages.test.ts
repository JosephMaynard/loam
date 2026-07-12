import { describe, expect, it } from "vitest";

import type { Message } from "@loam/schema";

import type { Conversation } from "./protocol";
import {
  compareCreatedAt,
  conversationMessages,
  groupReactionsByTarget,
  groupRepliesByParent,
  isConversationMessage,
  mergeMessagesInOrder,
  messageConversationKey,
  reactionSummary,
  repliesFor,
  topLevelMessages,
} from "./messages";

/** A minimal channel-post message; only the fields the ordering helpers read need to be real. */
function post(id: string, createdAt: number, body = id): Message {
  return {
    id,
    type: "channelPost",
    channelId: "channel.general",
    authorId: "user.1",
    body,
    createdAt,
  } as Message;
}

/** A minimal channel reply to `parentMessageId` in the given channel. */
function reply(
  id: string,
  createdAt: number,
  parentMessageId: string,
  channelId = "channel.general",
): Message {
  return {
    id,
    type: "channelReply",
    channelId,
    parentMessageId,
    authorId: "user.1",
    body: id,
    createdAt,
  } as Message;
}

/** A minimal DM from `authorId` to `recipientUserId`. */
function dm(id: string, createdAt: number, authorId: string, recipientUserId: string): Message {
  return {
    id,
    type: "dm",
    authorId,
    recipientUserId,
    body: id,
    createdAt,
  } as Message;
}

/** A minimal reaction of `emoji` on `targetMessageId` by `authorId`. */
function reaction(
  id: string,
  createdAt: number,
  targetMessageId: string,
  emoji: string,
  authorId: string,
): Message {
  return {
    id,
    type: "reaction",
    targetMessageId,
    reaction: emoji,
    authorId,
    createdAt,
  } as Message;
}

const CHANNEL: Conversation = { kind: "channel", id: "channel.general" };
const DM_WITH_PEER: Conversation = { kind: "dm", id: "user.peer" };
const ME = "user.me";

/** The reference behaviour the fast merge must reproduce byte-for-byte: Map dedupe + stable sort. */
function referenceMerge(previous: Message[], incoming: Message[]): Message[] {
  const next = new Map(previous.map((message) => [message.id, message]));
  for (const message of incoming) {
    next.set(message.id, message);
  }
  return Array.from(next.values()).sort(compareCreatedAt);
}

describe("mergeMessagesInOrder", () => {
  it("appends a newer message at the end", () => {
    const previous = [post("a", 1), post("b", 2)];
    const merged = mergeMessagesInOrder(previous, [post("c", 3)]);
    expect(merged.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("inserts an out-of-order message at its sorted position", () => {
    const previous = [post("a", 1), post("c", 3)];
    const merged = mergeMessagesInOrder(previous, [post("b", 2)]);
    expect(merged.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("updates an existing message in place, keeping its position, without a timestamp change", () => {
    const previous = [post("a", 1), post("b", 2), post("c", 3)];
    const merged = mergeMessagesInOrder(previous, [post("b", 2, "edited")]);
    expect(merged.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(merged.find((m) => m.id === "b")).toMatchObject({ body: "edited" });
  });

  it("dedupes by id when the same id appears in previous and incoming", () => {
    const previous = [post("a", 1), post("b", 2)];
    const merged = mergeMessagesInOrder(previous, [post("b", 2, "new"), post("c", 3)]);
    expect(merged.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(merged.filter((m) => m.id === "b")).toHaveLength(1);
    expect(merged.find((m) => m.id === "b")).toMatchObject({ body: "new" });
  });

  it("re-sorts correctly when an existing message's createdAt changes", () => {
    const previous = [post("a", 1), post("b", 2), post("c", 3)];
    // b moves to the end (createdAt 2 -> 4): the fallback path must reorder it.
    const merged = mergeMessagesInOrder(previous, [post("b", 4)]);
    expect(merged.map((m) => m.id)).toEqual(["a", "c", "b"]);
  });

  it("returns a new array (immutability) and does not mutate previous", () => {
    const previous = [post("a", 1)];
    const merged = mergeMessagesInOrder(previous, [post("b", 2)]);
    expect(merged).not.toBe(previous);
    expect(previous.map((m) => m.id)).toEqual(["a"]);
  });

  it("places new equal-timestamp items after existing ones, preserving incoming order", () => {
    const previous = [post("a", 1), post("b", 5)];
    const merged = mergeMessagesInOrder(previous, [post("x", 5), post("y", 5)]);
    // Reference stable sort keeps [a, b, x, y]: existing ties first, then incoming in order.
    expect(merged.map((m) => m.id)).toEqual(referenceMerge(previous, [post("x", 5), post("y", 5)]).map((m) => m.id));
    expect(merged.map((m) => m.id)).toEqual(["a", "b", "x", "y"]);
  });

  it("matches the reference merge across mixed batches", () => {
    const previous = [post("a", 1), post("b", 3), post("c", 5)];
    const batches: Message[][] = [
      [post("d", 6)],
      [post("b", 3, "edit-b")],
      [post("e", 2), post("f", 4)],
      [post("a", 1, "edit-a"), post("g", 7)],
      [post("h", 3)], // equal timestamp with existing b -> after it
    ];

    let fast = previous;
    let reference = previous;
    for (const batch of batches) {
      fast = mergeMessagesInOrder(fast, batch);
      reference = referenceMerge(reference, batch);
      expect(fast.map((m) => `${m.id}:${m.createdAt}:${"body" in m ? m.body : ""}`)).toEqual(
        reference.map((m) => `${m.id}:${m.createdAt}:${"body" in m ? m.body : ""}`),
      );
    }
  });
});

describe("isConversationMessage", () => {
  it("matches channel posts and replies in the same channel", () => {
    expect(isConversationMessage(post("a", 1), CHANNEL, ME)).toBe(true);
    expect(isConversationMessage(reply("r", 1, "a"), CHANNEL, ME)).toBe(true);
  });

  it("rejects messages from another channel", () => {
    const other = post("a", 1);
    (other as { channelId: string }).channelId = "channel.other";
    expect(isConversationMessage(other, CHANNEL, ME)).toBe(false);
  });

  it("rejects reactions and DMs for a channel conversation", () => {
    expect(isConversationMessage(reaction("x", 1, "a", "👍", ME), CHANNEL, ME)).toBe(false);
    expect(isConversationMessage(dm("d", 1, ME, "user.peer"), CHANNEL, ME)).toBe(false);
  });

  it("matches a DM in both directions with the peer", () => {
    expect(isConversationMessage(dm("d1", 1, ME, "user.peer"), DM_WITH_PEER, ME)).toBe(true);
    expect(isConversationMessage(dm("d2", 2, "user.peer", ME), DM_WITH_PEER, ME)).toBe(true);
  });

  it("rejects a DM involving a different peer", () => {
    expect(isConversationMessage(dm("d3", 1, ME, "user.other"), DM_WITH_PEER, ME)).toBe(false);
    expect(isConversationMessage(dm("d4", 1, "user.other", ME), DM_WITH_PEER, ME)).toBe(false);
  });
});

describe("conversationMessages", () => {
  it("filters a channel scope to its posts/replies and pulls in in-scope reactions, sorted", () => {
    const all: Message[] = [
      post("p2", 4),
      post("p1", 1),
      reply("r1", 2, "p1"),
      reaction("x1", 3, "p1", "👍", ME), // targets in-scope p1 -> included
      dm("d1", 5, ME, "user.peer"), // out of scope
      reaction("x2", 6, "d1", "❤️", ME), // targets out-of-scope d1 -> excluded
    ];
    const result = conversationMessages(all, CHANNEL, ME);
    expect(result.map((m) => m.id)).toEqual(["p1", "r1", "x1", "p2"]);
  });

  it("resolves a DM scope in both directions and includes reactions on those DMs", () => {
    const all: Message[] = [
      dm("d1", 1, ME, "user.peer"),
      dm("d2", 2, "user.peer", ME),
      dm("d3", 3, ME, "user.other"), // different peer, excluded
      reaction("x1", 4, "d1", "👍", "user.peer"), // in-scope target
      reaction("x2", 5, "d3", "👍", ME), // out-of-scope target, excluded
    ];
    const result = conversationMessages(all, DM_WITH_PEER, ME);
    expect(result.map((m) => m.id)).toEqual(["d1", "d2", "x1"]);
  });

  it("sorts the combined result by createdAt", () => {
    const all: Message[] = [
      reaction("x1", 10, "p1", "👍", ME),
      post("p1", 1),
      reply("r1", 5, "p1"),
    ];
    const result = conversationMessages(all, CHANNEL, ME);
    expect(result.map((m) => m.createdAt)).toEqual([1, 5, 10]);
  });
});

describe("topLevelMessages", () => {
  it("returns only channel posts for a channel, sorted, excluding replies and reactions", () => {
    const scoped: Message[] = [
      post("p2", 3),
      reply("r1", 2, "p1"),
      post("p1", 1),
      reaction("x1", 4, "p1", "👍", ME),
    ];
    const result = topLevelMessages(scoped, CHANNEL);
    expect(result.map((m) => m.id)).toEqual(["p1", "p2"]);
  });

  it("returns only DMs for a DM conversation, sorted", () => {
    const scoped: Message[] = [
      dm("d2", 3, "user.peer", ME),
      reaction("x1", 2, "d1", "👍", ME),
      dm("d1", 1, ME, "user.peer"),
    ];
    const result = topLevelMessages(scoped, DM_WITH_PEER);
    expect(result.map((m) => m.id)).toEqual(["d1", "d2"]);
  });
});

describe("repliesFor", () => {
  it("returns only channel replies with the matching parent, sorted", () => {
    const scoped: Message[] = [
      reply("r2", 3, "p1"),
      reply("r1", 1, "p1"),
      reply("r3", 2, "p2"), // different parent
      post("p1", 0),
      reaction("x1", 4, "p1", "👍", ME),
    ];
    const result = repliesFor(scoped, "p1");
    expect(result.map((m) => m.id)).toEqual(["r1", "r2"]);
  });

  it("returns an empty array when no reply matches", () => {
    expect(repliesFor([post("p1", 1), reply("r1", 2, "other")], "p1")).toEqual([]);
  });
});

describe("reactionSummary", () => {
  it("counts reactions per emoji and marks active when the current user reacted", () => {
    const scoped: Message[] = [
      reaction("x1", 1, "p1", "👍", "user.a"),
      reaction("x2", 2, "p1", "👍", ME),
      reaction("x3", 3, "p1", "❤️", "user.b"),
      reaction("x4", 4, "p2", "👍", ME), // different target, ignored
    ];
    const result = reactionSummary(scoped, "p1", ME);
    expect(result).toEqual([
      { reaction: "👍", count: 2, active: true },
      { reaction: "❤️", count: 1, active: false },
    ]);
  });

  it("sorts by count descending, then by reaction locale for ties", () => {
    const scoped: Message[] = [
      reaction("x1", 1, "p1", "b", "user.a"),
      reaction("x2", 2, "p1", "a", "user.b"),
      reaction("x3", 3, "p1", "c", "user.c"),
      reaction("x4", 4, "p1", "c", "user.d"), // c now has count 2
    ];
    const result = reactionSummary(scoped, "p1", ME);
    expect(result.map((r) => r.reaction)).toEqual(["c", "a", "b"]);
  });

  it("returns an empty array when no reaction targets the message", () => {
    expect(reactionSummary([post("p1", 1)], "p1", ME)).toEqual([]);
  });
});

describe("groupRepliesByParent", () => {
  it("groups channel replies by parent id, ignoring non-replies", () => {
    const messages: Message[] = [
      reply("r1", 1, "p1"),
      reply("r2", 2, "p1"),
      reply("r3", 3, "p2"),
      post("p1", 0),
      reaction("x1", 4, "p1", "👍", ME),
    ];
    const grouped = groupRepliesByParent(messages);
    expect(grouped.get("p1")?.map((m) => m.id)).toEqual(["r1", "r2"]);
    expect(grouped.get("p2")?.map((m) => m.id)).toEqual(["r3"]);
    expect(grouped.has("nope")).toBe(false);
  });

  it("feeding a grouped slice back through repliesFor matches scanning the whole array", () => {
    const messages: Message[] = [
      post("p1", 0),
      reply("r2", 3, "p1"),
      reply("r1", 1, "p1"),
      reply("r3", 2, "p2"),
    ];
    const grouped = groupRepliesByParent(messages);
    for (const parentId of ["p1", "p2"]) {
      const viaGroup = repliesFor(grouped.get(parentId) ?? [], parentId);
      const viaScan = repliesFor(messages, parentId);
      expect(viaGroup.map((m) => m.id)).toEqual(viaScan.map((m) => m.id));
    }
  });
});

describe("groupReactionsByTarget", () => {
  it("groups reactions by target id, ignoring non-reactions", () => {
    const messages: Message[] = [
      reaction("x1", 1, "p1", "👍", ME),
      reaction("x2", 2, "p1", "❤️", "user.a"),
      reaction("x3", 3, "p2", "👍", ME),
      post("p1", 0),
    ];
    const grouped = groupReactionsByTarget(messages);
    expect(grouped.get("p1")?.map((m) => m.id)).toEqual(["x1", "x2"]);
    expect(grouped.get("p2")?.map((m) => m.id)).toEqual(["x3"]);
    expect(grouped.has("p1.missing")).toBe(false);
  });

  it("feeding a grouped slice back through reactionSummary matches scanning the whole array", () => {
    const messages: Message[] = [
      post("p1", 0),
      reaction("x1", 1, "p1", "👍", "user.a"),
      reaction("x2", 2, "p1", "👍", ME),
      reaction("x3", 3, "p1", "❤️", "user.b"),
      reaction("x4", 4, "p2", "👍", ME),
    ];
    const grouped = groupReactionsByTarget(messages);
    for (const targetId of ["p1", "p2"]) {
      const viaGroup = reactionSummary(grouped.get(targetId) ?? [], targetId, ME);
      const viaScan = reactionSummary(messages, targetId, ME);
      expect(viaGroup).toEqual(viaScan);
    }
  });
});

describe("messageConversationKey", () => {
  it("keys channel posts and replies by channel id", () => {
    expect(messageConversationKey(post("p1", 1), ME)).toBe("channel:channel.general");
    expect(messageConversationKey(reply("r1", 1, "p1"), ME)).toBe("channel:channel.general");
  });

  it("keys a DM by the peer, resolved from either direction", () => {
    expect(messageConversationKey(dm("d1", 1, ME, "user.peer"), ME)).toBe("dm:user.peer");
    expect(messageConversationKey(dm("d2", 1, "user.peer", ME), ME)).toBe("dm:user.peer");
  });

  it("returns undefined for reactions (they drive no conversation)", () => {
    expect(messageConversationKey(reaction("x1", 1, "p1", "👍", ME), ME)).toBeUndefined();
  });
});
