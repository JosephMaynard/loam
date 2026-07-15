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
 * The one error code (see `openInitialStore` in app.ts, P1-1) that means boot failed NON-destructively
 * — an encrypted DB the current key can't open, with no start-fresh confirmation on disk (yet) — as
 * opposed to every other boot failure, which is presumed unrecoverable without operator/developer
 * intervention outside this process. Recovery from THIS one specific failure is possible from right
 * here, in this same process, once the operator confirms via the RN launcher bridge (main.js's
 * `loam-db-start-fresh` listener writes the marker, then calls `__loamBootEmbeddedServer` again — see
 * the export below) — so, uniquely, this code must not tear the process down.
 */
const DB_ENCRYPTION_UNREADABLE_CODE = "db_encryption_unreadable";

/** True when `error` carries the typed `.code` `openInitialStore` throws for an unopenable DB with no
 *  start-fresh confirmation present (app.ts). Narrow, defensive shape check — never assumes `error` is
 *  even an object. */
function hasDbEncryptionUnreadableCode(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === DB_ENCRYPTION_UNREADABLE_CODE
  );
}

/**
 * Boot the embedded server, reporting any async startup failure — a rejection from `start()` itself,
 * or one that escapes its promise chain entirely (e.g. an un-awaited fire-and-forget task started
 * during `buildApp`) — over the RN bridge instead of silently exiting. `start` is injectable so a
 * test can drive the failure path without booting a real nodejs-mobile/rn-bridge runtime; the real
 * entry point at the bottom of this file calls it with no arguments.
 *
 * Idempotent-safe to call more than once (P1-1, docs/15, Sol round 3): also exported on
 * `globalThis.__loamBootEmbeddedServer` (below) so `nodejs-project-template/main.js`'s
 * `loam-db-start-fresh` listener can re-invoke boot, in this SAME still-alive process, once the
 * operator has confirmed the start-fresh marker. A prior attempt that failed with
 * `db_encryption_unreadable` never reached `app.server.listen()`, so nothing is bound/leaked to redo —
 * a later successful call just picks up where the first one left off.
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

    if (hasDbEncryptionUnreadableCode(error)) {
      // FATAL, but recoverable without restarting the process. `openInitialStore` (app.ts) already
      // reported this over the SAME bridge, with this SAME code, immediately before throwing — that
      // report is what the RN host screen needs to show the "Preserve old database & start fresh"
      // action (see index.tsx's DB_UNREADABLE_CODE), so re-reporting here would just duplicate it.
      // The one thing THIS layer uniquely owns is deciding whether to exit — and, critically, it must
      // NOT process.exit() for this code: the `loam-db-start-fresh` bridge listener that can recover
      // from this lives in THIS process (main.js), so exiting here would kill it before it could ever
      // receive that message, permanently stranding the operator (the exact bug this redesign fixes).
      return;
    }

    reportBootError(messageOf(error), "boot_failed");
    process.exit(1);
  } finally {
    process.off("unhandledRejection", onUnhandledDuringBoot);
  }
}

// Exposed so the RN launcher (main.js) can re-invoke boot after an operator-confirmed start-fresh
// recovery — see the `bootEmbeddedServer` doc comment above and main.js's `loam-db-start-fresh`
// listener. Assigning this is a plain synchronous side effect (unlike the `void bootEmbeddedServer()`
// call below), so it's always in place by the time the FIRST boot attempt could possibly fail.
(globalThis as { __loamBootEmbeddedServer?: () => Promise<void> }).__loamBootEmbeddedServer = bootEmbeddedServer;

void bootEmbeddedServer();
