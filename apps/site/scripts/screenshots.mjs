// Takes the website's screenshots of the LOAM web client from a real, seeded node (demo-network.mjs),
// in light and dark, at phone and desktop sizes, and writes them as WebP to public/shots/.
//
//   pnpm build && node apps/site/scripts/screenshots.mjs
//
// Uses the installed Google Chrome through playwright-core (no browser download). WebP is encoded by
// Chrome itself, so no image tooling is needed either. The Android screenshots come from an emulator
// (see android-shots.md); this script only covers the web client.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "public", "shots");
mkdirSync(outDir, { recursive: true });
const only = process.argv.slice(2);

// 1. A seeded node.
const demo = spawn(process.execPath, [join(here, "demo-network.mjs")], {
  env: { ...process.env, DEMO_PHOTO: process.env.DEMO_PHOTO ?? join(here, "..", "public", "loam-hero-bkg.jpg") },
  stdio: ["ignore", "pipe", "inherit"],
});
const info = await new Promise((resolve, reject) => {
  createInterface({ input: demo.stdout }).on("line", (line) => {
    if (line.startsWith("{")) {
      resolve(JSON.parse(line));
    }
  });
  demo.once("exit", (code) => reject(new Error(`demo network exited (${code})`)));
});

async function apiAs(person, path) {
  const response = await fetch(`${info.base}${path}`, { headers: { cookie: info.cookies[person] } });
  return response.json();
}
const general = await apiAs("maya", "/api/messages/general");
const picnic = general.find((message) => message.body?.startsWith("We're setting up a picnic"));
const users = await apiAs("maya", "/api/users");
const tom = users.find((user) => user.displayName.startsWith("Tom"));

// 2. The views. Each is taken in light and dark.
const PHONE = { width: 390, height: 844, scale: 2, mobile: true };
const DESKTOP = { width: 1440, height: 900, scale: 2, mobile: false };
const views = [
  { name: "desktop-general", as: "maya", size: DESKTOP, path: "/channel/general" },
  { name: "phone-general", as: "maya", size: PHONE, path: "/channel/general" },
  { name: "phone-channels", as: "maya", size: PHONE, path: "/channels" },
  { name: "phone-thread", as: "maya", size: PHONE, path: `/channel/general/thread/${picnic.id}` },
  { name: "phone-dm", as: "maya", size: PHONE, path: `/dm/${tom.id}` },
  { name: "desktop-admin", as: "jo", size: DESKTOP, path: "/admin" },
];

const browser = await chromium.launch({ channel: "chrome" });
// WebP is encoded on a blank page: the client's own CSP (rightly) refuses the data: URL it needs.
const encoder = await browser.newPage();
try {
  for (const view of views.filter((candidate) => !only.length || only.includes(candidate.name))) {
    for (const scheme of ["light", "dark"]) {
      const context = await browser.newContext({
        viewport: { width: view.size.width, height: view.size.height },
        deviceScaleFactor: view.size.scale,
        isMobile: view.size.mobile,
        hasTouch: view.size.mobile,
        colorScheme: scheme,
        locale: "en-GB",
        timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      const [cookieName, cookieValue] = info.cookies[view.as].split("=");
      await context.addCookies([{ name: cookieName, value: cookieValue, url: info.base }]);
      const page = await context.newPage();
      // Open the root first (so the client hydrates and marks things read), then the view itself.
      await page.goto(`${info.base}${view.path}`);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(1500);
      const png = await page.screenshot({ type: "png" });
      const webp = await encoder.evaluate(async (base64) => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        canvas.getContext("2d").drawImage(bitmap, 0, 0);
        const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.86 });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = "";
        for (let index = 0; index < bytes.length; index += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
        }
        return btoa(binary);
      }, png.toString("base64"));
      const file = join(outDir, `${view.name}-${scheme}.webp`);
      writeFileSync(file, Buffer.from(webp, "base64"));
      console.log(`${view.name}-${scheme}.webp`);
      await context.close();
    }
  }
} finally {
  await browser.close();
  demo.kill("SIGINT");
}
