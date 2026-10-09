import { describe, expect, it } from "vitest";

import { encodeQR } from "./encode.js";
import { renderQRToTerminal } from "./render-terminal.js";

const matrix = encodeQR("http://192.168.8.159:3000#k=hostkey_0123456789abcdefghijklmnopqrstuvwxy");

describe("renderQRToTerminal", () => {
  it("draws bare blocks by default, quiet zone included", () => {
    const plain = renderQRToTerminal(matrix);
    const rows = plain.split("\n");
    expect(plain).not.toContain("\u001b");
    expect(rows).toHaveLength(Math.ceil((matrix.size + 4) / 2));
    for (const row of rows) {
      expect(row).toHaveLength(matrix.size + 4);
      expect(row).toMatch(/^ {2}.* {2}$/);
    }
    expect(rows[0]).toBe(" ".repeat(matrix.size + 4));
  });

  it("paints every row black on white when asked, the quiet zone with it", () => {
    const coloured = renderQRToTerminal(matrix, { colour: true, quietZone: 2 });
    const rows = coloured.split("\n");
    expect(rows).toHaveLength(Math.ceil((matrix.size + 4) / 2));
    for (const row of rows) {
      expect(row.startsWith("\u001b[30;47m")).toBe(true);
      expect(row.endsWith("\u001b[0m")).toBe(true);
    }
    // The same modules as the plain drawing, only wrapped.
    expect(rows.map((row) => row.slice("\u001b[30;47m".length, -"\u001b[0m".length)).join("\n")).toBe(renderQRToTerminal(matrix));
  });

  it("honours the quiet zone", () => {
    expect(renderQRToTerminal(matrix, { quietZone: 0 }).split("\n")[0]).toHaveLength(matrix.size);
    expect(renderQRToTerminal(matrix, { quietZone: 4 }).split("\n")[0]).toHaveLength(matrix.size + 8);
  });
});
