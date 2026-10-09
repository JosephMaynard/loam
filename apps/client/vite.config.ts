import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import preact from "@preact/preset-vite";
import { build, defineConfig, type Plugin, type ResolvedConfig } from "vite";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const apiPort = process.env.LOAM_API_PORT ?? "3001";
const apiTarget = `http://localhost:${apiPort}`;
const wsTarget = `ws://localhost:${apiPort}`;

/** The name the worker is served under; `main.tsx` registers it from the app's base. */
const SERVICE_WORKER_FILE = "service-worker.js";

/** A file of the build, for the worker's list and the build id. */
interface BuildFile {
  /** The path the browser asks for, under the app's base. */
  path: string;
  content: string | Uint8Array;
}

/** Every regular file under `dir` (recursively), skipping dotfiles, as `BuildFile`s under `base`. */
function publicFiles(dir: string, base: string): BuildFile[] {
  const files: BuildFile[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const file = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(file);
      } else if (entry.isFile()) {
        files.push({ path: base + relative(dir, file).split(/[\\/]/).map(encodeURIComponent).join("/"), content: readFileSync(file) });
      }
    }
  };
  walk(dir);
  return files;
}

/** A short content hash over every file of the build, in a fixed order: the same build, the same id. */
function buildIdFor(files: BuildFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path).update("\0").update(file.content).update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * Builds the service worker (`src/service-worker.ts`) once the app is written, as its own classic
 * script at `dist/service-worker.js`, with this build's file list, base and content hash defined in:
 * the worker precaches exactly what this build emitted (so a first visit works offline afterwards) and
 * caches under a name that changes with the build, so a deploy evicts the old bundles and refreshes
 * the unhashed files (icons, manifest). The list covers every emitted chunk and asset, except the
 * shell itself (`index.html`, cached under the base path) and source maps, plus the public files.
 */
function serviceWorkerPlugin(): Plugin {
  let config: ResolvedConfig;
  let emitted: BuildFile[] = [];

  return {
    name: "loam:service-worker",
    apply: "build",
    configResolved(resolved) {
      config = resolved;
    },
    buildStart() {
      emitted = [];
    },
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        emitted.push({ path: config.base + output.fileName, content: output.type === "chunk" ? output.code : output.source });
      }
    },
    async closeBundle() {
      if (!emitted.length) {
        return;
      }
      const files = [...emitted, ...(config.publicDir ? publicFiles(config.publicDir, config.base) : [])];
      const shellPath = config.base;
      const assetPaths = files
        .map((file) => file.path)
        .filter((path) => path !== `${shellPath}index.html` && !path.endsWith(".map") && path !== `${shellPath}${SERVICE_WORKER_FILE}`)
        .sort();
      const buildId = buildIdFor(files);

      await build({
        configFile: false,
        root: config.root,
        base: config.base,
        publicDir: false,
        logLevel: "warn",
        define: {
          __LOAM_SW_BUILD_ID__: JSON.stringify(buildId),
          __LOAM_SW_BASE__: JSON.stringify(shellPath),
          __LOAM_SW_ASSETS__: JSON.stringify(assetPaths),
        },
        build: {
          target: config.build.target,
          outDir: config.build.outDir,
          emptyOutDir: false,
          copyPublicDir: false,
          sourcemap: false,
          lib: {
            entry: resolve(config.root, "src/service-worker.ts"),
            formats: ["iife"],
            name: "loamServiceWorker",
            fileName: () => SERVICE_WORKER_FILE,
          },
        },
      });
      config.logger.info(`${posix.join(relative(config.root, config.build.outDir), SERVICE_WORKER_FILE)}: build ${buildId}, ${assetPaths.length} files precached`);
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [preact(), serviceWorkerPlugin()],
  // The floor DESIGN.md promises ("Browser floor": Android WebView ≈ Chrome 80): without an explicit target
  // the minifier rewrites the physical top/right/bottom/left fallbacks into `inset`, drops the `100vh` line
  // under `100dvh`, and leaves `??=` in the JS — all of which an old WebView can't parse.
  build: {
    target: ["chrome80", "safari14"],
    cssTarget: ["chrome80", "safari14"],
  },
  resolve: {
    alias: {
      "@loam/avatar": resolve(__dirname, "../../packages/avatar/src/index.ts"),
      "@loam/crypto": resolve(__dirname, "../../packages/crypto/src/index.ts"),
      "@loam/display-name": resolve(__dirname, "../../packages/display-name/src/index.ts"),
      "@loam/qr": resolve(__dirname, "../../packages/qr/src/index.ts"),
      "@loam/schema": resolve(__dirname, "../../packages/schema/src/index.ts"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 3000,
    strictPort: true,
    proxy: {
      "/api": apiTarget,
      "/ws": {
        target: wsTarget,
        ws: true,
      },
    },
  },
});
