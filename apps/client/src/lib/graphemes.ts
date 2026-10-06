/**
 * Split text into user-perceived characters (grapheme clusters).
 *
 * `Intl.Segmenter` does this properly, but it arrived in Chrome 87 and Safari 14.1, and the browser floor
 * (DESIGN.md) is an Android WebView of about Chrome 80. Without it, text is split with a regex that keeps
 * every emoji sequence whole (the schema's {@link EMOJI_SEQUENCE_PATTERN}: skin tones, ZWJ families,
 * flags, keycaps) and keeps combining marks on their base character. That is not full Unicode
 * segmentation, but it is enough for what the client asks: which parts of a body are emoji.
 */
import { EMOJI_SEQUENCE_PATTERN } from "@loam/schema";

/** One emoji sequence, or any one character, either followed by combining marks (variation selectors too). */
const FALLBACK_CLUSTER = new RegExp(`(?:${EMOJI_SEQUENCE_PATTERN}|[\\s\\S])\\p{M}*`, "gu");

/**
 * The grapheme clusters of `text`, in order.
 *
 * @param text - Any text.
 * @returns Each cluster as its own string; joined, they give back `text`.
 */
export function graphemes(text: string): string[] {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (part) => part.segment);
  }

  return text.match(FALLBACK_CLUSTER) ?? [];
}
