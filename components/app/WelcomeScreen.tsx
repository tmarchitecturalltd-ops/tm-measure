"use client";

/**
 * components/app/WelcomeScreen.tsx
 *
 * First-run introduction shown ahead of AppHome inside the Capacitor
 * shell. Purely a welcome mat: brand logo, one-line proposition, three
 * short "what happens next" beats, and a single Get Started CTA.
 *
 * Shown once per install. The dismissal flag lives in localStorage
 * under WELCOME_SEEN_KEY; AppHome owns the decision of whether to
 * render this or the home screen, so routing is unchanged and the
 * back-stack stays clean (no extra history entry to trap the user).
 */

import AppLogo from "@/components/app/AppLogo";
import {
  DraftingIcon,
  MeasureIcon,
  PhotoIcon,
} from "@/components/app/OnboardingIcons";

export const WELCOME_SEEN_KEY = "tm.welcome.seen.v1";

const BEATS: {
  title: string;
  body: string;
  Icon: (p: { size?: number; className?: string }) => React.ReactElement;
}[] = [
  {
    title: "Measure at your pace",
    body: "Walk each room and capture walls, ceilings, doors and windows in a guided flow.",
    Icon: MeasureIcon,
  },
  {
    title: "Photos that do the talking",
    body: "Add reference shots and voice notes so nothing gets lost in translation.",
    Icon: PhotoIcon,
  },
  {
    title: "Straight to our drawing board",
    body: "Send it over and our designers pick it up — no email back-and-forth.",
    Icon: DraftingIcon,
  },
];

export default function WelcomeScreen({ onGetStarted }: { onGetStarted: () => void }) {
  return (
    <div className="flex min-h-dvh flex-col bg-surface px-6 py-10">
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col">
        {/* Brand lockup */}
        <div className="flex flex-col items-center pt-6 text-center">
          <AppLogo size={96} />
          <p className="mt-6 text-[11px] font-medium uppercase tracking-[0.28em] text-primary">
            TM Architectural Designs
          </p>
          <h1 className="mt-3 font-serif text-3xl leading-tight text-on-surface">
            Welcome to TM Designs
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-on-surface-variant">
            TM Measure turns a walk around your home into the measurements our
            design team needs — usually in under an hour.
          </p>
        </div>

        {/* What happens next */}
        <ul className="mt-9 space-y-4">
          {BEATS.map((beat) => (
            <li key={beat.title} className="flex gap-3">
              <span
                className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
                style={{
                  backgroundColor: "rgba(184, 150, 80, 0.12)",
                  color: "#8a6f3a",
                }}
              >
                <beat.Icon size={26} />
              </span>
              <div>
                <p className="text-sm font-medium text-on-surface">{beat.title}</p>
                <p className="mt-0.5 text-[13px] leading-relaxed text-on-surface-variant">
                  {beat.body}
                </p>
              </div>
            </li>
          ))}
        </ul>

        {/* CTA pinned to the bottom of the viewport on tall screens */}
        <div className="mt-auto pt-10">
          <button
            type="button"
            onClick={onGetStarted}
            className="w-full rounded-full bg-primary px-6 py-4 text-[12px] font-bold uppercase tracking-[0.2em] text-on-primary transition hover:opacity-90 active:opacity-80"
          >
            Get started
          </button>
          <p className="mt-4 text-center text-[11px] text-on-surface-variant">
            You can revisit this any time from the home screen.
          </p>
        </div>
      </div>
    </div>
  );
}
