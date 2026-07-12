import { describe, expect, it } from "vitest";

import type { Message } from "@loam/schema";

import { compareCreatedAt, mergeMessagesInOrder } from "./messages";

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
