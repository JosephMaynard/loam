import { afterEach, describe, expect, it } from "vitest";

import { CONFIRMED_USER_KEY, forgetConfirmedIdentity, recordConfirmedIdentity } from "./identity";

afterEach(() => localStorage.clear());

describe("recordConfirmedIdentity (review 2026-09-25: missed-wipe purge)", () => {
  it("the first confirmation is not a change", () => {
    expect(recordConfirmedIdentity("user.a")).toBe(false);
    expect(localStorage.getItem(CONFIRMED_USER_KEY)).toBe("user.a");
  });

  it("the same identity again is not a change", () => {
    recordConfirmedIdentity("user.a");
    expect(recordConfirmedIdentity("user.a")).toBe(false);
  });

  it("a different server-confirmed identity is a change (purge the cache)", () => {
    recordConfirmedIdentity("user.a");
    expect(recordConfirmedIdentity("user.b")).toBe(true);
    expect(recordConfirmedIdentity("user.b")).toBe(false);
  });

  it("after a wipe forgets it, the next identity is a fresh start, not a change", () => {
    recordConfirmedIdentity("user.a");
    forgetConfirmedIdentity();
    expect(recordConfirmedIdentity("user.b")).toBe(false);
  });
});
