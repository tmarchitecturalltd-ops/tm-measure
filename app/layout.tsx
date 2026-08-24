import type { Metadata, Viewport } from "next";
import "./globals.css";
import IconFallback from "@/components/IconFallback";
import RegisterSW from "@/components/RegisterSW";

export const metadata: Metadata = {
  title: "TM Designs Ltd | Architectural Excellence",
  description:
    "Professional architectural drawings from £550. Guaranteed 2-week delivery, 100% online, UK-wide. 98% first-time planning approval.",
};

/**
 * No viewport was declared at all, which caused two problems that only
 * appear in the native build, never in Safari.
 *
 * `viewportFit: "cover"` lets the page use the full screen on a
 * notched iPhone AND makes the env(safe-area-inset-*) values
 * meaningful. Without it those insets are zero, so the header rendered
 * underneath the status bar and the title collided with the clock and
 * the battery icon.
 *
 * The scale is locked, which is a reversal.
 *
 * It was left unlocked on the reasoning that pinch-zoom is an
 * accessibility requirement. That reasoning applies to a website. This
 * is a native app in a WKWebView, where zooming the entire UI is not
 * expected behaviour, and iOS Accessibility → Zoom keeps working
 * system-wide regardless of what a viewport tag says — so the
 * accessibility path is not the one being removed here.
 *
 * What was actually happening, reported on build 1030: zooming in left
 * the user unable to get back out, and rotating to landscape got stuck
 * mid-zoom. There is no horizontal overflow on any page (checked at
 * 428 and 926 CSS px), so this is WKWebView's own scaling behaviour
 * inside a full-screen native shell rather than a layout fault.
 *
 * The 16px minimum on inputs in globals.css stays. That solves a
 * different problem — iOS auto-zooming on focus of a small field — and
 * would still be needed if this were ever run as a website.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#b89650",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="scroll-smooth h-full antialiased">
      <head>
        {/* Content Security Policy, as a meta tag rather than a header.
            next.config.ts defines a CSP in headers(), and `output:
            export` ignores headers() entirely — so the policy the
            config appears to set has never actually reached a single
            shipped page. Static files served by a native WebView have
            no server to add headers, which makes the meta form the only
            one that applies here.

            frame-ancestors and X-Frame-Options are deliberately absent:
            neither works from a meta tag, and both are meaningless in a
            WebView that cannot be framed. The rest carry over from the
            config so the two do not disagree.

            connect-src covers the Apps Script endpoint; img-src covers
            the marketing photography on the home screen. Removing
            either shows as a blank hero or a submission that silently
            fails, so widen with care. */}
        <meta
          httpEquiv="Content-Security-Policy"
          content={[
            "default-src 'self'",
            // Next injects inline bootstrap scripts; nonces are not
            // available in a static export.
            "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "font-src 'self' data: https://fonts.gstatic.com",
            "img-src 'self' data: blob: https://images.pexels.com https://images.unsplash.com",
            "media-src 'self' blob: data:",
            "connect-src 'self' https:",
            "base-uri 'self'",
            "form-action 'self'",
            "object-src 'none'",
          ].join("; ")}
        />
        <meta name="referrer" content="strict-origin-when-cross-origin" />

        {/* Favicon = same brand mark as the marketing site. We point
            at the SVG version of the app icon so the browser renders
            crisp at any size; falls back to /favicon.ico if SVG
            unsupported. */}
        <link rel="icon" type="image/svg+xml" href="/brand-mark.svg" />
        <link rel="icon" type="image/x-icon" href="/favicon.ico" />
        <link rel="apple-touch-icon" href="/brand-mark.svg" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <meta name="theme-color" content="#b89650" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="TM Measure" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0&display=block"
        />
      </head>
      <body className="bg-surface text-on-surface font-body min-h-full flex flex-col">
        {/* Dev-only on-screen error reporter.
            iOS Safari has no console without a Mac, so script errors there
            are invisible — the page just renders as dead server HTML. This
            inline script runs independently of the app bundle, so it still
            reports even when that bundle fails to parse or execute.
            Stripped entirely from production builds. */}
        {process.env.NODE_ENV !== "production" && (
          <script
            dangerouslySetInnerHTML={{
              __html: `
(function () {
  function box() {
    var el = document.getElementById('__err');
    if (el) return el;
    el = document.createElement('pre');
    el.id = '__err';
    el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;max-height:45vh;overflow:auto;margin:0;padding:10px;background:#7f1d1d;color:#fff;font:12px/1.4 monospace;white-space:pre-wrap';
    document.body.appendChild(el);
    return el;
  }
  function log(label, detail) { box().textContent += label + ': ' + detail + '\\n\\n'; }
  window.addEventListener('error', function (e) {
    log('ERROR', (e.message || e.error) + ' @ ' + (e.filename || '?') + ':' + (e.lineno || '?'));
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    log('PROMISE', (r && (r.stack || r.message)) || String(r));
  });
})();
`,
            }}
          />
        )}
        <IconFallback />
        <RegisterSW />
        {children}
      </body>
    </html>
  );
}
