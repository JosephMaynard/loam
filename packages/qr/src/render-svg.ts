import type { QRMatrix } from "./types";

type SvgOptions = {
  quietZone?: number;
  logoHref?: string;
  logoScale?: number;
  dark?: string;
  light?: string;
};

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function renderQRToSvg(matrix: QRMatrix, opts: SvgOptions = {}): string {
  const quietZone = opts.quietZone ?? 4;
  const dark = opts.dark ?? "#000";
  const light = opts.light ?? "#fff";
  const totalSize = matrix.size + quietZone * 2;
  let path = "";

  for (let row = 0; row < matrix.size; row += 1) {
    for (let col = 0; col < matrix.size; col += 1) {
      if (matrix.data[row * matrix.size + col]) {
        path += `M${col + quietZone},${row + quietZone}h1v1h-1z`;
      }
    }
  }

  let logoMarkup = "";
  if (opts.logoHref) {
    const logoScale = Math.min(Math.max(opts.logoScale ?? 0.18, 0), 0.24);
    const logoSize = matrix.size * logoScale;
    const backdropPadding = Math.max(1, logoSize * 0.18);
    const backdropSize = logoSize + backdropPadding * 2;
    const backdropX = quietZone + (matrix.size - backdropSize) / 2;
    const backdropY = quietZone + (matrix.size - backdropSize) / 2;
    const logoX = quietZone + (matrix.size - logoSize) / 2;
    const logoY = quietZone + (matrix.size - logoSize) / 2;

    logoMarkup = `<rect x="${backdropX}" y="${backdropY}" width="${backdropSize}" height="${backdropSize}" rx="${Math.max(1, backdropSize * 0.12)}" fill="${escapeXmlAttribute(light)}"/><image href="${escapeXmlAttribute(opts.logoHref)}" x="${logoX}" y="${logoY}" width="${logoSize}" height="${logoSize}" preserveAspectRatio="xMidYMid meet"/>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalSize} ${totalSize}" shape-rendering="crispEdges"><rect width="${totalSize}" height="${totalSize}" fill="${escapeXmlAttribute(light)}"/><path fill="${escapeXmlAttribute(dark)}" d="${path}"/>${logoMarkup}</svg>`;
}
