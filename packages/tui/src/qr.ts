/**
 * The join QR as styled lines. Each text row holds two module rows (upper and lower half blocks), and the
 * colours are fixed black on white, so the code reads correctly on a dark terminal as well as a light one
 * (a plain block-character QR comes out inverted on a dark background, which some scanners refuse).
 */
import { encodeQR } from "@loam/qr";

import type { Line } from "./ansi.js";

const QUIET_ZONE = 2;

export type QrBlock = { lines: Line[]; width: number };

/** The QR for `value`, or undefined when it doesn't fit the encoder (a very long join address). */
export function qrBlock(value: string): QrBlock | undefined {
  let matrix: ReturnType<typeof encodeQR>;
  try {
    matrix = encodeQR(value);
  } catch {
    return undefined;
  }
  const size = matrix.size + QUIET_ZONE * 2;
  const dark = (row: number, col: number): boolean => {
    const r = row - QUIET_ZONE;
    const c = col - QUIET_ZONE;
    return r >= 0 && c >= 0 && r < matrix.size && c < matrix.size && matrix.data[r * matrix.size + c] === true;
  };

  const lines: Line[] = [];
  for (let row = 0; row < size; row += 2) {
    let cells = "";
    for (let col = 0; col < size; col += 1) {
      const top = dark(row, col);
      const bottom = row + 1 < size && dark(row + 1, col);
      cells += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push([{ text: cells, style: { fg: "black", bg: "white", keepColor: true } }]);
  }
  return { lines, width: size };
}
