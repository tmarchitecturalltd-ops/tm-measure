"use client";

/**
 * components/app/AppButton.tsx
 *
 * One button, four weights.
 *
 * The home screen had grown three unrelated designs for what is the
 * same thing -- a full-width control that takes you somewhere. The
 * resume card was a 16px-padded rounded-2xl box with a gold border and
 * a two-line label. "Start a project" was a filled pill, 60px tall,
 * uppercase, with a trailing arrow. The More entries were hairline
 * rows in small caps with a thin chevron. Three corner radii, three
 * type treatments, three ideas about how tall a tappable thing is, all
 * within one scroll of each other.
 *
 * None of them was wrong on its own, which is how it happened. Put
 * together they read as three screens stacked, and the eye spends its
 * first moment working out what kind of page this is instead of
 * reading the one line that matters.
 *
 * So: one component, one radius, one height, one label style, one
 * place the chevron goes. The variants differ only in fill -- solid
 * for the one thing we want tapped, tinted for the thing you were
 * already doing, quiet for the rest. Everything structural is shared,
 * which is the point: a new button added later cannot invent a fourth
 * shape without going through here.
 *
 * `detail` is the second line. It exists because the resume card needs
 * one and nothing else does, and giving it a name is better than
 * letting one caller pass children that happen to lay out correctly.
 */

import Link from "next/link";
import type { ReactNode } from "react";

export type AppButtonVariant =
  /** The one action on the screen. Filled. */
  | "primary"
  /** Picking up something already started. Tinted, bordered. */
  | "secondary"
  /** An index entry. No fill, hairline separator supplied by the list. */
  | "quiet";

type Props = {
  variant?: AppButtonVariant;
  /** The label. Always small caps — see the note above. */
  label: string;
  /** Second line, muted. Only the resume control uses it. */
  detail?: ReactNode;
  /** Small caps line above the label, in the accent colour. */
  eyebrow?: string;
  /** Material Symbols name for the trailing icon. */
  trailingIcon?: string;
  href?: string;
  onClick?: () => void;
  className?: string;
};

/**
 * 60px.
 *
 * Above the 44px minimum by enough to be comfortable one-handed, and
 * the same for every variant — a quiet row that is shorter than the
 * primary button is what made the page look like three pages.
 */
const MIN_HEIGHT = 60;

export default function AppButton({
  variant = "primary",
  label,
  detail,
  eyebrow,
  trailingIcon = "chevron_right",
  href,
  onClick,
  className = "",
}: Props) {
  const fill =
    variant === "primary"
      ? "bg-primary text-on-primary shadow-lg shadow-primary/25 hover:bg-surface-tint"
      : variant === "secondary"
        ? "border border-primary/40 bg-primary/5 text-on-surface hover:bg-primary/10"
        : "text-on-surface hover:text-primary";

  const cls = [
    "flex w-full items-center gap-3 rounded-2xl px-5 text-left transition-all active:scale-[0.99]",
    fill,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const body = (
    <>
      <span className="min-w-0 flex-1">
        {eyebrow && (
          <span
            className={`font-label block text-sm font-bold uppercase tracking-[0.15em] ${
              variant === "primary" ? "text-on-primary/80" : "text-primary"
            }`}
          >
            {eyebrow}
          </span>
        )}
        {/* The quiet rows are not shouted.
            Small caps and heavy tracking is the house style for a
            heading, and using it for the rows as well put three levels
            of bold small caps within one screen of each other -- the
            section title, its group headings, and every row underneath
            them. Reported as the bold being confusing to look at, and
            it was: nothing on the block looked more important than
            anything else, so the eye had no way in.
            The rows now read as what they are, which is a list of
            places to go, and the small caps mean "heading" again. */}
        <span
          className={
            variant === "quiet"
              ? "block text-base font-medium"
              : "block text-base font-bold uppercase tracking-widest"
          }
        >
          {label}
        </span>
        {detail && (
          <span
            className={`mt-0.5 block truncate text-sm normal-case tracking-normal ${
              variant === "primary"
                ? "text-on-primary/80"
                : "text-on-surface-variant"
            }`}
          >
            {detail}
          </span>
        )}
      </span>
      {trailingIcon && (
        <span
          className={`material-symbols-outlined shrink-0 ${
            variant === "quiet" ? "text-on-surface-variant/40" : ""
          }`}
          style={{ fontSize: variant === "quiet" ? "18px" : "22px" }}
          aria-hidden
        >
          {trailingIcon}
        </span>
      )}
    </>
  );

  // Padding rather than justify-center: a label that is centred on one
  // control and left-aligned on the next is the same inconsistency in
  // a different place.
  const style = { minHeight: MIN_HEIGHT, paddingTop: 12, paddingBottom: 12 };

  if (href) {
    return (
      <Link href={href} className={cls} style={style}>
        {body}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} className={cls} style={style}>
      {body}
    </button>
  );
}
