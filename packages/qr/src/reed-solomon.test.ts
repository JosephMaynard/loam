import { describe, expect, it } from "vitest";

import { interleaveBlocks, rsEncodeBlock, rsGeneratorPoly } from "./reed-solomon.js";

describe("Reed-Solomon", () => {
  it("builds the expected generator polynomial for degree 7", () => {
    expect(Array.from(rsGeneratorPoly(7))).toEqual([1, 127, 122, 154, 164, 11, 68, 117]);
  });

  it("encodes a block into the expected ECC remainder", () => {
    const data = Uint8Array.from([0x40, 0x54, 0x84, 0x54, 0xc4, 0xc4, 0xf0]);

    expect(Array.from(rsEncodeBlock(data, 10))).toEqual([158, 220, 221, 92, 215, 198, 116, 97, 242, 1]);
  });

  it("interleaves variable-length blocks round-robin", () => {
    const interleaved = interleaveBlocks([
      {
        data: Uint8Array.from([1, 2]),
        ecc: Uint8Array.from([7, 8]),
      },
      {
        data: Uint8Array.from([3, 4, 5]),
        ecc: Uint8Array.from([9, 10]),
      },
      {
        data: Uint8Array.from([6]),
        ecc: Uint8Array.from([11, 12]),
      },
    ]);

    expect(Array.from(interleaved)).toEqual([1, 3, 6, 2, 4, 5, 7, 9, 11, 8, 10, 12]);
  });

  it("interleaves a two-size-class block layout (the version 5-H shape) in block order", () => {
    // Version 5-H splits data into two groups of unequal length — 2 blocks of 11 codewords and 2 of
    // 12 (see `getVersionInfo(5, "H").blocks`). This is a scaled-down analog of that layout
    // ([2, 2, 3, 3] data lengths): the subtlety a single-continuation test misses is the final data
    // column, where BOTH longer blocks (b2, b3) still contribute — in block order — after both
    // shorter blocks (b0, b1) have run out. The literal golden below locks that exact ordering.
    const golden = interleaveBlocks([
      { data: Uint8Array.from([10, 11]), ecc: Uint8Array.from([70, 71]) },
      { data: Uint8Array.from([20, 21]), ecc: Uint8Array.from([80, 81]) },
      { data: Uint8Array.from([30, 31, 32]), ecc: Uint8Array.from([90, 91]) },
      { data: Uint8Array.from([40, 41, 42]), ecc: Uint8Array.from([100, 101]) },
    ]);

    expect(Array.from(golden)).toEqual([
      // Data columns 0, 1 (all four blocks), then column 2 (only the two length-3 blocks).
      10, 20, 30, 40, 11, 21, 31, 41, 32, 42,
      // ECC columns 0, 1 (all four blocks — every ECC run is the same length).
      70, 80, 90, 100, 71, 81, 91, 101,
    ]);
  });
});
