"use client";

/**
 * components/measure/GuidedScreen.tsx
 *
 * The chrome for a one-question-at-a-time screen.
 *
 * Extracted from GuidedRoomFlow when the same treatment was wanted on
 * the project step. Copying it would have been quicker and would have
 * guaranteed the two drifting apart — one gets a padding fix, the
 * other doesn't, and six weeks later they are visibly different
 * screens in the same app. Everything here is layout; the questions
 * live in the flows that use it.
 *
 * The shape of it:
 *
 *   - Fixed to the viewport, opaque, above the app header. It is a
 *     takeover, not a card. A <div> rather than a <section> because
 *     globals.css forces `section` to 96% opacity, which let the page
 *     behind show through.
 *   - Two corner controls only: a way home on the left, a menu on the
 *     right. Everything else the customer might want is in that menu.
 *   - The question vertically centred with its answer under it, and
 *     Back/Next on the bottom edge in a BottomActionBar.
 *   - The middle band scrolls internally (min-h-0 + overflow-y-auto)
 *     so a long step keeps the corners and the buttons in place.
 *
 * The buttons started directly beneath the question, so the eye never
 * travelled from the answer to the control. They moved to the bottom
 * edge for thumb reach, which is a trade rather than a straight win —
 * see BottomActionBar. The short version: this is used one-handed
 * while holding a tape measure, and Next is pressed about fifty times
 * a survey against reading its position once.
 */

import Link from "next/link";
import BottomActionBar from "@/components/measure/BottomActionBar";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { SHOW_GUIDE_EVENT } from "@/components/measure/HowItWorksOverlay";

export type MenuItem = {
  label: string;
  onClick: () => void;
  /** Renders as the current selection. */
  active?: boolean;
};

export type MenuSection = {
  /** Small caps heading above the group. Omit for an ungrouped block. */
  heading?: string;
  items: MenuItem[];
};

type Props = {
  /** Small caps line above the question, e.g. "Room 1 of 3". */
  eyebrow?: string;
  /** The question itself. The main thing on the screen. */
  title: string;
  /** 0..1. Drawn as a hairline under the corners. */
  progress: number;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  menuSections: MenuSection[];
  /** Resets when this changes — see the scroll effect below. */
  scrollKey: string | number;
  onBack?: () => void;
  backDisabled?: boolean;
  /** Overrides "Back" — e.g. "Start fresh" on the resume prompt. */
  backLabelOverride?: string;
  onNext: () => void;
  nextLabel: string;
  nextDisabled?: boolean;
  /**
   * Why Next is unavailable. Shown above the buttons.
   *
   * A node rather than a string, so a message that names something to
   * go and fix can carry the button that goes there.
   */
  blockMessage?: ReactNode;
  /**
   * Let the content run edge to edge and fill the band.
   *
   * The default is a centred column with generous padding, which is
   * right for a question and wrong for the floor plan -- there the
   * content is a canvas that should take every pixel between the
   * controls and the bottom bar.
   */
  wide?: boolean;
  children: ReactNode;
};

