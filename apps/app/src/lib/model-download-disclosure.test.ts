import { describe, expect, it } from "vitest";

import { modelDownloadDisclosure } from "./model-download-disclosure";

describe("modelDownloadDisclosure (docs/30 H4)", () => {
  it("states the size and warns about mobile/metered data for a catalog model", () => {
    const text = modelDownloadDisclosure("Gemma 3 4B", "2.3 GB");
    expect(text.title).toBe("Download Gemma 3 4B (2.3 GB)?");
    expect(text.message).toContain("2.3 GB");
    expect(text.message).toMatch(/Wi-Fi/);
    expect(text.message).toMatch(/mobile data|metered/);
  });

  it("says the size is unknown for a custom URL, and still warns", () => {
    const text = modelDownloadDisclosure("model.gguf", undefined);
    expect(text.title).toBe("Download model.gguf?");
    expect(text.message).toMatch(/isn't known/);
    expect(text.message).toMatch(/metered/);
  });
});
