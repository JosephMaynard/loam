export type AvatarMode = "face" | "initial";

export interface AvatarResult {
  html: string;
  lightMode: string;
  darkMode: string;
}

export interface AvatarColors {
  bg: string;
  shade: string;
  accent: string;
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
const PALETTE = [
  "#f2c572",
  "#e8a878",
  "#e8897c",
  "#d9748c",
  "#c76bba",
  "#9a78dc",
  "#7b8ae5",
  "#68a3e4",
  "#63b8d9",
  "#67c5c0",
  "#78cdab",
  "#97d183",
  "#bed46d",
  "#d6ca72",
  "#e7b86c",
  "#eaa18d",
  "#d998bb",
  "#b88bcd",
  "#8fa0d9",
  "#80c0e0",
];
const LIGHT_SURFACE = "#f7f2eb";
const DARK_SURFACE = "#14161b";
const MIN_TEXT_CONTRAST = 4.5;
const BACKGROUND_INK = "#171411";
const BACKGROUND_PAPER = "#fffdf8";

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

  return svg as unknown as SVGSVGElement;
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

function clampChannel(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
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

function shiftColor(hex: string, lightnessDelta: number, saturationDelta = 0, hueDelta = 0): string {
  const hsl = rgbToHsl(hexToRgb(hex));
  return rgbToHex(
    hslToRgb({
      h: hsl.h + hueDelta,
      s: clamp01(hsl.s + saturationDelta),
      l: clamp01(hsl.l + lightnessDelta),
    }),
  );
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

function deriveAccent(bg: string, seed: number): string {
  const hsl = rgbToHsl(hexToRgb(bg));
  return rgbToHex(
    hslToRgb({
      h: hsl.h + 145 + (seed % 55),
      s: clamp01(Math.max(0.45, hsl.s + 0.08)),
      l: clamp01(hsl.l < 0.56 ? 0.62 : 0.42),
    }),
  );
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

function renderInitialAvatar(label: string, colors: AvatarColors): string {
  const initial = escapeXml(getInitialCharacter(label));
  const ink = getInitialInk(colors.bg);

  return [
    `<svg xmlns="${SVG_NS}" viewBox="0 0 128 128" aria-hidden="true" focusable="false">`,
    `<rect width="128" height="128" rx="30" fill="${colors.bg}"/>`,
    `<circle cx="101" cy="29" r="18" fill="${colors.accent}" opacity="0.5"/>`,
    `<path d="M0 100C18 90 34 85 50 86C78 87 100 102 128 90V128H0Z" fill="${colors.shade}" opacity="0.72"/>`,
    `<text x="64" y="70" fill="${ink}" font-size="56" font-weight="700" text-anchor="middle" dominant-baseline="middle">${initial}</text>`,
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
  const bg = PALETTE[seed % PALETTE.length];
  const shade = shiftColor(bg, -0.16, 0.04);
  const accent = deriveAccent(bg, seed);
  const colors: AvatarColors = {
    bg,
    shade,
    accent,
    lightMode: ensureContrast(bg, LIGHT_SURFACE, MIN_TEXT_CONTRAST),
    darkMode: ensureContrast(bg, DARK_SURFACE, MIN_TEXT_CONTRAST),
  };

  store.colors.set(id, colors);
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
    mode === "initial" ? renderInitialAvatar(label || id, colors) : createFaceAvatar(id, colors);
  const result: AvatarResult = {
    html,
    lightMode: colors.lightMode,
    darkMode: colors.darkMode,
  };

  store.results.set(cacheKey, result);
  return result;
}
