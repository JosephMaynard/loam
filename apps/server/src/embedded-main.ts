import type { LoamApp } from "./app.js";
import { startEmbeddedServer } from "./embedded.js";

// The nodejs-mobile launcher requires the bundle to boot the server on load; keeping the auto-start
// out of embedded.ts (it stays side-effect-free to import elsewhere) and behind the exported
// `bootEmbeddedServer` below (rather than inline at module scope) means both stay testable — this
// file's only unconditional side effect is the one-line call at the bottom. This is the esbuild
// bundle entry point (see apps/app/scripts/bundle-server.mjs).
//
// `require('./loam-server.js')` in the RN launcher (nodejs-project-template/main.js) is SYNCHRONOUS —
// its try/catch only sees errors thrown before this module finishes evaluating. `startEmbeddedServer`
// does its real work asynchronously (load config, then `server.listen`), so a config-load or listen
// failure surfaces as a REJECTED PROMISE well after `require()` has already returned: the launcher's
// try/catch never sees it, the process just exits, and the host UI has nothing to show but its
// multi-minute readiness-poll timeout (docs/15 A8). Report it instead over the same `global.__loam*`
// bridge the on-device-LLM hook uses: `main.js` installs a function on `global` before requiring this
// bundle (same pattern as `globalThis.__loamOnDeviceChat`), so the RN host screen gets a real error.

export type BootErrorReporter = (message: string, code: string) => void;

/**
 * Best-effort: post a boot failure to the RN host screen. Must never itself throw — this only runs
 * on an already-failing path, so a broken/absent reporter (e.g. running outside the Android host,
 * where nothing installs the hook) is silently ignored rather than masking the real error.
 */
function reportBootError(message: string, code: string): void {
  try {
    const reporter = (globalThis as { __loamReportBootError?: BootErrorReporter }).__loamReportBootError;
    reporter?.(message, code);
  } catch (reportError) {
    console.error("Failed to report boot error to the RN host:", reportError);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Boot the embedded server, reporting any async startup failure — a rejection from `start()` itself,
 * or one that escapes its promise chain entirely (e.g. an un-awaited fire-and-forget task started
 * during `buildApp`) — over the RN bridge instead of silently exiting. `start` is injectable so a
 * test can drive the failure path without booting a real nodejs-mobile/rn-bridge runtime; the real
 * entry point at the bottom of this file calls it with no arguments.
 */
export async function bootEmbeddedServer(start: () => Promise<LoamApp> = startEmbeddedServer): Promise<void> {
  const onUnhandledDuringBoot = (reason: unknown): void => {
    console.error("Unhandled rejection during embedded server startup:", reason);
    reportBootError(messageOf(reason), "boot_unhandled_rejection");
    process.exit(1);
  };

  // Registered only for the boot window (removed in `finally`) so it can never mask or mis-attribute
  // an unrelated rejection once the server is actually up and serving.
  process.on("unhandledRejection", onUnhandledDuringBoot);

  try {
    await start();
  } catch (error) {
    console.error("Failed to start embedded LOAM server:", error);
    reportBootError(messageOf(error), "boot_failed");
    process.exit(1);
  } finally {
    process.off("unhandledRejection", onUnhandledDuringBoot);
  }
}

void bootEmbeddedServer();
