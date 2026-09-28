import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const apiPort = process.env.LOAM_API_PORT ?? "3001";
const apiTarget = `http://localhost:${apiPort}`;
const wsTarget = `ws://localhost:${apiPort}`;

// https://vite.dev/config/
export default defineConfig({
  plugins: [preact()],
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
