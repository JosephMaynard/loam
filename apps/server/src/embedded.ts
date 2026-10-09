import type { DbEncryptionMode } from "@loam/schema";

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
 *   capture a stale earlier address (docs/04). Set it to pin an explicit host instead.
 * - `LOAM_DB_DRIVER`  — plaintext SQLite backend: `better-sqlite3` (the Android host, whose Node 18
 *   lacks `node:sqlite`) or `node-sqlite` (default). Ignored when `LOAM_DB_KEY` enables encryption.
 * - `LOAM_DB_KEY_MIGRATE_FROM` — the legacy passphrase key derivation (`SHA256(passphrase)` alone) to retry
 *   `openInitialStore` with if `LOAM_DB_KEY` can't open the database; on success the database is
 *   `PRAGMA rekey`'d to `LOAM_DB_KEY` in place. Never set except by a launcher offering an unmigrated
 *   passphrase DB's legacy key. Never logged.
 * - `LOAM_DB_ENCRYPTION_MODE` — the launcher's declared at-rest key strategy (`off`/`ephemeral`/
 *   `persistent`/`passphrase`, see `DbEncryptionModeSchema` in `@loam/schema`). Threaded into `buildApp`
 *   as `dbEncryptionMode` so the reported posture (`networkConfig.dbEncryption`) reflects what the
 *   launcher actually did with the key, not just the admin's declarative config axis, and so
 *   `executeKillSwitch` can tell a fixed (`persistent`/`passphrase`) key apart from a rotatable
 *   (`ephemeral`) one. It does **not** drive `ephemeralDbKey`: that comes ONLY from the literal
 *   `LOAM_DB_KEY==="ephemeral"` contract; see `resolveEphemeralDbKey` below.
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

/**
 * Parse the DB-encryption mode from `LOAM_DB_ENCRYPTION_MODE`. Only the four known values are
 * honoured; anything else (including unset) leaves the choice to `buildApp`'s default (`"off"`).
 */
export function parseDbEncryptionMode(value: string | undefined): DbEncryptionMode | undefined {
  return value === "off" || value === "ephemeral" || value === "persistent" || value === "passphrase"
    ? value
    : undefined;
}

/**
 * The at-rest key mode `buildApp` is told about. A declared mode wins. Without one, the key itself says what
 * it is: the `"ephemeral"` literal is a per-boot random key, and any other key is a fixed one this process
 * cannot replace, so it is reported and treated as `passphrase`. This matters for the `loamnet --encrypt` CLI,
 * which never sets `LOAM_DB_ENCRYPTION_MODE`: its fixed key must take the Emergency Reset's fixed-key branch,
 * which journals the wipe and resumes it on the next boot (docs/02). No key means no mode.
 */
export function resolveDbEncryptionMode(
  declared: DbEncryptionMode | undefined,
  dbKeyEnv: string | undefined,
): DbEncryptionMode | undefined {
  if (declared !== undefined) {
    return declared;
  }
  if (resolveEphemeralDbKey(dbKeyEnv)) {
    return "ephemeral";
  }
  return dbKeyEnv ? "passphrase" : undefined;
}

/**
 * Resolve whether the server should generate its own RAM-only ephemeral key. Honours ONLY the literal
 * `LOAM_DB_KEY === "ephemeral"` contract: the launcher's `ephemeral` boot always sets exactly this literal
 * (never a real hex key) before requiring the server bundle, so the literal alone is a complete and
 * authoritative signal.
 *
 * `LOAM_DB_ENCRYPTION_MODE` must not feed this decision. A boot that carries a mode but no key (an unset
 * `LOAM_DB_KEY`) has to stay keyless: treating the mode alone as ephemeral would generate a random key and
 * make `openStore` require the SQLCipher module on a boot that never selected it. The mode is still passed
 * to `buildApp` (see below), only for the reported posture and the kill switch's branch choice.
 */
