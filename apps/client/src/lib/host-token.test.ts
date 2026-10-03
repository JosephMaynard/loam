import { beforeEach, describe, expect, it } from "vitest";

import { captureHostToken } from "./host-token";

describe("captureHostToken", () => {
  beforeEach(() => {
    window.__loamHostDeviceToken = undefined;
    window.history.replaceState(null, "", "/");
  });

  it("takes the host token out of the address, leaving the key for the transport", () => {
    window.history.replaceState(null, "", "/#k=key_123&h=hosttoken-0123456789abcdef");
    captureHostToken();
    expect(window.location.hash).toBe("#k=key_123");
    expect(window.__loamHostDeviceToken).toBe("hosttoken-0123456789abcdef");
    expect((window as { __loamHostTransportKey?: string }).__loamHostTransportKey).toBe("key_123");
  });

  it("ignores a malformed token and leaves a fragment without one alone", () => {
    window.history.replaceState(null, "", "/#k=key_123&h=short");
    captureHostToken();
    expect(window.location.hash).toBe("#k=key_123");
    expect(window.__loamHostDeviceToken).toBeUndefined();

    window.history.replaceState(null, "", "/#k=key_123");
    captureHostToken();
    expect(window.location.hash).toBe("#k=key_123");
  });
});
