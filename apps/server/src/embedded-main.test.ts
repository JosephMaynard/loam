import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp, type LoamApp } from "./app.js";
import { openStore } from "./db.js";

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

describe("P1-1 end-to-end (Sol round 3): db_encryption_unreadable keeps the runtime alive so a start-fresh confirmation can retry boot in-process", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let listenersBefore: readonly NodeJS.UnhandledRejectionListener[];
  const envKeys = ["LOAM_DATA_DIR", "LOAM_CLIENT_DIST"] as const;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.resetModules();
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    listenersBefore = process.listeners("unhandledRejection");
    // The module-scope `void bootEmbeddedServer()` (see embedded-main.ts's bottom) fires on every
    // `import("./embedded-main.js")` below, using the REAL (unmocked) `startEmbeddedServer` — keep
    // LOAM_DATA_DIR unset so that first, unrelated auto-boot attempt fails fast (missing-env rejection,
    // no port ever touched) instead of trying to actually listen.
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const listener of process.listeners("unhandledRejection")) {
      if (!listenersBefore.includes(listener)) {
        process.off("unhandledRejection", listener);
      }
    }
    exitSpy.mockRestore();
    uninstallFakeBridge();
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it("reports db_encryption_unreadable without exiting, then recovers in-process once the loam-db-start-fresh marker is written", async () => {
    const reports = installFakeBridge();

    const mod = await import("./embedded-main.js");
    // Let the unrelated module-scope auto-boot (real startEmbeddedServer, missing LOAM_DATA_DIR) settle
    // and report/exit(mocked) before this test's own scenario begins.
    await new Promise((resolve) => setTimeout(resolve, 10));
    reports.length = 0;
    exitSpy.mockClear();

    // The exact hook `nodejs-project-template/main.js`'s `loam-db-start-fresh` listener calls — assert
    // it's really the exported `bootEmbeddedServer` (idempotent-safe to invoke again), not a copy.
    const globalBoot = (globalThis as unknown as { __loamBootEmbeddedServer?: typeof mod.bootEmbeddedServer })
      .__loamBootEmbeddedServer;
    expect(globalBoot).toBe(mod.bootEmbeddedServer);
    if (!globalBoot) {
      throw new Error("globalThis.__loamBootEmbeddedServer was not installed");
    }

    const dataDir = mkdtempSync(join(tmpdir(), "loam-p1-1-e2e-test-"));
    try {
      // A real encrypted DB under key A (multiple-ciphers is available on desktop/CI — docs/01).
      const original = openStore(join(dataDir, "loam.db"), { encryptionKey: "key A" });
      original.setConfigValue("seed", "value-under-key-A");
      original.close();

      let builtApp: LoamApp | undefined;
      const start = async (): Promise<LoamApp> => {
        const app = await buildApp({ dataDir, dbEncryptionKey: "key B", logger: false });
        builtApp = app;
        return app;
      };

      // First attempt: wrong key, no start-fresh marker present yet — must fail NON-destructively,
      // report the typed `db_encryption_unreadable` code, and — the actual P1-1 bug — must NOT exit:
      // the old code called `process.exit(1)` here, killing the very process whose `loam-db-start-fresh`
      // bridge listener (main.js) was the operator's only way to recover.
      await globalBoot(start);

      expect(reports).toEqual([expect.objectContaining({ code: "db_encryption_unreadable" })]);
      expect(exitSpy).not.toHaveBeenCalled();
      expect(builtApp).toBeUndefined(); // buildApp never resolved — nothing was touched on disk

      // Simulate the RN launcher handoff (main.js's `loam-db-start-fresh` listener): write the
      // confirmation marker, then call the SAME still-alive process's boot hook again.
      writeFileSync(join(dataDir, ".loam-db-start-fresh"), "");
      reports.length = 0;

      await globalBoot(start);

      // Recovered: a fresh (empty) DB opened under key B, no exit, and the old ciphertext preserved on
      // disk in a unique recovery-snapshot directory rather than deleted (Sol round-11 preserve recovery).
      expect(exitSpy).not.toHaveBeenCalled();
      expect(builtApp).toBeDefined();
      expect(builtApp?.store.getConfigValue("seed")).toBeUndefined();
      const preserved = readdirSync(dataDir).filter((name) => name.startsWith(".loam-recovery-"));
      expect(preserved.length).toBeGreaterThan(0);

      await builtApp?.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("RF2: bootEmbeddedServer is re-entrant-safe", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let listenersBefore: readonly NodeJS.UnhandledRejectionListener[];
  const envKeys = ["LOAM_DATA_DIR", "LOAM_CLIENT_DIST"] as const;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.resetModules();
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    listenersBefore = process.listeners("unhandledRejection");
    // The module-scope `void bootEmbeddedServer()` (embedded-main.ts's bottom) fires on import, using
    // the REAL (unmocked) `startEmbeddedServer` as its default `start` argument — keep LOAM_DATA_DIR
    // unset so that unrelated auto-boot attempt rejects fast (missing-env validation, no port ever
    // touched) and its `bootInFlight` guard clears well before this test's own controlled scenario
    // starts. Without this, that auto-boot's in-flight promise would swallow both of this test's calls
    // (the guard is exactly what's under test) and `start` below would never even run.
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const listener of process.listeners("unhandledRejection")) {
      if (!listenersBefore.includes(listener)) {
        process.off("unhandledRejection", listener);
      }
    }
    exitSpy.mockRestore();
    uninstallFakeBridge();
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it("a re-entrant call while a boot is already in flight does not start a second concurrent attempt (no double listen(), no process.exit killing the survivor)", async () => {
    const reports = installFakeBridge();

    const mod = await import("./embedded-main.js");
    // Let the unrelated module-scope auto-boot (real startEmbeddedServer, missing LOAM_DATA_DIR) settle
    // and clear `bootInFlight` before this test's own scenario begins.
    await new Promise((resolve) => setTimeout(resolve, 10));
    reports.length = 0;
    exitSpy.mockClear();

    let startCalls = 0;
    let resolveStart!: (app: LoamApp) => void;
    const gate = new Promise<LoamApp>((resolve) => {
      resolveStart = resolve;
    });
    const start = async (): Promise<LoamApp> => {
      startCalls += 1;
      return gate;
    };

    // First call: begins a boot attempt and doesn't resolve yet (simulates `buildApp()`/`listen()`
    // still mid-flight).
    const first = mod.bootEmbeddedServer(start);

    // Re-entrant call while the first is still pending — a double-tap of "start fresh" (main.js's
    // `loam-db-start-fresh` listener calling `__loamBootEmbeddedServer()` again) reduces to exactly
    // this. Without the guard this would invoke `start` a second time and race a second
    // `buildApp()`/`listen()` against the first.
    const second = mod.bootEmbeddedServer(start);

    // Let both calls' synchronous/microtask work settle.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(startCalls).toBe(1); // the guard suppressed the second concurrent attempt
    expect(exitSpy).not.toHaveBeenCalled(); // no EADDRINUSE-style loser being killed
    expect(reports).toEqual([]);

    // Resolve the one real attempt; both callers' promises settle together, since `second` is just the
    // SAME in-flight promise as `first`.
    const app = {} as LoamApp;
    resolveStart(app);
    await Promise.all([first, second]);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(reports).toEqual([]);

    // P3 (Sol round 4): `bootInFlight` clears once the attempt settles, but the settled STATE is now
    // "ready" — a later call must be a no-op, NOT boot again. Before this fix, `bootInFlight` alone was
    // the only guard, so this exact call would have invoked `start` a second time and raced a second
    // `buildApp()`/`listen()` against the server that just recovered (EADDRINUSE → process.exit(1),
    // killing the healthy survivor). This was previously asserted the OTHER way (`laterCalls === 1`) —
    // that assertion encoded the unsafe pre-P3 behaviour and has been flipped here.
    let laterCalls = 0;
    await mod.bootEmbeddedServer(async () => {
      laterCalls += 1;
      return app;
    });
    expect(laterCalls).toBe(0);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("P3 (Sol round 4): a genuinely separate call still retries while the last settled state is recoverable (db_encryption_unreadable), not just while nothing has succeeded yet", async () => {
    const reports = installFakeBridge();

    const mod = await import("./embedded-main.js");
    await new Promise((resolve) => setTimeout(resolve, 10));
    reports.length = 0;
    exitSpy.mockClear();

    const unreadableError = Object.assign(new Error("wrong key"), { code: "db_encryption_unreadable" });
    let attempts = 0;
    const app = {} as LoamApp;

    await mod.bootEmbeddedServer(async () => {
      attempts += 1;
      throw unreadableError;
    });
    expect(attempts).toBe(1);
    expect(exitSpy).not.toHaveBeenCalled(); // recoverable — must not exit

    // A later call (e.g. the operator's start-fresh confirmation) must still retry: the recoverable
    // state is NOT "ready", so the P3 no-op gate above must not suppress it.
    await mod.bootEmbeddedServer(async () => {
      attempts += 1;
      return app;
    });
    expect(attempts).toBe(2);
    expect(exitSpy).not.toHaveBeenCalled();

    // And once THAT attempt succeeds, state flips to "ready" and a further call is a no-op again.
    await mod.bootEmbeddedServer(async () => {
      attempts += 1;
      return app;
    });
    expect(attempts).toBe(2);
  });
});

describe("P2 (Sol round 4): boot-ready is reported directly to RN, independent of main.js's own readiness poll", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let listenersBefore: readonly NodeJS.UnhandledRejectionListener[];

  function installFakeReadyBridge(): number[] {
    const calls: number[] = [];
    (globalThis as unknown as { __loamReportBootReady?: () => void }).__loamReportBootReady = () => {
      calls.push(Date.now());
    };
    return calls;
  }

  function uninstallFakeReadyBridge(): void {
    delete (globalThis as unknown as { __loamReportBootReady?: unknown }).__loamReportBootReady;
  }

  beforeEach(() => {
    vi.resetModules();
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
    uninstallFakeReadyBridge();
    vi.useRealTimers();
    vi.doUnmock("./embedded.js");
  });

  it("reports ready on a plain successful boot", async () => {
    installFakeBridge();
    const readyCalls = installFakeReadyBridge();

    vi.doMock("./embedded.js", () => ({
      startEmbeddedServer: () => Promise.resolve({} as LoamApp),
    }));

    await import("./embedded-main.js");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(readyCalls.length).toBe(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("fake-timer test (Sol #4 / P2): exhausts the ~5-minute window main.js's own /api/health poll " +
    "would have given up in, then a later in-process recovery still reports ready to RN", async () => {
    const reports = installFakeBridge();
    const readyCalls = installFakeReadyBridge();

    // Real (unmocked) `startEmbeddedServer` for the unrelated module-scope auto-boot — kept out of this
    // test's own controlled scenario by an explicit `start` function passed to every `globalBoot(...)`
    // call below (mirroring the "P1-1 end-to-end"/"RF2" suites above), so the two never share state.
    const mod = await import("./embedded-main.js");
    await new Promise((resolve) => setTimeout(resolve, 10));
    reports.length = 0;
    exitSpy.mockClear();

    const globalBoot = (globalThis as unknown as { __loamBootEmbeddedServer?: typeof mod.bootEmbeddedServer })
      .__loamBootEmbeddedServer;
    if (!globalBoot) {
      throw new Error("globalThis.__loamBootEmbeddedServer was not installed");
    }

    // First attempt: fails with the recoverable `db_encryption_unreadable` code — it never reaches
    // `server.listen()`, so main.js's own `/api/health` poll never has anything to succeed against and
    // is left running (and eventually gives up ~5 minutes later, per `waitForServer`/`retry` in
    // main.js — untestable here directly, since that poll lives in a plain CJS launcher script with no
    // test harness; this simulates its outcome by advancing real elapsed time instead).
    const unreadableError = Object.assign(new Error("wrong key"), { code: "db_encryption_unreadable" });
    const failingStart = async (): Promise<LoamApp> => {
      throw unreadableError;
    };

    await globalBoot(failingStart);
    expect(exitSpy).not.toHaveBeenCalled(); // recoverable — the runtime stays alive
    expect(readyCalls).toEqual([]); // not ready yet — nothing for RN to show

    // Simulate main.js's own poll having already given up (~600 attempts * 500ms ≈ 5 minutes) before
    // the operator confirms "Preserve old database & start fresh" and this retry runs.
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    vi.useRealTimers();

    // The recovery retry — main.js's `loam-db-start-fresh` listener calling this same hook again —
    // this time succeeding.
    const succeedingStart = async (): Promise<LoamApp> => ({}) as LoamApp;
    await globalBoot(succeedingStart);

    // RN is told directly, regardless of how long (or whether) main.js's own poll was still running —
    // this is the whole point of the direct signal: it doesn't depend on that poll's state at all.
    expect(readyCalls.length).toBe(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
