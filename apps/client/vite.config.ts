import { resolve } from "node:path";

import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [preact()],
  resolve: {
    alias: {
      "@loam/avatar": resolve(__dirname, "../../packages/avatar/src/index.ts"),
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
      "/api": "http://localhost:3001",
      "/ws": {
        target: "ws://localhost:3001",
        ws: true,
      },
    },
  },
});
