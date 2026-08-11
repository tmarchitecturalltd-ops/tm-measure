/**
 * App Store screenshot capture.
 *
 * Drives a real build of the app through a realistic project and
 * captures each step at the exact canvas sizes Apple requires.
 *
 *   npm run build:cap
 *   node store-assets/screenshots/capture.mjs
 *
 * Output: store-assets/screenshots/out/<device>/NN-name.png
 *
 * WHY THIS EXISTS
 * Build 1020 was rejected under guideline 2.3.3 — "the screenshots do
 * not show the actual app in use". The set on the listing at the time
 * was 455x864 marketing mockups. Screenshots have to be regenerated
 * whenever the UI changes, and doing that by hand on two device classes
 * is the kind of chore that quietly doesn't happen.
 *
 * The reviewer tested on an iPad Air, so the iPad set is not optional.
 */

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const WEB = join(ROOT, 'out');
const OUT = join(HERE, 'out');
const PORT = 4321;

// Apple's required canvases. `css` x `dpr` must equal the pixel size.
const DEVICES = {
  iphone65: { w: 1284, h: 2778, css: 428, dpr: 3, mobile: true },
  ipad13: { w: 2064, h: 2752, css: 1032, dpr: 2, mobile: false },
};

// The project that appears in the screenshots. Deliberately a plausible
// UK job rather than "Test 123" — the listing is marketing.
const PROJECT = {
  name: 'Sarah Whitfield',
  email: 'sarah.whitfield@example.co.uk',
  project: 'Rear extension — 14 Oakfield Road',
  ceiling: '2.40',
  room: 'Kitchen',
  width: '4.20',
  length: '3.10',
};

if (!existsSync(WEB)) {
  console.error('No out/ directory. Run `npm run build:cap` first.');
  process.exit(1);
}

/* ── static server ─────────────────────────────────────────────── */

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.txt': 'text/plain', '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};
const isFile = async (p) => { try { return (await stat(p)).isFile(); } catch { return false; } };

const server = http.createServer(async (req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  // Next's static export writes /measure.html, not /measure/index.html.
  for (const c of [join(WEB, url), join(WEB, url, 'index.html'), join(WEB, url + '.html')]) {
    if (await isFile(c)) {
      res.writeHead(200, { 'Content-Type': TYPES[extname(c)] || 'application/octet-stream' });
      return res.end(await readFile(c));
    }
  }
  res.writeHead(404); res.end('not found');
});
await new Promise((r) => server.listen(PORT, r));

/* ── browser ───────────────────────────────────────────────────── */

let puppeteer, launchOpts = { headless: 'shell' };
try {
  puppeteer = (await import('puppeteer')).default;
} catch {
  puppeteer = (await import('puppeteer-core')).default;
  if (!process.env.PUPPETEER_EXECUTABLE_PATH) {
    console.error('puppeteer-core needs PUPPETEER_EXECUTABLE_PATH set to a Chrome binary.');
    process.exit(1);
  }
}
if (process.env.PUPPETEER_EXECUTABLE_PATH) {
  launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
}
launchOpts.args = ['--no-sandbox', '--disable-dev-shm-usage',
  '--font-render-hinting=none', '--force-color-profile=srgb'];

// Optional local font shim, for environments with no route to Google
// Fonts. Without the real faces every icon renders as a tofu box.
// See fonts/README.md before touching the unicode ranges.
const FONT_CSS = existsSync(join(HERE, 'fonts', 'fonts.css'))
  ? readFileSync(join(HERE, 'fonts', 'fonts.css'), 'utf8')
  : null;

const browser = await puppeteer.launch(launchOpts);

