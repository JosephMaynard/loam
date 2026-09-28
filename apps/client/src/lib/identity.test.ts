import { afterEach, describe, expect, it, vi } from "vitest";

import { CONFIRMED_USER_KEY, confirmIdentity, forgetConfirmedIdentity, listenForIdentityChange, recordConfirmedIdentity } from "./identity";

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

describe("confirmIdentity (CodeRabbit, PR #130: record only after a successful purge)", () => {
  it("records a first-ever identity without purging", async () => {
    const purge = vi.fn(async () => undefined);
    expect(await confirmIdentity("user.a", purge)).toBe("unchanged");
    expect(purge).not.toHaveBeenCalled();
    expect(localStorage.getItem(CONFIRMED_USER_KEY)).toBe("user.a");
  });

  it("purges before recording a different identity, and the record lands only after the purge resolved", async () => {
    recordConfirmedIdentity("user.a");
    const seen: (string | null)[] = [];
    const purge = vi.fn(async () => {
      seen.push(localStorage.getItem(CONFIRMED_USER_KEY));
    });
    expect(await confirmIdentity("user.b", purge)).toBe("purged");
    expect(seen).toEqual(["user.a"]); // still the old identity while the purge ran
    expect(localStorage.getItem(CONFIRMED_USER_KEY)).toBe("user.b");
  });

  it("retries a failed purge once, then records", async () => {
    recordConfirmedIdentity("user.a");
    const purge = vi.fn().mockRejectedValueOnce(new Error("blocked")).mockResolvedValueOnce(undefined);
    expect(await confirmIdentity("user.b", purge, { retryDelayMs: 0 })).toBe("purged");
    expect(purge).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem(CONFIRMED_USER_KEY)).toBe("user.b");
  });

  it("purges when the stored identity can't be READ (a storage failure is not 'nothing recorded')", async () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    try {
      const purge = vi.fn(async () => undefined);
      expect(await confirmIdentity("user.b", purge)).toBe("purged");
      expect(purge).toHaveBeenCalledTimes(1);
    } finally {
      getItem.mockRestore();
    }
  });

  it("leaves the OLD identity recorded when the purge keeps failing, so the next boot purges again", async () => {
    recordConfirmedIdentity("user.a");
    const purge = vi.fn(async () => {
      throw new Error("quota");
    });
    expect(await confirmIdentity("user.b", purge, { retryDelayMs: 0 })).toBe("purge_failed");
    expect(purge).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem(CONFIRMED_USER_KEY)).toBe("user.a");
    // The next boot sees the difference again.
    const purgeOk = vi.fn(async () => undefined);
    expect(await confirmIdentity("user.b", purgeOk)).toBe("purged");
    expect(localStorage.getItem(CONFIRMED_USER_KEY)).toBe("user.b");
  });
});
