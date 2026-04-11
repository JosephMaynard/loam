import { resolve } from "node:path";

import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const demoRoot = __dirname;
const workspaceRoot = resolve(__dirname, "../../..");

export default defineConfig({
  root: demoRoot,
  plugins: [preact(), tailwindcss()],
  resolve: {
    alias: {
      "@loam/avatar": resolve(__dirname, "../src/index.ts"),
      "@loam/display-name": resolve(__dirname, "../../display-name/src/index.ts"),
    },
  },
  server: {
    fs: {
      allow: [workspaceRoot],
    },
  },
  build: {
    outDir: resolve(__dirname, "../dist-demo"),
    emptyOutDir: true,
  },
});
