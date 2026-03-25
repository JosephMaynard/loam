import type { QRMatrix } from "./types";

type TerminalOptions = {
  quietZone?: number;
};

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
  const quietZone = opts.quietZone ?? 2;
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

    lines.push(line);
  }

  return lines.join("\n");
}