export function resolveEphemeralDbKey(dbKeyEnv: string | undefined): boolean {
  return dbKeyEnv === "ephemeral";
}

/** What a launcher can hand `startEmbeddedServer` directly, beside the env. */
export type EmbeddedServerOptions = {
  /** Where the server's log lines go instead of stdout (the `loamnet` terminal UI reads them). */
  logStream?: { write(line: string): void };
  /** A per-boot host token; overrides `LOAM_HOST_TOKEN`. See `AppOptions.hostToken`. */
  hostToken?: string;
  /** Install SIGINT/SIGTERM handlers that close the server and exit (default true). A launcher that
   * restarts the server in-process, or owns shutdown itself, turns this off. */
  handleSignals?: boolean;
};

/** Build and start the server from environment variables — the Android host's boot path (see the module note). */
export async function startEmbeddedServer(launcher: EmbeddedServerOptions = {}): Promise<LoamApp> {
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

  // A declared mode wins; a real key with none declared is a fixed key (`passphrase`), see resolveDbEncryptionMode.
  const dbEncryptionMode = resolveDbEncryptionMode(parseDbEncryptionMode(process.env.LOAM_DB_ENCRYPTION_MODE), process.env.LOAM_DB_KEY);
  // See `resolveEphemeralDbKey`: the literal LOAM_DB_KEY="ephemeral" contract only. Any other
  // LOAM_DB_KEY value → passphrase/persistent key; unset → no encryption. `dbEncryptionMode` is passed
  // to `buildApp` below for posture reporting and the kill switch's fixed-key branch; it never feeds this
  // decision. See docs/02-kill-switch.md.
  const ephemeralDbKey = resolveEphemeralDbKey(process.env.LOAM_DB_KEY);

  const app = await buildApp({
    dataDir,
    configPath: process.env.LOAM_CONFIG_FILE,
    clientDistDir,
    // Undefined (rather than resolved here) when unset — see the LOAM_JOIN_HOST note above; buildApp
    // does the (repeatable, request-time) resolution itself.
    joinHost: process.env.LOAM_JOIN_HOST,
    clientPort,
    dbEncryptionKey: ephemeralDbKey ? undefined : process.env.LOAM_DB_KEY,
    // The legacy passphrase key derivation, offered by main.js only when
    // it hasn't recorded a confirmed migration yet (db-encryption.ts). `undefined` (never an empty
    // string) when main.js has nothing to offer — see `openInitialStore`'s migration attempt. Never
    // logged.
    dbEncryptionMigrateFromKey: process.env.LOAM_DB_KEY_MIGRATE_FROM || undefined,
    ephemeralDbKey,
    dbEncryptionMode,
    // The launcher's immutable per-boot key-handoff id, captured ONCE here so the
    // passphrase-migration ack this boot emits is correlated to the exact attempt that opened the DB — never
    // a mutable launcher global a later/duplicate unlock overwrote. `undefined` when unset (non-passphrase
    // boots, non-launcher hosts).
    dbKeyRequestId: process.env.LOAM_DB_KEY_REQUEST_ID || undefined,
    dbDriver: parseDbDriver(process.env.LOAM_DB_DRIVER),
    // The Android host / npm CLI inject the app version via LOAM_VERSION (no package.json on the
    // bundle path); "dev" if unset.
    version: process.env.LOAM_VERSION?.trim() || "dev",
    // The launcher's per-boot host token (`LOAM_HOST_TOKEN`, minted in main.js): forces the `hostDevice`
    // admin bootstrap and gates the loopback mesh bridge — see `AppOptions.hostToken`. Never logged.
    hostToken: launcher.hostToken || process.env.LOAM_HOST_TOKEN || undefined,
    logStream: launcher.logStream,
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
  if (launcher.handleSignals !== false) {
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }

  await app.server.listen({ host, port });
  app.server.log.info(`LOAM embedded server listening on ${host}:${port}`);
  return app;
}
