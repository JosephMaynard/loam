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
const serverEntry = join(repoRoot, "apps/server/src/embedded-main.ts");
const clientDist = join(repoRoot, "apps/client/dist");
// Committed launcher template (main.js + package.json). The nodejs-project dir itself is gitignored
// build output; these two files are its versioned source of truth.
const templateDir = join(appDir, "nodejs-project-template");

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

// Rebuild the generated artifacts but preserve node_modules (the native better-sqlite3 prebuild,
// placed by scripts/fetch-native-modules.mjs) so bundling doesn't wipe it.
mkdirSync(outDir, { recursive: true });
for (const stale of [outFile, clientOut, join(outDir, "main.js"), join(outDir, "package.json")]) {
  rmSync(stale, { recursive: true, force: true });
}

const result = await build({
  entryPoints: [serverEntry],
  outfile: outFile,
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  // Keep the SQLite drivers external — none can be bundled, and the device resolves the right one
  // at runtime from nodejs-project/node_modules (see docs/04):
  // - node:sqlite: a Node ≥22 builtin absent on the device's Node 18 (docs/01). External so the
  //   desktop smoke test (Node ≥22) still resolves it and the device fails loudly if it's reached.
  // - better-sqlite3: the native .node the device actually uses (LOAM_DB_DRIVER=better-sqlite3,
  //   unencrypted for now) — ships as an ABI-108 android-arm64 prebuild, resolved at runtime.
  // - better-sqlite3-multiple-ciphers: the encrypted driver, loaded only when a DB key is set
  //   (the on-device encrypted path is a follow-up — docs/01).
  external: ["node:sqlite", "better-sqlite3", "better-sqlite3-multiple-ciphers"],
  // `import.meta.url` is empty in CJS output, which would make db.ts's `createRequire(import.meta.url)`
  // throw on-device. Define it to a __filename-derived file URL so the native driver resolves against
  // nodejs-project/node_modules at runtime (esbuild's CJS output has real __filename + require).
  banner: {
    js: "const __loamImportMetaUrl = require('node:url').pathToFileURL(__filename).href;",
  },
  define: {
    "import.meta.url": "__loamImportMetaUrl",
  },
  metafile: true,
  logLevel: "info",
});

cpSync(clientDist, clientOut, { recursive: true });
// The CJS launcher template (main.js) and its package.json — nodejs-mobile runs main.js on boot.
cpSync(join(templateDir, "main.js"), join(outDir, "main.js"));
cpSync(join(templateDir, "package.json"), join(outDir, "package.json"));

const hasNative = existsSync(
  join(outDir, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"),
);

const bytes = statSync(outFile).size;
const inputs = Object.keys(result.metafile.inputs).length;
console.log(
  `\n✓ Bundled ${inputs} modules → ${outFile.replace(`${repoRoot}/`, "")} (${(bytes / 1024 / 1024).toFixed(2)} MB)`,
);
console.log(`✓ Copied web client → ${clientOut.replace(`${repoRoot}/`, "")}`);
console.log(`✓ Copied launcher template (main.js, package.json)`);
console.log(
  hasNative
    ? "✓ better-sqlite3 native prebuild present"
    : "⚠ better-sqlite3 native prebuild MISSING — run `pnpm --filter app fetch:native` before building the APK.",
);
