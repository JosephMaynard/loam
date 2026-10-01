// Drives the LOAM Android app on a running emulator (or a USB phone) for the website's screenshots:
//
//   node apps/site/scripts/android.mjs tap "Community"     # tap the element whose text or label matches
//   node apps/site/scripts/android.mjs shot android-setup-type   # screenshot to public/shots/<name>.webp
//   node apps/site/scripts/android.mjs dump                # list the visible texts (to find the next tap)
//
// The steps used for the published screenshots are listed in android-shots.md. adb comes from
// $ANDROID_HOME/platform-tools (default ~/Library/Android/sdk). Screenshots are encoded to WebP by the
// installed Chrome, like scripts/screenshots.mjs.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const adb = join(process.env.ANDROID_HOME ?? join(homedir(), "Library/Android/sdk"), "platform-tools", "adb");
const run = (...args) => execFileSync(adb, args, { maxBuffer: 64 * 1024 * 1024 });

/** Every node in the current UI with its text/label and centre point. */
function nodes() {
  run("shell", "uiautomator", "dump", "/sdcard/ui.xml");
  const xml = run("shell", "cat", "/sdcard/ui.xml").toString("utf8");
  return [...xml.matchAll(/<node [^>]*?text="([^"]*)"[^>]*?content-desc="([^"]*)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)].map(
    ([, text, desc, x1, y1, x2, y2]) => ({
      label: (text || desc).replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"'),
      x: Math.round((Number(x1) + Number(x2)) / 2),
      y: Math.round((Number(y1) + Number(y2)) / 2),
    }),
  );
}

async function shot(name) {
  const png = run("exec-out", "screencap", "-p");
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage();
    const webp = await page.evaluate(async (base64) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
      // Shown at ~300 px wide on the site: 720 px is plenty for sharp phone screenshots.
      const scale = Math.min(1, 720 / bitmap.width);
      const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      context.imageSmoothingQuality = "high";
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.86 });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      }
      return btoa(binary);
    }, png.toString("base64"));
    const out = join(here, "..", "public", "shots");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, `${name}.webp`), Buffer.from(webp, "base64"));
    console.log(`${name}.webp`);
  } finally {
    await browser.close();
  }
}

const [command, ...args] = process.argv.slice(2);
if (command === "dump") {
  for (const node of nodes().filter((candidate) => candidate.label)) {
    console.log(`${node.x},${node.y}  ${node.label}`);
  }
} else if (command === "tap") {
  const wanted = args.join(" ");
  const match = nodes().find((node) => node.label === wanted) ?? nodes().find((node) => node.label.includes(wanted));
  if (!match) {
    throw new Error(`Nothing on screen says "${wanted}"`);
  }
  run("shell", "input", "tap", String(match.x), String(match.y));
} else if (command === "shot") {
  await shot(args[0]);
} else {
  throw new Error("usage: android.mjs dump | tap <text> | shot <name>");
}
