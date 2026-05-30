#!/usr/bin/env node
/**
 * render-screenshots.js — App Store / Play Store screenshot generator.
 *
 * Renders the 5 sections of screenshots.html to 1290 × 2796 PNGs using
 * Puppeteer (headless Chromium). One-shot — no watch mode, no flags.
 *
 * Usage on Windows:
 *   cd App
 *   npm i -D puppeteer
 *   node store-assets/render-screenshots.js
 *
 * Output: store-assets/screenshots/screen-1.png … screen-5.png
 *
 * Apple wants 1290 × 2796 (iPhone 6.9"). The same PNGs are the right
 * aspect for Google Play phone screenshots — Play accepts up to 8 MB
 * per file, so no compression step is needed.
 */

const fs = require("fs");
const path = require("path");

(async () => {
  const puppeteer = require("puppeteer");
  const outDir = path.join(__dirname, "screenshots");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

  const browser = await puppeteer.launch({
    headless: "new",
    defaultViewport: { width: 1290, height: 2796, deviceScaleFactor: 1 },
  });

  const fileUrl =
    "file://" + path.join(__dirname, "screenshots.html").replace(/\\/g, "/");

  for (let i = 1; i <= 5; i++) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1290, height: 2796, deviceScaleFactor: 1 });
    await page.goto(`${fileUrl}#screen-${i}`, { waitUntil: "networkidle0" });
    // Give Google Fonts a beat to settle before snapshotting.
    await new Promise((r) => setTimeout(r, 800));
    const target = await page.$(`#screen-${i}-stage`);
    if (!target) {
      console.warn(`screen-${i}-stage not found; skipping`);
      await page.close();
      continue;
    }
    const out = path.join(outDir, `screen-${i}.png`);
    await target.screenshot({ path: out, type: "png" });
    console.log(`wrote ${out}`);
    await page.close();
  }

  await browser.close();
  console.log(`\nDone. Five PNGs in: ${outDir}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
