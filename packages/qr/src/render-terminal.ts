import type { QRMatrix } from "./types.js";

export type TerminalOptions = {
  /** Blank modules around the code (the quiet zone scanners need), in modules per side. Default 2. */
  quietZone?: number;
  /**
   * Paint every line black on white with ANSI colours. Bare block characters take the terminal's own colours,
   * so on a dark theme the code comes out inverted (light modules on dark), which many scanners refuse. Off
   * by default: a caller knows whether its output is a colour terminal (not a file, not under NO_COLOR).
   */
  colour?: boolean;
};

/** Black text on a white background, then reset: the same colours `@loam/tui` draws its QR in. */
const BLACK_ON_WHITE = "\u001b[30;47m";
const RESET = "\u001b[0m";

function normalizeQuietZone(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 2;
  }

  return Math.max(0, Math.floor(value));
}

function getModule(matrix: QRMatrix, row: number, col: number, quietZone: number): boolean {
  if (
    row < quietZone ||
    col < quietZone ||
    row >= matrix.size + quietZone ||
    col >= matrix.size + quietZone
  ) {
    return false;
  }

  const innerRow = row - quietZone;
  const innerCol = col - quietZone;
  return matrix.data[innerRow * matrix.size + innerCol];
}

export function renderQRToTerminal(matrix: QRMatrix, opts: TerminalOptions = {}): string {
  const quietZone = normalizeQuietZone(opts.quietZone);
  const totalSize = matrix.size + quietZone * 2;
  const lines: string[] = [];

  for (let row = 0; row < totalSize; row += 2) {
    let line = "";

    for (let col = 0; col < totalSize; col += 1) {
      const top = getModule(matrix, row, col, quietZone);
      const bottom = row + 1 < totalSize ? getModule(matrix, row + 1, col, quietZone) : false;

      if (top && bottom) {
        line += "█";
      } else if (top) {
        line += "▀";
      } else if (bottom) {
        line += "▄";
      } else {
        line += " ";
      }
    }

    lines.push(opts.colour ? `${BLACK_ON_WHITE}${line}${RESET}` : line);
  }

  return lines.join("\n");
}
