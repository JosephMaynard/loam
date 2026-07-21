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

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");
const repoRoot = join(appDir, "..", "..");
const serverEntry = join(repoRoot, "apps/server/src/embedded-main.ts");
const clientDist = join(repoRoot, "apps/client/dist");
// Committed launcher template. The nodejs-project dir itself is gitignored build output; the files
// under templateDir are its versioned source of truth. main.js `require('./helper')`s its siblings
// (db-key-gate, start-fresh-marker, …) at boot, so EVERY template file must reach the runtime — a
// missing helper throws MODULE_NOT_FOUND before the server starts (Sol P0).
const templateDir = join(appDir, "nodejs-project-template");

// The whole template is runtime source: every *.js helper plus package.json. Copying the directory's
// actual contents (rather than a hardcoded [main.js, package.json] list) means a future helper can't
// be silently omitted. There are currently no template files that must be excluded; if one is ever
// added (e.g. a README), exclude it explicitly here with a comment explaining why.
const templateFiles = readdirSync(templateDir).filter(
  (name) => name.endsWith(".js") || name === "package.json",
);

// Output lands under nodejs-assets/nodejs-project — the layout nodejs-mobile expects.
const outDir = join(appDir, "nodejs-assets", "nodejs-project");
const outFile = join(outDir, "loam-server.js");
const clientOut = join(outDir, "client");

function assertBuilt(path, hint) {
  if (!existsSync(path)) {
    throw new Error(`Missing ${path}. Run \`${hint}\` first.`);
  }
}

/**
 * Statically verify that every relative `require('./x')` in a generated entry file resolves to a
 * sibling in the runtime dir. `./x` maps to `x.js` (or `x` verbatim if it already ends in `.js`);
 * `x/index.js` is accepted for a directory-style specifier. Throws (fails the build) on any miss.
 */
function assertRelativeRequiresResolve(entryFile, runtimeDir) {
  const source = readFileSync(entryFile, "utf8");
  const requireRe = /require\(\s*(['"])(\.\/[^'"]+)\1\s*\)/g;
  const specs = new Set();
  for (let match = requireRe.exec(source); match !== null; match = requireRe.exec(source)) {
    specs.add(match[2]);
  }
  const missing = [];
  for (const spec of specs) {
    const rel = spec.slice(2); // strip leading "./"
    const candidates = rel.endsWith(".js") ? [rel] : [`${rel}.js`, join(rel, "index.js")];
    if (!candidates.some((candidate) => existsSync(join(runtimeDir, candidate)))) {
      missing.push(spec);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `bundle:server smoke check failed: ${basename(entryFile)} requires relative module(s) absent ` +
        `from the generated runtime (${runtimeDir}): ${missing.join(", ")}. Ensure each helper ` +
        `exists in nodejs-project-template/ so it is copied into the runtime.`,
    );
  }
  console.log(
    `✓ Smoke check: all ${specs.size} relative require(s) in main.js resolve in the runtime`,
  );
}

assertBuilt(join(repoRoot, "packages/schema/dist/index.js"), "pnpm -r build");
assertBuilt(clientDist, "pnpm --filter client build");

// Rebuild the generated artifacts but preserve node_modules (the native better-sqlite3 prebuild,
// placed by scripts/fetch-native-modules.mjs) so bundling doesn't wipe it.
mkdirSync(outDir, { recursive: true });
for (const stale of [outFile, clientOut]) {
  rmSync(stale, { recursive: true, force: true });
}
// Purge STALE launcher helpers left by a previous run: any top-level *.js in the runtime that is
// neither the esbuild bundle (loam-server.js, regenerated below) nor a current template file. This
// stops a renamed/removed helper from lingering across rebuilds.
const keepJs = new Set(["loam-server.js", ...templateFiles.filter((n) => n.endsWith(".js"))]);
if (existsSync(outDir)) {
  for (const name of readdirSync(outDir)) {
    if (name.endsWith(".js") && !keepJs.has(name)) {
      rmSync(join(outDir, name), { force: true });
      console.log(`✓ Removed stale launcher helper → ${name}`);
    }
  }
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
    // Bake the app version (app.json) in at bundle time as LOAM_VERSION — which embedded.ts already reads
    // for `buildApp({ version })`, but which the launcher never actually set on-device, so the web client
    // footer showed "dev" for everyone. This makes it show the REAL build. A version bump flows through on
    // the next bundle.
    "process.env.LOAM_VERSION": JSON.stringify(
      JSON.parse(readFileSync(join(appDir, "app.json"), "utf8")).expo.version,
    ),
  },
  metafile: true,
  logLevel: "info",
});

cpSync(clientDist, clientOut, { recursive: true });
// The complete CJS launcher template — nodejs-mobile runs main.js on boot, which requires its helper
// siblings. Copy every template file so no `require('./helper')` target is missing on-device.
for (const name of templateFiles) {
  cpSync(join(templateDir, name), join(outDir, name));
}

// Build-time smoke check: every relative `require('./x')` in the generated main.js must resolve to a
// file present in the runtime dir. Catches the exact class of packaging bug (a referenced helper not
// copied → Node throws MODULE_NOT_FOUND at boot before the server starts). Fails the build loudly.
assertRelativeRequiresResolve(join(outDir, "main.js"), outDir);

const hasNative = existsSync(
  join(outDir, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"),
);

const bytes = statSync(outFile).size;
const inputs = Object.keys(result.metafile.inputs).length;
console.log(
  `\n✓ Bundled ${inputs} modules → ${outFile.replace(`${repoRoot}/`, "")} (${(bytes / 1024 / 1024).toFixed(2)} MB)`,
);
console.log(`✓ Copied web client → ${clientOut.replace(`${repoRoot}/`, "")}`);
console.log(`✓ Copied launcher template (${templateFiles.join(", ")})`);
console.log(
  hasNative
    ? "✓ better-sqlite3 native prebuild present"
    : "⚠ better-sqlite3 native prebuild MISSING — run `pnpm --filter app fetch:native` before building the APK.",
);
