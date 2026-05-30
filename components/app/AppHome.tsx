"use client";

/**
 * components/app/AppHome.tsx
 *
 * Home screen rendered inside the Capacitor app shell (iOS / Android).
 * Distinct from the marketing landing at tmdesignsltd.com — same brand
 * (logo wordmark, gold/cream/dark palette) but a UI tuned for someone
 * who already has the app installed and wants to start a measurement.
 *
 * Layout
 * ──────────────────────────────────────────────────────────────────
 *  1. Brand header — wordmark + small tagline.
 *  2. Hero — greeting + project-type tile grid (Extension, Loft,
 *     New build, Renovation, Garage, Other). Tapping a tile routes
 *     to /measure?type=<key> so the form can pre-fill the project
 *     type without an extra step.
 *  3. How it works — three condensed cards (Capture → Review → Send).
 *  4. Recent submissions — empty state for new users; reverse-chrono
 *     list for returning users, sourced from localStorage.
 *
 * The entire component is a client component because the recent-
 * submissions list and the dynamic year stamp both need browser APIs.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import BrandMark from "@/components/app/BrandMark";
import {
  getRecentSubmissions,
  projectTypeLabel,
  type ProjectType,
  type RecentSubmission,
} from "@/lib/recentSubmissions";

type Tile = {
  type: ProjectType;
  title: string;
  blurb: string;
  /** Inline SVG kept tiny so the tile stays compact and the icon
   *  inherits its colour from the wrapping span via currentColor. */
  icon: React.ReactNode;
  /** Subtle accent applied to the icon-pill background and (at very low
   *  opacity) the tile background. Hand-picked to sit close to the
   *  cream/gold palette — never pure red/blue, always a desaturated
   *  earth/architectural tone so the home still reads on-brand. */
  tint: { bg: string; pillBg: string; iconColor: string };
};

const TILES: Tile[] = [
  {
    type: "extension",
    title: "Extension",
    blurb: "Single or double storey, side or rear",
    // Brand gold — the anchor tile, stays on-brand.
    tint: {
      bg: "rgba(184, 150, 80, 0.04)",
      pillBg: "rgba(184, 150, 80, 0.14)",
      iconColor: "#8a6f3a",
    },
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />
        <path d="M14 9h6" />
        <path d="M17 6v6" />
      </svg>
    ),
  },
  {
    type: "loft",
    title: "Loft conversion",
    blurb: "Dormer, hip-to-gable, mansard or rooflight",
    // Slate blue — sky/roof line.
    tint: {
      bg: "rgba(110, 130, 150, 0.05)",
      pillBg: "rgba(110, 130, 150, 0.16)",
      iconColor: "#5a6a80",
    },
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M2 12L12 4l10 8" />
        <path d="M5 11v9h14v-9" />
        <rect x="10" y="13" width="4" height="4" />
      </svg>
    ),
  },
  {
    type: "newbuild",
    title: "New build",
    blurb: "Self-build or replacement dwelling",
    // Sage — fresh foundations.
    tint: {
      bg: "rgba(120, 145, 110, 0.05)",
      pillBg: "rgba(120, 145, 110, 0.16)",
      iconColor: "#5e7456",
    },
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M4 21V8l8-5 8 5v13" />
        <path d="M4 14h16" />
        <path d="M9 21v-7h6v7" />
      </svg>
    ),
  },
  {
    type: "renovation",
    title: "Renovation",
    blurb: "Internal layout changes, refurb, full re-fit",
    // Terracotta — warm refurb palette.
    tint: {
      bg: "rgba(180, 110, 90, 0.05)",
      pillBg: "rgba(180, 110, 90, 0.15)",
      iconColor: "#8a4f3d",
    },
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M3 21V8l9-5 9 5v13" />
        <path d="M9 21v-6h6v6" />
        <path d="M14 11l3 3" />
        <path d="M16 9l4 4" />
      </svg>
    ),
  },
  {
    type: "garage",
    title: "Garage conversion",
    blurb: "Garage to habitable room or annexe",
    // Stone taupe — concrete/structural.
    tint: {
      bg: "rgba(140, 125, 110, 0.05)",
      pillBg: "rgba(140, 125, 110, 0.16)",
      iconColor: "#6f5e4d",
    },
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M3 11l9-7 9 7v9H3z" />
        <path d="M6 14h12" />
        <path d="M6 17h12" />
      </svg>
    ),
  },
  {
    type: "other",
    title: "Not sure yet",
    blurb: "Pick the type later — start measuring now",
    // Neutral — undecided.
    tint: {
      bg: "rgba(120, 115, 105, 0.04)",
      pillBg: "rgba(120, 115, 105, 0.13)",
      iconColor: "#615b53",
    },
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="12" cy="12" r="9" />
        <path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7" />
        <circle cx="12" cy="17" r="0.6" fill="currentColor" />
      </svg>
    ),
  },
];


