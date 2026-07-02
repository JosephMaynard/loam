import { startEmbeddedServer } from "./embedded.js";

// The nodejs-mobile launcher requires the bundle to boot the server on load; keeping the auto-start
// here (not in embedded.ts) means startEmbeddedServer stays side-effect-free to import elsewhere.
// This file is the esbuild bundle entry (see apps/app/scripts/bundle-server.mjs).
startEmbeddedServer().catch((error) => {
  console.error("Failed to start embedded LOAM server:", error);
  process.exit(1);
});
