import { resolve } from "node:path";
import { defineConfig } from "vite";

// Static marketing site for loamnet.com. No framework — hand-written HTML/CSS with a touch of JS.
export default defineConfig({
  build: {
    target: "es2020",
    // Inline nothing large; keep the single CSS/JS files cacheable.
    assetsInlineLimit: 2048,
    // Two pages: the landing page and the privacy policy (Play requires a public policy URL).
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        privacy: resolve(import.meta.dirname, "privacy.html"),
      },
    },
  },
});
