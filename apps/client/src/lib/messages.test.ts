import { describe, expect, it } from "vitest";

import type { Message } from "@loam/schema";

import type { Conversation } from "./protocol";
import {
  compareCreatedAt,
  conversationMessages,
  countUnreadByConversation,
  groupReactionsByTarget,
  groupRepliesByParent,
  isConversationMessage,
  isJumboEmoji,
  LiveChangeJournal,
  mergeMessagesInOrder,
  messageConversationKey,
  newestMessageTimestamp,
  reactionSummary,
  reconcileConversationSnapshot,
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

describe("isJumboEmoji", () => {
  it("is true for a single emoji", () => {
    expect(isJumboEmoji("👍")).toBe(true);
  });

  it("is true for three emoji, one of them a ZWJ family sequence and a skin-tone modifier counted as one cluster each", () => {
    expect(isJumboEmoji("👍🏽 ❤️ 👨‍👩‍👧‍👦")).toBe(true);
  });

  it("is false for four emoji", () => {
    expect(isJumboEmoji("👍❤️😀🎉")).toBe(false);
  });

  it("is false when emoji are mixed with text", () => {
    expect(isJumboEmoji("hi 😀")).toBe(false);
  });

  it("is false for plain text", () => {
    expect(isJumboEmoji("hello world")).toBe(false);
  });

  it("is false for an empty or whitespace-only body", () => {
    expect(isJumboEmoji("")).toBe(false);
    expect(isJumboEmoji("   ")).toBe(false);
  });

  it("tolerates surrounding whitespace between emoji", () => {
    expect(isJumboEmoji("  👍   🎉  ")).toBe(true);
  });
});

describe("reconcileConversationSnapshot", () => {
  it("prunes a deleted message even when it was the newest in the conversation", () => {
    const previous = [post("older", 100), post("deleted-latest", 200)];
    const result = reconcileConversationSnapshot(
      previous,
      CHANNEL,
      [post("older", 100)],
      new Set(["older", "deleted-latest"]),
      ME,
    );
    expect(result.messages.map((message) => message.id)).toEqual(["older"]);
    expect(result.prunedIds).toEqual(["deleted-latest"]);
  });

  it("prunes reactions that targeted a pruned conversation message", () => {
    const previous = [post("a", 100), reaction("x", 150, "a", "👍", ME)];
    const result = reconcileConversationSnapshot(previous, CHANNEL, [], new Set(["a", "x"]), ME);
    expect(result.messages).toEqual([]);
    expect(result.prunedIds.sort()).toEqual(["a", "x"]);
  });

  it("keeps a message that arrived while the fetch was in flight, and other conversations", () => {
    const elsewhere = dm("d", 50, ME, "user.peer");
    const previous = [elsewhere, post("a", 100), post("raced", 300)];
    const result = reconcileConversationSnapshot(previous, CHANNEL, [post("a", 100, "edited")], new Set(["d", "a"]), ME);
    expect(result.messages.map((message) => message.id)).toEqual(["d", "a", "raced"]);
    expect(result.messages[1]).toMatchObject({ body: "edited" });
    expect(result.prunedIds).toEqual([]);
  });
});

describe("reconcileConversationSnapshot vs live events during the fetch (review 2026-09-25)", () => {
  it("doesn't resurrect a message a live messageDeleted removed while the fetch was in flight", () => {
    const journal = new LiveChangeJournal();
    const mark = journal.mark(); // fetch starts; the snapshot below still contains "gone"
    // ...the live delete arrives and removes it locally...
    journal.recordDeleted("gone");
    const previous = [post("a", 100)];
    const result = reconcileConversationSnapshot(
      previous,
      CHANNEL,
      [post("a", 100), post("gone", 200)],
      new Set(["a", "gone"]),
      ME,
      journal.since(mark),
    );
    expect(result.messages.map((message) => message.id)).toEqual(["a"]);
    expect(result.applied.map((message) => message.id)).toEqual(["a"]); // nothing to re-persist for "gone"
  });

  it("keeps a live edit over the older snapshot copy, but takes a strictly newer snapshot edit", () => {
    const journal = new LiveChangeJournal();
    const mark = journal.mark();
    const liveEdited = { ...post("a", 100, "live edit"), editedAt: 500 } as Message;
    journal.recordUpdated("a");
    const stale = reconcileConversationSnapshot(
      [liveEdited],
      CHANNEL,
      [post("a", 100, "original")],
      new Set(["a"]),
      ME,
      journal.since(mark),
    );
    expect(stale.messages[0]).toMatchObject({ body: "live edit" });
    expect(stale.applied).toEqual([]);

    const newer = { ...post("a", 100, "even newer"), editedAt: 900 } as Message;
    const fresh = reconcileConversationSnapshot([liveEdited], CHANNEL, [newer], new Set(["a"]), ME, journal.since(mark));
    expect(fresh.messages[0]).toMatchObject({ body: "even newer" });
  });

  it("only counts changes AFTER the mark, and forgets entries past their retention", () => {
    let now = 1_000;
    const journal = new LiveChangeJournal(60_000, () => now);
    journal.recordDeleted("before");
    const mark = journal.mark();
    journal.recordDeleted("after");
    journal.recordUpdated("edited");
    expect([...journal.since(mark).deletedIds]).toEqual(["after"]);
    expect([...journal.since(mark).updatedIds]).toEqual(["edited"]);

    now += 120_000;
    journal.recordDeleted("later");
    expect([...journal.since(0).deletedIds]).toEqual(["later"]);
    expect([...journal.since(0).updatedIds]).toEqual([]);
  });
});

describe("read markers use server timestamps (review 2026-09-25)", () => {
  it("newestMessageTimestamp is the newest post/DM createdAt, ignoring reactions", () => {
    expect(newestMessageTimestamp([])).toBeUndefined();
    expect(newestMessageTimestamp([post("a", 100), post("b", 300), reaction("r", 900, "a", "👍", ME)])).toBe(300);
  });

  it("a message newer than the marker is unread even when the client clock runs ahead of the server", () => {
    const peerPost = { ...post("new", 1_000), authorId: "user.peer" } as Message;
    // Old behaviour: the marker was the CLIENT's Date.now() (here, a clock 1h fast) — the new post vanished.
    const clientClockMarker = { [`channel:${CHANNEL.id}`]: 1_000 + 3_600_000 };
    expect(countUnreadByConversation([peerPost], clientClockMarker, ME).get(`channel:${CHANNEL.id}`)).toBeUndefined();
    // New behaviour: the marker is the newest createdAt seen on screen (server time) — the post counts.
    const serverMarker = { [`channel:${CHANNEL.id}`]: newestMessageTimestamp([post("seen", 900)])! };
    expect(countUnreadByConversation([peerPost], serverMarker, ME).get(`channel:${CHANNEL.id}`)).toBe(1);
    // Own messages and reactions never count.
    expect(countUnreadByConversation([post("mine", 2_000)], serverMarker, "user.1").size).toBe(0);
  });
});
