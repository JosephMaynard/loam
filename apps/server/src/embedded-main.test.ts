import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// embedded-main.ts auto-boots at import time (it's the esbuild bundle entry the RN launcher
// requires — see its own comment), so every test here mocks `./embedded.js` BEFORE importing it and
// uses `vi.resetModules()` between cases to get a fresh module instance (and a fresh
// `unhandledRejection` listener) per test.

type Reported = { message: string; code: string };

function installFakeBridge(): Reported[] {
  const reports: Reported[] = [];
  (globalThis as unknown as { __loamReportBootError?: (message: string, code: string) => void }).__loamReportBootError =
    (message, code) => reports.push({ message, code });
  return reports;
}

function uninstallFakeBridge(): void {
  delete (globalThis as unknown as { __loamReportBootError?: unknown }).__loamReportBootError;
}

describe("embedded-main boot-error reporting (docs/15 A8)", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let listenersBefore: readonly NodeJS.UnhandledRejectionListener[];

  beforeEach(() => {
    vi.resetModules();
    // The real process must never actually exit mid test run; assert the *call* instead. Because
    // it's mocked, a test simulating a boot that never settles leaves `bootEmbeddedServer`'s
    // `unhandledRejection` safety net attached (in real life `process.exit` would have ended the
    // process there) — snapshot the baseline so afterEach can strip only what THIS test added.
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    listenersBefore = process.listeners("unhandledRejection");
  });

  afterEach(() => {
    for (const listener of process.listeners("unhandledRejection")) {
      if (!listenersBefore.includes(listener)) {
        process.off("unhandledRejection", listener);
      }
    }
    exitSpy.mockRestore();
    uninstallFakeBridge();
    vi.doUnmock("./embedded.js");
  });

  it("reports a rejected boot promise over the RN bridge instead of exiting silently", async () => {
    const reports = installFakeBridge();

    vi.doMock("./embedded.js", () => ({
      startEmbeddedServer: () => Promise.reject(new Error("LOAM_DATA_DIR must be set")),
    }));

    await import("./embedded-main.js");
    // Let the async `bootEmbeddedServer()` IIFE run to completion (its rejection is caught inside).
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(reports).toEqual([{ message: "LOAM_DATA_DIR must be set", code: "boot_failed" }]);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("reports a rejection that escapes the boot promise (unhandledRejection) while boot is still pending", async () => {
    const reports = installFakeBridge();

    vi.doMock("./embedded.js", () => ({
      // Never settles on its own — simulates boot hanging while an unrelated fire-and-forget task
      // (started during buildApp) rejects out-of-band.
      startEmbeddedServer: () => new Promise(() => {}),
    }));

    await import("./embedded-main.js");
    process.emit("unhandledRejection", new Error("stray failure mid-boot"), Promise.reject().catch(() => {}));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(reports).toEqual([{ message: "stray failure mid-boot", code: "boot_unhandled_rejection" }]);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("never reports and removes its unhandledRejection listener once boot succeeds", async () => {
    const reports = installFakeBridge();

    vi.doMock("./embedded.js", () => ({
      startEmbeddedServer: () => Promise.resolve({}),
    }));

    await import("./embedded-main.js");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(reports).toEqual([]);
    expect(exitSpy).not.toHaveBeenCalled();
    // The boot-window safety net must be gone once boot settles — left attached, it would
    // mis-attribute some unrelated later rejection to a "boot failure" (and, worse, `process.exit`
    // an otherwise-healthy running server). Checked via listener count rather than by emitting a real
    // 'unhandledRejection' — that event is process-global and Vitest's own runner watches it too, so
    // triggering one with no listener left to catch it would fail the run out from under this test.
    expect(process.listeners("unhandledRejection")).toEqual(listenersBefore);
  });
});
