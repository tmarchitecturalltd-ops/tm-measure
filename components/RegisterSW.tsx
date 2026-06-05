"use client";

/**
 * components/RegisterSW.tsx
 *
 * Tiny client component that hooks navigator.serviceWorker on first
 * mount. Mounted once from the root layout. No UI. Failures are
 * silent — if the browser doesn't support service workers (older
 * iOS Safari, Capacitor WKWebView in some configurations) we just
 * skip registration.
 */

import { useEffect } from "react";

export default function RegisterSW() {
  useEffect(() => {
    if (typeof navigator === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    // Don't register inside the local LAN dev preview — hot module
    // reload doesn't play nicely with the cache-first strategy.
    if (window.location.hostname === "localhost") return;
    navigator.serviceWorker
      .register("/sw.js")
      .catch(() => {/* noop */});
  }, []);
  return null;
}
