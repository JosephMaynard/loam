import { describe, expect, it } from "vitest";

import { placeFormatInfo } from "./format-info";
import { buildMatrix } from "./matrix";

describe("format info", () => {
  it("writes the expected H/mask 0 format pattern into both strips", () => {
    const matrix = buildMatrix(4, []);

    placeFormatInfo(matrix, 0);

    const rowBits = Array.from({ length: 9 }, (_, col) => (matrix.modules[8][col] ? 1 : 0));
    const lowerColumnBits = Array.from({ length: 7 }, (_, index) =>
      matrix.modules[26 + index][8] ? 1 : 0,
    );

    // QR format string 001011010001001 is the H/mask-0 test vector, read MSB to LSB.
    expect(rowBits).toEqual([0, 0, 1, 0, 1, 1, 1, 0, 1]);
    // The lower column strip stores the same format information in layout order, top to bottom.
    expect(lowerColumnBits).toEqual([0, 1, 1, 0, 1, 0, 0]);
  });
});
