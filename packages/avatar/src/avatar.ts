export type AvatarMode = "face" | "initial" | "pattern";

export interface AvatarResult {
  html: string;
  lightMode: string;
  darkMode: string;
}

export interface AvatarColors {
  bg: string;
  shade: string;
  accent: string;
  tertiary: string;
  lightMode: string;
  darkMode: string;
}

export interface AvatarFeatureCounts {
  mouths: number;
  eyes: number;
  eyebrows: number;
  noses: number;
}

interface AvatarOptions {
  mode?: AvatarMode;
  label?: string;
}

type FeatureKey = keyof AvatarFeatureCounts;

interface TemplateCache {
  source: string;
  svg: SVGSVGElement;
  ids: Record<FeatureKey, string[]>;
  counts: AvatarFeatureCounts;
}

interface AvatarStore {
  colors: Map<string, AvatarColors>;
  results: Map<string, AvatarResult>;
  template?: TemplateCache;
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

interface HSL {
  h: number;
  s: number;
  l: number;
}

interface OKLCH {
  l: number;
  c: number;
  h: number;
}

type PatternShape = "circle" | "square" | "triangle" | "half" | "star";

const STORE_KEY = Symbol.for("loam.avatar.store");
const SVG_NS = "http://www.w3.org/2000/svg";
const FEATURE_IDS: Record<FeatureKey, string> = {
  mouths: "mouths",
  eyes: "eyes",
  eyebrows: "eyebrows",
  noses: "noses",
};
const RUNTIME_STYLE = `
#mouths > *,
#eyes > *,
#eyebrows > *,
#noses > * {
  display: none;
}

#mouths > *[data-active],
#eyes > *[data-active],
#eyebrows > *[data-active],
#noses > *[data-active] {
  display: inline;
}
`.trim();
const LIGHT_SURFACE = "#f7f2eb";
const DARK_SURFACE = "#14161b";
const MIN_TEXT_CONTRAST = 4.5;
const BACKGROUND_INK = "#171411";
const BACKGROUND_PAPER = "#fffdf8";
const SVG_TEXT_STACK = "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
const MAX_CACHE_SIZE = 500;

type AvatarGlobal = typeof globalThis & {
  [STORE_KEY]?: AvatarStore;
};

function getStore(): AvatarStore {
  const host = globalThis as AvatarGlobal;

  if (!host[STORE_KEY]) {
    host[STORE_KEY] = {
      colors: new Map(),
      results: new Map(),
    };
  }

  return host[STORE_KEY];
}

function setBoundedCache<K, V>(cache: Map<K, V>, key: K, value: V): void {
  if (cache.has(key)) {
    cache.delete(key);
  }

  cache.set(key, value);

  while (cache.size > MAX_CACHE_SIZE) {
    const oldestKey = cache.keys().next().value as K | undefined;

    if (oldestKey === undefined) {
      return;
    }

    cache.delete(oldestKey);
  }
}

function assertDomSupport(): void {
  if (typeof DOMParser === "undefined" || typeof XMLSerializer === "undefined") {
    throw new Error("Avatar generation requires DOMParser and XMLSerializer.");
  }
}

function parseSvg(svgText: string): SVGSVGElement {
  assertDomSupport();
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, "image/svg+xml");
  const svg = doc.documentElement;

  if (doc.querySelector("parsererror") || svg.tagName.toLowerCase() !== "svg") {
    throw new Error("Invalid avatar SVG template.");
  }

  sanitizeSvgTree(svg);

  return svg as unknown as SVGSVGElement;
}

function isDangerousUrl(value: string): boolean {
  const normalized = value.trim().replace(/[\u0000-\u001f\u007f\s]+/g, "").toLowerCase();
  return normalized.startsWith("javascript:") || normalized.startsWith("data:");
}

function isLocalFragmentReference(value: string): boolean {
  return value.trim().startsWith("#");
}

