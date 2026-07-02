import { defineConfig } from "vitest/config";

// Standalone from vite.config.ts on purpose: the units under test (src/lib/*) are plain TS with no
// JSX, so we skip the Preact plugin and just supply a DOM environment (markdown sanitizer needs
// document/window; local-store needs IndexedDB, provided per-test by fake-indexeddb).
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
  },
});
