import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildApp } from "./app.js";
import { parseDbEncryptionMode, parsePort, resolveDbEncryptionMode } from "./embedded.js";
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
// The port joiners are sent to. In production the server serves the client itself, so it is the listen
// port unless `CLIENT_PORT` says otherwise (`scripts/dev.ts` sets both: Vite on 3000, the API on 3001);
// defaulting it to a fixed 3000 put the wrong port in the join QR whenever `PORT` was anything else.
const clientPort = parsePort(process.env.CLIENT_PORT, port);
const host = process.env.HOST ?? "0.0.0.0";

// LOAM_DB_KEY: a passphrase encrypts at rest; the literal "ephemeral" uses a random RAM-only key
// (never persisted; lost on reboot; rotated by the kill switch). Unset = no encryption.
const ephemeralDbKey = process.env.LOAM_DB_KEY === "ephemeral";
// LOAM_DB_ENCRYPTION_MODE: the operator-declared at-rest key strategy, threaded through so the reported
// posture (`networkConfig.dbEncryption`) reflects the ACTUAL key path, not just `security.dbEncryption`
// in config — same contract the embedded/Android launcher uses (embedded.ts). Unset = inferred from the key:
// the `LOAM_DB_KEY === "ephemeral"` literal is `ephemeral`, any other key is a fixed `passphrase` key (so
// the Emergency Reset journals its wipe), no key is no mode (resolveDbEncryptionMode).
// Fail startup rather than silently falling back on a garbled value or a contradiction: a typo
// must not quietly disable encryption, and an ephemeral key paired with a non-ephemeral declared mode would
// misreport the effective posture.
const rawDbEncryptionMode = process.env.LOAM_DB_ENCRYPTION_MODE;
const parsedDbEncryptionMode = parseDbEncryptionMode(rawDbEncryptionMode);
if (rawDbEncryptionMode !== undefined && parsedDbEncryptionMode === undefined) {
  throw new Error(`Invalid LOAM_DB_ENCRYPTION_MODE: ${rawDbEncryptionMode}`);
}
if (ephemeralDbKey && parsedDbEncryptionMode !== undefined && parsedDbEncryptionMode !== "ephemeral") {
  throw new Error('LOAM_DB_KEY="ephemeral" requires LOAM_DB_ENCRYPTION_MODE=ephemeral (or unset)');
}
const dbEncryptionMode = resolveDbEncryptionMode(parsedDbEncryptionMode, process.env.LOAM_DB_KEY);

const app = await buildApp({
  dataDir,
  configPath: process.env.LOAM_CONFIG_FILE,
  clientDistDir: process.env.LOAM_CLIENT_DIST ?? join(rootDir, "apps/client/dist"),
  // An explicit override is passed through as-is (frozen for this boot); LAN address resolution here
  // is boot-time too — fine for the desktop/Pi CLI, whose network is up before this process starts
  // (see `startEmbeddedServer` for the embedded/Android host, which instead resolves at request time).
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
