#!/usr/bin/env node
// Smoke-tests the PUBLISHED shape of the `loamnet` CLI, which the workspace suites never exercise: packs
// cli/ with `npm pack`, installs the tarball into a scratch project exactly as `npm i loamnet` would (so a
// file missing from `files`, or an optional SQLCipher driver that won't install, fails here), then runs
// the installed `loam` bin:
//   1. `--help` exits 0;
//   2. an invalid `--port` is refused;
//   3. with the default port 3000 held by another listener, it moves to a free port and serves the
//      health check and the web client there;
//   4. an explicit `--port` that is taken is refused with a message (exit 1), not a stack trace;
//   5. `--encrypt` with $LOAM_DB_KEY starts, writes a database that isn't plaintext SQLite, and reopens
//      it with the same key.
//
// Needs `pnpm build` first (it runs scripts/build-cli.mjs itself). Uses the network for `npm install`.
// Usage: node scripts/cli-smoke.mjs

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, openSync, readSync, closeSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "loamnet-smoke-"));
const children = new Set();

/** Run a command to completion, failing the smoke test on a non-zero exit. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

function check(condition, message) {
  if (!condition) {
    throw new Error(`FAILED: ${message}`);
  }
  console.log(`✓ ${message}`);
}

/** Hold `port` on the wildcard address until the returned close() is called. */
function holdPort(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ port, host: "0.0.0.0" }, () => resolve(() => new Promise((done) => server.close(done))));
  });
}

/** A port the OS says is free right now. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ port: 0, host: "0.0.0.0" }, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Start the installed `loam` and wait for it to print its local URL. Resolves { port, stop }, or rejects
 * with its output if it exits first or takes longer than 30 s.
 */
function startLoam(bin, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    let output = "";
    const timer = setTimeout(() => reject(new Error(`loam did not start within 30 s:\n${output}`)), 30_000);
    const onData = (chunk) => {
      output += chunk;
      const match = /Open on this device:\s+http:\/\/localhost:(\d+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        const stop = () =>
          new Promise((done) => {
            child.once("exit", () => {
              children.delete(child);
              done();
            });
            child.kill("SIGINT");
          });
        resolve({ port: Number(match[1]), output: () => output, stop });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      children.delete(child);
      reject(new Error(`loam exited (${code}) before starting:\n${output}`));
    });
  });
}

/** The first 16 bytes of a file as text (a plaintext SQLite database starts "SQLite format 3\0"). */
function fileHeader(path) {
  const fd = openSync(path, "r");
  const buffer = Buffer.alloc(16);
  readSync(fd, buffer, 0, 16, 0);
  closeSync(fd);
  return buffer.toString("latin1");
}

async function main() {
  run(process.execPath, [join(repoRoot, "scripts/build-cli.mjs")], { stdio: "inherit" });

  // Pack and install the way a user gets it.
  run("npm", ["pack", "--pack-destination", work], { cwd: join(repoRoot, "cli") });
  const tarball = readdirSync(work).find((name) => name.endsWith(".tgz"));
  const project = join(work, "project");
  run("mkdir", ["-p", project]);
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "smoke", private: true }));
  const install = spawnSync("npm", ["install", "--no-audit", "--no-fund", join(work, tarball)], {
    cwd: project,
    encoding: "utf8",
  });
  check(install.status === 0, `npm install of ${tarball} succeeds`);
  check(!/npm warn deprecated/i.test(install.stderr), "install prints no deprecation warnings");
  const bin = join(project, "node_modules/loamnet/bin/loam.js");

  const baseEnv = { ...process.env };
  delete baseEnv.PORT;
  delete baseEnv.LOAM_DB_KEY;
  delete baseEnv.LOAM_DATA_DIR;

  check(spawnSync(process.execPath, [bin, "--help"], { encoding: "utf8" }).status === 0, "`loam --help` exits 0");

  const invalid = spawnSync(process.execPath, [bin, "--port", "70000"], { encoding: "utf8", env: baseEnv });
  check(invalid.status === 1 && /Invalid port/.test(invalid.stderr), "an invalid --port is refused");

  // Default port taken → next free one.
  const releaseDefault = await holdPort(3000).catch(() => undefined);
  try {
    const node = await startLoam(bin, ["--data-dir", join(work, "plain")], baseEnv);
    check(node.port !== 3000, `with 3000 taken, it moves to ${node.port}`);
    const health = await fetch(`http://127.0.0.1:${node.port}/api/health`);
    check(health.ok && (await health.json()).ok === true, "the health check answers on the chosen port");
    const shell = await fetch(`http://127.0.0.1:${node.port}/channels`);
    check(shell.ok && (await shell.text()).includes("<html"), "the web client is served (SPA route → shell)");
    await node.stop();
  } finally {
    await releaseDefault?.();
  }

  // Explicit port taken → refused.
  const takenPort = await freePort();
  const releaseTaken = await holdPort(takenPort);
  try {
    const taken = spawnSync(process.execPath, [bin, "--port", String(takenPort), "--data-dir", join(work, "taken")], {
      encoding: "utf8",
      env: baseEnv,
      timeout: 30_000,
    });
    check(
      taken.status === 1 && /already in use/.test(taken.stderr) && !/\n\s+at /.test(taken.stderr),
      "a taken explicit --port exits 1 with a message, not a stack trace",
    );
  } finally {
    await releaseTaken();
  }

  // Encrypted at rest, and reopenable with the same key.
  const encryptedDir = join(work, "encrypted");
  const encryptedEnv = { ...baseEnv, LOAM_DB_KEY: "smoke test passphrase" };
  const port = await freePort();
  let node = await startLoam(bin, ["--encrypt", "--port", String(port), "--data-dir", encryptedDir], encryptedEnv);
  check((await fetch(`http://127.0.0.1:${port}/api/health`)).ok, "an encrypted node starts (SQLCipher driver loads)");
  await node.stop();
  check(!fileHeader(join(encryptedDir, "loam.db")).startsWith("SQLite format 3"), "its database file is not plaintext SQLite");
  node = await startLoam(bin, ["--encrypt", "--port", String(port), "--data-dir", encryptedDir], encryptedEnv);
  check((await fetch(`http://127.0.0.1:${port}/api/health`)).ok, "it reopens the encrypted database with the same key");
  await node.stop();

  console.log("\nloamnet package smoke test passed.");
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  for (const child of children) {
    child.kill("SIGKILL");
  }
  rmSync(work, { recursive: true, force: true });
}
