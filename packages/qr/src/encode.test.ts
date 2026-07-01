import { describe, expect, it } from "vitest";

import { encodeQRDetailed } from "./encode.js";
import { renderQRToTerminal } from "./render-terminal.js";
import { renderQRToSvg } from "./render-svg.js";

function matrixRows(data: boolean[], size: number): string[] {
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, col) => (data[row * size + col] ? "1" : "0")).join(""),
  );
}

describe("encodeQR", () => {
  it("throws when a forced version cannot fit the payload", () => {
    const tooLong = "x".repeat(35);
    expect(() => encodeQRDetailed(tooLong, { version: 4 })).toThrow(/version 4-H capacity/);
  });

  it("produces a stable golden matrix for a local user link", () => {
    const result = encodeQRDetailed("http://loam.local/user/aZ4kP2");

    expect({
      version: result.matrix.version,
      maskId: result.maskId,
      rows: matrixRows(result.matrix.data, result.matrix.size),
    }).toMatchSnapshot();
  });

  it("produces a stable golden matrix for a WiFi payload", () => {
    const result = encodeQRDetailed(
      "WIFI:T:WPA;S:LOAM-7F3A;P:correct-horse-battery-staple;;",
    );

    expect({
      version: result.matrix.version,
      maskId: result.maskId,
      rows: matrixRows(result.matrix.data, result.matrix.size),
    }).toMatchSnapshot();
  });

  it("renders compact SVG and terminal output from the encoded matrix", () => {
    const result = encodeQRDetailed("http://loam.local/channel/general");
    const svg = renderQRToSvg(result.matrix, {
      logoHref: "data:image/png;base64,iVBORw0KGgo=",
    });
    const terminal = renderQRToTerminal(result.matrix);

    expect(svg).toContain("<path");
    expect(svg).toContain("<image");
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(terminal).toContain("█");
    expect(terminal.split("\n").length).toBeGreaterThan(10);
  });

  it("does not embed untrusted external logo URLs", () => {
    const result = encodeQRDetailed("http://loam.local/channel/general");
    const svg = renderQRToSvg(result.matrix, {
      logoHref: "https://example.com/logo.png",
    });

    expect(svg).not.toContain("<image");
  });
});
