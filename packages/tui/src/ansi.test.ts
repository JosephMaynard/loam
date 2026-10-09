import { describe, expect, it } from "vitest";

import { clean, graphemeWidth, lineWidth, padEnd, plain, renderLine, text, textWidth, truncate } from "./ansi.js";

describe("clean", () => {
  it("removes escape sequences, control characters and bidi overrides", () => {
    expect(clean("ada\x1b]0;pwned\x07lovelace")).toBe("ada]0;pwnedlovelace");
    expect(clean("a\x1b[2Jb\u009bc\u202ed\u2066e\x7f")).toBe("a[2Jbcde");
    expect(clean("tab\there")).toBe("tab here");
    expect(clean("a\u200eb\u200fc\u061cd")).toBe("abcd");
  });

  it("removes invisible characters that would let a copied name pass as different", () => {
    expect(clean("ada\u200blovelace")).toBe("adalovelace");
    expect(clean("a\u200cd\u200da\u2060 \ufeff\u00ad")).toBe("ada ");
    expect(clean("\u115f\u1160ada\u3164\uffa0")).toBe("ada");
    expect(clean("ada\u{e0067}\u{e007f}")).toBe("ada");
    expect(clean("\u200d\u200dada\u200d")).toBe("ada");
  });

  it("keeps the joiner inside an emoji sequence, and variation selectors", () => {
    expect(clean("👨‍👩‍👧")).toBe("👨‍👩‍👧");
    expect(textWidth(clean("👨‍👩‍👧"))).toBe(2);
    expect(clean("❤️‍🔥")).toBe("❤️‍🔥");
    expect(clean("👩🏽‍💻")).toBe("👩🏽‍💻");
    expect(clean("🏴‍☠️")).toBe("🏴‍☠️");
    expect(clean("☀️ ❤ ⚠️")).toBe("☀️ ❤ ⚠️");
    // A joiner next to a letter, or at either end of an emoji, holds nothing together.
    expect(clean("a\u200d😀")).toBe("a😀");
    expect(clean("😀\u200da")).toBe("😀a");
    expect(clean("😀\u200d")).toBe("😀");
  });

  it("keeps at most three combining marks on one base", () => {
    expect(clean("e\u0301")).toBe("e\u0301");
    expect(clean("e\u0301\u0323\u0302")).toBe("e\u0301\u0323\u0302");
    expect(clean("z\u0300\u0301\u0302\u0303\u0304a\u0301l\u0327\u0328\u0329go")).toBe("z\u0300\u0301\u0302a\u0301l\u0327\u0328\u0329go");
    // Marks on different bases in one cluster stay (a Devanagari conjunct).
    expect(clean("\u0915\u094d\u0937\u093f\u0902")).toBe("\u0915\u094d\u0937\u093f\u0902");
  });
});

describe("widths", () => {
  it("counts emoji and wide characters as two columns and combining marks as none", () => {
    expect(textWidth("abc")).toBe(3);
    expect(textWidth("👍🏽")).toBe(2);
    expect(textWidth("❤️")).toBe(2);
    expect(textWidth("日本")).toBe(4);
    expect(textWidth("é")).toBe(1);
    expect(textWidth("a\u200bb\u00ad\ufeff")).toBe(2);
    expect(textWidth("\u{1b000}\u2329")).toBe(4);
    expect(lineWidth(text("a\x1b[2Jb"))).toBe(5);
  });

  it("pins the width of a pictograph with and without the emoji presentation selector", () => {
    expect(graphemeWidth("☀")).toBe(1);
    expect(graphemeWidth("☀\ufe0f")).toBe(2);
    expect(textWidth("☀ ☀\ufe0f")).toBe(4);
  });

  it("cuts with an ellipsis and pads to an exact width", () => {
    expect(truncate("hello world", 5)).toBe("hell…");
    expect(truncate("hi", 5)).toBe("hi");
    expect(truncate("日本語", 4)).toBe("日…");
    expect(padEnd("hi", 4)).toBe("hi  ");
    expect(textWidth(padEnd("日本語です", 5))).toBe(5);
  });
});

describe("renderLine", () => {
  it("fills exactly the width, styled, and never passes a control character through", () => {
    const out = renderLine([{ text: "ok", style: { fg: "green" } }, { text: "\x1b[31mevil" }], 12);
    expect(out).toBe("\x1b[32mok\x1b[0m[31mevil  ");
    expect(renderLine([{ text: "toolong" }], 4)).toBe("too…");
  });

  it("drops colours without color, except where they carry meaning", () => {
    expect(renderLine([{ text: "x", style: { fg: "red", bold: true } }], 1, false)).toBe("\x1b[1mx\x1b[0m");
    expect(renderLine([{ text: "▀", style: { fg: "black", bg: "white", keepColor: true } }], 1, false)).toBe(
      "\x1b[30;47m▀\x1b[0m",
    );
  });

  it("gives plain text for tests", () => {
    expect(plain([{ text: "a" }, { text: "\x1bb" }])).toBe("ab");
  });
});
