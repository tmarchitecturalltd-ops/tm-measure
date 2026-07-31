/**
 * components/app/OnboardingIcons.tsx
 *
 * Line-art marks for the three welcome-screen beats. Drawn in the same
 * stroke language as AppLogo (2.6 stroke on a 108 viewBox, round caps
 * and joins) so the welcome screen reads as one coherent set rather
 * than logo-plus-generic-icons.
 *
 * All three inherit colour via `currentColor`, so the caller controls
 * the palette and dark mode needs no special handling.
 */

type IconProps = { size?: number; className?: string };

function Frame({
  size = 48,
  className,
  label,
  children,
}: IconProps & { label: string; children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 108 108"
      width={size}
      height={size}
      role="img"
      aria-label={label}
      className={className}
    >
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {children}
      </g>
    </svg>
  );
}

/** Beat 1 — a room outline with dimension arrows. */
export function MeasureIcon(props: IconProps) {
  return (
    <Frame {...props} label="Measure at your pace">
      <rect x="24" y="30" width="60" height="44" />
      <line x1="24" y1="86" x2="84" y2="86" />
      <path d="M 28 82 L 24 86 L 28 90" />
      <path d="M 80 82 L 84 86 L 80 90" />
      <line x1="16" y1="30" x2="16" y2="74" />
      <path d="M 12 34 L 16 30 L 20 34" />
      <path d="M 12 70 L 16 74 L 20 70" />
    </Frame>
  );
}

/** Beat 2 — a camera, for reference photos and voice notes. */
export function PhotoIcon(props: IconProps) {
  return (
    <Frame {...props} label="Photos that do the talking">
      <path d="M 20 40 L 34 40 L 40 32 L 68 32 L 74 40 L 88 40 L 88 80 L 20 80 Z" />
      <circle cx="54" cy="58" r="13" />
      <line x1="78" y1="48" x2="82" y2="48" />
    </Frame>
  );
}

/** Beat 3 — a drawing board, for the hand-off to the design team. */
export function DraftingIcon(props: IconProps) {
  return (
    <Frame {...props} label="Straight to our drawing board">
      <rect x="22" y="24" width="64" height="48" />
      <line x1="22" y1="72" x2="54" y2="88" />
      <line x1="86" y1="72" x2="54" y2="88" />
      <line x1="32" y1="60" x2="60" y2="34" />
      <line x1="32" y1="60" x2="70" y2="60" />
    </Frame>
  );
}
