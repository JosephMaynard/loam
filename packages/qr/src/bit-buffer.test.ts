import { describe, expect, it } from "vitest";

import { BitBuffer } from "./bit-buffer";

describe("BitBuffer", () => {
  it("writes bits and bytes in order", () => {
    const buffer = new BitBuffer();

    buffer.write(0b0100, 4);
    buffer.write(0x05, 8);
    buffer.write(0x41, 8);
    buffer.write(0, 4);
    buffer.padToByte();

    expect(Array.from(buffer.toBytes())).toEqual([0x40, 0x54, 0x10]);
  });
});