function sanitizeSvgTree(root: Element): void {
  const blockedElements = new Set(["script", "foreignobject", "iframe", "meta", "link"]);

  for (const element of Array.from(root.querySelectorAll("*"))) {
    if (blockedElements.has(element.tagName.toLowerCase())) {
      element.remove();
    }
  }

  for (const element of [root, ...Array.from(root.querySelectorAll("*"))]) {
    if (element.tagName.toLowerCase() === "style" && /@import|url\(|javascript:|data:|expression\(/i.test(element.textContent ?? "")) {
      element.textContent = "";
    }

    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value;

      if (name.startsWith("on") || name === "style") {
        element.removeAttribute(attribute.name);
        continue;
      }

      if ((name === "href" || name === "xlink:href") && (isDangerousUrl(value) || !isLocalFragmentReference(value))) {
        element.removeAttribute(attribute.name);
        continue;
      }

      if (name === "xmlns:xlink" && isDangerousUrl(value)) {
        element.removeAttribute(attribute.name);
        continue;
      }

      if (value.includes("url(") && !value.includes("url(#")) {
        element.removeAttribute(attribute.name);
      }
    }
  }
}

function ensureRuntimeStyle(svg: SVGSVGElement): void {
  let defs = svg.querySelector("defs");

  if (!defs) {
    defs = svg.ownerDocument.createElementNS(SVG_NS, "defs");
    svg.insertBefore(defs, svg.firstChild);
  }

  if (defs.querySelector('style[data-avatar-runtime="true"]')) {
    return;
  }

  const style = svg.ownerDocument.createElementNS(SVG_NS, "style");
  style.setAttribute("data-avatar-runtime", "true");
  style.textContent = RUNTIME_STYLE;
  defs.appendChild(style);
}

function getFeatureContainer(root: ParentNode, feature: FeatureKey): Element {
  const container = root.querySelector(`#${FEATURE_IDS[feature]}`);

  if (!container) {
    throw new Error(`Avatar template is missing #${FEATURE_IDS[feature]}.`);
  }

  return container;
}

function collectFeatureIds(svg: SVGSVGElement): Record<FeatureKey, string[]> {
  return {
    mouths: collectIdsFromContainer(getFeatureContainer(svg, "mouths"), "mouths"),
    eyes: collectIdsFromContainer(getFeatureContainer(svg, "eyes"), "eyes"),
    eyebrows: collectIdsFromContainer(getFeatureContainer(svg, "eyebrows"), "eyebrows"),
    noses: collectIdsFromContainer(getFeatureContainer(svg, "noses"), "noses"),
  };
}

function collectIdsFromContainer(container: Element, feature: FeatureKey): string[] {
  const ids = Array.from(container.children, (child) => child.getAttribute("id") ?? "");

  if (!ids.length || ids.some((id) => !id)) {
    throw new Error(`Avatar template children under #${FEATURE_IDS[feature]} must all have ids.`);
  }

  return ids;
}

function countFeatures(ids: Record<FeatureKey, string[]>): AvatarFeatureCounts {
  return {
    mouths: ids.mouths.length,
    eyes: ids.eyes.length,
    eyebrows: ids.eyebrows.length,
    noses: ids.noses.length,
  };
}

function ensureTemplate(): TemplateCache {
  const template = getStore().template;

  if (!template) {
    throw new Error("Avatar template has not been initialised.");
  }

  return template;
}

function mix32(value: number): number {
  let mixed = value >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b);
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

function pickIndex(seed: number, count: number): number {
  return count > 0 ? seed % count : 0;
}

function setVariantActive(root: SVGSVGElement, feature: FeatureKey, index: number): void {
  const container = getFeatureContainer(root, feature);
  const child = container.children.item(index);

  if (!child) {
    throw new Error(`Avatar template variant index out of range for ${feature}.`);
  }

  child.setAttribute("data-active", "");
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampChannel(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function toUnitInterval(seed: number, salt: number): number {
  return mix32(seed ^ salt) / 0xffffffff;
}

function hexToRgb(hex: string): RGB {
  const value = hex.replace("#", "");

  if (value.length !== 6) {
    throw new Error(`Unsupported colour format: ${hex}`);
  }

  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }: RGB): string {
  return `#${[r, g, b]
    .map((channel) => clampChannel(channel).toString(16).padStart(2, "0"))
    .join("")}`;
}

function normalizeHue(hue: number): number {
  return ((hue % 360) + 360) % 360;
}

function oklchToLinearRgb({ l, c, h }: OKLCH): RGB {
  const angle = (normalizeHue(h) * Math.PI) / 180;
  const a = c * Math.cos(angle);
  const b = c * Math.sin(angle);

  const lPrime = l + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = l - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = l - 0.0894841775 * a - 1.291485548 * b;

  const lCubed = lPrime ** 3;
  const mCubed = mPrime ** 3;
  const sCubed = sPrime ** 3;

  return {
    r: 4.0767416621 * lCubed - 3.3077115913 * mCubed + 0.2309699292 * sCubed,
    g: -1.2684380046 * lCubed + 2.6097574011 * mCubed - 0.3413193965 * sCubed,
    b: -0.0041960863 * lCubed - 0.7034186147 * mCubed + 1.707614701 * sCubed,
  };
}

function linearChannelToSrgb(value: number): number {
  const channel = clamp01(value);
  return channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
}

function isInSrgbGamut({ r, g, b }: RGB): boolean {
  return r >= 0 && r <= 1 && g >= 0 && g <= 1 && b >= 0 && b <= 1;
}

function oklchToHex(color: OKLCH): string {
  let candidate = { ...color };

  for (let step = 0; step < 24; step += 1) {
    const linear = oklchToLinearRgb(candidate);

    if (isInSrgbGamut(linear)) {
      return rgbToHex({
        r: linearChannelToSrgb(linear.r) * 255,
        g: linearChannelToSrgb(linear.g) * 255,
        b: linearChannelToSrgb(linear.b) * 255,
      });
    }

    candidate = {
      ...candidate,
      c: candidate.c * 0.92,
    };
  }

  const linear = oklchToLinearRgb(candidate);
  return rgbToHex({
    r: linearChannelToSrgb(linear.r) * 255,
    g: linearChannelToSrgb(linear.g) * 255,
    b: linearChannelToSrgb(linear.b) * 255,
  });
}

function rgbToHsl({ r, g, b }: RGB): HSL {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  const lightness = (max + min) / 2;

  if (!delta) {
    return { h: 0, s: 0, l: lightness };
  }

  const saturation =
    lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);

  let hue = 0;

  switch (max) {
    case red:
      hue = (green - blue) / delta + (green < blue ? 6 : 0);
      break;
    case green:
      hue = (blue - red) / delta + 2;
      break;
    default:
      hue = (red - green) / delta + 4;
      break;
  }

  return {
    h: hue * 60,
    s: saturation,
    l: lightness,
  };
}

function hueToChannel(p: number, q: number, t: number): number {
  let value = t;

  if (value < 0) {
    value += 1;
  }

  if (value > 1) {
    value -= 1;
  }

  if (value < 1 / 6) {
    return p + (q - p) * 6 * value;
  }

  if (value < 1 / 2) {
    return q;
  }

  if (value < 2 / 3) {
    return p + (q - p) * (2 / 3 - value) * 6;
  }

  return p;
}

function hslToRgb({ h, s, l }: HSL): RGB {
  const hue = ((h % 360) + 360) % 360 / 360;

  if (!s) {
    const channel = clampChannel(l * 255);
    return { r: channel, g: channel, b: channel };
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  return {
    r: clampChannel(hueToChannel(p, q, hue + 1 / 3) * 255),
    g: clampChannel(hueToChannel(p, q, hue) * 255),
    b: clampChannel(hueToChannel(p, q, hue - 1 / 3) * 255),
  };
}

function relativeLuminance(color: string): number {
  const { r, g, b } = hexToRgb(color);
  const channels = [r, g, b].map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function ensureContrast(color: string, surface: string, minContrast: number): string {
  if (contrastRatio(color, surface) >= minContrast) {
    return color;
  }

  const surfaceIsLight = relativeLuminance(surface) > 0.5;
  const hsl = rgbToHsl(hexToRgb(color));

  for (let step = 1; step <= 24; step += 1) {
    const lightness = clamp01(hsl.l + (surfaceIsLight ? -0.03 : 0.03) * step);
    const candidate = rgbToHex(hslToRgb({ ...hsl, l: lightness }));

    if (contrastRatio(candidate, surface) >= minContrast) {
      return candidate;
    }
  }

  return contrastRatio(BACKGROUND_INK, surface) >= contrastRatio(BACKGROUND_PAPER, surface)
    ? BACKGROUND_INK
    : BACKGROUND_PAPER;
}

function deriveAccent(seed: number, base: OKLCH): string {
  return oklchToHex({
    l: clamp(base.l + (toUnitInterval(seed, 0xf5f5f5f5) - 0.5) * 0.18, 0.46, 0.82),
    c: clamp(base.c + 0.08 + toUnitInterval(seed, 0x5a17c9b5) * 0.1, 0.18, 0.34),
    h: base.h + 108 + toUnitInterval(seed, 0x08f02d31) * 28,
  });
}

function deriveTertiary(seed: number, base: OKLCH): string {
  return oklchToHex({
    l: clamp(base.l + (toUnitInterval(seed, 0x541b4dd1) - 0.5) * 0.22, 0.42, 0.84),
    c: clamp(base.c + 0.07 + toUnitInterval(seed, 0x1d872b41) * 0.11, 0.18, 0.34),
    h: base.h + 228 + toUnitInterval(seed, 0x7f4a7c15) * 26,
  });
}

function createBaseColor(seed: number): OKLCH {
  return {
    l: 0.72 + toUnitInterval(seed, 0x243f6a88) * 0.16,
    c: 0.11 + toUnitInterval(seed, 0x85a308d3) * 0.13,
    h: toUnitInterval(seed, 0x13198a2e) * 360,
  };
}

function deriveShade(seed: number, base: OKLCH): string {
  return oklchToHex({
    l: clamp(base.l - (0.2 + toUnitInterval(seed, 0x37c7e57a) * 0.12), 0.28, 0.72),
    c: clamp(base.c + 0.06 + toUnitInterval(seed, 0x94d049bb) * 0.08, 0.14, 0.32),
    h: base.h - 10 + toUnitInterval(seed, 0x6ef372fe) * 24,
  });
}

function getInitialCharacter(label: string): string {
  const source = Array.from(label.trim()).find((char) => /[\p{L}\p{N}]/u.test(char));
  return source ? source.toUpperCase() : "?";
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function getInitialInk(bg: string): string {
  const darkContrast = contrastRatio(BACKGROUND_INK, bg);
  const lightContrast = contrastRatio(BACKGROUND_PAPER, bg);
  return darkContrast >= lightContrast ? BACKGROUND_INK : BACKGROUND_PAPER;
}

function starPoints(cx: number, cy: number, outerRadius: number, innerRadius: number, rotation: number): string {
  return Array.from({ length: 10 }, (_, index) => {
    const radius = index % 2 === 0 ? outerRadius : innerRadius;
    const angle = rotation + (Math.PI / 5) * index;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
}

function renderHalfCircle(x: number, y: number, fill: string, orientation: number): string {
  const left = x - 7.8;
  const right = x + 33.4;
  const top = y - 7.8;
  const bottom = y + 33.4;
  const centerX = x + 12.8;
  const centerY = y + 12.8;

  switch (orientation % 4) {
    case 0:
      return `<path data-shape="half" d="M ${left.toFixed(2)} ${centerY.toFixed(2)} A 20.6 20.6 0 0 1 ${right.toFixed(2)} ${centerY.toFixed(2)} L ${right.toFixed(2)} ${bottom.toFixed(2)} L ${left.toFixed(2)} ${bottom.toFixed(2)} Z" fill="${fill}"/>`;
    case 1:
      return `<path data-shape="half" d="M ${centerX.toFixed(2)} ${top.toFixed(2)} A 20.6 20.6 0 0 1 ${centerX.toFixed(2)} ${bottom.toFixed(2)} L ${left.toFixed(2)} ${bottom.toFixed(2)} L ${left.toFixed(2)} ${top.toFixed(2)} Z" fill="${fill}"/>`;
    case 2:
      return `<path data-shape="half" d="M ${left.toFixed(2)} ${centerY.toFixed(2)} A 20.6 20.6 0 0 0 ${right.toFixed(2)} ${centerY.toFixed(2)} L ${right.toFixed(2)} ${top.toFixed(2)} L ${left.toFixed(2)} ${top.toFixed(2)} Z" fill="${fill}"/>`;
    default:
      return `<path data-shape="half" d="M ${centerX.toFixed(2)} ${top.toFixed(2)} A 20.6 20.6 0 0 0 ${centerX.toFixed(2)} ${bottom.toFixed(2)} L ${right.toFixed(2)} ${bottom.toFixed(2)} L ${right.toFixed(2)} ${top.toFixed(2)} Z" fill="${fill}"/>`;
  }
}

function renderTriangle(x: number, y: number, fill: string, orientation: number): string {
  const left = x - 8.8;
  const right = x + 34.4;
  const top = y - 8.8;
  const bottom = y + 34.4;
  const centerX = x + 12.8;
  const centerY = y + 12.8;

  switch (orientation % 4) {
    case 0:
      return `<polygon data-shape="triangle" points="${centerX.toFixed(2)},${top.toFixed(2)} ${right.toFixed(2)},${bottom.toFixed(2)} ${left.toFixed(2)},${bottom.toFixed(2)}" fill="${fill}"/>`;
    case 1:
      return `<polygon data-shape="triangle" points="${right.toFixed(2)},${centerY.toFixed(2)} ${left.toFixed(2)},${top.toFixed(2)} ${left.toFixed(2)},${bottom.toFixed(2)}" fill="${fill}"/>`;
    case 2:
      return `<polygon data-shape="triangle" points="${centerX.toFixed(2)},${bottom.toFixed(2)} ${right.toFixed(2)},${top.toFixed(2)} ${left.toFixed(2)},${top.toFixed(2)}" fill="${fill}"/>`;
    default:
      return `<polygon data-shape="triangle" points="${left.toFixed(2)},${centerY.toFixed(2)} ${right.toFixed(2)},${top.toFixed(2)} ${right.toFixed(2)},${bottom.toFixed(2)}" fill="${fill}"/>`;
  }
}

function renderPatternTile(x: number, y: number, fill: string, shape: PatternShape, orientation: number): string {
  switch (shape) {
    case "circle":
      return `<circle data-shape="circle" cx="${x + 12.8}" cy="${y + 12.8}" r="18.4" fill="${fill}"/>`;
    case "square":
      return `<rect data-shape="square" x="${(x - 6.2).toFixed(2)}" y="${(y - 6.2).toFixed(2)}" width="38" height="38" fill="${fill}"/>`;
    case "triangle":
      return renderTriangle(x, y, fill, orientation);
    case "half":
      return renderHalfCircle(x, y, fill, orientation);
    case "star":
      return `<polygon data-shape="star" points="${starPoints(x + 12.8, y + 12.8, 20.2, 9.4, -Math.PI / 2 + (Math.PI / 2) * (orientation % 4))}" fill="${fill}"/>`;
  }
}

function patternTilePosition(index: number): number {
  return index * 25.6;
}

function setMirroredPatternCell(
  grid: Array<Array<boolean>>,
  row: number,
  col: number,
  value: boolean,
): void {
  for (const column of col === 2 ? [col] : [col, 4 - col]) {
    grid[row][column] = value;
  }
}

function countPatternCells(grid: Array<Array<boolean>>): number {
  return grid.flat().filter(Boolean).length;
}

function countPatternNeighbors(grid: Array<Array<boolean>>, row: number, col: number): number {
  let neighbors = 0;

  for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
    for (let colOffset = -1; colOffset <= 1; colOffset += 1) {
      if (!rowOffset && !colOffset) {
        continue;
      }

      const nextRow = row + rowOffset;
      const nextCol = col + colOffset;

      if (nextRow < 0 || nextRow > 4 || nextCol < 0 || nextCol > 4) {
        continue;
      }

      if (grid[nextRow][nextCol]) {
        neighbors += 1;
      }
    }
  }

  return neighbors;
}

function scorePatternCandidate(seed: number, row: number, col: number): number {
  return toUnitInterval(seed, 0x3c6ef372 ^ (row << 8) ^ col);
}

function buildPatternMask(seed: number): Array<Array<boolean>> {
  const grid = Array.from({ length: 5 }, () => Array<boolean>(5).fill(false));
  const profile = mix32(seed ^ 0x45d9f3b) % 4;
  const profileBias = [0.02, -0.03, 0.06, -0.01][profile];

  for (let row = 0; row < 5; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      const score = scorePatternCandidate(seed ^ (row * 0x9e3779b9), row, col);
      const rowBias = row === 2 ? -0.06 : row === 0 || row === 4 ? 0.04 : 0;
      const colBias = col === 1 ? 0.05 : 0;
      const active = score > 0.5 - profileBias - rowBias - colBias;
      setMirroredPatternCell(grid, row, col, active);
    }
  }

  if (!grid[2].some(Boolean)) {
    setMirroredPatternCell(grid, 2, mix32(seed ^ 0xa511e9b3) % 3, true);
  }

  if (!grid[0].some(Boolean)) {
    setMirroredPatternCell(grid, 0, mix32(seed ^ 0xf39cc060) % 3, true);
  }

  if (!grid[4].some(Boolean)) {
    setMirroredPatternCell(grid, 4, mix32(seed ^ 0x62992fc1) % 3, true);
  }

  for (let row = 0; row < 5; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      const mirroredCol = col === 2 ? 2 : 4 - col;
      const active = grid[row][col];
      const neighbors = countPatternNeighbors(grid, row, col);

      if (active && neighbors <= 1 && scorePatternCandidate(seed ^ 0x7f4a7c15, row, col) < 0.7) {
        setMirroredPatternCell(grid, row, col, false);
      } else if (
        !active &&
        neighbors >= 4 &&
        scorePatternCandidate(seed ^ 0x1d872b41, row, col) > 0.28
      ) {
        grid[row][col] = true;
        grid[row][mirroredCol] = true;
      }
    }
  }

  const minCells = 8;
  const maxCells = 17;

  while (countPatternCells(grid) < minCells) {
    let bestRow = 0;
    let bestCol = 0;
    let bestScore = -1;

    for (let row = 0; row < 5; row += 1) {
      for (let col = 0; col < 3; col += 1) {
        if (grid[row][col]) {
          continue;
        }

        const score =
          countPatternNeighbors(grid, row, col) * 0.25 + scorePatternCandidate(seed ^ 0x94d049bb, row, col);

        if (score > bestScore) {
          bestScore = score;
          bestRow = row;
          bestCol = col;
        }
      }
    }

    setMirroredPatternCell(grid, bestRow, bestCol, true);
  }

  while (countPatternCells(grid) > maxCells) {
    let worstRow = -1;
    let worstCol = -1;
    let worstScore = Number.POSITIVE_INFINITY;

    for (let row = 0; row < 5; row += 1) {
      for (let col = 0; col < 3; col += 1) {
        if (!grid[row][col]) {
          continue;
        }

        const protectedCell =
          (row === 2 && col === 1) ||
          (row === 0 && grid[0].filter(Boolean).length === (col === 2 ? 1 : 2)) ||
          (row === 4 && grid[4].filter(Boolean).length === (col === 2 ? 1 : 2));

        if (protectedCell) {
          continue;
        }

        const score =
          countPatternNeighbors(grid, row, col) * 0.3 + scorePatternCandidate(seed ^ 0x243f6a88, row, col);

        if (score < worstScore) {
          worstScore = score;
          worstRow = row;
          worstCol = col;
        }
      }
    }

    if (worstRow === -1) {
      break;
    }

    setMirroredPatternCell(grid, worstRow, worstCol, false);
  }

  return grid;
}

function getPatternShape(seed: number): PatternShape {
  const shapes: PatternShape[] = ["circle", "square", "triangle", "half", "star"];
  return shapes[mix32(seed ^ 0x632be5ab) % shapes.length];
}

function getPatternOrientation(shape: PatternShape): number {
  switch (shape) {
    case "triangle":
      return 1;
    case "half":
      return 2;
    case "star":
      return 3;
    default:
      return 0;
  }
}

function renderPatternAvatar(id: string, colors: AvatarColors): string {
  const seed = hashString(id);
  const grid = buildPatternMask(seed);
  const fillOrder = [colors.shade, colors.accent, colors.tertiary];
  const shape = getPatternShape(seed);
  const orientation = getPatternOrientation(shape);

  const tiles = grid.flatMap((row, rowIndex) =>
    row.flatMap((fill, colIndex) =>
      fill
        ? [
            (() => {
              const cellSeed = mix32(seed ^ (rowIndex * 0x85ebca6b) ^ (colIndex * 0xc2b2ae35));
              const fillColor = fillOrder[mix32(cellSeed ^ 0x165667b1) % fillOrder.length];

              return renderPatternTile(
                patternTilePosition(colIndex),
                patternTilePosition(rowIndex),
                fillColor,
                shape,
                orientation,
              );
            })(),
          ]
        : [],
    ),
  );

  return [
    `<svg xmlns="${SVG_NS}" viewBox="0 0 128 128" aria-hidden="true" focusable="false">`,
    `<rect width="128" height="128" rx="30" fill="${colors.bg}"/>`,
    `<g>${tiles.join("")}</g>`,
    `</svg>`,
  ].join("");
}

function renderInitialAvatar(label: string, colors: AvatarColors): string {
  const initial = escapeXml(getInitialCharacter(label));
  const ink = getInitialInk(colors.bg);

  return [
    `<svg xmlns="${SVG_NS}" viewBox="0 0 128 128" aria-hidden="true" focusable="false">`,
    `<rect width="128" height="128" rx="30" fill="${colors.bg}"/>`,
    `<circle cx="101" cy="29" r="18" fill="${colors.accent}" opacity="0.82"/>`,
    `<path d="M0 100C18 90 34 85 50 86C78 87 100 102 128 90V128H0Z" fill="${colors.shade}" opacity="0.72"/>`,
    `<text x="64" y="70" fill="${ink}" font-size="56" font-weight="700" text-anchor="middle" dominant-baseline="middle" font-family="${SVG_TEXT_STACK}">${initial}</text>`,
    `</svg>`,
  ].join("");
}

function serializeAvatar(svg: SVGSVGElement): string {
  assertDomSupport();
  return new XMLSerializer().serializeToString(svg);
}

function createFaceAvatar(id: string, colors: AvatarColors): string {
  const template = ensureTemplate();
  const svg = template.svg.cloneNode(true) as SVGSVGElement;
  const seed = hashString(id);
  const mouthSeed = mix32(seed ^ 0x1f123bb5);
  const eyesSeed = mix32(seed ^ (seed >>> 7) ^ 0x8f3a2c19);
  const eyebrowSeed = mix32(seed ^ (seed << 11) ^ 0x5bf03635);
  const noseSeed = mix32(seed ^ (seed >>> 13) ^ 0x36d2e9b1);

  setVariantActive(svg, "mouths", pickIndex(mouthSeed, template.counts.mouths));
  setVariantActive(svg, "eyes", pickIndex(eyesSeed, template.counts.eyes));
  setVariantActive(svg, "eyebrows", pickIndex(eyebrowSeed, template.counts.eyebrows));
  setVariantActive(svg, "noses", pickIndex(noseSeed, template.counts.noses));

  svg.style.setProperty("--bg", colors.bg);
  svg.style.setProperty("--shade", colors.shade);
  svg.style.setProperty("--accent", colors.accent);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

  return serializeAvatar(svg);
}

export function hashString(value: string): number {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return hash >>> 0;
}

export function initAvatarTemplate(svgText: string): void {
  const store = getStore();

  if (store.template?.source === svgText) {
    return;
  }

  const svg = parseSvg(svgText);
  ensureRuntimeStyle(svg);
  const ids = collectFeatureIds(svg);

  store.template = {
    source: svgText,
    svg,
    ids,
    counts: countFeatures(ids),
  };
  store.results.clear();
  store.colors.clear();
}

export function getAvatarCounts(): AvatarFeatureCounts {
  const { counts } = ensureTemplate();
  return { ...counts };
}

export function getAvatarColors(id: string): AvatarColors {
  const store = getStore();
  const cached = store.colors.get(id);

  if (cached) {
    return cached;
  }

  const seed = hashString(id);
  const base = createBaseColor(seed);
  const bg = oklchToHex(base);
  const shade = deriveShade(seed, base);
  const accent = deriveAccent(seed, base);
  const tertiary = deriveTertiary(seed, base);
  const colors: AvatarColors = {
    bg,
    shade,
    accent,
    tertiary,
    lightMode: ensureContrast(bg, LIGHT_SURFACE, MIN_TEXT_CONTRAST),
    darkMode: ensureContrast(bg, DARK_SURFACE, MIN_TEXT_CONTRAST),
  };

  setBoundedCache(store.colors, id, colors);
  return colors;
}

export function generateAvatar(id: string, options: AvatarOptions = {}): AvatarResult {
  const mode = options.mode ?? "face";
  const label = options.label ?? "";
  const cacheKey = mode === "initial" ? `${mode}\0${id}\0${label}` : `${mode}\0${id}`;
  const store = getStore();
  const cached = store.results.get(cacheKey);

  if (cached) {
    return cached;
  }

  const colors = getAvatarColors(id);
  const html =
    mode === "initial"
      ? renderInitialAvatar(label || id, colors)
      : mode === "pattern"
        ? renderPatternAvatar(id, colors)
        : createFaceAvatar(id, colors);
  const result: AvatarResult = {
    html,
    lightMode: colors.lightMode,
    darkMode: colors.darkMode,
  };

  setBoundedCache(store.results, cacheKey, result);
  return result;
}
