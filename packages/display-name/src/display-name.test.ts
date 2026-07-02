import { describe, expect, it } from "vitest";

import {
  englishWordPack,
  generateDisplayName,
  getDisplayNameParts,
  hashString,
} from "./display-name.js";

describe("hashString", () => {
  it("is deterministic and unsigned", () => {
    expect(hashString("jhiFKh88dhiu")).toBe(hashString("jhiFKh88dhiu"));
    expect(hashString("jhiFKh88dhiu") >>> 0).toBe(hashString("jhiFKh88dhiu"));
  });
});

describe("generateDisplayName", () => {
  it("returns a stable dotted three-word display name", () => {
    expect(generateDisplayName("jhiFKh88dhiu")).toBe(generateDisplayName("jhiFKh88dhiu"));
    expect(generateDisplayName("jhiFKh88dhiu")).toMatch(/^[a-z]+\.[a-z]+\.[a-z]+$/);
  });

  it("produces different names for different ids", () => {
    expect(generateDisplayName("jhiFKh88dhiu")).not.toBe(generateDisplayName("Qz1mV0f8eL2k"));
  });

  it("returns words from the configured pack", () => {
    const parts = getDisplayNameParts("abc123+/==", englishWordPack);

    expect(englishWordPack.adjectives).toContain(parts.adjective);
    expect(englishWordPack.materials).toContain(parts.material);
    expect(englishWordPack.creatures).toContain(parts.creature);
  });

  it("supports custom packs for future language sets", () => {
    const customPack = {
      adjectives: ["uno", "dos"],
      materials: ["tres", "cuatro"],
      creatures: ["cinco", "seis"],
    } as const;

    expect(generateDisplayName("seed", customPack)).toMatch(/^(uno|dos)\.(tres|cuatro)\.(cinco|seis)$/);
  });
});
