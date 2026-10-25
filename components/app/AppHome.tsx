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
   * The architect console used to be listed here and no longer is —
   * see the note where it was removed.
   */
  const moreItems: {
    label: string;
    blurb: string;
    icon: string;
    /**
     * Which group the row sits under.
     *
     * One flat run made "Privacy" look like the same kind of thing as
     * "Photo tips", so a customer looking for help had to read the
     * lot to find the two that were for them.
     *
     * "TM Designs" survives for Reset calibration, which only appears
     * on a scan-enabled build, so on a customer's phone there are two
     * groups.
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
    /*
     * Architect console is gone from here.
     *
     * It was always the odd one out: staff-only, behind a shared
     * secret, listed to homeowners on the front screen of their own
     * app — which is an invitation to try it. The note above this
     * list has said it wanted moving for months.
     *
     * Charlie and Fabian reach /architect in a browser now. Nothing
     * in the app links to it, deliberately.
     */
    /*
     * The ARKit trace probe has gone.
     *
     * It existed to answer one question — does ARKit give us real
     * metres — before anything was built on the assumption that it
     * does. It answered it, the tracer is now the ordinary way a
     * non-LiDAR phone measures a room, and an instrument that has
     * served its purpose is clutter on a customer's home screen.
     */
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
    <div
      className="flex flex-col overscroll-none bg-surface"
      /*
       * The viewport, less the notch, which the body has already
       * padded for.
       *
       * `h-[100dvh]` measures the whole screen. But globals.css puts
       * `padding-top: env(safe-area-inset-top)` on the body, so on a
       * notched iPhone this column started 59px down and was still a
       * full screen tall -- 59px of it below the bottom of the glass.
       * The footer went with it. The page looked like it had lost its
       * bottom margin when what it had actually lost was its bottom.
       */
      style={{ height: "calc(100dvh - env(safe-area-inset-top))" }}
    >
      {/* Brand header — slimmer than the marketing nav, no menu links.
          Logo mark + wordmark on the left, tiny outbound link on the
          right. The hairline gold rule under the header echoes the
          brand colour without being shouty. */}
      {/* Over the home screen rather than instead of it, so the tiles
          are already there behind and dismissing lands on them. */}
      {showWelcome && <WelcomeScreen onGetStarted={dismissWelcome} />}

      <header className="sticky top-0 z-40 border-b border-primary/25 bg-surface/90 shadow-[0_1px_0_rgba(241,91,34,0.08),0_8px_24px_-18px_rgba(24,30,34,0.25)] backdrop-blur-xl">
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

      {/* Centred when it is short, top-aligned when it is not.
          The explainer block fills the empty state and the recent
          list fills the returning one — but a customer with a draft
          and no submissions yet has neither, and that is the most
          common state of all in the first week. They were getting
          the resume card, the start button, and 270px of nothing
          beneath it: the same hole the explainer was written to
          close, reappearing in the one state it does not cover.
          Rather than inventing more content to fill it, the band
          centres what it has. The space then sits above and below
          as framing instead of pooling underneath as an absence,
          which is what space is for in a practice layout. Long
          content still scrolls from the top as normal — the same
          pattern GuidedScreen uses for its questions. */}
      <main className="mx-auto flex w-full min-h-0 max-w-3xl flex-1 flex-col justify-center overflow-y-auto px-4 py-4 md:px-6 md:py-6">
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
          <section className="mb-4">
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

        {/* ── What happens ───────────────────────────────────────
            Shown to a first-time customer and nobody else.

            The empty home screen was a header, one gold button and
            600px of nothing. It fitted, which is what we had been
            optimising for, and it read as a page that had failed to
            load the rest of itself — at the exact moment someone who
            has just paid several hundred pounds is least certain
            they have come to the right place. A button labelled
            "Start a project" does not tell them what the project is,
            how long it takes, or what arrives at the end.

            Three lines fix that, and they go above the button rather
            than below it: context, then action. The numbers carry
            the brand gold and the rest is quiet, so it frames the
            button instead of competing with it.

            Hidden the moment there is a draft or a submission. A
            returning customer knows what the app does — they are
            mid-job — and showing them the explainer again would cost
            the space the resume card needs. The screen earns its
            room by saying different things to different people,
            which is also the answer to its looking static. */}
        {!draft && recents.length === 0 && (
          <section className="tm-fade-up mb-6">
            <ol className="border-t border-outline-variant/30">
              {[
                {
                  n: "1",
                  title: "Measure, room by room",
                  body: "Point your phone at each corner. No tape measure needed.",
                },
                {
                  n: "2",
                  title: "Photograph as you go",
                  body: "A shot of each room, each side of the house, and any manholes.",
                },
                {
                  n: "3",
                  title: "We draw it up",
                  body: "A draughtsman checks every survey by hand. Drawings back by email.",
                },
              ].map((s) => (
                /* Oversized numeral behind the text, not beside it.
                   The numbers were 18px gold digits in a flex row —
                   the same size as the titles they were numbering,
                   so they read as part of the sentence rather than
                   as a sequence, and three rows of similar-sized
                   type is the definition of flat.
                   Set at 52px in a pale gold and placed *behind* the
                   words, they do two jobs at once. They become
                   unmistakably a count, and the overlap puts the
                   text in front of something — which is the only
                   depth cue on this page, and it costs no shadow, no
                   blur and no extra height. It is also the oldest
                   trick in editorial layout and all over the
                   practice portfolios: a huge faint figure with the
                   content sitting over its shoulder. */
                <li
                  key={s.n}
                  className="relative border-b border-outline-variant/25 py-3.5"
                >
                  <span
                    className="font-headline pointer-events-none absolute -top-1 left-0 select-none text-[52px] leading-none text-primary/20"
                    aria-hidden
                  >
                    {s.n}
                  </span>
                  <span className="relative block min-w-0 pl-9">
                    <span className="block text-base font-medium text-on-surface">
                      {s.title}
                    </span>
                    <span className="mt-0.5 block text-sm leading-snug text-on-surface-variant">
                      {s.body}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}

        {/* ── Hero ───────────────────────────────────────────────
            A gold radial wash used to sit behind this, with 24px
            corners and 8px 4px 0 of padding. It was built to sit
            behind the hero copy and the three tiles; the copy and the
            tiles are both gone, so it was a decorative panel wrapped
            around one button -- almost entirely hidden behind that
            button's own solid gold, and its 4px of side padding made
            Start a project 8px narrower than the resume card directly
            above it. Two full-width buttons that are not the same
            width is the sort of thing you see before you can say what
            you are looking at, which is what "the spacing isn't
            right" means.

            No wash, no wrapper padding, and the gap above comes from
            the resume card's own margin so there is one number to
            change rather than two that have to agree. */}
        <section className="tm-fade-up relative isolate">
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
          <section className="mt-6">
            <h3 className="font-label text-sm font-bold uppercase tracking-[0.25em] text-primary">
              Recent submissions
            </h3>
            {/* One.
                This has been three, then two, then three again as
                the page budget moved around. It settles at one
                because Help and your project is now permanently open
                and cannot give way, so the only block left that can
                is this one — and of everything on the screen it is
                the least urgent: a customer looking at their own
                history is not mid-job. The latest submission is the
                one that answers "did that go through"; Project
                status, two rows below, has the rest. */}
            <ul className="mt-2">
              {recents.slice(0, 1).map((r, i) => (
                <li
                  key={r.id}
                  className={`flex items-center justify-between gap-3 py-2.5 ${
                    i > 0 ? "border-t border-outline-variant/25" : ""
                  }`}
                >
                  {/* The plan they drew, not a tick.
                      This row said "4 rooms · yesterday" with a green
                      check — a receipt. What the customer actually
                      spent an hour producing is a drawing, and it is
                      the only imagery in the whole app that is
                      genuinely theirs. A line plan of their own house
                      also says what the product is in a way no amount
                      of copy does, and it is the house style: the
                      architectural boards are full of plans used
                      exactly this way.
                      Falls back to the tick for anything submitted
                      before outlines were stored. */}
                  {planThumb(r.outlines) ? (
                    <span
                      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-outline-variant/30 bg-surface-container-lowest"
                      aria-hidden
                    >
                      <svg width={40} height={40} viewBox="0 0 40 40">
                        <path
                          d={planThumb(r.outlines)!}
                          fill="none"
                          stroke="#f15b22"
                          strokeWidth={1.25}
                          strokeLinejoin="round"
                        />
                      </svg>
                    </span>
                  ) : null}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-headline text-sm font-semibold text-on-surface">
                      {r.projectName || "(untitled project)"}
                    </span>
                    <span className="mt-0.5 block truncate text-sm text-on-surface-variant">
                      {r.roomCount} room{r.roomCount === 1 ? "" : "s"} ·{" "}
                      {formatRelative(r.submittedAt)}
                      {r.remoteId ? ` · #${r.remoteId}` : ""}
                    </span>
                  </span>
                  {!planThumb(r.outlines) && (
                    <span
                      className="material-symbols-outlined shrink-0 text-primary"
                      style={{ fontSize: "18px" }}
                      aria-hidden
                    >
                      check
                    </span>
                  )}
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
      {/* And clear of the home indicator. The copyright line sat
          directly under it, which on a modern iPhone means partly
          behind it. */}
      {/* The list can grow; the buttons above it cannot be squeezed.
          `shrink-0` on its own says "this block takes whatever height
          it needs", which was fine until the height stopped being
          fixed. A staff build adds a TM Designs group; a scan-enabled
          one adds another row; the whole thing is 300px before any of
          that. Each addition came straight out of the band above, and
          when that band ran short it scrolled -- taking Continue and
          Start a project with it. Which is the bug: the list was
          winning an argument with the two buttons the app exists for.
          Capping it at 45% settles the argument permanently. The main
          band always keeps the other 55%, which holds the resume card
          and the start button with room to spare, and the list
          scrolls within itself if it ever outgrows its share. No
          future row can push a button off the screen again. */}
      <nav
        className="mx-auto flex w-full max-w-3xl shrink-0 flex-col px-4 pt-0 md:px-6"
        style={{
          maxHeight: "45%",
          paddingBottom: "calc(env(safe-area-inset-bottom) + 0.75rem)",
        }}
      >
        <div className="min-h-0 flex-1 overflow-y-auto border-t border-outline-variant/30 pt-3">
          {/* Always open. No toggle.
              It was briefly a collapsible section, because six rows
              and three headings pinned open at the bottom of a 667px
              iPhone SE pushed Start a project below the fold. That
              solved the height and created a worse problem: tapping
              it expanded the list upwards over the button it had been
              hiding, so the fix reproduced the bug on demand. And a
              customer who cannot see Photo tips cannot know to want
              it — a list of links nobody opens may as well not exist.
              What made it fit instead was taking things out. The
              staff console has gone, the toggle row with it, and
              Recent submissions shows one. Everything left is
              permanently visible and Start a project stays on screen
              in every state. */}
          {/* The parent heading has gone.
              "Help and your project" sat directly above "Help", and
              a little further down "Your project" — it was its own
              two children glued together, announcing them to a reader
              who could already see them. Three bands of small caps in
              a row with nothing between them read as one texture
              rather than a hierarchy. The rule above the block
              already says a section starts here. */}
          {(["Help", "Your project", "TM Designs"] as const)
            .map((group) => ({
              group,
              items: moreItems.filter((it) => it.group === group),
            }))
            .filter((sec) => sec.items.length > 0)
            .map((sec, si) => (
              <div key={sec.group} className={si > 0 ? "mt-3" : ""}>
                {/* Below the title, above the rows, and lighter than
                    both — so the three levels read in the order they
                    are meant to. */}
                <p className="mb-0.5 text-sm uppercase tracking-[0.18em] text-on-surface-variant/60">
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
        </div>
        {/* Outside the scrolling part, so the foot of the page is the
            foot of the page. Inside it, the copyright line wandered
            off the bottom whenever the list was long enough to
            scroll, which is the one circumstance in which a reader
            most wants to know they have reached the end. */}
        <p className="mt-2 shrink-0 text-center text-sm uppercase tracking-widest text-on-surface-variant/70">
          © {year} TM Architectural Designs Ltd · UK wide
        </p>
      </nav>
    </div>
  );
}

/**
 * Several room outlines, scaled to fit one small square, as an SVG
 * path.
 *
 * Deliberately not `outlineThumbnail` from measure-core: that takes
 * one polygon and fits it to the box, which is right for a row
 * showing a single room on the scan review screen and wrong here.
 * These rooms are in plan positions relative to each other, so each
 * one has to be scaled by the *same* factor or the plan stops being
 * a plan — a kitchen drawn as large as the house it sits in.
 *
 * One shared scale, one shared centring, aspect ratio preserved.
 * Returns null when there is nothing to draw, which is every
 * submission made before outlines were stored.
 */
function planThumb(
  outlines: { x: number; z: number }[][] | undefined,
  box = 40,
  pad = 4,
): string | null {
  if (!outlines || outlines.length === 0) return null;
  const pts = outlines.flat();
  if (pts.length < 3) return null;

  const xs = pts.map((p) => p.x);
  const zs = pts.map((p) => p.z);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  const w = maxX - minX;
  const h = maxZ - minZ;
  if (!(w > 0) || !(h > 0)) return null;

  const inner = box - pad * 2;
  const scale = Math.min(inner / w, inner / h);
  // Centre whichever axis has slack, so a long thin bungalow sits in
  // the middle of its square rather than against one edge.
  const offX = pad + (inner - w * scale) / 2;
  const offZ = pad + (inner - h * scale) / 2;

  return outlines
    .filter((o) => o.length >= 3)
    .map(
      (o) =>
        o
          .map((p, i) => {
            const x = offX + (p.x - minX) * scale;
            const z = offZ + (p.z - minZ) * scale;
            return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${z.toFixed(1)}`;
          })
          .join(" ") + " Z",
    )
    .join(" ");
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
