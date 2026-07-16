import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildApp } from "./app.js";
import { parseDbEncryptionMode } from "./embedded.js";
import { resolveLanIPv4 } from "./net.js";

const rootDir = fileURLToPath(new URL("../../..", import.meta.url));
const serverDir = fileURLToPath(new URL("..", import.meta.url));
const dataDir = process.env.LOAM_DATA_DIR ?? join(rootDir, ".loam");

/**
 * Resolve the node's version for display in the client. Prefers the `LOAM_VERSION` env override (set
 * by the npm CLI to inject the published package version), then the server package's own
 * `package.json`, then the workspace root's — falling back to `"dev"` if none can be read. Never
 * throws: a missing/malformed file just yields the fallback.
 */
function resolveVersion(): string {
  const fromEnv = process.env.LOAM_VERSION?.trim();

  if (fromEnv) {
    return fromEnv;
  }

  for (const candidate of [join(serverDir, "package.json"), join(rootDir, "package.json")]) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(candidate, "utf8"));

      if (parsed && typeof parsed === "object" && "version" in parsed && typeof parsed.version === "string" && parsed.version) {
        return parsed.version;
      }
    } catch {
      // Try the next candidate; unreadable/malformed files fall through to "dev".
    }
  }

  return "dev";
}
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const clientPort = Number.parseInt(process.env.CLIENT_PORT ?? "3000", 10);
const host = process.env.HOST ?? "0.0.0.0";

// LOAM_DB_KEY: a passphrase encrypts at rest; the literal "ephemeral" uses a random RAM-only key
// (never persisted; lost on reboot; rotated by the kill switch). Unset = no encryption.
const ephemeralDbKey = process.env.LOAM_DB_KEY === "ephemeral";
// LOAM_DB_ENCRYPTION_MODE: the operator-declared at-rest key strategy, threaded through so the reported
// posture (`networkConfig.dbEncryption`) reflects the ACTUAL key path, not just `security.dbEncryption`
// in config — same contract the embedded/Android launcher uses (embedded.ts). Unset on the CLI = fall
// back to the configured value; `ephemeral` is inferred from the `LOAM_DB_KEY === "ephemeral"` literal.
const dbEncryptionMode =
  parseDbEncryptionMode(process.env.LOAM_DB_ENCRYPTION_MODE) ?? (ephemeralDbKey ? "ephemeral" : undefined);

const app = await buildApp({
  dataDir,
  configPath: process.env.LOAM_CONFIG_FILE,
  clientDistDir: process.env.LOAM_CLIENT_DIST ?? join(rootDir, "apps/client/dist"),
  // An explicit override is passed through as-is (frozen for this boot); LAN address resolution here
  // is boot-time too — fine for the desktop/Pi CLI, whose network is up before this process starts
  // (see docs/15 A7 for the embedded/Android host, which instead resolves at request time).
  joinHost: process.env.LOAM_JOIN_HOST ?? resolveLanIPv4(),
  clientPort,
  dbEncryptionKey: ephemeralDbKey ? undefined : process.env.LOAM_DB_KEY,
  ephemeralDbKey,
  dbEncryptionMode,
  version: resolveVersion(),
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
