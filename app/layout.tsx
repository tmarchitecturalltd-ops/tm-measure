import type { Metadata } from "next";
import "./globals.css";
import IconFallback from "@/components/IconFallback";
import RegisterSW from "@/components/RegisterSW";

export const metadata: Metadata = {
  title: "TM Designs Ltd | Architectural Excellence",
  description:
    "Professional architectural drawings from £550. Guaranteed 2-week delivery, 100% online, UK-wide. 98% first-time planning approval.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="scroll-smooth h-full antialiased">
      <head>
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