export default function GuidedScreen({
  eyebrow,
  title,
  progress,
  menuOpen,
  onMenuOpenChange,
  menuSections,
  scrollKey,
  onBack,
  backDisabled,
  backLabelOverride,
  onNext,
  nextLabel,
  nextDisabled,
  blockMessage,
  wide = false,
  children,
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  /**
   * The help panel.
   *
   * Every screen in this flow is one question with two buttons under
   * it, which is deliberate -- but it leaves someone who is stuck with
   * nowhere to go except Back. The corner opposite Home is the
   * conventional place for a question mark and, since the menu moved
   * to the bottom bar, it has been empty.
   *
   * Local state rather than a prop: the panel says the same thing on
   * every screen, and threading open/close through six callers to
   * achieve that would be six chances to forget one.
   */
  const [helpOpen, setHelpOpen] = useState(false);

  /*
   * Freeze the page behind.
   *
   * Without this the document still scrolls when a drag starts on a
   * non-scrollable part of the question, so the customer leaves the
   * takeover to find the form somewhere they did not leave it.
   */
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Reset the scroll on every question. Without it, moving from a long
  // step to a short one leaves the new question scrolled out of view —
  // the exact problem this layout exists to fix.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [scrollKey]);

  /*
   * Which way the customer is travelling.
   *
   * Every step used to arrive the same way regardless of whether
   * Back or Next produced it, so going back felt identical to going
   * forward and the flow had no spatial shape -- six screens of
   * questions that each appeared from nowhere. Reading the
   * direction off the control that was pressed is enough: forward
   * enters from the right, back from the left, which is the model
   * every phone already teaches.
   *
   * Held here rather than passed in, so no caller has to know about
   * it and nothing about the existing step logic changes.
   */
  const [direction, setDirection] = useState<"fwd" | "back">("fwd");

  return (
    <div
      className="fixed inset-0 z-[45] flex flex-col"
      /*
       * Drafting paper.
       *
       * Replaces a flat cream fill, and before that a 1920px
       * Unsplash photo of an office fetched over the network and
       * darkened to 15% behind an opaque surface — a request for an
       * image nobody could see, in an app used in hallways with one
       * bar of signal.
       *
       * Two rule scales like real paper: a fine 28px grid with a
       * heavier line every fifth. Drawn in the ink colour at 3% and
       * 5%, which on cream is visible as texture and nowhere near
       * strong enough to compete with a word of text. Fixed, so the
       * grid is the sheet and the content moves across it.
       *
       * Inline rather than a class: rules added to globals.css below
       * the existing ones were not reaching the browser, and a
       * full-screen takeover whose background might not paint is a
       * page you cannot read.
       */
      style={{
        backgroundColor: "#cbd0d2",
        backgroundImage: [
          "linear-gradient(rgba(24,30,34,0.05) 1px, transparent 1px)",
          "linear-gradient(90deg, rgba(24,30,34,0.05) 1px, transparent 1px)",
          "linear-gradient(rgba(24,30,34,0.03) 1px, transparent 1px)",
          "linear-gradient(90deg, rgba(24,30,34,0.03) 1px, transparent 1px)",
        ].join(","),
        backgroundSize: "140px 140px, 140px 140px, 28px 28px, 28px 28px",
      }}
    >
      {/* ── Corners ───────────────────────────────────────────────── */}
      <div
        className="flex shrink-0 items-center justify-between px-3 py-2"
        style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.5rem)" }}
      >
        <Link
          href="/"
          aria-label="Back to the home screen"
          className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-sm font-bold text-on-surface-variant hover:text-primary"
        >
          <span
            className="material-symbols-outlined"
            style={{ fontSize: "20px" }}
            aria-hidden
          >
            home
          </span>
          {/* "Home", not "Self measure".
              The icon was a house and the word was the name of the
              thing you were already doing, so the control read as a
              label for the current screen rather than as a way off
              it. The one place a customer looks for the way out is
              the top-left corner, and the word they look for there
              is Home. */}
          Home
        </Link>

        {/* The menu has moved to the bottom bar.
            Navigation split between a hamburger in the top-right corner
            and the buttons at the bottom meant the customer had to
            reach for two different parts of the screen depending on
            what they wanted, and the top corner is the hardest place on
            a phone to reach one-handed. Everything that navigates is
            now in one row along the bottom.

            What is here instead is help, which is not navigation. */}
        <button
          type="button"
          onClick={() => setHelpOpen(true)}
          aria-label="Need help?"
          className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-sm font-bold text-on-surface-variant hover:text-primary"
          style={{ minHeight: 44 }}
        >
          <span
            className="material-symbols-outlined"
            style={{ fontSize: "20px" }}
            aria-hidden
          >
            help
          </span>
          Help?
        </button>
      </div>

      {/* ── Help ──────────────────────────────────────────────────── */}
      {helpOpen && (
        <>
          <button
            type="button"
            aria-label="Close help"
            onClick={() => setHelpOpen(false)}
            className="fixed inset-0 z-[70] bg-black/30"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Need help?"
            className="fixed inset-x-3 top-16 z-[71] rounded-2xl border border-outline-variant/40 bg-surface-container-lowest p-5 shadow-2xl sm:left-auto sm:right-4 sm:w-96"
          >
            <p className="mb-1 text-sm font-bold uppercase tracking-widest text-primary">
              Need help?
            </p>
            <h2 className="font-headline mb-3 text-xl leading-tight text-on-surface">
              Nothing here can be got wrong
            </h2>
            <p className="mb-4 text-base leading-relaxed text-on-surface-variant">
              Skip anything you can&apos;t answer and carry on. We check
              everything before we draw it, and we&apos;ll ask if
              something&apos;s missing. Your answers are saved as you go,
              so you can stop and come back.
            </p>
            <button
              type="button"
              onClick={() => {
                setHelpOpen(false);
                window.dispatchEvent(new Event(SHOW_GUIDE_EVENT));
              }}
              className="mb-2 w-full rounded-xl border border-outline-variant/50 px-4 py-3 text-left text-base font-bold text-on-surface hover:text-primary"
              style={{ minHeight: 48 }}
            >
              Show the short guide again
            </button>
            <a
              href="mailto:tmarchitecturalltd@gmail.com?subject=Help%20with%20my%20measurements"
              className="mb-2 block w-full rounded-xl border border-outline-variant/50 px-4 py-3 text-left text-base font-bold text-on-surface hover:text-primary"
              style={{ minHeight: 48 }}
            >
              Email us about this survey
            </a>
            <button
              type="button"
              onClick={() => setHelpOpen(false)}
              className="w-full px-4 py-3 text-center text-base font-bold text-on-surface-variant hover:text-primary"
              style={{ minHeight: 48 }}
            >
              Close
            </button>
          </div>
        </>
      )}

      {/* Progress. A guided flow with no visible end is an
          interrogation — but a hairline, so it frames the question
          rather than competing with it. */}
      <div className="h-1 shrink-0 bg-outline-variant/25">
        <div
          className="h-full bg-primary transition-all"
          style={{ width: `${Math.max(0, Math.min(1, progress)) * 100}%` }}
        />
      </div>

      {/* ── Menu ──────────────────────────────────────────────────── */}
      {menuOpen && (
        <>
          {/* Tap anywhere else to close. A menu on a phone that can only
              be dismissed by finding its own button again is a trap. */}
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => onMenuOpenChange(false)}
            className="fixed inset-0 z-40 bg-black/20"
          />
          {/* Anchored to the bottom-left, above the bar it opens from.
              A menu that appears at the opposite end of the screen from
              the button that opened it makes the customer hunt for it. */}
          <div
            className="absolute bottom-24 left-3 right-3 z-50 max-h-[60vh] overflow-y-auto rounded-2xl border border-outline-variant/40 bg-surface-container-lowest shadow-2xl sm:right-auto sm:w-80"
            style={{ marginBottom: "env(safe-area-inset-bottom)" }}
          >
            {menuSections.map((sec, si) => (
              <div key={si}>
                {sec.heading && (
                  <div
                    className={`px-5 pb-1 pt-3 text-sm font-bold uppercase tracking-widest text-on-surface-variant ${
                      si > 0 ? "border-t border-outline-variant/30" : ""
                    }`}
                  >
                    {sec.heading}
                  </div>
                )}
                {sec.items.map((it, ii) => (
                  <button
                    key={ii}
                    type="button"
                    onClick={() => {
                      onMenuOpenChange(false);
                      it.onClick();
                    }}
                    className={`w-full justify-start px-5 py-2.5 text-left text-base ${
                      it.active ? "font-bold text-primary" : "text-on-surface"
                    } ${!sec.heading && si > 0 ? "border-t border-outline-variant/30" : ""}`}
                  >
                    {it.label}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </>
      )}

      {/* ── The question ──────────────────────────────────────────── */}
      <div
        ref={scrollRef}
        // justify-center keeps a short question in the middle of the
        // band; a long one scrolls from the top as normal.
        className={`flex min-h-0 flex-1 flex-col overflow-y-auto ${
          wide ? "px-3 py-2" : "justify-center px-5 py-5"
        }`}
      >
        {/* A new question arrives rather than appears.
            Motion as punctuation, not decoration. Every screen in
            this flow has the same furniture — corners, hairline,
            heading, buttons — so one question replacing another was
            a silent swap of the middle of the screen, and the eye
            had no reason to go back to the top and start reading.
            A 0.45s rise is long enough to notice and short enough
            not to wait for, and keying it to scrollKey means it
            replays on each question rather than once per mount.

            Not applied to the floor plan, which is a canvas being
            worked on rather than a question being asked; re-animating
            it every time something is tapped would be seasickness.
            prefers-reduced-motion is honoured globally in
            globals.css, so this is off for anyone who has asked for
            that. */}
        <div
          key={wide ? undefined : scrollKey}
          className={
            (wide ? "w-full " : "mx-auto w-full max-w-xl ") +
            (direction === "back" ? "tm-step-back" : "tm-step-fwd")
          }
        >
          {/* ── Typography pass ─────────────────────────────────────
              The question is the screen, and it was not being
              treated as one.

              An architectural practice gets its authority from type
              and space: a large heading, a long way from a small
              label, with nothing boxed in. This screen had a 14px
              eyebrow 8px above a 30px heading 20px above the
              controls — three bands of similar weight, evenly
              spaced, which reads as a form rather than as a
              question. Everything looked equally important, so
              nothing was.

              The eyebrow drops to 12px and loses its bold; the
              heading grows and gains room beneath it. The gap
              between the smallest and largest thing on screen is
              what does the work, which is why portfolios set a 48pt
              title over 11pt body and look expensive while doing
              almost nothing. */}
          {eyebrow && (
            <p
              className="font-label mb-3 text-xs font-medium uppercase tracking-[0.3em] text-on-surface-variant/70"
              style={wide ? undefined : { animation: "tmFadeUp 0.4s ease-out both" }}
            >
              {eyebrow}
            </p>
          )}
          {/* An empty title renders nothing at all rather than an
              empty heading holding open five rems of margin. The floor
              plan step uses this: the grid is the heading. */}
          {title && (
            <h2
              className="font-headline mb-7 text-[34px] font-normal leading-[1.1] tracking-[-0.01em] text-on-surface"
              style={
                wide ? undefined : { animation: "tmFadeUp 0.4s ease-out 0.07s both" }
              }
            >
              {title}
            </h2>
          )}

          {/* The answer arrives last. Not decoration: on a screen
              where the label, the question and the field are three
              lines of similar length, the order they appear in is
              the only thing that says which to read first. The floor
              plan is excluded — it is a drawing being worked on, not
              a question being asked, and re-animating it on every
              tap would be unbearable. */}
          {wide ? (
            children
          ) : (
            <div style={{ animation: "tmFadeUp 0.45s ease-out 0.14s both" }}>
              {children}
            </div>
          )}
        </div>
      </div>

      {/* Controls last in the column, so they sit on the bottom edge
          without overlaying anything — see BottomActionBar for why this
          is a flex child rather than a fixed bar. */}
      <BottomActionBar
        onMenu={
          menuSections.length > 0
            ? () => onMenuOpenChange(!menuOpen)
            : undefined
        }
        backLabel={backLabelOverride}
        onBack={
          onBack
            ? () => {
                setDirection("back");
                onBack();
              }
            : undefined
        }
        backDisabled={backDisabled || !onBack}
        onNext={() => {
          setDirection("fwd");
          onNext();
        }}
        nextLabel={nextLabel}
        nextDisabled={nextDisabled}
        message={
          blockMessage ? (
            <div className="rounded-md bg-amber-100/60 px-3 py-2 text-sm text-amber-900">
              {blockMessage}
            </div>
          ) : undefined
        }
      />
    </div>
  );
}
