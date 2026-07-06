import { encodeQR, renderQRToSvg } from "@loam/qr";

/**
 * Render a URL as a QR SVG string, returning "" if the encoder can't fit it (the dependency-free
 * encoder caps at version 6-H ≈ 58 UTF-8 bytes, so an unusually long host+port join URL throws).
 * Callers show the URL text alongside the QR, so a missing code degrades gracefully rather than
 * crashing the panel that renders it.
 */
export function safeQrSvg(url: string | undefined, dark: string, light = "#ffffff"): string {
  if (!url) {
    return "";
  }

  try {
    return renderQRToSvg(encodeQR(url), { dark, light });
  } catch {
    return "";
  }
}
