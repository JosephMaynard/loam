/**
 * Raw terminal input to key events. In raw mode a keypress arrives as bytes: a printable character, a
 * control byte (Enter is "\r", Ctrl-C is "\x03") or an escape sequence (arrows are "\x1b[A"…). One chunk can
 * hold several keys (fast typing), and one key can arrive split over two chunks (over SSH especially), so
 * the reader keeps an unfinished sequence until the rest arrives; a lone Escape is only an Escape once
 * nothing follows it for a moment (`flush`).
 *
 * Pasted text arrives between bracketed-paste markers (the terminal is asked for them) and becomes one
 * "paste" event, so a pasted line break or letter can never act as a key.
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
  | "char"
  | "paste";

/** A key; `char` holds the typed character (one grapheme) for "char", `text` the pasted text for "paste". */
export type Key = { name: KeyName; char?: string; text?: string };

/** CSI sequences by their final part. */
const CSI: Record<string, KeyName> = {
  "[A": "up",
  "[B": "down",
  "[C": "right",
  "[D": "left",
  "[H": "home",
  "[F": "end",
  "[Z": "shift-tab",
  "[1~": "home",
  "[4~": "end",
  "[7~": "home",
  "[8~": "end",
  "[5~": "pageup",
  "[6~": "pagedown",
  "[3~": "delete",
};

/** SS3 sequences (application cursor mode, and F1 to F4, which we don't use). */
const SS3: Record<string, KeyName> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
};

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

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
/** A paste larger than this without its end marker is given up on. */
const MAX_PASTE = 64 * 1024;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export type KeyReader = {
  /** The keys a chunk completes. An unfinished sequence at its end is kept for the next chunk. */
  feed(chunk: string): Key[];
  /** Give up waiting: a kept lone Escape becomes Escape, anything else unfinished is dropped. */
  flush(): Key[];
  /** Whether something is being kept. */
  pending(): boolean;
};

export function createKeyReader(): KeyReader {
  let kept = "";

  /** Parse `input`; returns the keys and what's left unfinished. */
  function parse(input: string): { keys: Key[]; rest: string } {
    const keys: Key[] = [];
    let index = 0;
    while (index < input.length) {
      const rest = input.slice(index);

      if (rest.startsWith("\x1b")) {
        if (rest.startsWith(PASTE_START)) {
          const end = rest.indexOf(PASTE_END);
          if (end < 0) {
            return { keys, rest };
          }
          keys.push({ name: "paste", text: rest.slice(PASTE_START.length, end) });
          index += end + PASTE_END.length;
          continue;
        }
        if (rest.length === 1 || PASTE_START.startsWith(rest)) {
          return { keys, rest };
        }
        const second = rest[1]!;
        if (second === "[") {
          // CSI: parameters, intermediates, then one final byte.
          const csi = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(rest);
          if (!csi) {
            if (/^\x1b\[[0-?]*[ -/]*$/.test(rest)) {
              return { keys, rest };
            }
            keys.push({ name: "escape" });
            index += 1;
            continue;
          }
          const known = CSI[csi[0].slice(1)];
          if (known) {
            keys.push({ name: known });
          }
          index += csi[0].length;
          continue;
        }
        if (second === "O") {
          if (rest.length < 3) {
            return { keys, rest };
          }
          const known = SS3[rest[2]!];
          if (known) {
            keys.push({ name: known });
          }
          index += 3;
          continue;
        }
        // Escape, then another key (Alt+key, or Escape pressed twice): the Escape, then read on.
        keys.push({ name: "escape" });
        index += second === "\x1b" ? 1 : 2;
        continue;
      }

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
    return { keys, rest: "" };
  }

  return {
    feed(chunk) {
      const { keys, rest } = parse(kept + chunk);
      kept = rest;
      return keys;
    },
    flush() {
      // A paste still arriving is kept (up to a limit): its end marker may just be slow.
      if (kept.startsWith(PASTE_START) && kept.length < MAX_PASTE) {
        return [];
      }
      const wasEscape = kept === "\x1b";
      kept = "";
      return wasEscape ? [{ name: "escape" }] : [];
    },
    pending: () => kept.length > 0,
  };
}

/** The keys in one complete chunk of input (a fresh reader, flushed): for tests and one-off parsing. */
export function parseKeys(chunk: string): Key[] {
  const reader = createKeyReader();
  return [...reader.feed(chunk), ...reader.flush()];
}

/** Whether `key` is the character `char` (case-insensitive for letters). */
export function isChar(key: Key, char: string): boolean {
  return key.name === "char" && key.char?.toLowerCase() === char.toLowerCase();
}
