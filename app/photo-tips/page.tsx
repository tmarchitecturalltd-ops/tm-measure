"use client";

/**
 * app/photo-tips/page.tsx
 *
 * Stand-alone guidance page for in-app customers — "how to take great
 * room photos for your architect". Linked from AppHome and from the
 * Photos step inside MeasureIntakeForm.
 *
 * Aesthetic mirrors AppHome: cream/dark/gold base, BrandMark in the
 * header, four colour-tinted sections (lighting / angles / capture /
 * avoid) reusing the same architectural palette as the tile grid.
 *
 * Renders fine in both web and Capacitor builds. The marketing site
 * will not link to it, but a deep link still resolves cleanly.
 */

import Link from "next/link";
import BrandMark from "@/components/app/BrandMark";

type TipSection = {
  /** Brand-aligned tone — must match an existing tile palette stop. */
  tone: "amber" | "slate" | "sage" | "terracotta";
  eyebrow: string;
  title: string;
  blurb: string;
  bullets: { strong: string; rest: string }[];
};

/** Pre-baked rgba palettes so we keep one source of truth between this
 *  page and the AppHome tiles. */
const TONE: Record<
  TipSection["tone"],
  { bg: string; pillBg: string; ink: string; border: string }
> = {
  amber: {
    bg: "rgba(184, 150, 80, 0.05)",
    pillBg: "rgba(184, 150, 80, 0.16)",
    ink: "#8a6f3a",
    border: "rgba(184, 150, 80, 0.25)",
  },
  slate: {
    bg: "rgba(110, 130, 150, 0.05)",
    pillBg: "rgba(110, 130, 150, 0.16)",
    ink: "#5a6a80",
    border: "rgba(110, 130, 150, 0.28)",
  },
  sage: {
    bg: "rgba(120, 145, 110, 0.05)",
    pillBg: "rgba(120, 145, 110, 0.16)",
    ink: "#5e7456",
    border: "rgba(120, 145, 110, 0.28)",
  },
  terracotta: {
    bg: "rgba(180, 110, 90, 0.05)",
    pillBg: "rgba(180, 110, 90, 0.16)",
    ink: "#8a4f3d",
    border: "rgba(180, 110, 90, 0.28)",
  },
};

const SECTIONS: TipSection[] = [
  {
    tone: "amber",
    eyebrow: "Lighting",
    title: "Light the room before you shoot",
    blurb:
      "Even good phone cameras struggle in dim rooms. Two minutes of prep lifts every photo.",
    bullets: [
      {
        strong: "Turn every light on.",
        rest: "Ceiling lights, lamps, even the cooker hood — more sources mean fewer harsh shadows.",
      },
      {
        strong: "Open blinds and curtains.",
        rest: "Natural light is best, but don't shoot directly into a bright window or the room will silhouette.",
      },
      {
        strong: "Avoid mid-day sunbeams.",
        rest: "Hot patches of sun on a wall blow out the exposure. Overcast days or evenings are kinder.",
      },
    ],
  },
  {
    tone: "slate",
    eyebrow: "Camera angles",
    title: "Shoot from corners, not the centre",
    blurb:
      "Standing in the middle of a room hides the walls. Standing in the corner shows three of them.",
    bullets: [
      {
        strong: "Stand in a corner.",
        rest: "Point diagonally across the room. One shot per corner gives full coverage in four photos.",
      },
      {
        strong: "Hold the phone level.",
        rest: "Roughly chest or eye height, screen vertical. Tilted phones distort wall heights.",
      },
      {
        strong: "Use landscape orientation.",
        rest: "Wider field of view captures floor and ceiling lines in the same frame.",
      },
      {
        strong: "Tap to focus.",
        rest: "Tap a wall or door frame on the screen before you press the shutter so the picture is sharp.",
      },
    ],
  },
  {
    tone: "sage",
    eyebrow: "What to capture",
    title: "Include the things we'll need to draw",
    blurb:
      "Photos fill the gaps the measurements can't show. The more context, the fewer follow-up questions.",
    bullets: [
      {
        strong: "All four walls in full.",
        rest: "Floor to ceiling, corner to corner. Don't crop the skirting or the cornice off.",
      },
      // Sockets, ceilings and photographing doors both open and closed
      // were all cut on the architect's instruction: he can read swing
      // direction from the hinges, ceilings rarely change what he draws,
      // and socket positions are not something he works from. Every
      // extra instruction here is another thing a customer has to do
      // before they can finish, and the list was asking for work that
      // was never used.
      {
        strong: "Doors and windows.",
        rest: "One clear shot of each is plenty — we can read the swing direction from the hinges.",
      },
      {
        strong: "Awkward bits.",
        rest: "Niches, columns, alcoves, boxed-in pipes, step-ups in floor level. The weirder, the better.",
      },
    ],
  },
  {
    tone: "terracotta",
    eyebrow: "Avoid",
    title: "Common photo mistakes",
    blurb:
      "These are the ones that cost us the most time and force us to ask for re-shoots.",
    bullets: [
      {
        strong: "Blurry or motion-blurred shots.",
        rest: "Brace your phone against a doorframe if the room is dark. Burst mode is your friend.",
      },
      {
        strong: "Cropped features.",
        rest: "Half a window, the top of a radiator missing, a door with no frame visible.",
      },
      {
        strong: "Backlit silhouettes.",
        rest: "Shooting straight into a bright window with the rest of the room in shadow.",
      },
      {
        strong: "Portrait-only.",
        rest: "If you must shoot vertically, follow up with a landscape shot of the same view.",
      },
      {
        strong: "Photos through doorways.",
        rest: "Step into the room. Photos taken from the threshold lose the wall behind you.",
      },
    ],
  },
];

