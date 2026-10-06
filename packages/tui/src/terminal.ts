/**
 * The terminal the UI draws on, behind a small interface so tests can use a fake. The real one switches to
 * the alternate screen (like `top` or `less`: the shell's scrollback is left as it was and comes back on
 * exit), hides the cursor, turns line wrap off (a row can never spill into the next one), asks for
 * bracketed paste (so pasted text can't act as keys) and reads keys in raw mode. Whatever happens, `stop()`
 * puts the terminal back.
 */
import type { Line } from "./ansi.js";
import { renderLine } from "./ansi.js";

export type Terminal = {
  columns(): number;
  rows(): number;
  /** Whether colours should be used (NO_COLOR unset). */
  color: boolean;
  write(output: string): void;
  onInput(listener: (chunk: string) => void): void;
  onResize(listener: () => void): void;
  start(): void;
  stop(): void;
};

/** The process's own terminal. Only call when stdin and stdout are TTYs. */
export function processTerminal(): Terminal {
  const { stdin, stdout } = process;
  let started = false;
  const restore = (): void => {
    if (!started) {
      return;
    }
    started = false;
    // Reset styles; paste markers off, line wrap back on, cursor shown; leave the alternate screen.
    stdout.write("\x1b[0m\x1b[?2004l\x1b[?7h\x1b[?25h\x1b[?1049l");
    if (stdin.isTTY) {
      stdin.setRawMode(false);
    }
    stdin.pause();
  };
  return {
    columns: () => stdout.columns || 80,
    rows: () => stdout.rows || 24,
    color: !process.env.NO_COLOR,
    write: (output) => {
      stdout.write(output);
    },
    onInput(listener) {
      stdin.on("data", (chunk: Buffer | string) => listener(chunk.toString()));
    },
    onResize(listener) {
      stdout.on("resize", listener);
    },
    start() {
      if (started) {
        return;
      }
      started = true;
      stdin.setRawMode(true);
      stdin.setEncoding("utf8");
      stdin.resume();
      // Alternate screen, hidden cursor, no line wrap, bracketed paste, cleared.
      stdout.write("\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?2004h\x1b[2J\x1b[H");
      process.once("exit", restore);
    },
    stop: restore,
  };
}

/**
 * Draws frames, rewriting only the rows that changed since the last one, so a once-a-second refresh doesn't
 * flicker. `invalidate()` forces the next frame to repaint everything (after a resize, or Ctrl-L).
 */
export function createPainter(terminal: Terminal): { paint(lines: Line[]): void; invalidate(): void } {
  let previous: string[] = [];
  return {
    paint(lines) {
      const width = terminal.columns();
      const rows = terminal.rows();
      let output = "";
      for (let row = 0; row < rows; row += 1) {
        const rendered = renderLine(lines[row] ?? [], width, terminal.color);
        if (previous[row] !== rendered) {
          output += `\x1b[${row + 1};1H${rendered}`;
          previous[row] = rendered;
        }
      }
      previous.length = rows;
      if (output) {
        terminal.write(output);
      }
    },
    invalidate() {
      previous = [];
      terminal.write("\x1b[2J");
    },
  };
}
