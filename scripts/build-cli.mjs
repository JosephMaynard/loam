#!/usr/bin/env node
// Bundles the LOAM server into a single self-contained ESM file for the `loamnet` npm package, and
// copies the built web client alongside it. The published package boots a full node (server + PWA)
// from `bin/loam.js`, which imports `startEmbeddedServer` (and the QR helpers) from the bundle
// produced here.
//
// Forked from apps/app/scripts/bundle-server.mjs (the Android bundler), with three differences:
//   - format: esm, target: node22 (npm users run modern Node; import.meta.url works natively, so no
//     CJS banner is needed for db.ts's createRequire path).
//   - the entry (cli/cli-entry.ts) re-exports startEmbeddedServer + the @loam/qr helpers as a library,
//     so bin/loam.js controls env setup and the join-QR print before booting — rather than the
//     Android bundler's embedded-main.ts, which boots on import.
//   - output lands in cli/ (the publishable package), not nodejs-assets/.
//
// The @loam/* workspace packages are inlined from their compiled dist/ (run `pnpm -r build` first).
// The three SQLite drivers stay external: node:sqlite is a Node ≥22 builtin (the default, zero
// node-gyp); better-sqlite3(-multiple-ciphers) are optional native deps resolved at runtime only when
// an alternate/encrypted driver is requested.
//
// Usage: node scripts/build-cli.mjs   (or: pnpm build:cli)

import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const entry = join(repoRoot, "cli/cli-entry.ts");
const clientDist = join(repoRoot, "apps/client/dist");
const pkgDir = join(repoRoot, "cli");
const outFile = join(pkgDir, "dist/loam-server.js");
const clientOut = join(pkgDir, "client");

function assertBuilt(path, hint) {
  if (!existsSync(path)) {
    throw new Error(`Missing ${path}. Run \`${hint}\` first.`);
  }
}

for (const pkg of ["schema", "display-name", "avatar", "qr"]) {
  assertBuilt(join(repoRoot, `packages/${pkg}/dist/index.js`), "pnpm -r build");
}
assertBuilt(clientDist, "pnpm --filter client build");

// Rebuild the generated artifacts (dist bundle + copied client); leave bin/ and package.json alone.
rmSync(join(pkgDir, "dist"), { recursive: true, force: true });
rmSync(clientOut, { recursive: true, force: true });
mkdirSync(dirname(outFile), { recursive: true });

const result = await build({
  entryPoints: [entry],
  outfile: outFile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Keep the SQLite drivers external — none can be bundled:
  // - node:sqlite: the default, a Node ≥22 builtin (zero native deps).
  // - better-sqlite3 / better-sqlite3-multiple-ciphers: optional native deps, resolved at runtime
  //   from node_modules only when an alternate/encrypted driver is requested.
  external: ["node:sqlite", "better-sqlite3", "better-sqlite3-multiple-ciphers"],
  // Some bundled deps are CommonJS and call `require(...)` / read `__dirname` (e.g. @fastify/static).
  // ESM output has neither, so esbuild's `__require` shim throws on them. Recreate the CJS globals
  // from import.meta.url at the top of the bundle so those requires resolve normally.
  banner: {
    js: [
      "import { createRequire as __loamCreateRequire } from 'node:module';",
      "import { fileURLToPath as __loamFileURLToPath } from 'node:url';",
      "import { dirname as __loamDirname } from 'node:path';",
      "const require = __loamCreateRequire(import.meta.url);",
      "const __filename = __loamFileURLToPath(import.meta.url);",
      "const __dirname = __loamDirname(__filename);",
    ].join("\n"),
  },
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
