/**
 * Raw terminal input to key events. In raw mode a keypress arrives as bytes: a printable character, a
 * control byte (Enter is "\r", Ctrl-C is "\x03") or an escape sequence (arrows are "\x1b[A"…). One chunk can
 * hold several keys (fast typing, a paste), so a chunk becomes a list.
 */

export type KeyName =
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "pageup"
  | "pagedown"
  | "enter"
  | "escape"
  | "backspace"
  | "delete"
  | "tab"
  | "shift-tab"
  | "ctrl-c"
  | "ctrl-d"
  | "ctrl-l"
  | "char";

/** A key; `char` holds the typed character (one grapheme) when `name` is "char". */
export type Key = { name: KeyName; char?: string };

/** Escape sequences, longest first so a prefix never wins. */
const SEQUENCES: [string, KeyName][] = [
  ["\x1b[1~", "home"],
  ["\x1b[4~", "end"],
  ["\x1b[5~", "pageup"],
  ["\x1b[6~", "pagedown"],
  ["\x1b[3~", "delete"],
  ["\x1b[A", "up"],
  ["\x1b[B", "down"],
  ["\x1b[C", "right"],
  ["\x1b[D", "left"],
  ["\x1b[H", "home"],
  ["\x1b[F", "end"],
  ["\x1b[Z", "shift-tab"],
  ["\x1bOA", "up"],
  ["\x1bOB", "down"],
  ["\x1bOC", "right"],
  ["\x1bOD", "left"],
  ["\x1bOH", "home"],
  ["\x1bOF", "end"],
];

const CONTROL: Record<string, KeyName> = {
  "\r": "enter",
  "\n": "enter",
  "\x7f": "backspace",
  "\b": "backspace",
  "\t": "tab",
  "\x03": "ctrl-c",
  "\x04": "ctrl-d",
  "\x0c": "ctrl-l",
};

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The keys in one chunk of raw input. Unknown escape sequences are skipped whole. */
export function parseKeys(chunk: string): Key[] {
  const keys: Key[] = [];
  let index = 0;
  while (index < chunk.length) {
    const rest = chunk.slice(index);

    if (rest.startsWith("\x1b")) {
      const known = SEQUENCES.find(([sequence]) => rest.startsWith(sequence));
      if (known) {
        keys.push({ name: known[1] });
        index += known[0].length;
        continue;
      }
      // A CSI sequence we don't use (a function key, a mouse report): skip to its final byte.
      const csi = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(rest);
      if (csi) {
        index += csi[0].length;
        continue;
      }
      // A lone Escape, or Alt+key: either way the user meant Escape.
      keys.push({ name: "escape" });
      index += /^\x1b[^[O]/.test(rest) ? 2 : 1;
      continue;
    }

    // "\r\n" from some terminals is one Enter.
    if (rest.startsWith("\r\n")) {
      keys.push({ name: "enter" });
      index += 2;
      continue;
    }

    const control = CONTROL[rest[0]!];
    if (control) {
      keys.push({ name: control });
      index += 1;
      continue;
    }

    const grapheme = segmenter.segment(rest)[Symbol.iterator]().next().value?.segment ?? rest[0]!;
    // Any other control byte is dropped.
    if (!/^[\u0000-\u001f]/.test(grapheme)) {
      keys.push({ name: "char", char: grapheme });
    }
    index += grapheme.length;
  }
  return keys;
}

/** Whether `key` is the character `char` (case-insensitive for letters). */
export function isChar(key: Key, char: string): boolean {
  return key.name === "char" && key.char?.toLowerCase() === char.toLowerCase();
}
