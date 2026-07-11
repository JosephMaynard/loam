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

  describe("level M (docs/15 #10 — WiFi payload capacity)", () => {
    it("encodes a WiFi payload too long for level H's version-6 ceiling (58 bytes)", () => {
      // A realistic LocalOnlyHotspot SSID + escaped passphrase: comfortably over H's 58-byte cap,
      // but well within M's 106-byte cap at version 6.
      const payload =
        "WIFI:T:WPA;S:LocalOnlyHotspot-8F3A21;P:a-realistic\\;long\\,passphrase\\:with\\\"escapes-99;;";
      expect(new TextEncoder().encode(payload).length).toBeGreaterThan(58);

      expect(() => encodeQRDetailed(payload, { ecLevel: "H" })).toThrow(/exceeds QR version 6-H capacity/);

      const result = encodeQRDetailed(payload, { ecLevel: "M" });
      expect(result.matrix.version).toBe(6);
    });

    it("produces a stable golden matrix for a long WiFi payload at level M", () => {
      const payload =
        "WIFI:T:WPA;S:LocalOnlyHotspot-8F3A21;P:a-realistic\\;long\\,passphrase\\:with\\\"escapes-99;;";
      const result = encodeQRDetailed(payload, { ecLevel: "M" });

      expect({
        version: result.matrix.version,
        maskId: result.maskId,
        rows: matrixRows(result.matrix.data, result.matrix.size),
      }).toMatchSnapshot();
    });

    it("throws when a level-M payload exceeds version 6-M capacity", () => {
      const tooLong = "x".repeat(107);
      expect(() => encodeQRDetailed(tooLong, { ecLevel: "M" })).toThrow(/exceeds QR version 6-M capacity/);
    });

    it("fits exactly at each version's M capacity boundary (62 / 84 / 106 bytes)", () => {
      expect(encodeQRDetailed("x".repeat(62), { ecLevel: "M" }).matrix.version).toBe(4);
      expect(encodeQRDetailed("x".repeat(84), { ecLevel: "M" }).matrix.version).toBe(5);
      expect(encodeQRDetailed("x".repeat(106), { ecLevel: "M" }).matrix.version).toBe(6);
    });

    it("still defaults to level H when ecLevel is omitted (small join-link QRs unaffected)", () => {
      const result = encodeQRDetailed("http://loam.local/user/aZ4kP2");
      expect(result.matrix.version).toBe(encodeQRDetailed("http://loam.local/user/aZ4kP2", { ecLevel: "H" }).matrix.version);
    });
  });
});
