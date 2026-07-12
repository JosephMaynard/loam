import type { InternalMatrix, QRErrorCorrectionLevel } from "./types.js";

/**
 * Precomputed 15-bit format-info strings (ISO/IEC 18004 §8.9): 2 error-correction-level indicator
 * bits + 3 mask-pattern bits, BCH(15,5)-encoded (generator `0b1_0100_1101_11`) and XORed with the
 * fixed mask `0b1010_1000_0010_010`. Indexed by mask id 0-7. `H`'s values were verified against a
 * from-scratch computation of the same algorithm (see docs/15 #10 follow-up), which reproduced
 * this table exactly and was then used to derive `M`.
 */
export const FORMAT_INFO_H = [
  0b001011010001001,
  0b001001110111110,
  0b001110011100111,
  0b001100111010000,
  0b000011101100010,
  0b000001001010101,
  0b000110100001100,
  0b000100000111011,
] as const;

export const FORMAT_INFO_M = [
  0b101010000010010,
  0b101000100100101,
  0b101111001111100,
  0b101101101001011,
  0b100010111111001,
  0b100000011001110,
  0b100111110010111,
  0b100101010100000,
] as const;

function getBit(value: number, index: number): boolean {
  return ((value >>> index) & 1) === 1;
}

function setFormatModule(matrix: InternalMatrix, row: number, col: number, dark: boolean): void {
  matrix.modules[row][col] = dark;
  matrix.reserved[row][col] = true;
}

/**
 * Write the format-info bits (error correction level + mask id) into both redundant strips flanking
 * the top-left finder pattern.
 *
 * @param ecLevel - Error correction level; defaults to `"H"` (unchanged behaviour for existing callers)
 */
export function placeFormatInfo(matrix: InternalMatrix, maskId: number, ecLevel: QRErrorCorrectionLevel = "H"): void {
  const table = ecLevel === "M" ? FORMAT_INFO_M : FORMAT_INFO_H;

  if (!Number.isInteger(maskId) || maskId < 0 || maskId >= table.length) {
    throw new RangeError(`Mask id must be an integer from 0 to ${table.length - 1}`);
  }

  const bits = table[maskId];

  for (let i = 0; i <= 5; i += 1) {
    setFormatModule(matrix, i, 8, getBit(bits, i));
  }
  setFormatModule(matrix, 7, 8, getBit(bits, 6));
  setFormatModule(matrix, 8, 8, getBit(bits, 7));
  setFormatModule(matrix, 8, 7, getBit(bits, 8));
  for (let i = 9; i < 15; i += 1) {
    setFormatModule(matrix, 8, 14 - i, getBit(bits, i));
  }

  for (let i = 0; i < 8; i += 1) {
    setFormatModule(matrix, 8, matrix.size - 1 - i, getBit(bits, i));
  }
  for (let i = 8; i < 15; i += 1) {
    setFormatModule(matrix, matrix.size - 15 + i, 8, getBit(bits, i));
  }
}
