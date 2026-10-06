import { isReactionEmoji } from "@loam/schema";
import { afterEach, describe, expect, it } from "vitest";

import {
  clearRecentReactions,
  firstEmoji,
  MAX_RECENT_REACTIONS,
  QUICK_REACTIONS,
  readRecentReactions,
  RECENT_REACTIONS_KEY,
  rememberReaction,
  SHEET_REACTIONS,
} from "./reactions";

afterEach(() => {
  localStorage.clear();
});

describe("reaction lists", () => {
  it("fills the sheet's three rows of five with distinct emoji the server accepts", () => {
    expect(SHEET_REACTIONS).toHaveLength(15);
    expect(new Set(SHEET_REACTIONS).size).toBe(15);
    for (const emoji of [...SHEET_REACTIONS, ...QUICK_REACTIONS]) {
      expect(isReactionEmoji(emoji), emoji).toBe(true);
    }
  });

  it("keeps every toolbar reaction in the sheet too", () => {
    for (const emoji of QUICK_REACTIONS) {
      expect(SHEET_REACTIONS).toContain(emoji);
    }
  });
});

describe("firstEmoji", () => {
  it("takes the first emoji whole, skipping text before it", () => {
    expect(firstEmoji("🦔")).toBe("🦔");
    expect(firstEmoji("hi 👍🏽 and 🦔")).toBe("👍🏽");
    expect(firstEmoji("👩‍👩‍👧")).toBe("👩‍👩‍👧");
    expect(firstEmoji("🇬🇧")).toBe("🇬🇧");
  });

  it("finds nothing in plain text", () => {
    expect(firstEmoji("")).toBeUndefined();
    expect(firstEmoji("lol 123 #")).toBeUndefined();
  });
});

describe("recent reactions", () => {
  it("remembers picks newest first, without repeats, up to the limit", () => {
    rememberReaction("🦔");
    rememberReaction("🐢");
    rememberReaction("🦔");
    expect(readRecentReactions()).toEqual(["🦔", "🐢"]);

    for (const emoji of ["🍕", "🌧️", "🚲", "🧭"]) {
      rememberReaction(emoji);
    }
    expect(readRecentReactions()).toEqual(["🧭", "🚲", "🌧️", "🍕"]);
    expect(readRecentReactions()).toHaveLength(MAX_RECENT_REACTIONS);
  });

  it("doesn't store an emoji the sheet already shows, or anything else", () => {
    rememberReaction("👍");
    rememberReaction("lol");
    expect(readRecentReactions()).toEqual([]);
  });

  it("ignores a damaged or tampered stored value", () => {
    localStorage.setItem(RECENT_REACTIONS_KEY, "{not json");
    expect(readRecentReactions()).toEqual([]);
    localStorage.setItem(RECENT_REACTIONS_KEY, JSON.stringify(["🦔", 5, "<b>", "👍"]));
    expect(readRecentReactions()).toEqual(["🦔"]);
  });

  it("forgets everything on clear", () => {
    rememberReaction("🦔");
    clearRecentReactions();
    expect(localStorage.getItem(RECENT_REACTIONS_KEY)).toBeNull();
    expect(readRecentReactions()).toEqual([]);
  });
});
