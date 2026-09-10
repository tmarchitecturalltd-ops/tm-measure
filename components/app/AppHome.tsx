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
 *  3. Recent submissions — empty state for new users; reverse-chrono
 *     list for returning users, sourced from localStorage.
 *
 * The entire component is a client component because the recent-
 * submissions list and the dynamic year stamp both need browser APIs.
 */

import { useEffect, useState } from "react";
import AppLogo from "@/components/app/AppLogo";
import AppButton from "@/components/app/AppButton";
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
  type RecentSubmission,
} from "@/lib/recentSubmissions";

/*
 * The TILES array used to live here -- Extension, Loft conversion and
 * Not sure yet, each with its own icon and tint.
 *
 * All three linked to the same place and produced the same survey. The
 * choice set one word in the notification email and changed nothing
 * the app then did, so it was three decisions on the first screen in
 * exchange for something the project step asks anyway. ProjectType
 * still defines all six values so older drafts and past submissions
 * keep their labels.
 */

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
      /*
       * Once per app launch, not once per device.
       *
       * It used to be a localStorage flag set forever on first
       * dismissal, so the welcome was seen once and never again — and
       * it replaced the home screen rather than sitting over it.
       * sessionStorage clears on a cold start, which is exactly "when
       * you open the app", and a returning customer gets a two-second
       * reminder of what this is for rather than nothing.
       */
      setShowWelcome(window.sessionStorage.getItem(WELCOME_SEEN_KEY) !== "1");
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

  /**
   * The "More" list.
   *
   * Each row gets a line of description, which the old pills had no
   * room for -- "Status" and "Architect" sat next to each other with
   * nothing to say that one is for the customer and the other is not.
   *
   * The architect console is still here and still shouldn't be. It is
   * staff-only behind a shared secret, and listing it to homeowners
   * invites them to try. Left in place for now because Charlie and
   * Fabian reach it this way; it wants moving somewhere customers do
   * not see before this goes to the App Store.
   */
  const moreItems: {
    label: string;
    blurb: string;
    icon: string;
    /**
     * Which group the row sits under.
     *
     * One flat run of six rows made "Privacy" and "Architect console"
     * look like the same kind of thing as "Photo tips", so a customer
     * looking for help had to read all six to find the two that were
     * for them. Grouped, the first heading is the only one most people
     * ever need to read.
     */
    group: "Help" | "Your project" | "TM Designs";
    href?: string;
    onClick?: () => void;
  }[] = [
    {
      label: "How it works",
      blurb: "",
      icon: "help",
      group: "Help",
      onClick: () => setShowWelcome(true),
    },
    {
      label: "Photo tips",
      blurb: "",
      icon: "photo_camera",
      group: "Help",
      href: "/photo-tips",
    },
    {
      label: "Project status",
      blurb: "",
      icon: "fact_check",
      group: "Your project",
      href: "/status",
    },
    {
      label: "Privacy",
      blurb: "",
      icon: "shield",
      group: "Your project",
      href: "/privacy",
    },
    {
      label: "Architect console",
      blurb: "TM Designs staff only",
      icon: "architecture",
      group: "TM Designs",
      href: "/architect",
    },
    ...(calib && process.env.NEXT_PUBLIC_ENABLE_SCAN === "1"
      ? [
          {
            label: "Reset calibration",
            blurb: "",
            icon: "restart_alt",
            group: "TM Designs" as const,
            onClick: () => {
              if (typeof window === "undefined") return;
              const ks: string[] = [];
              for (let i = 0; i < window.localStorage.length; i++) {
                const k = window.localStorage.key(i);
                if (k && k.startsWith("tm.calib.")) ks.push(k);
              }
              ks.forEach((k) => window.localStorage.removeItem(k));
              setCalib(null);
              alert(
                ks.length
                  ? "Stored camera calibration cleared. The next scan will re-calibrate."
                  : "No stored calibration to clear.",
              );
            },
          },
        ]
      : []),
  ];

  const dismissWelcome = () => {
    try {
      window.sessionStorage.setItem(WELCOME_SEEN_KEY, "1");
    } catch {
      /* noop — dismissal still applies for this session */
    }
    setShowWelcome(false);
  };

  // Hold the first paint until we know whether the welcome is due, so
  // it does not flash in and straight back out during hydration.
  if (showWelcome === null) return null;

  // The page is exactly the viewport and does not scroll.
  //
  // min-h-screen plus padding kept leaving a little slack, and a home
  // screen that drifts a few pixels reads as broken rather than as
  // long. It is now a fixed-height column: header, a middle band that
  // scrolls only if it genuinely has to, and More pinned underneath.
  // 100dvh rather than 100vh so the iOS address bar does not push the
  // footer off the bottom.
  //
  // overscroll-none kills the rubber band as well. On iOS a page that
  // fits still drags away from the top and springs back, which looks
  // exactly like a screen with something above it that failed to
  // arrive -- and there is nothing up there to find.
  return (
    <div className="flex h-[100dvh] flex-col overscroll-none bg-surface">
      {/* Brand header — slimmer than the marketing nav, no menu links.
          Logo mark + wordmark on the left, tiny outbound link on the
          right. The hairline gold rule under the header echoes the
          brand colour without being shouty. */}
      {/* Over the home screen rather than instead of it, so the tiles
          are already there behind and dismissing lands on them. */}
      {showWelcome && <WelcomeScreen onGetStarted={dismissWelcome} />}

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

      <main className="mx-auto w-full min-h-0 max-w-3xl flex-1 overflow-y-auto px-4 pt-4 md:px-6 md:pt-6">
        {/* ── Continue where you left off ────────────────────────
            First, above the tiles, and only when there is something to
            continue.

            A customer with a half-finished survey opened this app for
            exactly one reason, and it was underneath the question
            "What are you building?" -- which they had already answered.
            Being asked it again reads as the app having forgotten,
            which is the impression a form that saves as you go can
            least afford to give. */}
        {draft && (
          <section>
            {/* Two rows, not five.
                This was a label, the project name, the room count and
                a "Resume →" line, in a card with 20px of padding --
                five rows to say "you left something half done". The
                whole card was already a link, so the Resume row was
                telling the customer they could do the thing they were
                already about to do by tapping it. */}
            <AppButton
              variant="secondary"
              href="/measure"
              eyebrow="Continue where you left off"
              label={draft.projectName?.trim() || "Untitled project"}
              detail={`${draft.rooms?.length ?? 0} room${
                (draft.rooms?.length ?? 0) === 1 ? "" : "s"
              } · saved ${formatSavedAt(draft.savedAt)}`}
            />
          </section>
        )}


        {/* ── Hero ───────────────────────────────────────────────
            Soft warm wash sits behind the hero copy and tile grid —
            a low-opacity gold radial that fades into the surface so
            the home feels warmer without saturating the brand. */}
        <section
          className={`tm-fade-up relative isolate ${draft ? "mt-6" : ""}`}
          style={{
            backgroundImage:
              "radial-gradient(80% 60% at 0% 0%, rgba(184, 150, 80, 0.09) 0%, rgba(184, 150, 80, 0) 70%)",
            borderRadius: "24px",
            padding: "8px 4px 0",
          }}
        >
          {/* "Self-measure your project" and "What are you building?"
              used to sit here, above a paragraph, above the button.

              The heading asked a question the screen no longer offers
              an answer to -- the three tiles that answered it are gone,
              and the project step asks the same thing properly. So it
              was a large question followed by a single button that did
              not appear to answer it. The button says what it does. */}

          {/* One button, not three tiles.
              Extension / Loft / Not sure yet went to the same place and
              produced the same survey -- the answer was one word in the
              notification email and nothing in the app behaved
              differently. So it was three decisions on the first screen,
              before anyone had learned what the app does, to collect
              something we ask again inside the flow anyway.

              The type question still exists on the project step, where
              it is one tap among questions the customer is already
              answering rather than a toll gate in front of them. */}
          <AppButton
            variant="primary"
            href="/measure"
            label="Start a project"
            trailingIcon="arrow_forward"
            className="tm-fade-up-late"
          />
        </section>

        {/* The "How it works" cards used to sit here.
            They are now a single screen shown once, at the moment the
            customer starts a project -- which is the only moment the
            information is wanted. On the home screen they were three
            cards between the tiles and the resume card, read by nobody
            and pushing the thing a returning customer came back for
            further down the page. The "How it works" button in the
            footer still opens the welcome screen for anyone who wants
            a reminder. */}

        {/* ── Recent submissions ─────────────────────────────────
            Hidden entirely when there is nothing in it.

            The empty state was a dashed box the height of a phone
            screen: an illustration, a paragraph explaining that
            submissions appear here once you send one, and a second
            "Start your first measurement" button duplicating the one
            directly above it. All of that to tell a first-time
            customer that a list they have never used is empty -- and
            it pushed everything else off the screen.

            Three at most. Someone who wants the fourth is looking for
            a submission ID, and that is what Project status is for. */}
        {recents.length > 0 && (
          <section className="mt-8">
            <h3 className="font-label text-sm font-bold uppercase tracking-[0.25em] text-primary">
              Recent submissions
            </h3>
            <ul className="mt-2">
              {recents.slice(0, 3).map((r, i) => (
                <li
                  key={r.id}
                  className={`flex items-center justify-between gap-3 py-2.5 ${
                    i > 0 ? "border-t border-outline-variant/25" : ""
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-headline text-sm font-semibold text-on-surface">
                      {r.projectName || "(untitled project)"}
                    </span>
                    <span className="mt-0.5 block truncate text-sm text-on-surface-variant">
                      {r.roomCount} room{r.roomCount === 1 ? "" : "s"} ·{" "}
                      {formatRelative(r.submittedAt)}
                      {r.remoteId ? ` · #${r.remoteId}` : ""}
                    </span>
                  </span>
                  <span
                    className="material-symbols-outlined shrink-0 text-primary"
                    style={{ fontSize: "18px" }}
                    aria-hidden
                  >
                    check
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Calibration used to be stated here as its own line. It is
            a developer's number on a customer's home screen, and the
            one action attached to it -- resetting it -- is in More.

            The copyright line used to be here too, above the More
            list, which put the end of the page in the middle of it. It
            is now the last thing on the screen, which is where a
            footer goes. */}
      </main>

      {/* ── More ─────────────────────────────────────────────────────
          An index, not a menu of suggestions.

          This started as six rounded chips wrapping across the bottom
          of the screen -- the shape a chat assistant uses to offer
          prompts, and it read as one: a scatter of things to try. The
          first fix made them full-width rows, which was better and
          still wrong, because each row had a gold circle with an icon
          in it and a card around the lot. Coloured bubbles in a
          rounded card is the same visual language.

          Now it is set like the contents page of a drawing pack:
          small caps, hairline rules, no card, no icons, a thin chevron
          to say it goes somewhere. Nothing decorative -- the section
          is a reference list and should look like one.

          They stay at the bottom, below the tiles and the recent list,
          for the same reason as before: all of it is wanted
          occasionally and none of it first. */}
      <nav className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-3 pt-0 md:px-6">
        <div className="border-t border-outline-variant/30 pt-4">
          <p className="mb-3 text-sm font-bold uppercase tracking-widest text-on-surface-variant">
            More
          </p>
          {(["Help", "Your project", "TM Designs"] as const)
            .map((group) => ({
              group,
              items: moreItems.filter((it) => it.group === group),
            }))
            .filter((sec) => sec.items.length > 0)
            .map((sec, si) => (
              <div key={sec.group} className={si > 0 ? "mt-4" : ""}>
                <p className="mb-1 text-sm font-bold uppercase tracking-[0.18em] text-on-surface-variant/70">
                  {sec.group}
                </p>
          <ul>
            {/* The same control as the two above, at its quietest.
                The rows kept their own layout -- baseline-aligned,
                56px, an 18px chevron, small caps at a different
                tracking from everything else -- which is four ways of
                being not-quite the buttons further up the page. They
                are the same kind of thing and are now built by the
                same component; only the fill differs. */}
            {sec.items.map((item, i) => (
              <li
                key={item.label}
                className={i > 0 ? "border-t border-outline-variant/25" : ""}
              >
                <AppButton
                  variant="quiet"
                  label={item.label}
                  detail={item.blurb || undefined}
                  href={item.href}
                  onClick={item.onClick}
                  className="!px-0"
                />
              </li>
            ))}
          </ul>
              </div>
            ))}
          <p className="mt-5 text-center text-sm uppercase tracking-widest text-on-surface-variant/70">
            © {year} TM Architectural Designs Ltd · UK wide
          </p>
        </div>
      </nav>
    </div>
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
