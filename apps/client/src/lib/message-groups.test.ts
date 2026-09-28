import type { Message } from "@loam/schema";
import { describe, expect, it } from "vitest";

import { GROUP_WINDOW_MS, groupMessages } from "./message-groups";

const MINUTE = 60 * 1000;
// Noon local time, so adding a few minutes never crosses midnight.
const NOON = new Date(2026, 8, 28, 12, 0, 0).getTime();

function post(id: string, authorId: string, createdAt: number): Message {
  return { id, type: "channelPost", channelId: "general", authorId, body: id, createdAt } as Message;
}

/** A compact picture of the grouping: "F" first, "L" last, "FL" alone, "-" middle; "|" marks a new day. */
function shape(messages: Message[], isolate?: (message: Message) => boolean): string[] {
  return groupMessages(messages, { isolate }).map(
    (entry) => `${entry.newDay ? "|" : ""}${entry.first ? "F" : ""}${entry.last ? "L" : ""}` || "-",
  );
}

describe("groupMessages", () => {
  it("returns nothing for an empty list", () => {
    expect(groupMessages([])).toEqual([]);
  });

  it("joins consecutive messages from one author inside the window", () => {
    const messages = [post("a", "ada", NOON), post("b", "ada", NOON + MINUTE), post("c", "ada", NOON + 2 * MINUTE)];
    expect(shape(messages)).toEqual(["|F", "-", "L"]);
  });

  it("starts a new group when the author changes", () => {
    const messages = [post("a", "ada", NOON), post("b", "bo", NOON + MINUTE), post("c", "ada", NOON + 2 * MINUTE)];
    expect(shape(messages)).toEqual(["|FL", "FL", "FL"]);
  });

  it("starts a new group after the time window", () => {
    const messages = [post("a", "ada", NOON), post("b", "ada", NOON + GROUP_WINDOW_MS + 1)];
    expect(shape(messages)).toEqual(["|FL", "FL"]);
    // Exactly at the window still joins.
    expect(shape([post("a", "ada", NOON), post("b", "ada", NOON + GROUP_WINDOW_MS)])).toEqual(["|F", "L"]);
  });

  it("breaks groups (and marks the day) across local midnight", () => {
    const lateEvening = new Date(2026, 8, 28, 23, 59, 0).getTime();
    const messages = [post("a", "ada", lateEvening), post("b", "ada", lateEvening + 2 * MINUTE)];
    expect(shape(messages)).toEqual(["|FL", "|FL"]);
  });

  it("keeps isolated messages on their own", () => {
    const messages = [post("a", "troll", NOON), post("b", "troll", NOON + MINUTE), post("c", "ada", NOON + 2 * MINUTE)];
    expect(shape(messages, (message) => message.authorId === "troll")).toEqual(["|FL", "FL", "FL"]);
  });

  it("does not join a message that sorts before its neighbour (clock skew between devices)", () => {
    const messages = [post("a", "ada", NOON + MINUTE), post("b", "ada", NOON)];
    expect(shape(messages)).toEqual(["|FL", "FL"]);
  });
});
