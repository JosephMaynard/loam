// Line assembly for the `loam` launcher's no-echo passphrase prompt (bin/loam.js). Pure, so it's
// testable (cli/test/line-buffer.test.mjs). Raw-mode stdin can deliver several lines in ONE chunk — a
// pasted "pass\npass\n" answers the passphrase AND its confirmation — so completed lines queue here
// across prompts instead of being dropped after the first newline.

/**
 * A buffer fed raw terminal chunks. `push(chunk)` returns `"interrupt"` when the chunk contains Ctrl-C
 * (the caller aborts), else undefined. `next()` takes the oldest completed line, or undefined when none
 * is complete yet.
 *
 * Enter arrives as "\r" in raw mode; a paste may carry "\n" or "\r\n" (one line break, not two). Ctrl-D
 * ends the line like Enter. Backspace/DEL removes the last character; other control characters are ignored.
 */
export function createLineBuffer() {
  const lines = [];
  let current = "";
  let lastWasCR = false;
  return {
    push(chunk) {
      for (const ch of String(chunk)) {
        if (ch === "\u0003") {
          return "interrupt";
        }
        if (ch === "\n" && lastWasCR) {
          lastWasCR = false;
          continue;
        }
        lastWasCR = ch === "\r";
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          lines.push(current);
          current = "";
        } else if (ch === "\u007f" || ch === "\b") {
          current = current.slice(0, -1);
        } else if (ch >= " ") {
          current += ch;
        }
      }
      return undefined;
    },
    next() {
      return lines.shift();
    },
  };
}
