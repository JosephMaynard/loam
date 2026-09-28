import type { User } from "@loam/schema";
import { describe, expect, it } from "vitest";

import { reconcileRoster } from "./roster";

function user(id: string, displayName = id): User {
  return { id, displayName, type: "human", isAdmin: false, createdAt: 1, ephemeral: true };
}

describe("reconcileRoster (review 2026-09-25)", () => {
  it("drops cached users the server's full list no longer returns", () => {
    const { users, removedIds } = reconcileRoster(
      [user("user.a"), user("user.gone")],
      [user("user.a")],
      new Set(["user.a", "user.gone"]),
    );
    expect(users.map((entry) => entry.id)).toEqual(["user.a"]);
    expect(removedIds).toEqual(["user.gone"]);
  });

  it("keeps a user that arrived live while the request was in flight, and takes the server's copy of the rest", () => {
    const { users, removedIds } = reconcileRoster(
      [user("user.a", "Old name"), user("user.raced")],
      [user("user.a", "New name"), user("user.b")],
      new Set(["user.a"]),
    );
    expect(users.map((entry) => [entry.id, entry.displayName])).toEqual([
      ["user.a", "New name"],
      ["user.b", "user.b"],
      ["user.raced", "user.raced"],
    ]);
    expect(removedIds).toEqual([]);
  });
});
