import { describe, expect, it } from "vitest";

import {
  ATTACHMENT_FILE_MAX_BYTES,
  ATTACHMENT_IMAGE_SOURCE_MAX_BYTES,
  attachmentExtension,
  attachmentPath,
  bytesToBase64,
  exceededAttachmentLimit,
  fitWithin,
  formatByteLimit,
} from "./attachments";

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

describe("attachment size limits (review 2026-09-25)", () => {
  it("refuses a non-image file over the server's 1 MiB cap before it's read", () => {
    expect(exceededAttachmentLimit({ type: "application/pdf", size: ATTACHMENT_FILE_MAX_BYTES })).toBeUndefined();
    expect(exceededAttachmentLimit({ type: "application/pdf", size: ATTACHMENT_FILE_MAX_BYTES + 1 })).toBe(ATTACHMENT_FILE_MAX_BYTES);
    expect(exceededAttachmentLimit({ type: "", size: 100 * 1024 * 1024 })).toBe(ATTACHMENT_FILE_MAX_BYTES);
  });

  it("lets a normal photo through to the downscaler but refuses an absurd source image", () => {
    expect(exceededAttachmentLimit({ type: "image/jpeg", size: 8 * 1024 * 1024 })).toBeUndefined();
    expect(exceededAttachmentLimit({ type: "image/jpeg", size: ATTACHMENT_IMAGE_SOURCE_MAX_BYTES + 1 })).toBe(
      ATTACHMENT_IMAGE_SOURCE_MAX_BYTES,
    );
  });

  it("formats limits for the error text", () => {
    expect(formatByteLimit(1024 * 1024)).toBe("1 MB");
    expect(formatByteLimit(256 * 1024)).toBe("256 KB");
  });

  it("bytesToBase64 matches btoa for small and multi-chunk inputs", () => {
    const small = new Uint8Array([0, 1, 2, 250, 255]);
    expect(bytesToBase64(small)).toBe(btoa(String.fromCharCode(...small)));
    const big = new Uint8Array(100_000).map((_, index) => index % 256);
    let reference = "";
    for (const byte of big) {
      reference += String.fromCharCode(byte);
    }
    expect(bytesToBase64(big)).toBe(btoa(reference));
    expect(bytesToBase64(new Uint8Array())).toBe("");
  });
});
