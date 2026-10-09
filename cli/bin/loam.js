#!/usr/bin/env node
// `loam` — boot a full LOAM node (Fastify server + bundled PWA) and run its terminal UI (@loam/tui): the join
// QR stays on screen, with activity, people, settings and debug screens a key away. Without a terminal (a
// service, piped output) or with --plain it prints the join QR and URLs instead. The server is env-driven:
// this launcher sets the env the bundled `startEmbeddedServer` reads, then hands off.
// Storage defaults to a user-writable directory (never inside the global package). Default DB driver
// is the built-in node:sqlite (Node ≥22) — zero node-gyp; `--encrypt` opts into the optional native
// SQLCipher driver.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createLineBuffer } from "./line-buffer.js";
import { findFreePort, isPortFree } from "./port.js";

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
  console.log(`loam: run a local LOAM node (off-grid messaging over your LAN)

Usage: loam [options]

Options:
  --port <n>        Port to listen on (default $PORT, else 3000 or the next
                    free port after it)
  --data-dir <dir>  Where to store the SQLite DB + avatars
                    (default $XDG_DATA_HOME/loam or ~/.loam)
  --encrypt         Encrypt the database at rest (SQLCipher). The passphrase comes
                    from $LOAM_DB_KEY if set, otherwise you are prompted for it
                    (not echoed). For a new database, an empty answer (or no
                    terminal to prompt on) uses an ephemeral RAM-only key (data
                    unreadable after exit); an existing database needs its passphrase.
  --encrypt ephemeral
                    Use an ephemeral RAM-only key without prompting.
  --encrypt <pass>  Use <pass> directly. Discouraged: it is visible to other users
                    in \`ps\` and saved in your shell history.
                    Encryption requires the optional native driver (installed
                    automatically unless it failed to build).
  --kiosk           Start locked in kiosk mode: only the join QR shows until the
                    kiosk password is entered (you choose one if none is saved)
  --plain           Print the join QR and URLs instead of the full-screen
                    terminal UI (automatic when there is no terminal)
  --verbose         In plain mode, also print a log line for every request
  -h, --help        Show this help

In a terminal, loam shows its full-screen UI: the join QR, activity, people,
settings and debug screens (press ? there for the keys). Scan the QR from
another device on the same network to join. Settings you change in the UI that
apply at startup are kept in cli.json in the data folder.

Requires Node.js 22.14+ (or 23.6+).`);
  process.exit(0);
}

const defaultDataDir = process.env.XDG_DATA_HOME
  ? join(process.env.XDG_DATA_HOME, "loam")
  : join(homedir(), ".loam");
const dataDir = requiredValue("--data-dir") ?? process.env.LOAM_DATA_DIR ?? defaultDataDir;
mkdirSync(dataDir, { recursive: true });

const bundlePath = join(pkgRoot, "dist/loam-server.js");
if (!existsSync(bundlePath)) {
  console.error(`Missing ${bundlePath}. The package looks incomplete. Reinstall loamnet.`);
  process.exit(1);
}
const bundle = await import(pathToFileURL(bundlePath).href);

// The full-screen UI needs a terminal on both ends; a service or piped output gets the plain print-out.
const useTui = !args.includes("--plain") && process.stdin.isTTY && process.stdout.isTTY;
if (args.includes("--kiosk") && !useTui) {
  console.error("--kiosk needs the terminal UI: run loam in a terminal, without --plain.");
  process.exit(1);
}

// What the terminal UI saved for the next start (cli.json). Flags and environment variables win over it.
const saved = bundle.readCliSettings(dataDir);

const requestedPort = requiredValue("--port") ?? process.env.PORT;
if (
  requestedPort !== undefined &&
  (!/^\d+$/.test(String(requestedPort)) || Number(requestedPort) < 1 || Number(requestedPort) > 65535)
) {
  console.error(`Invalid port "${requestedPort}": expected an integer between 1 and 65535.`);
  process.exit(1);
}

