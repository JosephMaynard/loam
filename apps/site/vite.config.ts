import { resolve } from "node:path";
import { defineConfig } from "vite";

// Static marketing site for loamnet.com. No framework — hand-written HTML/CSS with a touch of JS.
export default defineConfig({
  build: {
    target: "es2020",
    // Inline nothing large; keep the single CSS/JS files cacheable.
    assetsInlineLimit: 2048,
    // Three pages: the landing page, the privacy policy and the child safety standards (Play requires
    // a public URL for each).
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        privacy: resolve(import.meta.dirname, "privacy.html"),
        childSafety: resolve(import.meta.dirname, "child-safety.html"),
      },
    },
  },
});
