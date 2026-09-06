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
  /**
   * Opens the list of steps. Sits between Back and Next, so the row
   * reads in the order the customer thinks in: where I have been,
   * where I am, where I am going.
   *
   * Labelled "Steps" rather than left as three bare lines. A hamburger
   * is a convention people have learned, not one they understand, and
   * the word costs nothing next to the icon.
   */
  onMenu?: () => void;
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
  onMenu,
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
      {/* gap-3 and equal flex-1 basis on all three children: the row is
          divided into thirds with the same air between each. Steps was
          shrink-0 and Next was flex-[2], which pinched Steps into a
          sliver between two much wider buttons. */}
      <div className="mx-auto flex max-w-xl items-stretch gap-3">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            disabled={backDisabled}
            style={{ minHeight: 56 }}
            className="min-w-0 flex-1 rounded-full border-2 border-outline px-3 text-sm font-bold uppercase leading-tight tracking-wide text-on-surface transition-colors disabled:opacity-35"
          >
            {backLabel}
          </button>
        )}
        {onMenu && (
          <button
            type="button"
            onClick={onMenu}
            style={{ minHeight: 56 }}
            className="flex min-w-0 flex-1 flex-col items-center justify-center rounded-full border-2 border-outline px-3 text-on-surface"
          >
            <span
              className="material-symbols-outlined"
              style={{ fontSize: "22px", lineHeight: 1 }}
              aria-hidden
            >
              menu
            </span>
            <span className="mt-0.5 text-[11px] font-bold uppercase tracking-widest">
              Steps
            </span>
          </button>
        )}
        <button
          type="button"
          onClick={onNext}
          disabled={nextDisabled}
          style={{ minHeight: 56 }}
          // Equal width with the other two. Next used to be twice the
          // width, which squeezed Steps into a sliver between them —
          // three controls at one size read as one row of choices,
          // where three at different sizes read as clutter. Next stays
          // the obvious one to hit through colour and fill rather than
          // size.
          // min-w-0 and tighter tracking because there are three
          // controls in this row now: on a 375px screen the old
          // padding and letter-spacing pushed a two-word label off the
          // end of its own button.
          className="min-w-0 flex-1 rounded-full bg-primary px-3 text-sm font-bold uppercase leading-tight tracking-wide text-on-primary shadow-lg shadow-primary/25 transition-all active:scale-[0.98] disabled:opacity-40 disabled:shadow-none"
        >
          {nextLabel}
        </button>
      </div>
    </div>
  );
}
