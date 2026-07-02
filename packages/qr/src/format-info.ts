import type { InternalMatrix } from "./types.js";

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

function getBit(value: number, index: number): boolean {
  return ((value >>> index) & 1) === 1;
}

function setFormatModule(matrix: InternalMatrix, row: number, col: number, dark: boolean): void {
  matrix.modules[row][col] = dark;
  matrix.reserved[row][col] = true;
}

export function placeFormatInfo(matrix: InternalMatrix, maskId: number): void {
  if (!Number.isInteger(maskId) || maskId < 0 || maskId >= FORMAT_INFO_H.length) {
    throw new RangeError(`Mask id must be an integer from 0 to ${FORMAT_INFO_H.length - 1}`);
  }

  const bits = FORMAT_INFO_H[maskId];

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
