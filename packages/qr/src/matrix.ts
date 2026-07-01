import { getVersionInfo } from "./capacity.js";
import type { InternalMatrix, QRVersion } from "./types.js";

function create2DArray(size: number, initial: boolean): boolean[][] {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => initial));
}

function inBounds(matrix: InternalMatrix, row: number, col: number): boolean {
  return row >= 0 && row < matrix.size && col >= 0 && col < matrix.size;
}

function setFunctionModule(matrix: InternalMatrix, row: number, col: number, dark: boolean): void {
  if (!inBounds(matrix, row, col)) {
    return;
  }

  matrix.modules[row][col] = dark;
  matrix.reserved[row][col] = true;
}

export function placeFinder(matrix: InternalMatrix, row: number, col: number): void {
  for (let dr = -1; dr <= 7; dr += 1) {
    for (let dc = -1; dc <= 7; dc += 1) {
      const r = row + dr;
      const c = col + dc;

      if (!inBounds(matrix, r, c)) {
        continue;
      }

      const insideCore = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
      const dark =
        insideCore &&
        (dr === 0 ||
          dr === 6 ||
          dc === 0 ||
          dc === 6 ||
          (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));

      setFunctionModule(matrix, r, c, dark);
    }
  }
}

export function placeAlignment(matrix: InternalMatrix, centerRow: number, centerCol: number): void {
  if (matrix.reserved[centerRow][centerCol]) {
    return;
  }

  for (let dr = -2; dr <= 2; dr += 1) {
    for (let dc = -2; dc <= 2; dc += 1) {
      const distance = Math.max(Math.abs(dr), Math.abs(dc));
      setFunctionModule(matrix, centerRow + dr, centerCol + dc, distance !== 1);
    }
  }
}

export function placeTiming(matrix: InternalMatrix): void {
  for (let i = 8; i < matrix.size - 8; i += 1) {
    setFunctionModule(matrix, 6, i, i % 2 === 0);
    setFunctionModule(matrix, i, 6, i % 2 === 0);
  }
}

export function reserveFormatInfo(matrix: InternalMatrix): void {
  const reserve = (row: number, col: number): void => {
    matrix.reserved[row][col] = true;
  };

  for (let col = 0; col <= 5; col += 1) {
    reserve(8, col);
  }
  reserve(8, 7);
  reserve(8, 8);

  for (let row = 0; row <= 5; row += 1) {
    reserve(row, 8);
  }
  reserve(7, 8);

  for (let col = matrix.size - 8; col < matrix.size; col += 1) {
    reserve(8, col);
  }

  for (let row = matrix.size - 7; row < matrix.size; row += 1) {
    reserve(row, 8);
  }
}

export function placeDarkModule(matrix: InternalMatrix, version: QRVersion): void {
  setFunctionModule(matrix, version * 4 + 9, 8, true);
}

export function placeDataBits(matrix: InternalMatrix, bits: number[]): void {
  let bitIndex = 0;
  let upwards = true;

  for (let rightCol = matrix.size - 1; rightCol >= 1; rightCol -= 2) {
    if (rightCol === 6) {
      rightCol -= 1;
    }

    for (let i = 0; i < matrix.size; i += 1) {
      const row = upwards ? matrix.size - 1 - i : i;

      for (let offset = 0; offset < 2; offset += 1) {
        const col = rightCol - offset;

        if (matrix.reserved[row][col]) {
          continue;
        }

        matrix.modules[row][col] = bitIndex < bits.length ? bits[bitIndex] === 1 : false;
        bitIndex += 1;
      }
    }

    upwards = !upwards;
  }
}

export function buildMatrix(version: QRVersion, finalBits: number[]): InternalMatrix {
  const { size, alignmentCenters } = getVersionInfo(version);
  const matrix: InternalMatrix = {
    size,
    modules: create2DArray(size, false),
    reserved: create2DArray(size, false),
  };

  placeFinder(matrix, 0, 0);
  placeFinder(matrix, 0, size - 7);
  placeFinder(matrix, size - 7, 0);
  placeTiming(matrix);

  for (const row of alignmentCenters) {
    for (const col of alignmentCenters) {
      placeAlignment(matrix, row, col);
    }
  }

  reserveFormatInfo(matrix);
  placeDarkModule(matrix, version);
  placeDataBits(matrix, finalBits);

  return matrix;
}

export function flattenMatrix(matrix: InternalMatrix): boolean[] {
  return matrix.modules.flat();
}
