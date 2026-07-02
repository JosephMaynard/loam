import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildApp } from "./app.js";

const rootDir = fileURLToPath(new URL("../../..", import.meta.url));
const dataDir = process.env.LOAM_DATA_DIR ?? join(rootDir, ".loam");
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const clientPort = Number.parseInt(process.env.CLIENT_PORT ?? "3000", 10);
const host = process.env.HOST ?? "0.0.0.0";

function localIPv4(): string {
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const address of interfaces ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        return address.address;
      }
    }
  }

  return "localhost";
}

// LOAM_DB_KEY: a passphrase encrypts at rest; the literal "ephemeral" uses a random RAM-only key
// (never persisted; lost on reboot; rotated by the kill switch). Unset = no encryption.
const ephemeralDbKey = process.env.LOAM_DB_KEY === "ephemeral";

const app = await buildApp({
  dataDir,
  configPath: process.env.LOAM_CONFIG_FILE,
  clientDistDir: process.env.LOAM_CLIENT_DIST ?? join(rootDir, "apps/client/dist"),
  joinHost: process.env.LOAM_JOIN_HOST ?? localIPv4(),
  clientPort,
  dbEncryptionKey: ephemeralDbKey ? undefined : process.env.LOAM_DB_KEY,
  ephemeralDbKey,
});

if (app.adminSetupCode) {
  app.server.log.info(`Admin setup code (single use): ${app.adminSetupCode}`);
}

function shutdown(): void {
  void app.close().finally(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.server.listen({ host, port });
