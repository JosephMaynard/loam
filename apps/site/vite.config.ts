import { defineConfig } from "vite";

// Static marketing site for loamnet.com. No framework — hand-written HTML/CSS with a touch of JS.
export default defineConfig({
  build: {
    target: "es2020",
    // Inline nothing large; keep the single CSS/JS files cacheable.
    assetsInlineLimit: 2048,
  },
});