async function capture(key) {
  const d = DEVICES[key];
  const dir = join(OUT, key);
  mkdirSync(dir, { recursive: true });

  const page = await browser.newPage();
  await page.setViewport({
    width: d.css, height: Math.round(d.h / d.dpr),
    deviceScaleFactor: d.dpr, isMobile: d.mobile, hasTouch: d.mobile,
  });

  if (FONT_CSS) {
    await page.setRequestInterception(true);
    page.on('request', (r) =>
      /fonts\.(googleapis|gstatic)\.com/.test(r.url()) ? r.abort() : r.continue());
  }

  // The tutorial overlay covers the whole screen on first run, which
  // Apple counts as not showing the app in use.
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('tm-measure:tutorial-seen:v1', '1'); } catch {}
  });

  const settle = async (ms = 700) => {
    if (FONT_CSS) await page.addStyleTag({ content: FONT_CSS });
    await page.evaluate(() => document.fonts.ready);
    await new Promise((r) => setTimeout(r, ms));
  };
  const shot = (n) => page.screenshot({ path: join(dir, `${n}.png`) });

  // React ignores a directly assigned .value, so go through the native
  // setter and dispatch the event it listens for.
  const fill = async (label, value, nth = 0) => {
    const ok = await page.evaluate((label, value, nth) => {
      const si = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      const st = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      const ls = [...document.querySelectorAll('label')]
        .filter((x) => x.textContent.trim().toLowerCase().startsWith(label.toLowerCase()));
      const l = ls[nth];
      if (!l) return false;
      const el = l.parentElement.querySelector('input,textarea') || l.nextElementSibling;
      if (!el) return false;
      (el.tagName === 'TEXTAREA' ? st : si).call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }, label, value, nth);
    if (!ok) console.warn(`  ! no field for "${label}" — has the label text changed?`);
    await new Promise((r) => setTimeout(r, 120));
  };

  const click = async (text) => {
    const ok = await page.evaluate((text) => {
      const b = [...document.querySelectorAll('button,a')].find((x) =>
        x.textContent.replace(/\s+/g, ' ').trim().toLowerCase().includes(text.toLowerCase()));
      if (!b) return false; b.click(); return true;
    }, text);
    if (!ok) console.warn(`  ! no control matching "${text}"`);
    await new Promise((r) => setTimeout(r, 700));
    return ok;
  };

  // Park the named field near the top of the frame. Scrolling to 0
  // lands on the quick-start panel instead of the measurements.
  const scrollTo = async (label, offset = 150) => {
    await page.evaluate((label, offset) => {
      const l = [...document.querySelectorAll('label')]
        .find((x) => x.textContent.trim().toLowerCase().startsWith(label.toLowerCase()));
      if (!l) return;
      window.scrollTo(0, Math.max(0, l.getBoundingClientRect().top + window.scrollY - offset));
    }, label, offset);
    await new Promise((r) => setTimeout(r, 500));
  };

  const go = async (path) => {
    await page.goto(`http://localhost:${PORT}${path}`, { waitUntil: 'networkidle0' });
    await settle(300);
  };

  await go('/');
  await settle(); await shot('01-home');

  await go('/measure');
  await fill('Your name', PROJECT.name);
  await fill('Email', PROJECT.email);
  await fill('Project name', PROJECT.project);
  await fill('Ceiling height', PROJECT.ceiling);
  await settle(400); await shot('02-project-details');

  await click('Continue to rooms'); await settle(600);
  await fill('Room name', PROJECT.room);
  await fill('Width (m)', PROJECT.width);
  await fill('Length (m)', PROJECT.length);
  await settle(600);
  await scrollTo('Room name', 150); await shot('03-room-measurements');

  await click('Edit walls individually'); await settle(700);
  await scrollTo('Label', 220); await shot('04-walls-detail');

  await click('Floor plan'); await settle(900);
  await page.evaluate(() => window.scrollTo(0, 0)); await shot('05-floor-plan');

  await click('Review'); await settle(900);
  await page.evaluate(() => window.scrollTo(0, 0)); await shot('06-review');

  // Guard: a wrong viewport silently produces an unusable set, and App
  // Store Connect rejects on exact pixel size.
  const { width, height } = await page.evaluate(() => ({
    width: window.innerWidth * window.devicePixelRatio,
    height: window.innerHeight * window.devicePixelRatio,
  }));
  if (Math.round(width) !== d.w || Math.round(height) !== d.h) {
    console.warn(`  ! ${key} produced ${width}x${height}, expected ${d.w}x${d.h}`);
  }
  await page.close();
  console.log(`${key}: 6 screenshots -> ${dir}`);
}

for (const key of Object.keys(DEVICES)) await capture(key);

await browser.close();
server.close();
console.log('done');
