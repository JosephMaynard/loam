import type { HostUser } from "@loam/schema";
import { describe, expect, it } from "vitest";

import { nameKey, sharedNames } from "./people.js";

function person(id: string, displayName: string): HostUser {
  return { id, displayName, isAdmin: false, pending: false, banned: false, online: false, createdAt: "2026-10-09T10:00:00.000Z" } as HostUser;
}

describe("nameKey", () => {
  it("ignores case, surrounding and repeated spaces", () => {
    expect(nameKey("  Ada   Lovelace ")).toBe("ada lovelace");
    expect(nameKey("ADA")).toBe(nameKey("ada"));
  });

  it("sees through invisible characters", () => {
    expect(nameKey("ada\u200blovelace")).toBe("adalovelace");
    expect(nameKey("ada\u200d")).toBe("ada");
    expect(nameKey("\u115fada\u3164")).toBe("ada");
    expect(nameKey("ada\ufeff\u00ad\u2060")).toBe("ada");
    expect(nameKey("ada\u{e0067}")).toBe("ada");
  });

  it("sees through compatibility forms", () => {
    expect(nameKey("\uff21da")).toBe("ada");
    expect(nameKey("\ufb01ona")).toBe("fiona");
    expect(nameKey("\u210cal")).toBe("hal");
    expect(nameKey("ada\u2460")).toBe("ada1");
  });

  it("treats an emoji with and without its presentation selector as one name", () => {
    expect(nameKey("sunny \u2600\ufe0f")).toBe(nameKey("sunny \u2600"));
    expect(nameKey("👨\u200d👩\u200d👧")).toBe(nameKey("👨👩👧"));
  });

  it("keeps different names apart", () => {
    expect(nameKey("ada")).not.toBe(nameKey("adam"));
    expect(nameKey("ada 1")).not.toBe(nameKey("ada 2"));
  });
});

describe("sharedNames", () => {
  it("flags a name copied with an invisible character or a lookalike letter", () => {
    const users = [
      person("user.0001", "Ada"),
      person("user.0002", "ada\u200b"),
      person("user.0003", "\uff21da"),
      person("user.0004", "Grace"),
    ];
    const shared = sharedNames(users);
    expect(shared).toEqual(new Set(["ada"]));
    expect(shared.has(nameKey("Grace"))).toBe(false);
  });

  it("flags nothing when every name is its own", () => {
    expect(sharedNames([person("user.0001", "Ada"), person("user.0002", "Adam")]).size).toBe(0);
  });
});
