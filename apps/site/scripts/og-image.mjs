// Renders the 1200×630 share image (public/og-image.png) from scripts/og-image.html, through a running
// dev server so the page has the site's fonts:
//
//   pnpm --filter site dev   # in one terminal (port 5173 unless told otherwise)
//   node apps/site/scripts/og-image.mjs [http://localhost:5173]
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const base = process.argv[2] ?? "http://localhost:5173";

const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.goto(`${base}/scripts/og-image.html`);
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(here, "..", "public", "og-image.png"), type: "png" });
  console.log("og-image.png");
} finally {
  await browser.close();
}
