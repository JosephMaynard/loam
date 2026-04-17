import { describe, expect, it } from "vitest";

import { gfDiv, gfMul, gfPow } from "./gf256";

describe("GF(256)", () => {
  it("multiplies known values with polynomial 0x11d", () => {
    expect(gfMul(2, 2)).toBe(4);
    expect(gfMul(128, 2)).toBe(29);
    expect(gfMul(15, 32)).toBe(253);
  });

  it("supports power and division helpers", () => {
    expect(gfPow(0)).toBe(1);
    expect(gfPow(8)).toBe(29);
    expect(gfDiv(29, 29)).toBe(1);
    expect(() => gfDiv(1, 0)).toThrow();
  });
});
