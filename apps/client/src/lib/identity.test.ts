import { afterEach, describe, expect, it, vi } from "vitest";

import { CONFIRMED_USER_KEY, forgetConfirmedIdentity, listenForIdentityChange, recordConfirmedIdentity } from "./identity";

describe("listenForIdentityChange (review 2026-09-25: multi-tab purge)", () => {
  function fire(key: string, newValue: string | null): void {
    window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
  }

  it("fires only when a sibling confirms a different identity than this tab's", () => {
    let mine: string | undefined = "user.a";
    const onChange = vi.fn();
    const unsubscribe = listenForIdentityChange(() => mine, onChange);

    fire(CONFIRMED_USER_KEY, "user.a"); // same identity
    fire("loam.somethingElse", "user.b"); // another key
    fire(CONFIRMED_USER_KEY, null); // removed by a wipe — the wipe listener's job
    expect(onChange).not.toHaveBeenCalled();

    fire(CONFIRMED_USER_KEY, "user.b");
    expect(onChange).toHaveBeenCalledTimes(1);

    mine = undefined; // this tab holds no identity's content
    fire(CONFIRMED_USER_KEY, "user.c");
    expect(onChange).toHaveBeenCalledTimes(1);

    unsubscribe();
    mine = "user.a";
    fire(CONFIRMED_USER_KEY, "user.d");
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

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
