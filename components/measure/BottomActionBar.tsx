"use client";

/**
 * components/measure/BottomActionBar.tsx
 *
 * The primary controls, parked where a thumb can reach them.
 *
 * This app is used one-handed, standing up, often with a tape measure
 * in the other hand. On a 6.7" phone the top third of the screen is
 * not reachable without shifting grip, and the bottom is — so the
 * controls pressed on every single screen belong down there.
 *
 * A note on what this replaced, because it is a real trade-off rather
 * than a straight win. Back/Next previously sat directly beneath the
 * question, so the eye never travelled from the answer to the button.
 * That is better for reading and worse for reaching, and reaching wins
 * here: the customer presses Next around fifty times a survey and
 * reads the button's position once.
 *
 * Deliberately NOT `position: fixed`. The guided screen is already a
 * full-viewport flex column, so a flex child that doesn't shrink is
 * pinned to the bottom by construction — no overlay, no z-index
 * argument with the keyboard, and no content hidden underneath it. A
 * fixed bar on iOS also drifts when the software keyboard opens, which
 * is precisely when someone is typing a wall length.
 *
 * Safe-area inset on the bottom so the bar clears the home indicator;
 * without it the lower third of the button is under the gesture strip
 * and swipes home instead of advancing.
 *
 * Targets are 56px tall — above the 48dp floor, because these two are
 * the most-pressed controls in the app and the people using it are
 * frequently not steady-handed.
 */

import type { ReactNode } from "react";

type Props = {
  /** Secondary action, left. Omit to hide it entirely. */
  backLabel?: string;
  onBack?: () => void;
  backDisabled?: boolean;
  /** Primary action, right. Always present. */
  nextLabel: string;
  onNext: () => void;
  nextDisabled?: boolean;
  /**
   * Shown above the buttons — why the primary action is unavailable,
   * or anything else the customer needs before pressing it. Sits
   * inside the bar so it cannot scroll out of view while the button it
   * explains stays visible.
   */
  message?: ReactNode;
};

export default function BottomActionBar({
  backLabel = "Back",
  onBack,
  backDisabled,
  nextLabel,
  onNext,
  nextDisabled,
  message,
}: Props) {
  return (
    <div
      className="shrink-0 border-t border-outline-variant/30 bg-surface px-4 pt-3"
      style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
    >
      {message && <div className="mx-auto mb-3 max-w-xl">{message}</div>}
      <div className="mx-auto flex max-w-xl items-center gap-3">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            disabled={backDisabled}
            style={{ minHeight: 56 }}
            className="flex-1 rounded-full border-2 border-outline px-5 text-sm font-bold uppercase tracking-widest text-on-surface transition-colors disabled:opacity-35"
          >
            {backLabel}
          </button>
        )}
        <button
          type="button"
          onClick={onNext}
          disabled={nextDisabled}
          style={{ minHeight: 56 }}
          // Two-thirds of the width when there is a Back button. The
          // primary action should be the obvious one to hit, and the
          // larger target is also the one under the thumb's natural
          // resting arc on a right-handed grip.
          className="flex-[2] rounded-full bg-primary px-6 text-sm font-bold uppercase tracking-widest text-on-primary shadow-lg shadow-primary/25 transition-all active:scale-[0.98] disabled:opacity-40 disabled:shadow-none"
        >
          {nextLabel}
        </button>
      </div>
    </div>
  );
}
