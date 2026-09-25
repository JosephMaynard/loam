#!/usr/bin/env node
// `loam` — boot a full LOAM node (Fastify server + bundled PWA) and print a join QR. Everything is
// env-driven: this launcher sets the env the bundled `startEmbeddedServer` reads, then hands off.
// Storage defaults to a user-writable directory (never inside the global package). Default DB driver
// is the built-in node:sqlite (Node ≥22) — zero node-gyp; `--encrypt` opts into the optional native
// SQLCipher driver.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
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
  if (index !== args.lastIndexOf(name)) {
    console.error(`${name} was given more than once.`);
    process.exit(1);
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
  --encrypt         Encrypt the database at rest (SQLCipher). The passphrase comes
                    from $LOAM_DB_KEY if set, otherwise you are prompted for it
                    (not echoed). An empty answer — or no terminal to prompt on —
                    uses an ephemeral RAM-only key (data unreadable after exit).
  --encrypt ephemeral
                    Use an ephemeral RAM-only key without prompting.
  --encrypt <pass>  Use <pass> directly. Discouraged: it is visible to other users
                    in \`ps\` and saved in your shell history.
                    Encryption requires the optional native driver (installed
                    automatically unless it failed to build).
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

/**
 * Read a line from the terminal without echoing it (for the DB passphrase). Ctrl-C aborts the launch.
 * Only called when stdin is a TTY.
 */
function promptHidden(question) {
  const { stdin, stdout } = process;
  return new Promise((resolve) => {
    let value = "";
    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          cleanup();
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          cleanup();
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
        } else if (ch >= " ") {
          value += ch;
        }
      }
    };
    stdout.write(question);
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

/**
 * Resolve the `--encrypt` key WITHOUT putting a passphrase in argv where avoidable (pre-release review
 * 2026-09-25): an argv passphrase is readable by every local user via `ps` and lands in shell history.
 * Order: `--encrypt <value>` (warned; `ephemeral` is not a secret) → $LOAM_DB_KEY → an interactive no-echo
 * prompt (confirmed twice when no database exists yet, so a typo can't lock a brand-new DB) → ephemeral.
 */
async function resolveEncryptionKey() {
  const fromArgs = optionValue("--encrypt");
  if (fromArgs !== undefined) {
    if (fromArgs !== "ephemeral") {
      console.warn(
        "Warning: a passphrase given on the command line is visible to other users (`ps`) and saved in your\n" +
          "shell history. Prefer `LOAM_DB_KEY=… loam --encrypt`, or bare `--encrypt` to be prompted.",
      );
    }
    return fromArgs;
  }
  if (process.env.LOAM_DB_KEY) {
    return process.env.LOAM_DB_KEY;
  }
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    console.warn("--encrypt: no $LOAM_DB_KEY and no terminal to prompt on — using an ephemeral RAM-only key.");
    return "ephemeral";
  }
  const isNewDatabase = !existsSync(join(dataDir, "loam.db"));
  for (;;) {
    const passphrase = await promptHidden(
      "Database passphrase (leave empty for an ephemeral RAM-only key): ",
    );
    if (!passphrase) {
      return "ephemeral";
    }
    if (!isNewDatabase) {
      return passphrase;
    }
    const confirmation = await promptHidden("Confirm the passphrase for the new database: ");
    if (confirmation === passphrase) {
      return passphrase;
    }
    console.error("The passphrases didn't match — try again.");
  }
}

const bundlePath = join(pkgRoot, "dist/loam-server.js");
if (!existsSync(bundlePath)) {
  console.error(`Missing ${bundlePath}. The package looks incomplete — reinstall loamnet.`);
  process.exit(1);
}

/**
 * Whether the optional SQLCipher driver actually loads, resolved exactly as the bundled server resolves it
 * (from dist/). `require` only loads the JS wrapper — opening an in-memory DB forces the native addon.
 * Checked BEFORE the server starts: if the keyed open fails inside the server, its recovery path can
 * leave an unencrypted database file behind — never let an encrypted launch get that far.
 */
function encryptedDriverLoads() {
  try {
    const Database = createRequire(bundlePath)("better-sqlite3-multiple-ciphers");
    new Database(":memory:").close();
    return true;
  } catch {
    return false;
  }
}

if (args.includes("--encrypt") || process.env.LOAM_DB_KEY) {
  if (!encryptedDriverLoads()) {
    console.error(
      "\nEncryption requested but the native SQLCipher driver is unavailable.\n" +
        "Install it with:  npm install -g better-sqlite3-multiple-ciphers\n" +
        "or run without --encrypt (and without LOAM_DB_KEY) for an unencrypted local database.",
    );
    process.exit(1);
  }
}

if (args.includes("--encrypt")) {
  // A passphrase, or "ephemeral" → a random RAM-only key (lost on reboot). Either way the store must
  // live on disk (not :memory:), which it does (dataDir above). See docs/02.
  process.env.LOAM_DB_KEY = await resolveEncryptionKey();
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

try {
  // Start FIRST, then print the QR: the QR must carry the host's transport public key as a
  // `#k=<key>` fragment (docs/08) so a scanner learns the key out-of-band and the first join is
  // MITM-resistant — the same guarantee the browser and Android join QRs already give. The key
  // only exists once the server has booted, and it's read straight off the app (never via an HTTP
  // call, which would mint a session and could consume the `firstUser` admin grant).
  const app = await startEmbeddedServer();
  const transportKey = app.getTransportPublicKey?.();
  const qrUrl = transportKey ? `${joinUrl}#k=${transportKey}` : joinUrl;

  console.log(`Open on this device:  http://localhost:${port}`);
  console.log(`Join from your phone: ${joinUrl}`);
  console.log("");
  // A QR that won't fit (the encoder caps at ~106 bytes; a long LOAM_JOIN_HOST can exceed it) must
  // never take down a server that is already listening — degrade to the printed URL instead.
  try {
    console.log(renderQRToTerminal(encodeQR(qrUrl), { quietZone: 2 }));
    console.log("");
    if (transportKey) {
      console.log("Scan the QR to join — it carries this node's encryption key, so scanned joins are");
      console.log("protected against impersonation. Depending on this node's security settings, a");
      console.log("hand-typed URL may connect without that protection, or be refused entirely.");
      console.log("");
    }
  } catch {
    // No QR to carry the key out-of-band, so hand out the KEYED link here — copy/paste keeps the
    // MITM protection; only the plain printed URL above loses it. (The normal path deliberately
    // shows the plain URL as text: the key rides the QR image, not the human-readable line.)
    // Generic on purpose: this catch covers ANY encode/render failure (an over-capacity join
    // address is merely the most likely cause).
    console.log("(Couldn't render a join QR for this address.)");
    if (transportKey) {
      console.log("Share this exact link instead — copied whole, it keeps the encryption key:");
      console.log(qrUrl);
    } else {
      console.log("Share the URL above instead.");
    }
    console.log("");
  }
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
