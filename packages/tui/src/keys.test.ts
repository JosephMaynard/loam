import { describe, expect, it } from "vitest";

import { isChar, parseKeys } from "./keys.js";

describe("parseKeys", () => {
  it("reads arrows, editing keys and controls", () => {
    expect(parseKeys("\x1b[A\x1b[B\x1bOC\x1b[D").map((key) => key.name)).toEqual(["up", "down", "right", "left"]);
    expect(parseKeys("\x1b[5~\x1b[6~\x1b[H\x1b[4~\x1b[3~\x1b[Z").map((key) => key.name)).toEqual([
      "pageup",
      "pagedown",
      "home",
      "end",
      "delete",
      "shift-tab",
    ]);
    expect(parseKeys("\r\x7f\t\x03\x04\x0c").map((key) => key.name)).toEqual([
      "enter",
      "backspace",
      "tab",
      "ctrl-c",
      "ctrl-d",
      "ctrl-l",
    ]);
    expect(parseKeys("\r\n").map((key) => key.name)).toEqual(["enter"]);
  });

  it("splits a paste into characters, keeping an emoji whole", () => {
    expect(parseKeys("hi 👍🏽")).toEqual([
      { name: "char", char: "h" },
      { name: "char", char: "i" },
      { name: "char", char: " " },
      { name: "char", char: "👍🏽" },
    ]);
  });

  it("treats a lone Escape or Alt+key as Escape and skips sequences it doesn't use", () => {
    expect(parseKeys("\x1b")).toEqual([{ name: "escape" }]);
    expect(parseKeys("\x1bx")).toEqual([{ name: "escape" }]);
    expect(parseKeys("\x1b[15~a")).toEqual([{ name: "char", char: "a" }]);
    expect(parseKeys("\x01b")).toEqual([{ name: "char", char: "b" }]);
  });

  it("matches characters regardless of case", () => {
    expect(isChar({ name: "char", char: "Q" }, "q")).toBe(true);
    expect(isChar({ name: "enter" }, "q")).toBe(false);
  });
});
