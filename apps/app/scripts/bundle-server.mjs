#!/usr/bin/env node
// Bundles the LOAM server (apps/server) into a single CommonJS file that the Android host app's
// nodejs-mobile runtime can `require()`. See docs/04-android-host-app.md for the validated recipe.
//
// The embedded Node runtime is 18.x, has no bundler, and boots a CJS `main.js`, so we:
//   - target node18, format cjs, bundle everything (all server deps are pure JS)
//   - inline the workspace packages from their compiled dist/ (run `pnpm -r build` first)
//   - keep Node builtins external (esbuild does this for `node:` specifiers automatically)
//   - copy the built web client into the output so the server can serve it offline
//
// Usage: pnpm --filter app bundle:server   (or: node ./scripts/bundle-server.mjs)

import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");
const repoRoot = join(appDir, "..", "..");
const serverEntry = join(repoRoot, "apps/server/src/embedded.ts");
const clientDist = join(repoRoot, "apps/client/dist");

// Output lands under nodejs-assets/nodejs-project — the layout nodejs-mobile expects.
const outDir = join(appDir, "nodejs-assets", "nodejs-project");
const outFile = join(outDir, "loam-server.js");
const clientOut = join(outDir, "client");

function assertBuilt(path, hint) {
  if (!existsSync(path)) {
    throw new Error(`Missing ${path}. Run \`${hint}\` first.`);
  }
}

assertBuilt(join(repoRoot, "packages/schema/dist/index.js"), "pnpm -r build");
assertBuilt(clientDist, "pnpm --filter client build");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const result = await build({
  entryPoints: [serverEntry],
  outfile: outFile,
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  // node:sqlite is a Node ≥22 builtin absent on the device's Node 18 — the on-device build supplies
  // an encrypted better-sqlite3 driver in its place (docs/01). Keeping it external means the desktop
  // smoke test (Node ≥22) still resolves it, and the device build fails loudly if the alias is missing
  // rather than silently shipping a broken store.
  external: ["node:sqlite"],
  metafile: true,
  logLevel: "info",
});

cpSync(clientDist, clientOut, { recursive: true });

const bytes = statSync(outFile).size;
const inputs = Object.keys(result.metafile.inputs).length;
console.log(
  `\n✓ Bundled ${inputs} modules → ${outFile.replace(`${repoRoot}/`, "")} (${(bytes / 1024 / 1024).toFixed(2)} MB)`,
);
console.log(`✓ Copied web client → ${clientOut.replace(`${repoRoot}/`, "")}`);
console.log(
  "\nNext: the on-device build must alias node:sqlite to an encrypted better-sqlite3 driver and " +
    "set LOAM_DATA_DIR / LOAM_CLIENT_DIST (=./client) before requiring loam-server.js.",
);
