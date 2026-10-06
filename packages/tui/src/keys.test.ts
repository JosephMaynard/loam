import { describe, expect, it } from "vitest";

import { createKeyReader, isChar, parseKeys } from "./keys.js";

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

describe("createKeyReader", () => {
  it("skips F1 to F4 and other unused sequences whole", () => {
    expect(parseKeys("\x1bOP\x1bOQa\x1b[15~")).toEqual([{ name: "char", char: "a" }]);
  });

  it("joins a sequence split across reads", () => {
    const reader = createKeyReader();
    expect(reader.feed("\x1b")).toEqual([]);
    expect(reader.pending()).toBe(true);
    expect(reader.feed("[A")).toEqual([{ name: "up" }]);
    expect(reader.feed("\x1b[1;5")).toEqual([]);
    expect(reader.feed("A1")).toEqual([{ name: "char", char: "1" }]);
  });

  it("makes a lone Escape an Escape only when flushed", () => {
    const reader = createKeyReader();
    expect(reader.feed("\x1b")).toEqual([]);
    expect(reader.flush()).toEqual([{ name: "escape" }]);
    expect(reader.pending()).toBe(false);
  });

  it("reads Alt+arrow as Escape then the arrow, never as letters", () => {
    expect(parseKeys("\x1b\x1b[A")).toEqual([{ name: "escape" }, { name: "up" }]);
  });

  it("turns a bracketed paste into one paste event, even across reads", () => {
    const reader = createKeyReader();
    expect(reader.feed("\x1b[200~hello\nq")).toEqual([]);
    expect(reader.flush()).toEqual([]);
    expect(reader.feed("y\x1b[201~x")).toEqual([{ name: "paste", text: "hello\nqy" }, { name: "char", char: "x" }]);
  });
});
