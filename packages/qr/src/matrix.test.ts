import { describe, expect, it } from "vitest";

import { buildMatrix } from "./matrix.js";

describe("matrix builder", () => {
  it("creates the right size and reserves core function modules", () => {
    const matrix = buildMatrix(4, []);

    expect(matrix.size).toBe(33);
    expect(matrix.modules[0][0]).toBe(true);
    expect(matrix.modules[6][6]).toBe(true);
    expect(matrix.reserved[8][8]).toBe(true);
    expect(matrix.modules[26][26]).toBe(true);
    expect(matrix.reserved[32][32]).toBe(false);
  });
});
