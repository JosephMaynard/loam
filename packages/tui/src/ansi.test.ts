import { describe, expect, it } from "vitest";

import { clean, padEnd, plain, renderLine, textWidth, truncate } from "./ansi.js";

describe("clean", () => {
  it("removes escape sequences, control characters and bidi overrides", () => {
    expect(clean("ada\x1b]0;pwned\x07lovelace")).toBe("ada]0;pwnedlovelace");
    expect(clean("a\x1b[2Jb\u009bc‮d⁦e\x7f")).toBe("a[2Jbcde");
    expect(clean("tab\there")).toBe("tab here");
  });
});

describe("widths", () => {
  it("counts emoji and wide characters as two columns and combining marks as none", () => {
    expect(textWidth("abc")).toBe(3);
    expect(textWidth("👍🏽")).toBe(2);
    expect(textWidth("❤️")).toBe(2);
    expect(textWidth("日本")).toBe(4);
    expect(textWidth("é")).toBe(1);
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
