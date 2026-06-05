/* TM Measure service worker.
 *
 * Goals:
 *   • Make the form usable when the customer loses signal mid-survey
 *     (lift-of-the-house extension surveys are notorious for this).
 *   • Don't accidentally serve stale measurement code after a build —
 *     bump CACHE_VERSION whenever the build changes.
 *
 * Strategy:
 *   • Static export → almost everything in `/` is cache-friendly.
 *   • Cache-first for same-origin requests (HTML, JS chunks, brand
 *     SVGs, manifest). Falls through to the network if missing.
 *   • Network-first for everything else (Apps Script POSTs, Google
 *     Drive image fetches) so live data isn't mocked from cache.
 *   • Cache invalidated on every activate when CACHE_VERSION ticks. */

const CACHE_VERSION = "tm-measure-v1";
const PRECACHE_URLS = [
  "/",
  "/measure",
  "/architect",
  "/architect/review",
  "/status",
  "/privacy",
  "/photo-tips",
  "/manifest.webmanifest",
  "/brand-mark.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      // Best-effort: skip URLs that 404 (e.g. /privacy when the page
      // isn't deployed yet) so the SW installs anyway.
      await Promise.allSettled(PRECACHE_URLS.map((u) => cache.add(u)));
      self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)),
      );
      self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin) {
    // Network-first for Apps Script + Drive so the architect always
    // sees live data when online. Fall back to nothing — no cache.
    return;
  }
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      const cached = await cache.match(req);
      if (cached) {
        // Refresh in the background so the next visit is up-to-date.
        event.waitUntil(
          fetch(req)
            .then((res) => {
              if (res.ok) return cache.put(req, res.clone());
              return undefined;
            })
            .catch(() => {/* offline — keep the cached copy */}),
        );
        return cached;
      }
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch (err) {
        // Last-resort fallback: return the cached `/` if we have it,
        // so the user at least sees the home screen instead of a
        // browser error page.
        const fallback = await cache.match("/");
        if (fallback) return fallback;
        throw err;
      }
    })(),
  );
});