export default function AppHome() {
  const [recents, setRecents] = useState<RecentSubmission[]>([]);
  // Year stamp pinned to 2025 — the company's incorporation year.
  // Was previously dynamic (`new Date().getFullYear()`), which
  // surfaced "2026" on devices with skewed clocks.
  const [year, setYear] = useState<number>(2025);
  /** Cached focal-length calibration, surfaced as a small at-a-glance
   *  badge so testers can spot a stale/implausible value. */
  const [calib, setCalib] = useState<{ focalPx: number; savedAt: number } | null>(null);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setRecents(getRecentSubmissions());
    setYear(new Date().getFullYear());
    try {
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k && k.startsWith("tm.calib.")) {
          const raw = window.localStorage.getItem(k);
          if (raw) setCalib(JSON.parse(raw));
          break;
        }
      }
    } catch {
      /* noop */
    }
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  return (
    <div className="min-h-screen bg-surface pb-20">
      {/* Brand header — slimmer than the marketing nav, no menu links.
          Logo mark + wordmark on the left, tiny outbound link on the
          right. The hairline gold rule under the header echoes the
          brand colour without being shouty. */}
      <header className="border-b border-primary/20 bg-surface/95 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-3xl items-center justify-between px-4 md:px-6">
          <div className="flex items-center gap-3">
            <BrandMark size={36} />
            <div>
              <p className="font-label text-[10px] font-bold uppercase tracking-[0.25em] text-primary">
                TM Designs Ltd
              </p>
              <h1 className="font-headline text-base font-semibold text-on-surface">
                Measure
              </h1>
            </div>
          </div>
          <a
            href="https://tmdesignsltd.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant hover:text-primary"
          >
            tmdesignsltd.com
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 pt-8 md:px-6 md:pt-12">
        {/* ── Hero ───────────────────────────────────────────────
            Soft warm wash sits behind the hero copy and tile grid —
            a low-opacity gold radial that fades into the surface so
            the home feels warmer without saturating the brand. */}
        <section
          className="relative isolate"
          style={{
            backgroundImage:
              "radial-gradient(80% 60% at 0% 0%, rgba(184, 150, 80, 0.07) 0%, rgba(184, 150, 80, 0) 70%)",
            borderRadius: "24px",
            padding: "8px 4px 0",
          }}
        >
          <p className="font-label text-[10px] font-bold uppercase tracking-[0.25em] text-primary">
            Self-measure your project
          </p>
          <h2
            className="font-headline mt-2 text-on-surface"
            style={{
              fontSize: "clamp(1.85rem, 6vw, 2.6rem)",
              lineHeight: 1.1,
              letterSpacing: "-0.02em",
            }}
          >
            What are you building?
          </h2>
          <p className="mt-3 max-w-prose text-sm leading-relaxed text-on-surface-variant md:text-base">
            Pick the type below to start. We&apos;ll guide you through walls,
            doors, windows and a quick floor plan — usually 10–15 minutes per
            room. One reference photo per room, then it&apos;s in our hands.
          </p>

          {/* Discreet link to the photo-tips page. Sits just below the
              hero copy so it's findable for first-time users without
              competing with the main tile-grid CTA. */}
          <p className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
            <Link
              href="/photo-tips"
              className="inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-widest text-primary hover:underline"
            >
              <span
                className="material-symbols-outlined"
                style={{ fontSize: "14px" }}
                aria-hidden
              >
                photo_camera
              </span>
              How to take great room photos
            </Link>
            {/* Architect console — internal-use review page. Same app
                shell on purpose so Harry can open it on any device with
                the deployed URL; no login (URL-secret only). */}
            <Link
              href="/architect"
              className="inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-widest text-primary hover:underline"
            >
              <span
                className="material-symbols-outlined"
                style={{ fontSize: "14px" }}
                aria-hidden
              >
                fact_check
              </span>
              Architect console
            </Link>
            <Link
              href="/status"
              className="inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-widest text-primary hover:underline"
            >
              <span
                className="material-symbols-outlined"
                style={{ fontSize: "14px" }}
                aria-hidden
              >
                fact_check_outlined
              </span>
              Project status
            </Link>
            <Link
              href="/privacy"
              className="inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-widest text-primary hover:underline"
            >
              <span
                className="material-symbols-outlined"
                style={{ fontSize: "14px" }}
                aria-hidden
              >
                shield
              </span>
              Privacy
            </Link>
            <button
              type="button"
              onClick={() => {
                if (typeof window === "undefined") return;
                // Wipe every per-device calibration we've cached. The
                // tm.calib.<hash> keys are scoped to the user-agent, so
                // we sweep anything matching that prefix in one go.
                const ks: string[] = [];
                for (let i = 0; i < window.localStorage.length; i++) {
                  const k = window.localStorage.key(i);
                  if (k && k.startsWith("tm.calib.")) ks.push(k);
                }
                ks.forEach((k) => window.localStorage.removeItem(k));
                alert(
                  ks.length
                    ? "Stored camera calibration cleared. The next scan will re-calibrate."
                    : "No stored calibration to clear.",
                );
              }}
              className="inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-widest text-primary hover:underline"
              title="Wipes a stale calibration that may be making rooms read tiny or huge"
            >
              <span
                className="material-symbols-outlined"
                style={{ fontSize: "14px" }}
                aria-hidden
              >
                restart_alt
              </span>
              Reset calibration
            </button>
          </p>

          {/* Tile grid — each tile keeps the cream surface base but
              adds a hairline of its own architectural-tone tint on
              the icon pill and a barely-there body wash. The hover
              state still lifts to gold for brand cohesion. */}
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {TILES.map((t) => (
              <Link
                key={t.type}
                href={`/measure?type=${t.type}`}
                className="group flex items-start gap-3 rounded-xl border border-outline-variant/30 p-4 transition-colors hover:border-primary hover:bg-surface-container-high"
                style={{ backgroundColor: t.tint.bg }}
              >
                <span
                  className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                  style={{
                    backgroundColor: t.tint.pillBg,
                    color: t.tint.iconColor,
                  }}
                >
                  {t.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-headline text-sm font-semibold text-on-surface">
                    {t.title}
                  </span>
                  <span className="mt-0.5 block text-xs leading-snug text-on-surface-variant">
                    {t.blurb}
                  </span>
                </span>
                <span
                  className="material-symbols-outlined shrink-0 self-center text-on-surface-variant transition-transform group-hover:translate-x-0.5 group-hover:text-primary"
                  aria-hidden
                >
                  arrow_forward
                </span>
              </Link>
            ))}
          </div>
        </section>

        {/* ── How it works ─────────────────────────────────────── */}
        <section className="mt-12">
          <h3 className="font-label text-[10px] font-bold uppercase tracking-[0.25em] text-primary">
            How it works
          </h3>
          <ol className="mt-3 grid gap-3 sm:grid-cols-3">
            <Step
              n={1}
              title="Capture"
              text="Walk room-by-room. Use the camera scan or type wall lengths in metres."
            />
            <Step
              n={2}
              title="Review"
              text="Check measurements in metric and imperial. Add notes, photos, doors and windows."
            />
            <Step
              n={3}
              title="Send"
              text="Drag rooms onto the floor plan and submit. We reply within 2 working days."
            />
          </ol>
        </section>

        {/* ── Recent submissions ───────────────────────────────── */}
        <section className="mt-12">
          <div className="flex items-center justify-between">
            <h3 className="font-label text-[10px] font-bold uppercase tracking-[0.25em] text-primary">
              Recent submissions
            </h3>
            {recents.length > 0 && (
              <span className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant">
                {recents.length} on this device
              </span>
            )}
          </div>

          {recents.length === 0 ? (
            <div className="mt-3 rounded-xl border border-dashed border-outline-variant/40 bg-surface-container-low p-6 text-center">
              <p className="text-sm text-on-surface-variant">
                Nothing here yet. Your submissions will appear in this list once
                you send your first measurement.
              </p>
            </div>
          ) : (
            <ul className="mt-3 divide-y divide-outline-variant/20 rounded-xl border border-outline-variant/20 bg-surface-container-low">
              {recents.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center justify-between gap-4 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate font-headline text-sm font-semibold text-on-surface">
                      {r.projectName || "(untitled project)"}
                    </p>
                    <p className="mt-0.5 text-xs text-on-surface-variant">
                      {projectTypeLabel(r.projectType)} ·{" "}
                      {r.roomCount} room{r.roomCount === 1 ? "" : "s"} ·{" "}
                      {formatRelative(r.submittedAt)}
                      {r.remoteId ? ` · #${r.remoteId}` : ""}
                    </p>
                  </div>
                  <span
                    className="material-symbols-outlined shrink-0 text-on-surface-variant"
                    aria-hidden
                  >
                    check_circle
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {calib && (
          <p className="mt-8 text-center text-[10px] uppercase tracking-widest text-on-surface-variant">
            Camera calibrated · <span className="font-mono text-primary">{Math.round(calib.focalPx)} px</span> ·{" "}
            {Math.max(1, Math.round((Date.now() - calib.savedAt) / 86400000))} d ago
          </p>
        )}
        <p className="mt-12 text-center text-[10px] uppercase tracking-widest text-on-surface-variant">
          © {year} TM Architectural Designs Ltd · UK wide
        </p>
      </main>
    </div>
  );
}

function Step({ n, title, text }: { n: number; title: string; text: string }) {
  return (
    <li className="rounded-xl border border-outline-variant/20 bg-surface-container-low p-4">
      <span className="font-label text-[10px] font-bold uppercase tracking-widest text-primary">
        Step {n}
      </span>
      <p className="font-headline mt-1 text-sm font-semibold text-on-surface">
        {title}
      </p>
      <p className="mt-1 text-xs leading-snug text-on-surface-variant">{text}</p>
    </li>
  );
}

/**
 * "3 hours ago" / "yesterday" / "12 Apr" — purely cosmetic, kept inline
 * to avoid pulling in date-fns for one helper.
 */
function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diffMs = Date.now() - then;
  const min = Math.round(diffMs / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.round(hr / 24);
  if (day === 1) return "yesterday";
  if (day < 7) return `${day} days ago`;
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
}