/** Why the chosen port can't be used, and the fix. */
function printPortInUse(taken) {
  console.error(
    `\nPort ${taken} is already in use by another program.\n` +
      "Stop that program, or pick another port:  loam --port <n>",
  );
}

// An explicitly chosen port (--port or $PORT) is used as-is: moving it silently would break a bookmark or
// a printed QR. With no choice made, 3000 is only a preference — step past a port something else holds
// (a dev server on 3000 is common) instead of crashing.
const listenHost = process.env.HOST ?? "0.0.0.0";
let port;
if (requestedPort !== undefined) {
  port = Number(requestedPort);
  if (!(await isPortFree(port, listenHost))) {
    printPortInUse(port);
    process.exit(1);
  }
} else {
  // The port saved from the terminal UI is a preference like the default: step past it if it's taken. One
  // this computer won't let us use at all (a port below 1024 without administrator rights) falls back to
  // the default instead of stopping every start.
  let preferred = saved.port ?? 3000;
  try {
    port = await findFreePort(preferred, listenHost);
  } catch (error) {
    if (saved.port === undefined) {
      throw error;
    }
    console.log(
      `The port saved in ${join(dataDir, "cli.json")} (${preferred}) can't be used here (${error?.code ?? error}), ` +
        "so LOAM is using 3000 or the next free one. Change it on the Settings screen.",
    );
    preferred = 3000;
    port = await findFreePort(preferred, listenHost);
  }
  if (port === undefined) {
    console.error(`\nPorts ${preferred}–${preferred + 19} are all in use. Pick a free port:  loam --port <n>`);
    process.exit(1);
  }
  if (port !== preferred) {
    console.log(`Port ${preferred} is in use by another program, so LOAM is using ${port} instead.`);
  }
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

// Shared across prompts: a pasted "pass\npass\n" arrives as one chunk and answers both the passphrase and
// its confirmation, so lines past the first must survive until the next prompt asks.
const passphraseInput = createLineBuffer();

/**
 * Read a line from the terminal without echoing it (for the DB passphrase). Ctrl-C aborts the launch.
 * Only called when stdin is a TTY.
 */
function promptHidden(question) {
  const { stdin, stdout } = process;
  stdout.write(question);
  const queued = passphraseInput.next();
  if (queued !== undefined) {
    stdout.write("\n");
    return Promise.resolve(queued);
  }
  return new Promise((resolve) => {
    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    };
    const onData = (chunk) => {
      if (passphraseInput.push(chunk) === "interrupt") {
        cleanup();
        process.exit(130);
      }
      const line = passphraseInput.next();
      if (line !== undefined) {
        cleanup();
        resolve(line);
      }
    };
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
 * An empty answer means ephemeral only for a NEW database: a fresh RAM-only key can never open an existing
 * one (the server would just stop on an unreadable-database error), so there it asks again.
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
    console.warn("--encrypt: no $LOAM_DB_KEY and no terminal to prompt on, so using an ephemeral RAM-only key.");
    return "ephemeral";
  }
  const databasePath = join(dataDir, "loam.db");
  const isNewDatabase = !existsSync(databasePath);
  for (;;) {
    const passphrase = await promptHidden(
      isNewDatabase
        ? "Database passphrase (leave empty for an ephemeral RAM-only key): "
        : "Database passphrase: ",
    );
    if (!passphrase) {
      if (isNewDatabase) {
        return "ephemeral";
      }
      console.error(
        `${databasePath} already exists, and an ephemeral key can never open it. Enter its passphrase ` +
          "(Ctrl-C to quit), or use a different --data-dir for a new database.",
      );
      continue;
    }
    if (!isNewDatabase) {
      return passphrase;
    }
    const confirmation = await promptHidden("Confirm the passphrase for the new database: ");
    if (confirmation === passphrase) {
      return passphrase;
    }
    console.error("The passphrases didn't match. Try again.");
  }
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

/**
 * Why encryption can't start, and the fix. The driver is resolved from the loamnet package itself (its
 * optionalDependency, next to dist/), so a separate global install of the driver is never found. It ships
 * prebuilt binaries for 64-bit Linux (glibc and musl), macOS and Windows and builds nothing at install, so
 * it is missing either because the install skipped it or because this platform has no prebuilt binary.
 */
function printDriverMissingHint() {
  console.error(
    "\nEncryption requested but the native SQLCipher driver (better-sqlite3-multiple-ciphers) is unavailable.\n" +
      "It is loaded from the loamnet package itself, resolved from:\n" +
      `  ${dirname(bundlePath)}\n` +
      "It ships prebuilt for 64-bit Linux, macOS and Windows" +
      ` (this machine: ${process.platform}-${process.arch}).\n` +
      "On one of those, reinstall loamnet (npm install -g loamnet) and check the install output, since\n" +
      "optional dependencies are skipped silently. Other platforms (such as 32-bit Raspberry Pi OS) have\n" +
      "no prebuilt binary: build it in place with `npx node-gyp rebuild --release` inside\n" +
      "loamnet's node_modules/better-sqlite3-multiple-ciphers (needs a C/C++ toolchain and Python).\n" +
      "Or run without --encrypt (and without LOAM_DB_KEY) for an unencrypted local database.",
  );
}

/**
 * The SQLCipher driver is built against Node-API 10 (Node 22.14+ / 23.6+). On an older Node, loading it
 * doesn't throw — the process segfaults — so this must be checked before `encryptedDriverLoads` ever runs.
 */
function nodeSupportsDriver() {
  return Number(process.versions.napi) >= 10;
}

if (args.includes("--encrypt") || process.env.LOAM_DB_KEY) {
  if (!nodeSupportsDriver()) {
    console.error(
      `\nEncryption needs Node.js 22.14+ (or 23.6+); this is ${process.version} (Node-API ${process.versions.napi}).\n` +
        "Upgrade Node, then reinstall loamnet (npm install -g loamnet).\n" +
        "Or run without --encrypt (and without LOAM_DB_KEY) for an unencrypted local database.",
    );
    process.exit(1);
  }
  if (!encryptedDriverLoads()) {
    printDriverMissingHint();
    process.exit(1);
  }
}

if (args.includes("--encrypt")) {
  // A passphrase, or "ephemeral" → a random RAM-only key (lost on reboot). Either way the store must
  // live on disk (not :memory:), which it does (dataDir above). See docs/02.
  process.env.LOAM_DB_KEY = await resolveEncryptionKey();
}

const {
  createLogBook,
  createTui,
  encodeQR,
  firstLanIPv4,
  processSystem,
  processTerminal,
  renderQRToTerminal,
  startEmbeddedServer,
  writeCliSettings,
} = bundle;

// Keep the printed join host and the server's own join URL in sync. A join address pinned in the terminal
// UI is used only while this computer still has it (a laptop moves between networks).
const system = processSystem();
const savedJoinHost =
  saved.joinHost && system.lanAddresses().some((entry) => entry.address === saved.joinHost) ? saved.joinHost : undefined;
const envJoinHost = process.env.LOAM_JOIN_HOST;
const joinHost = envJoinHost ?? savedJoinHost ?? firstLanIPv4();
process.env.LOAM_JOIN_HOST = joinHost;

// A per-boot host token, as the Android host has: nobody on the network becomes admin by being first to open
// the app. Admin comes from this computer instead: the terminal UI's "open as admin" link or People screen,
// or, in plain mode, the one-time admin link printed below. It never leaves this process.
const hostToken = randomBytes(32).toString("base64url");

// The server's log. The terminal UI shows it on its Activity and Debug screens; plain mode prints it, minus
// the two lines per request unless --verbose.
const logBook = createLogBook();
const verbose = args.includes("--verbose");
const plainLogStream = {
  write(line) {
    if (verbose || !/"msg":"(incoming request|request completed)"/.test(line)) {
      // JSON escapes C0 control characters but not C1 ones (a request path can carry them); a terminal reading
      // this output must never receive one.
      process.stdout.write(line.replace(/[\u0080-\u009f]/g, ""));
    }
  },
};

console.log("");
console.log(`LOAM node: data in ${dataDir}`);

let app;
try {
  // Start FIRST, then show the QR: the QR must carry the host's transport public key as a `#k=<key>`
  // fragment (docs/08) so a scanner learns the key out-of-band and the first join is MITM-resistant. The
  // key only exists once the server has booted, and it's read straight off the app (never via an HTTP
  // call, which would mint a session).
  app = await startEmbeddedServer({
    hostToken,
    logStream: useTui ? { write: (line) => logBook.write(line) } : plainLogStream,
    handleSignals: false,
  });
} catch (error) {
  // Only treat this as a missing-driver case when the error actually names the SQLCipher module —
  // a bare `Cannot find module` match would misreport any unrelated missing dependency.
  if (process.env.LOAM_DB_KEY && String(error?.message ?? "").includes("better-sqlite3-multiple-ciphers")) {
    printDriverMissingHint();
    process.exit(1);
  }
  // The port was free when probed above, but another program can take it before the server binds.
  if (error?.code === "EADDRINUSE") {
    printPortInUse(port);
    process.exit(1);
  }
  throw error;
}

let tui;
let stopping = false;
const originalConsoleError = console.error;
/** Close the server and exit, once. A second Ctrl-C or SIGTERM while it closes stops at once. */
async function shutdown(code = 0) {
  if (stopping) {
    process.exit(1);
  }
  stopping = true;
  tui?.stop();
  // The terminal UI routed console output to its log; with the UI gone, errors go to the terminal again.
  console.error = originalConsoleError;
  try {
    await app.close();
  } catch (error) {
    console.error("Error while stopping LOAM:", error);
    code = 1;
  }
  process.exit(code);
}
process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

if (useTui) {
  // Anything else that would print (a Node warning, a stray console line) goes to the Activity screen
  // instead of scribbling over the UI.
  process.removeAllListeners("warning");
  process.on("warning", (warning) => logBook.note("warn", `${warning.name}: ${warning.message}`));
  for (const [method, level] of [["log", "info"], ["info", "info"], ["warn", "warn"], ["error", "error"]]) {
    console[method] = (...parts) => logBook.note(level, parts.map(String).join(" "));
  }
  if (savedJoinHost === undefined && saved.joinHost && !envJoinHost) {
    logBook.note("warn", `The saved join address ${saved.joinHost} isn't on this computer now, so LOAM picked ${joinHost}.`);
  }
  tui = createTui({
    host: app.host,
    log: logBook,
    terminal: processTerminal(),
    system,
    launch: {
      dataDir,
      nodeVersion: process.version,
      platform: `${process.platform} ${process.arch}`,
      databaseDriver: process.env.LOAM_DB_KEY ? "SQLCipher" : "node:sqlite",
    },
    settings: saved,
    saveSettings: (next) => writeCliSettings(dataDir, next),
    writeFile: (path, contents) => writeFileSync(path, contents, { mode: 0o600 }),
    startLocked: args.includes("--kiosk") || saved.kiosk?.startLocked === true,
    quit: () => shutdown(0),
  });
  // Put the terminal back before any crash report is printed.
  process.on("uncaughtException", (error) => {
    tui?.stop();
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exit(1);
  });
  tui.start();
} else {
  printPlain(app);
}

/** The plain print-out: URLs, the join QR, and a one-time admin link while nobody is admin. */
function printPlain(app) {
  // What the server advertises to joiners (its join host and client port, which `CLIENT_PORT` can set apart
  // from the port it listens on), as the terminal UI shows; `port` stays the local listener's.
  const advertised = app.host.status();
  const advertisedHost =
    advertised.joinHost.includes(":") && !advertised.joinHost.startsWith("[") ? `[${advertised.joinHost}]` : advertised.joinHost;
  const joinUrl = `http://${advertisedHost}:${advertised.port}`;
  const transportKey = app.host.transportPublicKey();
  const qrUrl = transportKey ? `${joinUrl}#k=${transportKey}` : joinUrl;

  console.log(`Open on this device:  http://localhost:${port}`);
  console.log(`Join from your phone: ${joinUrl}`);
  console.log("");
  // The host's responsibilities (the terminal UI and the Android app show the same note once). A print-out has
  // nobody to acknowledge it, so it's printed on every start: short, and it only goes to this host's log.
  console.log("You run this network: what people post is stored on this computer, and you're responsible");
  console.log("for it. Check reports in the web app, remove anything that breaks LOAM's rules, and if you find");
  console.log("sexual content involving a child, remove it and report it to the police.");
  console.log("More: https://loamnet.com/child-safety");
  console.log("");
  // A QR that won't fit (the encoder caps at ~106 bytes; a long LOAM_JOIN_HOST can exceed it) must
  // never take down a server that is already listening — degrade to the printed URL instead.
  try {
    console.log(renderQRToTerminal(encodeQR(qrUrl), { quietZone: 2 }));
    console.log("");
    if (transportKey) {
      console.log("Scan the QR to join: it carries this node's encryption key, so scanned joins are");
      console.log("protected against impersonation. Depending on this node's security settings, a");
      console.log("hand-typed URL may connect without that protection, or be refused entirely.");
      console.log("");
    }
  } catch {
    // No QR to carry the key out-of-band, so hand out the KEYED link here — copy/paste keeps the
    // MITM protection; only the plain printed URL above loses it.
    console.log("(Couldn't render a join QR for this address.)");
    if (transportKey) {
      console.log("Share this exact link instead. Copied whole, it keeps the encryption key:");
      console.log(qrUrl);
    } else {
      console.log("Share the URL above instead.");
    }
    console.log("");
  }

  // While nobody is admin (a new network, or again after an Emergency Reset), keep a one-time admin link on
  // hand (each lasts 10 minutes). In a terminal it is printed. Without one (a service), it goes to a file only
  // this user can read, never to the log: a journal or log shipper is read by more people than this. A code
  // that is replaced, or no longer needed because someone is admin, is retired on the server too: deleting
  // the file alone would leave it usable until it expired.
  const linkFile = join(dataDir, "admin-link.txt");
  let current;
  const retireCurrent = () => {
    if (current) {
      app.host.revokeAdminClaimCode(current.code);
      current = undefined;
    }
  };
  const offerAdminLink = () => {
    let status;
    try {
      status = app.host.status();
    } catch {
      return;
    }
    if (status.people.admins > 0) {
      if (current) {
        rmSync(linkFile, { force: true });
        retireCurrent();
      }
      return;
    }
    if (current && current.expiresAt - Date.now() > 60_000 && current.resets === status.resets) {
      return;
    }
    retireCurrent();
    const minted = app.host.adminClaimCode();
    if (!minted) {
      return;
    }
    const key = app.host.transportPublicKey();
    const link = `${joinUrl}#${key ? `k=${key}&` : ""}a=${minted.code}`;
    current = { code: minted.code, expiresAt: minted.expiresAt, resets: status.resets };
    if (process.stdout.isTTY) {
      console.log("Nobody is admin yet. Open this link to become admin (it works once, for 10 minutes):");
      console.log(`  ${link}`);
      console.log("");
      return;
    }
    // Remove first: `mode` only applies to a new file, so an existing one (left with looser permissions, or a
    // symlink pointing elsewhere) would otherwise keep its permissions or send the code somewhere else.
    try {
      rmSync(linkFile, { force: true });
      writeFileSync(linkFile, `${link}\n`, { mode: 0o600, flag: "wx" });
    } catch (error) {
      // Something put a file back in between (or the folder isn't writable): don't write through it.
      retireCurrent();
      console.error(`Couldn't write the one-time admin link to ${linkFile} (${error?.code ?? error}). Trying again shortly.`);
      return;
    }
    console.log(`Nobody is admin yet. A one-time admin link (renewed every 10 minutes) is in ${linkFile}`);
  };
  const adminTimer = setInterval(offerAdminLink, 30_000);
  adminTimer.unref();
  offerAdminLink();
}
