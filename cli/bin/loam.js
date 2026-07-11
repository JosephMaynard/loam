#!/usr/bin/env node
// `loam` — boot a full LOAM node (Fastify server + bundled PWA) and print a join QR. Everything is
// env-driven: this launcher sets the env the bundled `startEmbeddedServer` reads, then hands off.
// Storage defaults to a user-writable directory (never inside the global package). Default DB driver
// is the built-in node:sqlite (Node ≥22) — zero node-gyp; `--encrypt` opts into the optional native
// SQLCipher driver.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const args = process.argv.slice(2);

function optionValue(name) {
  const index = args.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const next = args[index + 1];
  return next && !next.startsWith("-") ? next : undefined;
}

// Like optionValue, but errors when the flag is present without a value instead of silently falling
// back to a default (e.g. `loam --data-dir -bad` would otherwise use the default dir with no warning).
function requiredValue(name) {
  const index = args.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const next = args[index + 1];
  if (!next || next.startsWith("-")) {
    console.error(`${name} requires a value. See \`loam --help\`.`);
    process.exit(1);
  }
  return next;
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`loam — run a local LOAM node (off-grid messaging over your LAN)

Usage: loam [options]

Options:
  --port <n>        Port to listen on (default 3000, or $PORT)
  --data-dir <dir>  Where to store the SQLite DB + avatars
                    (default $XDG_DATA_HOME/loam or ~/.loam)
  --encrypt [key]   Encrypt the database at rest (SQLCipher). With a value, use it
                    as the passphrase; bare, use an ephemeral RAM-only key.
                    Requires the optional native driver (installed automatically
                    unless it failed to build).
  -h, --help        Show this help

Scan the printed QR (or open the printed URL) from another device on the same
network to join. Node ≥22 required.`);
  process.exit(0);
}

const defaultDataDir = process.env.XDG_DATA_HOME
  ? join(process.env.XDG_DATA_HOME, "loam")
  : join(homedir(), ".loam");
const dataDir = requiredValue("--data-dir") ?? process.env.LOAM_DATA_DIR ?? defaultDataDir;
mkdirSync(dataDir, { recursive: true });

const port = requiredValue("--port") ?? process.env.PORT ?? "3000";
if (!/^\d+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535) {
  console.error(`Invalid port "${port}": expected an integer between 1 and 65535.`);
  process.exit(1);
}

process.env.LOAM_DATA_DIR = dataDir;
process.env.LOAM_CLIENT_DIST = join(pkgRoot, "client");
process.env.PORT = String(port);

// Advertise this package's version to the server, which surfaces it to clients in /api/config as
// "LOAM v…". Best-effort: an unreadable manifest just leaves the server on its "dev" fallback.
if (!process.env.LOAM_VERSION) {
  try {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
    if (typeof pkg.version === "string" && pkg.version) {
      process.env.LOAM_VERSION = pkg.version;
    }
  } catch {
    // best effort
  }
}

if (args.includes("--encrypt")) {
  // A passphrase if provided, else "ephemeral" → a random RAM-only key (lost on reboot). Either way
  // the store must live on disk (not :memory:), which it does (dataDir above). See docs/02.
  process.env.LOAM_DB_KEY = optionValue("--encrypt") ?? process.env.LOAM_DB_KEY ?? "ephemeral";
}

const bundlePath = join(pkgRoot, "dist/loam-server.js");
if (!existsSync(bundlePath)) {
  console.error(`Missing ${bundlePath}. The package looks incomplete — reinstall loamnet.`);
  process.exit(1);
}

const { startEmbeddedServer, firstLanIPv4, encodeQR, renderQRToTerminal } = await import(
  pathToFileURL(bundlePath).href
);

// Keep the printed join host and the server's own join URL in sync.
const joinHost = process.env.LOAM_JOIN_HOST ?? firstLanIPv4();
process.env.LOAM_JOIN_HOST = joinHost;
const joinUrl = `http://${joinHost}:${port}`;

console.log("");
console.log(`LOAM node — data in ${dataDir}`);
console.log(`Open on this device:  http://localhost:${port}`);
console.log(`Join from your phone: ${joinUrl}`);
console.log("");
console.log(renderQRToTerminal(encodeQR(joinUrl), { quietZone: 2 }));
console.log("");

try {
  await startEmbeddedServer();
} catch (error) {
  // Only treat this as a missing-driver case when the error actually names the SQLCipher module —
  // a bare `Cannot find module` match would misreport any unrelated missing dependency.
  if (process.env.LOAM_DB_KEY && String(error?.message ?? "").includes("better-sqlite3-multiple-ciphers")) {
    console.error(
      "\nEncryption requested but the native SQLCipher driver is unavailable.\n" +
        "Install it with:  npm install -g better-sqlite3-multiple-ciphers\n" +
        "or run without --encrypt for an unencrypted local database.",
    );
    process.exit(1);
  }
  throw error;
}
