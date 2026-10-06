import { afterEach, describe, expect, it } from "vitest";

import { graphemes } from "./graphemes";
import { isJumboEmoji } from "./messages";
import { firstEmoji } from "./reactions";

/** Remove `Intl.Segmenter`, as on the browser floor (Chrome 80 to 86, Safari 14.0). */
const nativeSegmenter = Intl.Segmenter;
function withoutSegmenter(): void {
  delete (Intl as { Segmenter?: unknown }).Segmenter;
}

afterEach(() => {
  (Intl as { Segmenter?: unknown }).Segmenter = nativeSegmenter;
});

const SAMPLE = "hi 👍🏽 👩‍👩‍👧 🇬🇧🇫🇷 1️⃣ ❤️ é ❤";

describe("graphemes", () => {
  it("keeps emoji sequences and combining marks whole with Intl.Segmenter", () => {
    expect(graphemes(SAMPLE).filter((part) => part !== " ")).toEqual(
      ["h", "i", "👍🏽", "👩‍👩‍👧", "🇬🇧", "🇫🇷", "1️⃣", "❤️", "é", "❤"],
    );
  });

  it("gives the same clusters for this text without it", () => {
    const native = graphemes(SAMPLE);
    withoutSegmenter();
    expect(typeof Intl.Segmenter).toBe("undefined");
    expect(graphemes(SAMPLE)).toEqual(native);
    expect(graphemes(SAMPLE).join("")).toBe(SAMPLE);
    expect(graphemes("")).toEqual([]);
  });

  it("lets jumbo emoji and the emoji field work without it", () => {
    withoutSegmenter();
    expect(isJumboEmoji("👍🏽 👩‍👩‍👧")).toBe(true);
    expect(isJumboEmoji("hello")).toBe(false);
    expect(isJumboEmoji("👍👍👍👍")).toBe(false);
    expect(firstEmoji("ok 👍🏽")).toBe("👍🏽");
    expect(firstEmoji("👩‍👩‍👧")).toBe("👩‍👩‍👧");
  });
});
