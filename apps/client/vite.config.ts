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
      "/api": apiTarget,
      "/ws": {
        target: wsTarget,
        ws: true,
      },
    },
  },
});
