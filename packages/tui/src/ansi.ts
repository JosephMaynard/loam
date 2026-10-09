/**
 * Styled text for the terminal. A screen is a list of {@link Line}s; a line is a list of segments, each with
 * an optional style. Widths are measured on the text alone, so a line can be cut or padded to the terminal
 * width without counting escape codes.
 *
 * Every segment's text is cleaned before it is written: names, node names and log lines come from other
 * people, and a control character in them (an escape sequence in a display name, say) must never reach the
 * terminal, where it could move the cursor, rewrite the screen or worse.
 */

export type Color = "black" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white" | "gray";

export type Style = {
  bold?: boolean;
  dim?: boolean;
  inverse?: boolean;
  underline?: boolean;
  fg?: Color;
  bg?: Color;
  /** Keep the colours even under NO_COLOR, where they carry meaning (the QR's black on white). */
  keepColor?: boolean;
};

export type Segment = { text: string; style?: Style };
export type Line = Segment[];

const FG: Record<Color, number> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,
};

/** Control characters (C0, DEL, C1) and the bidi controls that could reorder what the operator reads. */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

/**
 * Invisible characters: Unicode's format characters and default ignorables (zero-width spaces and joiners,
 * the word joiner, soft hyphens, the byte order mark, Hangul fillers, tag characters…). Two names that differ
 * only by one of these look the same, so none reaches the terminal, with two exceptions made in {@link clean}:
 * a variation selector (it only picks a glyph, ☀ against ☀️) and a zero-width joiner holding an emoji
 * sequence together (👨‍👩‍👧).
 */
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;

const ZWJ = "\u200d";
const VARIATION_SELECTOR = /^[\ufe00-\ufe0f]$/u;
const EMOJI_MODIFIER = /^[\u{1f3fb}-\u{1f3ff}]$/u;
const PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u;

/**
 * A combining mark, variation selectors aside (they pick a glyph rather than stack on it). Too many on one
 * base draw over the rows above and below in most terminals, so {@link clean} keeps the first three (enough
 * for Burmese, Khmer and Tibetan stacks).
 */
const MARK = "(?:(?![\\ufe00-\\ufe0f])\\p{M})";
const STACKED_MARKS = new RegExp(`(${MARK}{3})${MARK}+`, "gu");

/** The code point that ends just before `index`, with where it starts. */
function codePointBefore(text: string, index: number): { codePoint: number; start: number } | undefined {
  if (index <= 0) {
    return undefined;
  }
  const low = text.charCodeAt(index - 1);
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
    const high = text.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) {
      return { codePoint: text.codePointAt(index - 2)!, start: index - 2 };
    }
  }
  return { codePoint: low, start: index - 1 };
}

/**
 * Whether the zero-width joiner at `index` sits between two pictographs (looking past a skin tone or
 * variation selector before it): the joiner of an emoji sequence, not an invisible character on its own.
 */
function joinsEmoji(text: string, index: number): boolean {
  const after = text.codePointAt(index + ZWJ.length);
  if (after === undefined || !PICTOGRAPHIC.test(String.fromCodePoint(after))) {
    return false;
  }
  let at = index;
  for (;;) {
    const before = codePointBefore(text, at);
    if (!before) {
      return false;
    }
    const char = String.fromCodePoint(before.codePoint);
    if (PICTOGRAPHIC.test(char)) {
      return true;
    }
    if (!VARIATION_SELECTOR.test(char) && !EMOJI_MODIFIER.test(char)) {
      return false;
    }
    at = before.start;
  }
}

/**
 * `text` as it may reach the terminal: tabs become a space; control characters, bidi controls and invisible
 * characters are removed (see {@link INVISIBLE} for the two kept); a base keeps at most three combining marks (enough for Burmese, Khmer and Tibetan stacks; not enough to smear rows).
 */
export function clean(text: string): string {
  return text
    .replace(/\t/g, " ")
    .replace(UNSAFE, "")
    .replace(INVISIBLE, (char, offset: number, whole: string) => {
      if (VARIATION_SELECTOR.test(char) || (char === ZWJ && joinsEmoji(whole, offset))) {
        return char;
      }
      return "";
    })
    .replace(STACKED_MARKS, "$1");
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Wide (two-column) ranges, per UAX #11's East Asian Wide and Fullwidth classes (the blocks that matter for
 * text: JavaScript has no East_Asian_Width property to ask). Line wrap is off while the UI runs, so a
 * character this misses can only cut its own row short, never spill into the next.
 */
