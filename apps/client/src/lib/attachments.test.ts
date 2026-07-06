import { describe, expect, it } from "vitest";

import { attachmentExtension, attachmentPath, fitWithin } from "./attachments";

describe("fitWithin", () => {
  it("never upscales", () => {
    expect(fitWithin(640, 480, 1280)).toEqual({ width: 640, height: 480 });
  });

  it("caps the longest edge preserving aspect ratio", () => {
    expect(fitWithin(4000, 3000, 1280)).toEqual({ width: 1280, height: 960 });
    expect(fitWithin(3000, 4000, 1280)).toEqual({ width: 960, height: 1280 });
  });

  it("never collapses a dimension to zero", () => {
    expect(fitWithin(10_000, 1, 1280).height).toBe(1);
    expect(fitWithin(0, 0, 1280)).toEqual({ width: 1, height: 1 });
  });
});

describe("attachment paths", () => {
  it("maps MIME types to the server's canonical extensions", () => {
    expect(attachmentExtension("image/png")).toBe("png");
    expect(attachmentExtension("image/jpeg")).toBe("jpg");
    expect(attachmentExtension("image/webp")).toBe("webp");
  });

  it("builds the served path from id and MIME type", () => {
    expect(attachmentPath({ id: "att_0123456789abcdef", mimeType: "image/webp" })).toBe(
      "/api/attachments/att_0123456789abcdef.webp",
    );
  });
});
