import { beforeEach, describe, expect, it } from "vitest";

import { captureInviteCode } from "./invite";
import { captureJoinKey, getCachedHostPublicKey, resetTransportStateForTests } from "./transport";

const PINNED = "A".repeat(43);
const OTHER = "B".repeat(43);

/** Run the start-up capture main.tsx runs, against a given address. */
function startAt(url: string): void {
  window.history.replaceState(null, "", url);
  captureInviteCode();
  captureJoinKey();
}

beforeEach(() => {
  resetTransportStateForTests();
  localStorage.clear();
  sessionStorage.clear();
  delete (window as { __loamHostTransportKey?: string }).__loamHostTransportKey;
  window.history.replaceState(null, "", "/");
});

describe("the join key at start-up", () => {
  it("pins a scanned key before the router can drop the fragment", () => {
    startAt(`/#k=${PINNED}`);
    expect(getCachedHostPublicKey()).toBe(PINNED);
    expect(window.location.hash).toBe("");
  });

  it("never lets a link swap an established pin, whatever else the link carries", () => {
    // Review 2026-10-03 #1: an `h=` parameter used to mark the page as the host app's own and adopt the
    // link's key over the pin, without a prompt.
    startAt(`/#k=${PINNED}`);
    for (const extra of ["", `&h=${"x".repeat(16)}`, `&i=invitecode&h=${"y".repeat(32)}`]) {
      startAt(`/#k=${OTHER}${extra}`);
      expect(getCachedHostPublicKey()).toBe(PINNED);
    }
    expect((window as { __loamHostDeviceToken?: string }).__loamHostDeviceToken).toBeUndefined();
  });

  it("adopts the key only the host app's own WebView injects", () => {
    startAt(`/#k=${PINNED}`);
    (window as { __loamHostTransportKey?: string }).__loamHostTransportKey = OTHER;
    startAt("/");
    expect(getCachedHostPublicKey()).toBe(OTHER);
  });
});
