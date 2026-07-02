import { networkInterfaces } from "node:os";

import { buildApp, type LoamApp } from "./app.js";

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
 * - `LOAM_JOIN_HOST`  — host shown in the join URL (defaults to the first non-internal IPv4).
 */
export function firstLanIPv4(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        return address.address;
      }
    }
  }

  return "localhost";
}

/**
 * Parse a TCP port from an env value, falling back to `fallback` for missing/invalid/out-of-range
 * input (so a bad `PORT` can never reach `server.listen` as `NaN`).
 */
export function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : fallback;
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

  const app = await buildApp({
    dataDir,
    configPath: process.env.LOAM_CONFIG_FILE,
    clientDistDir,
    joinHost: process.env.LOAM_JOIN_HOST ?? firstLanIPv4(),
    clientPort,
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
