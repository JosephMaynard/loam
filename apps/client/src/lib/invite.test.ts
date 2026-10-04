import { beforeEach, describe, expect, it } from "vitest";

import { captureInviteCode, splitInviteFragment, takeInviteCode } from "./invite";

describe("splitInviteFragment", () => {
  it("takes the code out and keeps the key", () => {
    expect(splitInviteFragment("#k=abc_DEF-1&i=CODE_123")).toEqual({ hash: "#k=abc_DEF-1", code: "CODE_123" });
    expect(splitInviteFragment("#i=CODE&k=abc")).toEqual({ hash: "#k=abc", code: "CODE" });
    expect(splitInviteFragment("#i=CODE")).toEqual({ hash: "", code: "CODE" });
  });

  it("leaves a fragment without a code alone, and drops a malformed code", () => {
    expect(splitInviteFragment("#k=abc")).toEqual({ hash: "#k=abc", code: undefined });
    expect(splitInviteFragment("")).toEqual({ hash: "" });
    expect(splitInviteFragment("#k=abc&i=<script>")).toEqual({ hash: "#k=abc", code: undefined });
  });
});

describe("captureInviteCode", () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  it("strips the code from the address bar and hands it out once", () => {
    window.history.replaceState(null, "", "/#k=key&i=CODE");
    captureInviteCode();
    expect(window.location.hash).toBe("#k=key");
    expect(takeInviteCode()).toBe("CODE");
    expect(takeInviteCode()).toBeUndefined();
  });

  it("does nothing without a code", () => {
    window.history.replaceState(null, "", "/#k=key");
    captureInviteCode();
    expect(window.location.hash).toBe("#k=key");
    expect(takeInviteCode()).toBeUndefined();
  });
});
