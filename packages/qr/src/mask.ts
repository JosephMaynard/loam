import type { InternalMatrix } from "./types";
import { placeFormatInfo } from "./format-info";

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

function cloneMatrix(matrix: InternalMatrix): InternalMatrix {
  return {
    size: matrix.size,
    modules: matrix.modules.map((row) => [...row]),
    reserved: matrix.reserved.map((row) => [...row]),
  };
}

export function shouldMask(maskId: number, row: number, col: number): boolean {
  switch (maskId) {
    case 0:
      return (row + col) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    case 3:
      return (row + col) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6:
      return ((((row * col) % 2) + ((row * col) % 3)) % 2) === 0;
    case 7:
      return ((((row + col) % 2) + ((row * col) % 3)) % 2) === 0;
    default:
      throw new Error(`Unsupported mask ${maskId}`);
  }
}

function applyMask(matrix: InternalMatrix, maskId: number): InternalMatrix {
  const masked = cloneMatrix(matrix);

  for (let row = 0; row < masked.size; row += 1) {
    for (let col = 0; col < masked.size; col += 1) {
      if (!masked.reserved[row][col] && shouldMask(maskId, row, col)) {
        masked.modules[row][col] = !masked.modules[row][col];
      }
    }
  }

  return masked;
}

function finderPenaltyCountPatterns(runHistory: number[], _size: number): number {
  const n = runHistory[1];
  const core =
    n > 0 &&
    runHistory[2] === n &&
    runHistory[3] === n * 3 &&
    runHistory[4] === n &&
    runHistory[5] === n;

  return (
    (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0) +
    (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0)
  );
}

function finderPenaltyAddHistory(currentRunLength: number, runHistory: number[], size: number): void {
  if (runHistory[0] === 0) {
    currentRunLength += size;
  }

  runHistory.pop();
  runHistory.unshift(currentRunLength);
}

function finderPenaltyTerminateAndCount(
  currentRunColor: boolean,
  currentRunLength: number,
  runHistory: number[],
  size: number,
): number {
  if (currentRunColor) {
    finderPenaltyAddHistory(currentRunLength, runHistory, size);
    currentRunLength = 0;
  }

  currentRunLength += size;
  finderPenaltyAddHistory(currentRunLength, runHistory, size);
  return finderPenaltyCountPatterns(runHistory, size);
}

export function scoreMask(matrix: InternalMatrix): number {
  let score = 0;
  let darkCount = 0;

  for (let row = 0; row < matrix.size; row += 1) {
    let runColor = false;
    let runLength = 0;
    const runHistory = [0, 0, 0, 0, 0, 0, 0];

    for (let col = 0; col < matrix.size; col += 1) {
      if (matrix.modules[row][col] === runColor) {
        runLength += 1;
        if (runLength === 5) {
          score += PENALTY_N1;
        } else if (runLength > 5) {
          score += 1;
        }
      } else {
        finderPenaltyAddHistory(runLength, runHistory, matrix.size);
        if (!runColor) {
          score += finderPenaltyCountPatterns(runHistory, matrix.size) * PENALTY_N3;
        }
        runColor = matrix.modules[row][col];
        runLength = 1;
      }

      if (matrix.modules[row][col]) {
        darkCount += 1;
      }

      if (
        row < matrix.size - 1 &&
        col < matrix.size - 1 &&
        matrix.modules[row][col] === matrix.modules[row][col + 1] &&
        matrix.modules[row][col] === matrix.modules[row + 1][col] &&
        matrix.modules[row][col] === matrix.modules[row + 1][col + 1]
      ) {
        score += PENALTY_N2;
      }
    }

    score +=
      finderPenaltyTerminateAndCount(runColor, runLength, runHistory, matrix.size) * PENALTY_N3;
  }

  for (let col = 0; col < matrix.size; col += 1) {
    let runColor = false;
    let runLength = 0;
    const runHistory = [0, 0, 0, 0, 0, 0, 0];

    for (let row = 0; row < matrix.size; row += 1) {
      if (matrix.modules[row][col] === runColor) {
        runLength += 1;
        if (runLength === 5) {
          score += PENALTY_N1;
        } else if (runLength > 5) {
          score += 1;
        }
      } else {
        finderPenaltyAddHistory(runLength, runHistory, matrix.size);
        if (!runColor) {
          score += finderPenaltyCountPatterns(runHistory, matrix.size) * PENALTY_N3;
        }
        runColor = matrix.modules[row][col];
        runLength = 1;
      }
    }

    score +=
      finderPenaltyTerminateAndCount(runColor, runLength, runHistory, matrix.size) * PENALTY_N3;
  }

  const totalModules = matrix.size * matrix.size;
  const balancePenalty = Math.ceil(Math.abs(darkCount * 20 - totalModules * 10) / totalModules) - 1;
  score += balancePenalty * PENALTY_N4;

  return score;
}

export function applyBestMask(matrix: InternalMatrix): { masked: InternalMatrix; maskId: number } {
  let bestMaskId = 0;
  let bestMatrix = applyMask(matrix, 0);
  const firstScored = cloneMatrix(bestMatrix);
  placeFormatInfo(firstScored, 0);
  let bestScore = scoreMask(firstScored);

  for (let maskId = 1; maskId < 8; maskId += 1) {
    const candidate = applyMask(matrix, maskId);
    const scoredCandidate = cloneMatrix(candidate);
    placeFormatInfo(scoredCandidate, maskId);
    const score = scoreMask(scoredCandidate);

    if (score < bestScore) {
      bestScore = score;
      bestMaskId = maskId;
      bestMatrix = candidate;
    }
  }

  return { masked: bestMatrix, maskId: bestMaskId };
}
