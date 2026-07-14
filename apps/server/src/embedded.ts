import { buildApp, type LoamApp } from "./app.js";
import type { StoreDriver } from "./db.js";

/**
 * Logic for running the LOAM server embedded in a host process (the Android app's nodejs-mobile
 * runtime, per docs/04). Unlike `server.ts`, this uses no top-level await and no `import.meta.url`
 * — both are unavailable once esbuild bundles it to a single CJS file for the Node 18 runtime — so
 * every path comes from an env var with an explicit fallback.
 *
 * This module has **no import-time side effects** (importable from tests/tools); the actual boot
 * lives in the tiny `embedded-main.ts` entry, which is the esbuild bundle entry point.
 *
 * Required/notable env:
 * - `LOAM_DATA_DIR`   — writable directory for the SQLite DB + avatars (app sandbox on device).
 * - `LOAM_CLIENT_DIST`— directory of the built web client to serve (shipped inside the bundle).
 * - `PORT` / `HOST`   — listen address (defaults 3000 / 0.0.0.0 for hotspot reachability).
 * - `LOAM_JOIN_HOST`  — host shown in the join URL. Left unset here (rather than resolved once at
 *   boot) so `buildApp` re-resolves the current best non-internal IPv4 on every request instead of
 *   freezing whatever was up (or nothing) at `startEmbeddedServer` time — the Android hotspot
 *   interface comes up *after* this process starts, so a boot-time scan can miss it entirely or
 *   capture a stale earlier address (docs/04, docs/15 A7). Set it to pin an explicit host instead.
 * - `LOAM_DB_DRIVER`  — plaintext SQLite backend: `better-sqlite3` (the Android host, whose Node 18
 *   lacks `node:sqlite`) or `node-sqlite` (default). Ignored when `LOAM_DB_KEY` enables encryption.
 */
export { resolveLanIPv4 as firstLanIPv4 } from "./net.js";

/**
 * Parse a TCP port from an env value, falling back to `fallback` for missing/invalid/out-of-range
 * input (so a bad `PORT` can never reach `server.listen` as `NaN`).
 */
export function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : fallback;
}

/**
 * Resolve the plaintext SQLite driver from `LOAM_DB_DRIVER`. Only the two known values are honoured;
 * anything else (including unset) leaves the choice to `buildApp` (i.e. the `node:sqlite` default).
 */
export function parseDbDriver(value: string | undefined): StoreDriver | undefined {
  return value === "better-sqlite3" || value === "node-sqlite" ? value : undefined;
}

export async function startEmbeddedServer(): Promise<LoamApp> {
  const dataDir = process.env.LOAM_DATA_DIR;

  if (!dataDir) {
    throw new Error("LOAM_DATA_DIR must be set for the embedded server (a writable app directory).");
  }

  const clientDistDir = process.env.LOAM_CLIENT_DIST;

  if (!clientDistDir) {
    // The embedded host exists to serve the client to hotspot joiners; without it they'd only get
    // the bare fallback page, which defeats the purpose — fail fast rather than start half-usable.
    throw new Error("LOAM_CLIENT_DIST must be set for the embedded server (the built web client to serve).");
  }

  const port = parsePort(process.env.PORT, 3000);
  const host = process.env.HOST ?? "0.0.0.0";
  const clientPort = parsePort(process.env.CLIENT_PORT, port);

  // LOAM_DB_KEY="ephemeral" → random RAM-only key (lost on reboot, rotated by the kill switch);
  // any other value → passphrase; unset → no encryption. See docs/02-kill-switch.md.
  const ephemeralDbKey = process.env.LOAM_DB_KEY === "ephemeral";

  const app = await buildApp({
    dataDir,
    configPath: process.env.LOAM_CONFIG_FILE,
    clientDistDir,
    // Undefined (rather than resolved here) when unset — see the LOAM_JOIN_HOST note above; buildApp
    // does the (repeatable, request-time) resolution itself.
    joinHost: process.env.LOAM_JOIN_HOST,
    clientPort,
    dbEncryptionKey: ephemeralDbKey ? undefined : process.env.LOAM_DB_KEY,
    ephemeralDbKey,
    dbDriver: parseDbDriver(process.env.LOAM_DB_DRIVER),
    // The Android host / npm CLI inject the app version via LOAM_VERSION (no package.json on the
    // bundle path); "dev" if unset.
    version: process.env.LOAM_VERSION?.trim() || "dev",
  });

  if (app.adminSetupCode) {
    app.server.log.info(`Admin setup code (single use): ${app.adminSetupCode}`);
  }

  const shutdown = (): void => {
    app.server.log.info("Shutting down embedded LOAM server…");
    app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        app.server.log.error(error, "Error during embedded server shutdown");
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.server.listen({ host, port });
  app.server.log.info(`LOAM embedded server listening on ${host}:${port}`);
  return app;
}
