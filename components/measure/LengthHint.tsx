"use client";

/**
 * components/measure/LengthHint.tsx
 *
 * Reads a typed length back to the customer in feet and inches, and
 * says so when the number looks wrong.
 *
 * Two failures this is aimed at, both seen in real submissions:
 *
 * The unit slip. Someone measures 350 cm and types "350", or reads a
 * tape in feet and types "11". The field says metres, but a label
 * saying "m" has never once stopped anyone doing this. Echoing the
 * value back as "about 1,148 feet" does, because it is obviously
 * absurd in a way that "350" is not.
 *
 * The silent typo. An extra digit turns 3.5 into 35 and the room
 * reaches the architect as a hall the length of a cricket pitch. Worth
 * catching, but worth catching *gently* — some of these rooms really
 * are unusual, and a warning that blocks would be wrong far more often
 * than it would be right. So this warns and never stops anyone.
 *
 * The feet reading is the point, not the warning. Plenty of people who
 * have measured in metres their whole lives still picture a room in
 * feet, and a second opinion in familiar units is how you notice you
 * mistyped.
 */

import { metresToFeetInches } from "@tm-designs/measure-core";

type Kind = "wall" | "ceiling" | "opening";

/**
 * Ranges are deliberately wide. These are "are you sure" boundaries,
 * not validation — a 15 m open-plan room and a 4.2 m Victorian ceiling
 * both exist, and neither should be argued with.
 */
const RANGES: Record<Kind, { min: number; max: number; what: string }> = {
  wall: { min: 0.4, max: 25, what: "a wall" },
  ceiling: { min: 1.6, max: 6, what: "a ceiling" },
  opening: { min: 0.3, max: 6, what: "a door or window" },
};

export default function LengthHint({
  value,
  kind = "wall",
}: {
  /** Raw field text, exactly as typed. */
  value: string;
  kind?: Kind;
}) {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const m = Number.parseFloat(trimmed);
  if (!Number.isFinite(m) || m <= 0) {
    return (
      <p className="mt-1 text-sm text-on-surface-variant">
        That doesn&apos;t look like a number — try something like 3.5
      </p>
    );
  }

  const { min, max, what } = RANGES[kind];
  const feet = metresToFeetInches(m);

  if (m > max) {
    // The commonest cause by far, so name it rather than leaving the
    // person to work out what we're objecting to.
    const asCm = m / 100;
    return (
      <p className="mt-1 text-sm font-semibold text-[#8a6f2f]">
        {m} metres is about {feet}, which is very large for {what}.
        {asCm >= min && asCm <= max
          ? ` Did you mean ${asCm} metres (${metresToFeetInches(asCm)})? If you measured in centimetres, divide by 100.`
          : " Double-check the number if that isn't right."}{" "}
        You can carry on either way.
      </p>
    );
  }

  if (m < min) {
    return (
      <p className="mt-1 text-sm font-semibold text-[#8a6f2f]">
        {m} metres is about {feet}, which is very small for {what}. Worth a
        second look — but you can carry on either way.
      </p>
    );
  }

  return (
    <p className="mt-1 text-sm text-on-surface-variant">
      That&apos;s about {feet}
    </p>
  );
}
