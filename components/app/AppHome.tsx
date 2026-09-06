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
import AppLogo from "@/components/app/AppLogo";
import WelcomeScreen, { WELCOME_SEEN_KEY } from "@/components/app/WelcomeScreen";
import { loadDraft, type ProjectDraftSnapshot } from "@/lib/draftStorage";

/** "3 min ago" / "yesterday" style stamp for the resume card. */
function formatSavedAt(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "recently";
  const mins = Math.floor((Date.now() - then) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}
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

/**
 * Three tiles, down from six.
 *
 * The type a customer picks changes nothing about what the app then
 * asks — it is one word in the notification email. Six choices on the
 * first screen is six decisions before anyone has learned what the app
 * does, in exchange for information we could get by replying to them.
 *
 * New build, renovation and garage conversions land under "Something
 * else"; the project name and the photographs describe those better
 * than a category does. ProjectType still defines all six so older
 * drafts and past submissions keep their labels.
 */
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
  /** Tri-state: null until localStorage has been read on the client, so
   *  we never flash the wrong screen during hydration. */
  const [showWelcome, setShowWelcome] = useState<boolean | null>(null);
  /** In-flight survey, if any — powers the resume card. */
  const [draft, setDraft] = useState<ProjectDraftSnapshot | null>(null);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setRecents(getRecentSubmissions());
    setYear(new Date().getFullYear());
    setDraft(loadDraft());
    try {
      setShowWelcome(window.localStorage.getItem(WELCOME_SEEN_KEY) !== "1");
    } catch {
      // Private mode / storage disabled — show the home screen rather
      // than trapping the user on the welcome mat every launch.
      setShowWelcome(false);
    }
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

  const dismissWelcome = () => {
    try {
      window.localStorage.setItem(WELCOME_SEEN_KEY, "1");
    } catch {
      /* noop — dismissal still applies for this session */
    }
    setShowWelcome(false);
  };

  // Hold the first paint until we know which screen to show, avoiding a
  // flash of the home screen for brand-new installs.
  if (showWelcome === null) return null;
  if (showWelcome) return <WelcomeScreen onGetStarted={dismissWelcome} />;

  return (
    <div className="min-h-screen bg-surface pb-20">
      {/* Brand header — slimmer than the marketing nav, no menu links.
          Logo mark + wordmark on the left, tiny outbound link on the
          right. The hairline gold rule under the header echoes the
          brand colour without being shouty. */}
      <header className="sticky top-0 z-40 border-b border-primary/25 bg-surface/90 shadow-[0_1px_0_rgba(184,150,80,0.08),0_8px_24px_-18px_rgba(28,28,26,0.25)] backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-3xl items-center justify-between px-4 md:px-6">
          <div className="flex items-center gap-3">
            <AppLogo size={36} className="text-primary" />
            <div>
              <p className="font-label text-sm font-bold uppercase tracking-[0.25em] text-primary">
                TM Designs Ltd
              </p>
              <h1 className="font-headline text-base font-semibold text-on-surface">
                Measure
              </h1>
            </div>
          </div>
          {/* The tmdesignsltd.com link lived here and is gone.
              Someone who has opened the app has already chosen us; a
              link out to the marketing site at the top of every screen
              only offers them a way to stop measuring and start reading
              about extensions. There is nothing on the website a
              customer part-way through a survey needs. */}
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 pt-8 md:px-6 md:pt-12">
        {/* ── Hero ───────────────────────────────────────────────
            Soft warm wash sits behind the hero copy and tile grid —
            a low-opacity gold radial that fades into the surface so
            the home feels warmer without saturating the brand. */}
        <section
          className="tm-fade-up relative isolate"
          style={{
            backgroundImage:
              "radial-gradient(80% 60% at 0% 0%, rgba(184, 150, 80, 0.09) 0%, rgba(184, 150, 80, 0) 70%)",
            borderRadius: "24px",
            padding: "8px 4px 0",
          }}
        >
          <p className="font-label text-sm font-bold uppercase tracking-[0.25em] text-primary">
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
            doors, windows and a quick floor plan — usually around 15 minutes
            per room. One reference photo per room, then it&apos;s in our hands.
          </p>

          {/* Tile grid — each tile keeps the cream surface base but
              adds a hairline of its own architectural-tone tint on
              the icon pill and a barely-there body wash. The hover
              state still lifts to gold for brand cohesion. */}
          <div className="tm-fade-up-late mt-6 grid gap-3 sm:grid-cols-2">
            {TILES.map((t) => (
              <Link
                key={t.type}
                href={`/measure?type=${t.type}`}
                className="tm-lift group flex items-start gap-3.5 rounded-2xl border border-outline-variant/40 p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/70 hover:shadow-lg hover:shadow-primary/10 active:translate-y-0 active:scale-[0.99]"
                style={{ backgroundColor: t.tint.bg }}
              >
                <span
                  className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-transform duration-200 group-hover:scale-105"
                  style={{
                    backgroundColor: t.tint.pillBg,
                    color: t.tint.iconColor,
                  }}
                >
                  {t.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-headline text-[15px] font-semibold leading-snug text-on-surface">
                    {t.title}
                  </span>
                  <span className="mt-1 block text-sm leading-snug text-on-surface-variant">
                    {t.blurb}
                  </span>
                </span>
                <span
                  className="material-symbols-outlined shrink-0 self-center text-on-surface-variant/60 transition-all group-hover:translate-x-0.5 group-hover:text-primary"
                  style={{ fontSize: "20px" }}
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
          <h3 className="font-label text-sm font-bold uppercase tracking-[0.25em] text-primary">
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

        {/* ── Continue where you left off ──────────────────────── */}
        {draft && (
          <section className="mt-12">
            <Link
              href="/measure"
              className="block rounded-2xl border border-primary/40 bg-primary/5 p-5 transition-colors hover:bg-primary/10"
            >
              <p className="font-label text-sm font-bold uppercase tracking-[0.25em] text-primary">
                Continue where you left off
              </p>
              <p className="mt-2 text-sm font-medium text-on-surface">
                {draft.projectName?.trim() || "Untitled project"}
              </p>
              <p className="mt-1 text-[13px] text-on-surface-variant">
                {draft.rooms?.length ?? 0} room
                {(draft.rooms?.length ?? 0) === 1 ? "" : "s"} · saved{" "}
                {formatSavedAt(draft.savedAt)}
              </p>
              <p className="mt-3 text-sm font-bold uppercase tracking-widest text-primary">
                Resume →
              </p>
            </Link>
          </section>
        )}

        {/* ── Recent submissions ───────────────────────────────── */}
        <section className="mt-12">
          <div className="flex items-center justify-between">
            <h3 className="font-label text-sm font-bold uppercase tracking-[0.25em] text-primary">
              Recent submissions
            </h3>
            {recents.length > 0 && (
              <span className="text-sm font-semibold uppercase tracking-widest text-on-surface-variant">
                {recents.length} on this device
              </span>
            )}
          </div>

          {recents.length === 0 ? (
            <div className="mt-3 rounded-2xl border border-dashed border-outline-variant/50 bg-surface-container-low p-8 text-center">
              {/* Tiny "drafted floor plan" illustration — inline SVG so it
                  inherits the brand gold via currentColor and costs no
                  network fetch. Purely decorative. */}
              <svg
                viewBox="0 0 64 48"
                width="64"
                height="48"
                className="mx-auto text-primary"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <rect x="8" y="6" width="48" height="36" rx="2" opacity="0.9" />
                <path d="M8 24h20M28 6v18M28 24v8M28 40v2" opacity="0.55" />
                <path d="M42 6v14M42 28v14" opacity="0.55" />
                <path d="M14 12h8" opacity="0.35" />
                <path d="M48 34h4" opacity="0.35" />
                <circle cx="32" cy="24" r="1.4" fill="currentColor" stroke="none" opacity="0.8" />
              </svg>
              <p className="mt-4 text-sm text-on-surface-variant">
                Nothing here yet. Your submissions will appear in this list once
                you send your first measurement.
              </p>
              <Link
                href="/measure"
                className="mt-4 inline-flex items-center gap-2 rounded-full border border-primary/50 px-5 py-2 text-sm font-bold uppercase tracking-widest text-primary transition-colors hover:bg-primary hover:text-on-primary"
              >
                Start your first measurement
                <span
                  className="material-symbols-outlined"
                  style={{ fontSize: "16px" }}
                  aria-hidden
                >
                  arrow_forward
                </span>
              </Link>
            </div>
          ) : (
            <ul className="tm-lift mt-3 divide-y divide-outline-variant/20 overflow-hidden rounded-2xl border border-outline-variant/30 bg-surface-container-lowest">
              {recents.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center justify-between gap-4 px-4 py-3.5"
                >
                  <div className="min-w-0">
                    <p className="truncate font-headline text-sm font-semibold text-on-surface">
                      {r.projectName || "(untitled project)"}
                    </p>
                    <p className="mt-0.5 text-sm text-on-surface-variant">
                      {projectTypeLabel(r.projectType)} ·{" "}
                      {r.roomCount} room{r.roomCount === 1 ? "" : "s"} ·{" "}
                      {formatRelative(r.submittedAt)}
                      {r.remoteId ? ` · #${r.remoteId}` : ""}
                    </p>
                  </div>
                  <span
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10"
                    aria-hidden
                  >
                    <span
                      className="material-symbols-outlined text-primary"
                      style={{ fontSize: "18px" }}
                    >
                      check
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {calib && process.env.NEXT_PUBLIC_ENABLE_SCAN === "1" && (
          <p className="mt-8 text-center text-sm uppercase tracking-widest text-on-surface-variant">
            Camera calibrated · <span className="font-mono text-primary">{Math.round(calib.focalPx)} px</span> ·{" "}
            {Math.max(1, Math.round((Date.now() - calib.savedAt) / 86400000))} d ago
          </p>
        )}
        <p className="mt-12 text-center text-sm uppercase tracking-widest text-on-surface-variant">
          © {year} TM Architectural Designs Ltd · UK wide
        </p>
      </main>

      {/* ── Secondary links ──────────────────────────────────────────
          These were a row of white pills directly under the hero copy,
          above the thing the screen exists for. Six of them, before any
          decision had been made, which reads as a menu of suggestions
          rather than a way in — and looks like a chat assistant rather
          than an architect's tool.

          They are all things a customer wants occasionally and nobody
          wants first, so they belong at the bottom: reachable by anyone
          looking for them, invisible to anyone who isn't. */}
      <nav className="mx-auto w-full max-w-3xl px-5 pb-10 pt-2">
        <div className="border-t border-outline-variant/30 pt-5">
          <p className="mb-3 text-sm font-bold uppercase tracking-widest text-on-surface-variant">
            More
          </p>
          <div className="flex flex-wrap gap-2">
            {/* The welcome screen tells the customer they can revisit it
                "any time from the home screen", but nothing here did
                that — the flag was set on dismissal and there was no way
                back. This is that way back. */}
            <button
              type="button"
              onClick={() => setShowWelcome(true)}
              className="inline-flex items-center gap-1.5 rounded-full border border-outline-variant/40 bg-surface-container-lowest px-3.5 py-1.5 text-sm font-bold uppercase tracking-widest text-on-surface-variant transition-colors hover:border-primary/60 hover:text-primary"
            >
              <span
                className="material-symbols-outlined text-primary"
                style={{ fontSize: "14px" }}
                aria-hidden
              >
                help
              </span>
              How it works
            </button>
            <Link
              href="/photo-tips"
              className="inline-flex items-center gap-1.5 rounded-full border border-outline-variant/40 bg-surface-container-lowest px-3.5 py-1.5 text-sm font-bold uppercase tracking-widest text-on-surface-variant transition-colors hover:border-primary/60 hover:text-primary"
            >
              <span
                className="material-symbols-outlined text-primary"
                style={{ fontSize: "14px" }}
                aria-hidden
              >
                photo_camera
              </span>
              Photo tips
            </Link>
            {/* Architect console — internal-use review page. Same app
                shell on purpose so Harry can open it on any device with
                the deployed URL; no login (URL-secret only). */}
            <Link
              href="/architect"
              className="inline-flex items-center gap-1.5 rounded-full border border-outline-variant/40 bg-surface-container-lowest px-3.5 py-1.5 text-sm font-bold uppercase tracking-widest text-on-surface-variant transition-colors hover:border-primary/60 hover:text-primary"
            >
              <span
                className="material-symbols-outlined text-primary"
                style={{ fontSize: "14px" }}
                aria-hidden
              >
                fact_check
              </span>
              Architect console
            </Link>
            <Link
              href="/status"
              className="inline-flex items-center gap-1.5 rounded-full border border-outline-variant/40 bg-surface-container-lowest px-3.5 py-1.5 text-sm font-bold uppercase tracking-widest text-on-surface-variant transition-colors hover:border-primary/60 hover:text-primary"
            >
              <span
                className="material-symbols-outlined text-primary"
                style={{ fontSize: "14px" }}
                aria-hidden
              >
                fact_check_outlined
              </span>
              Project status
            </Link>
            <Link
              href="/privacy"
              className="inline-flex items-center gap-1.5 rounded-full border border-outline-variant/40 bg-surface-container-lowest px-3.5 py-1.5 text-sm font-bold uppercase tracking-widest text-on-surface-variant transition-colors hover:border-primary/60 hover:text-primary"
            >
              <span
                className="material-symbols-outlined text-primary"
                style={{ fontSize: "14px" }}
                aria-hidden
              >
                shield
              </span>
              Privacy
            </Link>
            {process.env.NEXT_PUBLIC_ENABLE_SCAN === "1" && (
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
              className="inline-flex items-center gap-1.5 rounded-full border border-outline-variant/40 bg-surface-container-lowest px-3.5 py-1.5 text-sm font-bold uppercase tracking-widest text-on-surface-variant transition-colors hover:border-primary/60 hover:text-primary"
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
            )}
          </div>
        </div>
      </nav>
    </div>
  );
}

function Step({ n, title, text }: { n: number; title: string; text: string }) {
  return (
    <li className="tm-lift rounded-2xl border border-outline-variant/30 bg-surface-container-lowest p-4">
      <div className="flex items-center gap-2.5">
        <span
          className="font-headline flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-primary/40 bg-primary/10 text-sm font-bold text-primary"
          aria-hidden
        >
          {n}
        </span>
        <p className="font-headline text-sm font-semibold text-on-surface">
          {title}
        </p>
      </div>
      <p className="mt-2.5 text-sm leading-relaxed text-on-surface-variant">
        {text}
      </p>
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
