import { describe, expect, it } from "vitest";

import { inlineParts, PRIVACY_POLICY } from "./privacy-policy";
import { parseRoute } from "./protocol";

describe("the in-app privacy policy", () => {
  it("is served at /privacy", () => {
    expect(parseRoute("/privacy")).toEqual({ screen: "privacy" });
  });

  it("splits its inline markup into plain, strong and code runs", () => {
    expect(inlineParts("**Camera:** scan a `link code` only.")).toEqual([
      { text: "Camera:", style: "strong" },
      { text: " scan a " },
      { text: "link code", style: "code" },
      { text: " only." },
    ]);
  });

  it("has no em-dashes and no links out of the app", () => {
    const text = JSON.stringify(PRIVACY_POLICY);
    expect(text).not.toContain("—");
    expect(text).not.toMatch(/https?:\/\//);
  });
});
