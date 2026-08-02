import type { NextConfig } from "next";

const isCapacitorExport = process.env.CAPACITOR === "1";
const isDev = process.env.NODE_ENV !== "production";

const nextConfig: NextConfig = {
  output: isCapacitorExport ? "export" : undefined,
  images: { unoptimized: isCapacitorExport },
  // Phone testing goes through a Cloudflare quick tunnel. Without listing
  // that origin the dev server rejects its requests for internal assets and
  // the hot-reload socket, so the page arrives as server-rendered HTML that
  // never hydrates — every button dead, no error shown.
  allowedDevOrigins: ["*.trycloudflare.com"],
  transpilePackages: [
    "@tm-designs/measure-core",
    "@tm-designs/capacitor-roomplan",
  ],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              // Google Fonts serves the Material Symbols stylesheet; without
              // it every icon falls back to its raw glyph name.
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "font-src 'self' data: https://fonts.gstatic.com",
              // Marketing photography is hosted on Pexels and Unsplash.
              // Blocking it left the hero and carousel as empty boxes, which
              // also collapsed the surrounding layout.
              "img-src 'self' data: blob: https://images.pexels.com https://images.unsplash.com",
              // The dev server needs its HMR socket and blob workers. Safari
              // enforces CSP far more strictly than Chrome and will refuse
              // the whole dev runtime — leaving the page as dead server-side
              // HTML with no hydration — so widen these outside production.
              isDev
                ? "connect-src 'self' https: ws: wss: blob:"
                : "connect-src 'self' https:",
              ...(isDev ? ["worker-src 'self' blob:"] : []),
              "frame-ancestors 'none'",
            ].join("; "),
          },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Camera is needed for corner-tap / auto-scan as well as the
          // photo capture flow; microphone for per-room voice memos.
          { key: "Permissions-Policy", value: "camera=(self), microphone=(self)" },
        ],
      },
    ];
  },
};

export default nextConfig;
