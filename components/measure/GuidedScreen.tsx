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
 *   - The question vertically centred, its answer under it, and
 *     Back/Next under that — not pinned to the bottom edge, so the eye
 *     does not have to travel from what was just typed to a button
 *     somewhere else.
 *   - The middle band scrolls internally (min-h-0 + overflow-y-auto)
 *     so a long step keeps the corners and the buttons in place.
 */

import Link from "next/link";
import { useEffect, useRef, type ReactNode } from "react";

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
  onNext: () => void;
  nextLabel: string;
  nextDisabled?: boolean;
  /** Why Next is unavailable. Shown above the buttons. */
  blockMessage?: string | null;
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
  onNext,
  nextLabel,
  nextDisabled,
  blockMessage,
  children,
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

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

  return (
    <div
      className="fixed inset-0 z-[45] flex flex-col"
      style={{ backgroundColor: "#fcf9f5" }}
    >
      {/* ── Corners ───────────────────────────────────────────────── */}
      <div
        className="flex shrink-0 items-center justify-between px-3 py-2"
        style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
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
          Self measure
        </Link>

        <button
          type="button"
          onClick={() => onMenuOpenChange(!menuOpen)}
          aria-label="Menu"
          aria-expanded={menuOpen}
          className="rounded-full px-3 py-2 text-on-surface-variant hover:text-primary"
        >
          <span
            className="material-symbols-outlined"
            style={{ fontSize: "26px" }}
            aria-hidden
          >
            menu
          </span>
        </button>
      </div>

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
          <div className="absolute right-3 top-14 z-50 max-h-[75vh] w-72 overflow-y-auto rounded-2xl border border-outline-variant/40 bg-surface-container-lowest shadow-2xl">
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
        className="flex min-h-0 flex-1 flex-col justify-center overflow-y-auto px-5 py-4"
      >
        <div className="mx-auto w-full max-w-xl">
          {eyebrow && (
            <p className="font-label mb-2 text-sm font-bold uppercase tracking-widest text-primary">
              {eyebrow}
            </p>
          )}
          <h2 className="font-headline mb-5 text-3xl leading-tight text-on-surface">
            {title}
          </h2>

          {children}

          {blockMessage && (
            <p className="mt-4 rounded-md bg-amber-100/60 px-3 py-2 text-sm text-amber-900">
              {blockMessage}
            </p>
          )}

          <div className="mt-7 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={onBack}
              disabled={backDisabled || !onBack}
              className="rounded-full border border-outline px-6 py-3 text-sm font-bold uppercase tracking-widest disabled:opacity-40"
            >
              Back
            </button>
            <button
              type="button"
              onClick={onNext}
              disabled={nextDisabled}
              className="rounded-full bg-primary px-8 py-3 text-sm font-bold uppercase tracking-widest text-on-primary disabled:opacity-40"
            >
              {nextLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
