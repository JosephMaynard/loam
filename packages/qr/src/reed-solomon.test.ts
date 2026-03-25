import { describe, expect, it } from "vitest";

import { interleaveBlocks, rsEncodeBlock, rsGeneratorPoly } from "./reed-solomon";

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
});
