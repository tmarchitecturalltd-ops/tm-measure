"use client";

/**
 * components/measure/TutorialOverlay.tsx
 *
 * First-run onboarding shown on the measure form. Four-slide walkthrough
 * covering the wizard layout, calibration, the photo requirement, and
 * how to submit. Dismisses to localStorage so it never shows twice.
 *
 * Trigger: mount-time on MeasureIntakeForm. Bypassable instantly via
 * the "Skip" link in the top-right.
 */

import { useEffect, useState } from "react";

const STORAGE_KEY = "tm-measure:tutorial-seen:v1";

type Slide = {
  title: string;
  body: string;
  iconName: string; // Material Symbols Outlined glyph name
};

const SLIDES: Slide[] = [
  {
    iconName: "checklist",
    title: "Four steps, one project",
    body:
      "Project details, then rooms (with photos), then the floor plan, then review. You can jump between them any time using the pills at the top.",
  },
  {
    iconName: "center_focus_strong",
    title: "Calibrate once, measure many",
    body:
      "Lay a known reference (tape measure, A4 sheet, door frame) on the floor and tap both ends. We solve your camera's focal length and remember it for next time — accuracy lands at ±3 cm.",
  },
  {
    iconName: "photo_camera",
    title: "One photo per room, minimum",
    body:
      "Reference photos let the architect verify the dimensions against what's actually there — radiators, chimney breasts, columns. The form won't submit without them.",
  },
  {
    iconName: "send",
    title: "Send straight to TM Designs",
    body:
      "Submit reaches us within seconds — measurements, photos, and floor plan all in one go. Quote usually back within two working days.",
  },
];

export default function TutorialOverlay() {
  const [open, setOpen] = useState(false);
  const [slide, setSlide] = useState(0);

  // Read the seen-flag from localStorage on mount. If absent, surface
  // the tutorial; otherwise stay silent. Storage failures (private
  // mode, quota) treat the user as a returning visitor — better to
  // be quiet than annoying.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const seen = window.localStorage.getItem(STORAGE_KEY);
      if (!seen) setOpen(true);
    } catch {
      /* noop */
    }
  }, []);

  const dismiss = (markSeen = true) => {
    setOpen(false);
    if (markSeen && typeof window !== "undefined") {
      try {
        window.localStorage.setItem(STORAGE_KEY, "1");
      } catch {
        /* noop */
      }
    }
  };

  if (!open) return null;
  const current = SLIDES[slide];
  const isLast = slide === SLIDES.length - 1;

  return (
    <div
      className="fixed inset-0 z-[180] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tutorial-title"
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/55 backdrop-blur-sm"
        aria-label="Dismiss tutorial"
        onClick={() => dismiss(false)}
      />
      <div className="relative w-full max-w-md rounded-2xl border border-outline-variant/30 bg-surface p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <span
            className="material-symbols-outlined rounded-xl bg-primary/15 p-3 text-primary"
            style={{ fontSize: "32px" }}
            aria-hidden
          >
            {current.iconName}
          </span>
          <button
            type="button"
            onClick={() => dismiss(true)}
            className="text-sm font-bold uppercase tracking-widest text-on-surface-variant hover:text-primary"
          >
            Skip
          </button>
        </div>
        <h2
          id="tutorial-title"
          className="font-headline mt-4 text-xl text-on-surface"
        >
          {current.title}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-on-surface-variant">
          {current.body}
        </p>

        <div className="mt-6 flex items-center justify-between">
          <div className="flex gap-1.5" aria-hidden>
            {SLIDES.map((_, i) => (
              <span
                key={i}
                className={`h-1.5 rounded-full transition-all ${
                  i === slide ? "w-6 bg-primary" : "w-1.5 bg-outline-variant/40"
                }`}
              />
            ))}
          </div>
          <div className="flex gap-2">
            {slide > 0 && (
              <button
                type="button"
                onClick={() => setSlide((s) => Math.max(0, s - 1))}
                className="rounded-full border border-outline-variant/40 px-4 py-2 text-sm font-bold uppercase tracking-widest text-on-surface"
              >
                Back
              </button>
            )}
            <button
              type="button"
              onClick={() => (isLast ? dismiss(true) : setSlide((s) => s + 1))}
              className="rounded-full bg-primary px-5 py-2 text-sm font-bold uppercase tracking-widest text-on-primary"
            >
              {isLast ? "Got it" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
