import { networkInterfaces } from "node:os";

import { buildApp, type LoamApp } from "./app.js";

/**
 * Entry point for running the LOAM server embedded in a host process (the Android app's
 * nodejs-mobile runtime, per docs/04). Unlike `server.ts`, this uses no top-level await and no
 * `import.meta.url` — both are unavailable once esbuild bundles it to a single CJS file for the
 * Node 18 runtime — so every path comes from an env var with an explicit fallback.
 *
 * Required/notable env:
 * - `LOAM_DATA_DIR`   — writable directory for the SQLite DB + avatars (app sandbox on device).
 * - `LOAM_CLIENT_DIST`— directory of the built web client to serve (shipped inside the bundle).
 * - `PORT` / `HOST`   — listen address (defaults 3000 / 0.0.0.0 for hotspot reachability).
 * - `LOAM_JOIN_HOST`  — host shown in the join URL (defaults to the first non-internal IPv4).
 */
function firstLanIPv4(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        return address.address;
      }
    }
  }

  return "localhost";
}

export async function startEmbeddedServer(): Promise<LoamApp> {
  const dataDir = process.env.LOAM_DATA_DIR;

  if (!dataDir) {
    throw new Error("LOAM_DATA_DIR must be set for the embedded server (a writable app directory).");
  }

  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  const host = process.env.HOST ?? "0.0.0.0";
  const clientPort = Number.parseInt(process.env.CLIENT_PORT ?? String(port), 10);

  const app = await buildApp({
    dataDir,
    configPath: process.env.LOAM_CONFIG_FILE,
    clientDistDir: process.env.LOAM_CLIENT_DIST,
    joinHost: process.env.LOAM_JOIN_HOST ?? firstLanIPv4(),
    clientPort,
  });

  if (app.adminSetupCode) {
    app.server.log.info(`Admin setup code (single use): ${app.adminSetupCode}`);
  }

  const shutdown = (): void => {
    void app.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.server.listen({ host, port });
  app.server.log.info(`LOAM embedded server listening on ${host}:${port}`);
  return app;
}

// Boot immediately when this module is the process entry (the nodejs-mobile launcher requires it).
startEmbeddedServer().catch((error) => {
  console.error("Failed to start embedded LOAM server:", error);
  process.exit(1);
});
