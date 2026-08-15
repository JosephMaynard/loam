import { encodeQR, renderQRToSvg } from "@loam/qr";

/**
 * Render a URL as a QR SVG string, returning "" if the encoder can't fit it. The dependency-free
 * encoder caps at version 6 but auto-degrades the EC level (H → M, ≈58 → ≈106 UTF-8 bytes) so
 * keyed `#k=` join URLs encode; only genuinely oversized payloads (e.g. a mesh identity card's
 * JSON) still throw. Callers show the URL text alongside the QR, so a missing code degrades
 * gracefully rather than crashing the panel that renders it.
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
