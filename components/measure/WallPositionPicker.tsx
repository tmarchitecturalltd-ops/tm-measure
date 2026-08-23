"use client";

/**
 * components/measure/WallPositionPicker.tsx
 *
 * Drag an opening along a wall to say roughly where it sits.
 *
 * The offset was previously a bare "Offset (m)" number field. It was
 * optional, it sat at the bottom of a collapsed section, and it asked
 * someone standing in their kitchen to produce a measurement from a
 * corner they may not be able to reach. Predictably it was left empty,
 * and the architect received a room with a window somewhere in it.
 *
 * A bar you can drag gets filled in, because it costs one gesture and
 * requires no tape. The exact number stays visible and editable beside
 * it, so anyone who *has* measured can still type the real figure.
 *
 * The two are not equivalent, and the difference is recorded rather
 * than hidden: dragging marks the value approximate, typing marks it
 * measured. An eyeballed 1.85 and a surveyed 1.85 are the same number
 * and very different facts, and the person drawing from it has no way
 * to tell them apart unless we say.
 */

import { useCallback, useRef } from "react";

type Props = {
  /** Length of the wall this opening sits on, in metres. */
  wallLengthM: number;
  /** Width of the opening itself, in metres. Drawn to scale. */
  openingWidthM: number;
  /** Current centre offset from the wall's start corner, in metres. */
  positionM: number | null;
  /** True when the current value came from dragging rather than typing. */
  approx: boolean;
  /** Fires with the new offset and how it was set. */
  onChange: (positionM: number, approx: boolean) => void;
  label?: string;
};

export default function WallPositionPicker({
  wallLengthM,
  openingWidthM,
  positionM,
  approx,
  onChange,
  label = "Position along wall",
}: Props) {
  const trackRef = useRef<HTMLDivElement | null>(null);

  const usableLength = Number.isFinite(wallLengthM) && wallLengthM > 0 ? wallLengthM : 0;

  // Without a wall length there is nothing to position against, and a
  // bar representing an unknown distance would invite nonsense.
  if (usableLength <= 0) {
    return (
      <p className="text-[11px] leading-relaxed text-on-surface-variant">
        Enter this wall&apos;s length first and you&apos;ll be able to drag the
        opening into place.
      </p>
    );
  }

  const width = Math.max(0, Math.min(openingWidthM || 0, usableLength));
  // The centre cannot sit so close to a corner that the opening would
  // hang off the end of the wall.
  const minCentre = width / 2;
  const maxCentre = usableLength - width / 2;
  const centre =
    positionM !== null && Number.isFinite(positionM)
      ? Math.min(Math.max(positionM, minCentre), maxCentre)
      : usableLength / 2;

  const setFromClientX = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
      const raw = ratio * usableLength;
      const clamped = Math.min(Math.max(raw, minCentre), maxCentre);
      // Two decimals: the gesture is not precise enough to justify more,
      // and a long decimal implies a confidence the drag does not have.
      onChange(Number(clamped.toFixed(2)), true);
    },
    [usableLength, minCentre, maxCentre, onChange],
  );

  const pct = usableLength > 0 ? (centre / usableLength) * 100 : 50;
  const widthPct = usableLength > 0 ? (width / usableLength) * 100 : 10;

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="font-label text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
          {label}
        </span>
        <span className="text-[10px] text-on-surface-variant">
          {approx ? "approximate" : "measured"}
        </span>
      </div>

      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={Number(minCentre.toFixed(2))}
        aria-valuemax={Number(maxCentre.toFixed(2))}
        aria-valuenow={Number(centre.toFixed(2))}
        aria-valuetext={`${centre.toFixed(2)} metres from the corner`}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          setFromClientX(e.clientX);
        }}
        onPointerMove={(e) => {
          if (e.buttons === 0) return;
          setFromClientX(e.clientX);
        }}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 0.5 : 0.05;
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            const next = centre + (e.key === "ArrowRight" ? step : -step);
            onChange(
              Number(Math.min(Math.max(next, minCentre), maxCentre).toFixed(2)),
              true,
            );
          }
        }}
        // touchAction none so dragging along the bar doesn't scroll the
        // page out from under the finger doing the dragging.
        style={{ touchAction: "none" }}
        className="relative h-12 w-full cursor-pointer rounded-lg border border-outline-variant/40 bg-surface-container-lowest"
      >
        {/* The wall */}
        <div className="absolute inset-x-2 top-1/2 h-1 -translate-y-1/2 rounded bg-on-surface/25" />

        {/* The opening, drawn to scale along it */}
        <div
          className="absolute top-1/2 h-5 -translate-y-1/2 rounded-sm bg-primary"
          style={{
            left: `calc(${pct}% - ${widthPct / 2}%)`,
            width: `max(10px, ${widthPct}%)`,
          }}
        />

        <span className="absolute left-2 top-1 text-[9px] text-on-surface-variant">
          corner
        </span>
        <span className="absolute right-2 top-1 text-[9px] text-on-surface-variant">
          {usableLength.toFixed(2)} m
        </span>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <input
          inputMode="decimal"
          value={positionM !== null ? String(positionM) : ""}
          onChange={(e) => {
            const v = Number.parseFloat(e.target.value);
            // Typing is a claim to have measured it, so the approximate
            // flag comes off.
            if (Number.isFinite(v)) onChange(v, false);
          }}
          placeholder={`${(usableLength / 2).toFixed(2)}`}
          aria-label="Exact distance from the corner in metres"
          className="w-28 rounded-lg border border-outline-variant/40 bg-surface-container-lowest px-3 py-2 text-sm outline-none ring-primary/30 focus:border-primary/70 focus:ring-2"
        />
        <span className="text-[11px] leading-snug text-on-surface-variant">
          metres from the corner to the centre. Drag above for roughly, or type
          it if you&apos;ve measured.
        </span>
      </div>
    </div>
  );
}
