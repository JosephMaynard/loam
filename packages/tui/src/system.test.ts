import { describe, expect, it } from "vitest";

import { openCommand } from "./system.js";

describe("openCommand", () => {
  const url = "http://localhost:3000/#k=key&a=code";

  it("uses the platform's opener", () => {
    expect(openCommand("darwin", {})?.command).toBe("open");
    expect(openCommand("darwin", {})?.args(url)).toEqual([url]);
    expect(openCommand("linux", { DISPLAY: ":0" })?.command).toBe("xdg-open");
    expect(openCommand("win32", {})?.args(url)).toEqual(["/c", "start", '""', "http://localhost:3000/#k=key^&a=code"]);
  });

  it("has nothing to open with on a Linux box without a desktop (over SSH)", () => {
    expect(openCommand("linux", {})).toBeUndefined();
  });
});