export default function PhotoTipsPage() {
  return (
    <div className="min-h-screen bg-surface pb-20">
      {/* Brand header — same lockup as AppHome but with a back chevron
          so customers can return without getting stuck. */}
      <header className="border-b border-primary/20 bg-surface/95 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-3xl items-center justify-between px-4 md:px-6">
          <div className="flex items-center gap-3">
            <BrandMark size={36} />
            <div>
              <p className="font-label text-sm font-bold uppercase tracking-[0.25em] text-primary">
                TM Designs Ltd
              </p>
              <h1 className="font-headline text-base font-semibold text-on-surface">
                Photo tips
              </h1>
            </div>
          </div>
          <Link
            href="/"
            className="inline-flex items-center gap-1 text-sm font-bold uppercase tracking-widest text-on-surface-variant hover:text-primary"
          >
            <span
              className="material-symbols-outlined"
              style={{ fontSize: "14px" }}
              aria-hidden
            >
              arrow_back
            </span>
            Home
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 pt-8 md:px-6 md:pt-12">
        {/* ── Hero ─────────────────────────────────────────────── */}
        <section
          className="relative isolate"
          style={{
            backgroundImage:
              "radial-gradient(80% 60% at 0% 0%, rgba(184, 150, 80, 0.07) 0%, rgba(184, 150, 80, 0) 70%)",
            borderRadius: "24px",
            padding: "8px 4px 0",
          }}
        >
          <div className="px-1 pt-3 pb-2">
            <p className="font-label text-sm font-bold uppercase tracking-[0.25em] text-primary">
              Take great room photos
            </p>
            <h2
              className="font-headline mt-2 text-on-surface"
              style={{
                fontSize: "clamp(1.7rem, 5.5vw, 2.4rem)",
                lineHeight: 1.1,
                letterSpacing: "-0.02em",
              }}
            >
              A few small habits make a huge difference
            </h2>
            <p className="mt-3 max-w-prose text-sm leading-relaxed text-on-surface-variant md:text-base">
              Photos fill the gaps that measurements alone can&apos;t cover —
              they show our team how the space actually feels and stops us from
              sending you back for re-shoots. Five minutes of prep gets you
              there.
            </p>
          </div>
        </section>

        {/* ── Tip sections ─────────────────────────────────────── */}
        <div className="mt-8 space-y-4">
          {SECTIONS.map((s) => {
            const tone = TONE[s.tone];
            return (
              <section
                key={s.eyebrow}
                className="rounded-2xl border p-5 md:p-6"
                style={{
                  backgroundColor: tone.bg,
                  borderColor: tone.border,
                }}
              >
                <div className="flex items-center gap-3">
                  <span
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                    style={{ backgroundColor: tone.pillBg, color: tone.ink }}
                  >
                    <SectionIcon tone={s.tone} />
                  </span>
                  <p
                    className="font-label text-sm font-bold uppercase tracking-[0.25em]"
                    style={{ color: tone.ink }}
                  >
                    {s.eyebrow}
                  </p>
                </div>
                <h3 className="font-headline mt-3 text-lg font-semibold text-on-surface md:text-xl">
                  {s.title}
                </h3>
                <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-on-surface-variant">
                  {s.blurb}
                </p>
                <ul className="mt-4 space-y-2.5">
                  {s.bullets.map((b) => (
                    <li
                      key={b.strong}
                      className="flex gap-2.5 text-sm leading-relaxed text-on-surface-variant"
                    >
                      <span
                        aria-hidden
                        className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: tone.ink }}
                      />
                      <span>
                        <strong className="font-semibold text-on-surface">
                          {b.strong}
                        </strong>{" "}
                        {b.rest}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>

        {/* ── CTA back to measure flow ─────────────────────────── */}
        <section className="mt-10">
          <div className="rounded-2xl border border-primary/40 bg-primary/5 p-5 md:flex md:items-center md:justify-between md:p-6">
            <div>
              <p className="font-label text-sm font-bold uppercase tracking-[0.25em] text-primary">
                Ready to start?
              </p>
              <p className="mt-1 max-w-prose text-sm leading-relaxed text-on-surface-variant md:text-base">
                Pick a project type and we&apos;ll prompt you for the right
                photos as you go.
              </p>
            </div>
            <Link
              href="/"
              className="mt-4 inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-on-primary transition-colors hover:bg-surface-tint md:mt-0"
            >
              Start a measurement
              <span
                className="material-symbols-outlined"
                style={{ fontSize: "16px" }}
                aria-hidden
              >
                arrow_forward
              </span>
            </Link>
          </div>
        </section>

        <p className="mt-12 text-center text-sm uppercase tracking-widest text-on-surface-variant">
          © {new Date().getFullYear()} TM Architectural Designs Ltd · UK wide
        </p>
      </main>
    </div>
  );
}

/**
 * Per-tone icon — kept local so each section gets a glyph matched
 * to its meaning without pulling in a Material font weight just for
 * four icons.
 */
function SectionIcon({ tone }: { tone: TipSection["tone"] }) {
  switch (tone) {
    case "amber":
      // Sun
      return (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      );
    case "slate":
      // Camera
      return (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M3 8h3l2-3h8l2 3h3v11H3z" />
          <circle cx="12" cy="13" r="3.5" />
        </svg>
      );
    case "sage":
      // Checklist
      return (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5 4h11a2 2 0 0 1 2 2v14H5z" />
          <path d="M9 9l2 2 4-4" />
          <path d="M9 15h6" />
        </svg>
      );
    case "terracotta":
      // Warning triangle
      return (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 3l10 17H2z" />
          <path d="M12 10v5" />
          <circle cx="12" cy="18" r="0.6" fill="currentColor" />
        </svg>
      );
  }
}
