import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const demoRoot = fileURLToPath(new URL(".", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));

export default defineConfig({
  root: demoRoot,
  base: "./",
  plugins: [preact(), tailwindcss()],
  resolve: {
    alias: {
      "@loam/avatar": resolve(demoRoot, "../src/index.ts"),
      "@loam/display-name": resolve(demoRoot, "../../display-name/src/index.ts"),
    },
  },
  server: {
    fs: {
      allow: [workspaceRoot],
    },
  },
  build: {
    outDir: resolve(demoRoot, "../dist-demo"),
    emptyOutDir: true,
  },
});
