/**
 * components/app/BrandMark.tsx
 *
 * TM Designs monogram — drawn inline so it lives in one place and
 * picks up theme colour via currentColor. Square mark with a gold
 * border, two thin architectural rules (top + bottom) for a "drafted"
 * feel, and a serif "TM" centred inside.
 *
 * Used by every Capacitor-app screen header (AppHome, /photo-tips,
 * eventually /history, etc.) so the brand identity stays consistent.
 */

export default function BrandMark({ size = 36 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 40 40"
      width={size}
      height={size}
      aria-hidden
      className="text-primary"
    >
      <rect
        x="2"
        y="2"
        width="36"
        height="36"
        rx="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      {/* Two thin architectural rules — like elevation guide lines. */}
      <line
        x1="6"
        y1="9"
        x2="34"
        y2="9"
        stroke="currentColor"
        strokeWidth="0.5"
        opacity="0.45"
      />
      <line
        x1="6"
        y1="31"
        x2="34"
        y2="31"
        stroke="currentColor"
        strokeWidth="0.5"
        opacity="0.45"
      />
      <text
        x="20"
        y="25"
        textAnchor="middle"
        fontFamily="Georgia, 'Times New Roman', serif"
        fontWeight="600"
        fontSize="14"
        letterSpacing="0.5"
        fill="currentColor"
      >
        TM
      </text>
    </svg>
  );
}
