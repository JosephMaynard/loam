import { readFileSync } from "node:fs";

import { JSDOM } from "jsdom";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  generateAvatar,
  getAvatarColors,
  getAvatarCounts,
  hashString,
  initAvatarTemplate,
} from "./avatar.js";

const STORE_KEY = Symbol.for("loam.avatar.store");
const LIGHT_SURFACE = "#f7f2eb";
const DARK_SURFACE = "#14161b";
const svgText = readFileSync(
  new URL("../../../apps/client/src/assets/avatars.svg", import.meta.url),
  "utf8",
);

function relativeLuminance(color: string): number {
  const value = color.replace("#", "");
  const channels = [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
  const mapped = channels.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * mapped[0] + 0.7152 * mapped[1] + 0.0722 * mapped[2];
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

beforeAll(() => {
  const { window } = new JSDOM("");
  Object.assign(globalThis, {
    DOMParser: window.DOMParser,
    XMLSerializer: window.XMLSerializer,
  });
});

beforeEach(() => {
  delete (globalThis as typeof globalThis & { [STORE_KEY]?: unknown })[STORE_KEY];
  initAvatarTemplate(svgText);
});

describe("hashString", () => {
  it("is deterministic and unsigned", () => {
    expect(hashString("loam:user")).toBe(hashString("loam:user"));
    expect(hashString("loam:user")).toBe(3507778623);
    expect(hashString("loam:user") >>> 0).toBe(hashString("loam:user"));
  });
});

describe("template loading", () => {
  it("derives variant counts from the SVG children", () => {
    expect(getAvatarCounts()).toEqual({
      mouths: 20,
      eyes: 18,
      eyebrows: 10,
      noses: 5,
    });
  });

  it("sanitizes unsafe SVG template content before caching", () => {
    initAvatarTemplate(`
      <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" onload="alert(1)" viewBox="0 0 128 128">
        <defs><style>@import url("https://example.com/style.css"); .x { fill: red; }</style></defs>
        <script>alert(1)</script>
        <g id="mouths"><g id="mouth-1" onclick="alert(1)"><path href="javascript:alert(1)" style="fill: url(https://example.com/a.svg)"/></g></g>
        <g id="eyes"><g id="eye-1"><foreignObject><p>unsafe</p></foreignObject><path xlink:href="data:image/svg+xml;base64,AAAA"/></g></g>
        <g id="eyebrows"><g id="eyebrow-1"><path/></g></g>
        <g id="noses"><g id="nose-1"><path/></g></g>
      </svg>
    `);

    const result = generateAvatar("sanitize-template").html;

    expect(result).not.toContain("onload");
    expect(result).not.toContain("onclick");
    expect(result).not.toContain("javascript:");
    expect(result).not.toContain("data:image");
    expect(result).not.toContain("foreignObject");
    expect(result).not.toContain("@import");
    expect(result).not.toContain("https://example.com");
  });
});

describe("generateAvatar", () => {
  it("returns cached results for repeated lookups", () => {
    const first = generateAvatar("moss.lake");
    const second = generateAvatar("moss.lake");

    expect(first).toBe(second);
  });

  it("activates exactly one variant in each feature container", () => {
    const result = generateAvatar("fern.ridge");
    const doc = new DOMParser().parseFromString(result.html, "image/svg+xml");

    expect(doc.querySelectorAll("#mouths > *[data-active]").length).toBe(1);
    expect(doc.querySelectorAll("#eyes > *[data-active]").length).toBe(1);
    expect(doc.querySelectorAll("#eyebrows > *[data-active]").length).toBe(1);
    expect(doc.querySelectorAll("#noses > *[data-active]").length).toBe(1);
    expect(result.html).toContain("--bg:");
    expect(result.html).toContain("--shade:");
    expect(result.html).toContain("--accent:");
  });

  it("usually varies across different ids", () => {
    expect(generateAvatar("moss.lake").html).not.toBe(generateAvatar("glass.cove").html);
  });

  it("uses the optional label for initial mode while keeping the id seed stable", () => {
    const ada = generateAvatar("user-42", { mode: "initial", label: "Ada" });
    const ben = generateAvatar("user-42", { mode: "initial", label: "Ben" });

    expect(ada.html).toContain(">A<");
    expect(ben.html).toContain(">B<");
    expect(ada.lightMode).toBe(ben.lightMode);
    expect(ada.darkMode).toBe(ben.darkMode);
    expect(ada).not.toBe(ben);
  });

  it("never lets a hostile label inject markup into the initial avatar", () => {
    const hostile = generateAvatar("user-42", { mode: "initial", label: '<img onerror="x">' });
    const symbols = generateAvatar("user-43", { mode: "initial", label: '<>&"\'' });

    expect(hostile.html).not.toContain("<img");
    expect(hostile.html).not.toContain("onerror");
    expect(hostile.html).toContain(">I<");

    const doc = new DOMParser().parseFromString(symbols.html, "image/svg+xml");
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.querySelector("text")?.textContent).toBe("?");
  });

  it("renders a mirrored abstract pattern mode", () => {
    const result = generateAvatar("pattern-user", { mode: "pattern" });
    const doc = new DOMParser().parseFromString(result.html, "image/svg+xml");
    const shapes = Array.from(doc.querySelectorAll("[data-shape]"), (node) =>
      node.getAttribute("data-shape"),
    );

    expect(result.html).not.toContain("clipPath");
    expect(shapes.length).toBeGreaterThanOrEqual(6);
    expect(new Set(shapes).size).toBe(1);
    expect(result).toBe(generateAvatar("pattern-user", { mode: "pattern" }));
  });

  it("produces multiple distinct pattern silhouettes across seeds", () => {
    const silhouettes = new Set(
      ["pattern-a", "pattern-b", "pattern-c", "pattern-d", "pattern-e"].map((id) => {
        const doc = new DOMParser().parseFromString(
          generateAvatar(id, { mode: "pattern" }).html,
          "image/svg+xml",
        );

        return [
          ...Array.from(doc.querySelectorAll("circle"), (node) =>
            `c:${node.getAttribute("cx")},${node.getAttribute("cy")}`,
          ),
          ...Array.from(doc.querySelectorAll('rect[x][y]'), (node) =>
            `r:${node.getAttribute("x")},${node.getAttribute("y")}`,
          ),
          ...Array.from(doc.querySelectorAll("polygon"), (node) => `g:${node.getAttribute("points")}`),
          ...Array.from(doc.querySelectorAll("path"), (node) => `p:${node.getAttribute("d")}`),
        ]
          .sort()
          .join("|");
      }),
    );

    expect(silhouettes.size).toBeGreaterThan(3);
  });

  it("uses multiple shape families across a small seed sample", () => {
    const shapeFamilies = new Set(
      ["pattern-a", "pattern-b", "pattern-c", "pattern-d", "pattern-e", "pattern-f", "pattern-g"].flatMap((id) => {
        const doc = new DOMParser().parseFromString(
          generateAvatar(id, { mode: "pattern" }).html,
          "image/svg+xml",
        );

        return Array.from(doc.querySelectorAll("[data-shape]"), (node) => node.getAttribute("data-shape") ?? "");
      }),
    );

    expect(shapeFamilies.size).toBeGreaterThan(2);
  });
});

describe("getAvatarColors", () => {
  it("returns accessible username colours for the default light and dark surfaces", () => {
    const colors = getAvatarColors("ember.wren");

    expect(contrastRatio(colors.lightMode, LIGHT_SURFACE)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.darkMode, DARK_SURFACE)).toBeGreaterThanOrEqual(4.5);
    expect(colors.tertiary).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("produces a wider spread of background colours than the old fixed palette", () => {
    const backgrounds = new Set(
      Array.from({ length: 64 }, (_, index) => getAvatarColors(`seed-${index}`).bg),
    );

    expect(backgrounds.size).toBeGreaterThan(40);
  });
});