const WIDE_RANGES: [number, number][] = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x17000, 0x18cff],
  [0x1aff0, 0x1b2ff],
  [0x1f200, 0x1f2ff],
  [0x20000, 0x3fffd],
];

function isWideCodePoint(cp: number): boolean {
  return WIDE_RANGES.some(([low, high]) => cp >= low && cp <= high);
}

/**
 * Columns one grapheme takes: 2 for emoji and wide characters, 0 for a lone combining mark or an invisible
 * format character (zero-width space, soft hyphen, BOM…), else 1.
 */
export function graphemeWidth(grapheme: string): number {
  const first = grapheme.codePointAt(0) ?? 0;
  if (/^[\p{M}\p{Default_Ignorable_Code_Point}]+$/u.test(grapheme)) {
    return 0;
  }
  // \ufe0f is VARIATION SELECTOR-16, emoji presentation: a pictograph on its own (☀) is text, one column
  // wide; with the selector (☀️) it is the colour emoji, two wide. Written as an escape so it stays visible.
  if (/\p{Emoji_Presentation}|\p{Extended_Pictographic}\ufe0f/u.test(grapheme) || isWideCodePoint(first)) {
    return 2;
  }
  return 1;
}

/** The graphemes of `text`. */
function graphemesOf(text: string): string[] {
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

/** Columns `text` takes in the terminal. */
export function textWidth(text: string): number {
  let width = 0;
  for (const grapheme of graphemesOf(text)) {
    width += graphemeWidth(grapheme);
  }
  return width;
}

/** `text` cut to at most `width` columns, with an ellipsis when it had to be cut. */
export function truncate(text: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  if (textWidth(text) <= width) {
    return text;
  }
  let out = "";
  let used = 0;
  for (const grapheme of graphemesOf(text)) {
    const w = graphemeWidth(grapheme);
    if (used + w > width - 1) {
      break;
    }
    out += grapheme;
    used += w;
  }
  return `${out}…`;
}

/** `text` padded with spaces (or cut) to exactly `width` columns. */
export function padEnd(text: string, width: number): string {
  const cut = truncate(text, width);
  return cut + " ".repeat(Math.max(0, width - textWidth(cut)));
}

/** Columns a line takes. */
export function lineWidth(line: Line): number {
  return line.reduce((sum, segment) => sum + textWidth(clean(segment.text)), 0);
}

/** A one-segment line. */
export function text(value: string, style?: Style): Line {
  return [{ text: value, style }];
}

export const blank: Line = [];

/** The SGR escape for a style, or "" for none. */
function sgr(style: Style | undefined, color: boolean): string {
  if (!style) {
    return "";
  }
  const codes: number[] = [];
  if (style.bold) codes.push(1);
  if (style.dim) codes.push(2);
  if (style.underline) codes.push(4);
  if (style.inverse) codes.push(7);
  const colored = color || style.keepColor === true;
  if (colored && style.fg) codes.push(FG[style.fg]);
  if (colored && style.bg) codes.push(FG[style.bg] + 10);
  return codes.length ? `\x1b[${codes.join(";")}m` : "";
}

/**
 * A line as terminal output exactly `width` columns wide: cleaned, styled, cut to fit and padded, so it
 * overwrites whatever was on that row before. `color: false` (NO_COLOR) keeps bold/inverse but drops colours.
 */
export function renderLine(line: Line, width: number, color = true): string {
  let out = "";
  let used = 0;
  for (const segment of line) {
    if (used >= width) {
      break;
    }
    const value = clean(segment.text);
    const room = width - used;
    const piece = textWidth(value) > room ? truncate(value, room) : value;
    const code = sgr(segment.style, color);
    out += code ? `${code}${piece}\x1b[0m` : piece;
    used += textWidth(piece);
  }
  return out + " ".repeat(Math.max(0, width - used));
}

/** Plain text of a line (tests, diagnostics). */
export function plain(line: Line): string {
  return line.map((segment) => clean(segment.text)).join("");
}
