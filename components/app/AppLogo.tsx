/**
 * components/app/AppLogo.tsx
 *
 * The single source of truth for the TM Designs primary logo — the
 * two-building line mark used on the Play Store / App Store listing,
 * the launcher icon and the splash screen.
 *
 * Drawn inline (rather than loaded from /public) so it renders instantly
 * with no network round-trip inside the Capacitor WebView, scales
 * losslessly at any size, and stays byte-identical to the store assets
 * in `store-assets/app-icon-adaptive-foreground.svg`.
 *
 * Prefer this over BrandMark (the "TM" monogram) anywhere the full brand
 * logo belongs: splash, welcome screen and app headers.
 */

export default function AppLogo({
  size = 40,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 108 108"
      width={size}
      height={size}
      role="img"
      aria-label="TM Architectural Designs"
      className={className}
    >
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M 30 84 L 30 32 L 60 19 L 60 84 Z" />
        <rect x="60" y="35" width="28" height="49" />
        <line x1="60" y1="45" x2="88" y2="45" />
        <line x1="60" y1="55" x2="88" y2="55" />
        <line x1="60" y1="65" x2="88" y2="65" />
        <line x1="60" y1="75" x2="88" y2="75" />
        <line x1="22" y1="87" x2="92" y2="87" />
      </g>
    </svg>
  );
}
