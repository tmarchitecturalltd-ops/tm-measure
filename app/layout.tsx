import type { Metadata } from "next";
import "./globals.css";
import IconFallback from "@/components/IconFallback";

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
        {/* Explicit font preloads — the CSS @import in globals.css
            sometimes loses the race against first paint on Capacitor's
            WKWebView, leaving every icon rendered as its raw glyph
            name ("arrow_forward", "photo_camera", etc). Loading the
            stylesheet via <link> guarantees the font request fires
            before the body renders. font-display=block keeps the
            icon container invisible until the font has loaded
            instead of flashing the literal text. */}
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
        <IconFallback />
        {children}
      </body>
    </html>
  );
}
