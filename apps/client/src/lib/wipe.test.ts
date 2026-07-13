import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  announceWipe,
  clearWipeTombstone,
  isWipeTombstoned,
  listenForRemoteWipe,
  setWipeTombstone,
} from "./wipe";

describe("wipe coordinator", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  describe("durable tombstone", () => {
    it("set / is / clear round-trips and survives (persisted, not in-memory)", () => {
      expect(isWipeTombstoned()).toBe(false);
      setWipeTombstone();
      expect(isWipeTombstoned()).toBe(true);
      // Persisted in localStorage — a reload (fresh module) still sees it (the whole point of round-4 H2).
      expect(localStorage.getItem("loam.wipeTombstone")).toBe("1");
      clearWipeTombstone();
      expect(isWipeTombstoned()).toBe(false);
    });
  });

  describe("cross-tab propagation", () => {
    // BroadcastChannel exists in the Node test runtime; guard anyway so the suite is portable.
    const hasChannel = typeof BroadcastChannel !== "undefined";

    it.runIf(hasChannel)("announceWipe reaches another tab's listener", async () => {
      let received = 0;
      const unsubscribe = listenForRemoteWipe(() => {
        received += 1;
      });
      try {
        announceWipe(); // a "different tab" initiating a wipe
        await new Promise((resolve) => setTimeout(resolve, 20)); // let the message dispatch
      } finally {
        unsubscribe();
      }
      expect(received).toBe(1);
    });

    it.runIf(hasChannel)("a listener stops firing after it unsubscribes", async () => {
      let received = 0;
      const unsubscribe = listenForRemoteWipe(() => {
        received += 1;
      });
      unsubscribe();
      announceWipe();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(received).toBe(0);
    });
  });
});
