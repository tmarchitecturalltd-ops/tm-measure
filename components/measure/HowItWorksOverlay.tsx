"use client";

/**
 * components/measure/HowItWorksOverlay.tsx
 *
 * Three sentences on what is about to happen, shown once.
 *
 * The home screen already explains the process, and nobody reads it —
 * they read the tiles, tap one, and arrive at "What's your name?" with
 * no idea whether this takes two minutes or two hours, or what happens
 * to the answers. That uncertainty is what makes someone put the phone
 * down on the second screen.
 *
 * So it is said once, at the only moment it is wanted: after choosing
 * what they are building, before the first question. Once per install,
 * not once per launch — the welcome mat is the thing that greets you
 * every time; this is a briefing, and a briefing repeated is nagging.
 *
 * One button. There is nothing to decide here, and a dismissible thing
 * with two ways out invites the customer to wonder which is correct.
 */

import { useEffect, useState } from "react";

const SEEN_KEY = "tm.howItWorks.seen";

const STEPS: { icon: string; title: string; body: string }[] = [
  {
    icon: "straighten",
    title: "Measure room by room",
    body: "We ask one thing at a time. Skip anything you can't answer and come back to it.",
  },
  {
    icon: "photo_camera",
    title: "One photo per room",
    body: "It shows us what a measurement can't — radiators, alcoves, awkward corners.",
  },
  {
    // Said now, not when we get there. Photographing the outside means
    // shoes on and a walk round the garden, and being asked to do that
    // an hour in, having thought you were nearly finished, is where a
    // survey gets abandoned three screens from the end.
    icon: "home",
    title: "Then a walk round the outside",
    body: "At the end we'll ask for a photo of each side of the house, plus the boiler and fuse box. Worth knowing before you start.",
  },
  {
    icon: "send",
    title: "Send it over",
    body: "It comes straight to us as a drawing. We'll come back to you by email.",
  },
];

export default function HowItWorksOverlay() {
  /* Tri-state: null until storage has been read, so a returning
     customer never sees this flash up and disappear on hydration. */
  const [show, setShow] = useState<boolean | null>(null);

  /* eslint-disable-next-line react-hooks/set-state-in-effect */
  useEffect(() => {
    try {
      setShow(window.localStorage.getItem(SEEN_KEY) !== "1");
    } catch {
      // Storage disabled. Showing nothing is the safe failure: the
      // alternative is a briefing that cannot remember being read and
      // therefore appears on every single project.
      setShow(false);
    }
  }, []);

  if (!show) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(SEEN_KEY, "1");
    } catch {
      /* noop — worst case it shows again */
    }
    setShow(false);
  };

  return (
    /* Above the guided screens (z-45), because it is shown over the
       first of them. */
    <div
      role="dialog"
      aria-modal="true"
      aria-label="How it works"
      className="fixed inset-0 z-[60] flex flex-col"
      style={{ backgroundColor: "#fcf9f5" }}
    >
      <div
        className="flex min-h-0 flex-1 flex-col justify-center overflow-y-auto px-6"
        style={{ paddingTop: "calc(env(safe-area-inset-top) + 1rem)" }}
      >
        <div className="mx-auto w-full max-w-xl">
          <p className="font-label mb-2 text-sm font-bold uppercase tracking-widest text-primary">
            Before you start
          </p>
          <h2 className="font-headline mb-6 text-3xl leading-tight text-on-surface">
            How this works
          </h2>

          <ol className="space-y-5">
            {STEPS.map((s, i) => (
              <li key={s.title} className="flex gap-4">
                <span
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
                  aria-hidden
                >
                  <span
                    className="material-symbols-outlined"
                    style={{ fontSize: "22px" }}
                  >
                    {s.icon}
                  </span>
                </span>
                <div>
                  <p className="text-base font-bold text-on-surface">
                    {i + 1}. {s.title}
                  </p>
                  <p className="mt-1 text-base leading-relaxed text-on-surface-variant">
                    {s.body}
                  </p>
                </div>
              </li>
            ))}
          </ol>

          <p className="mt-6 text-base leading-relaxed text-on-surface-variant">
            Your progress saves as you go, so you can stop and pick it up
            later.
          </p>
        </div>
      </div>

      <div
        className="shrink-0 border-t border-outline-variant/30 bg-surface px-4 pt-3"
        style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
      >
        <button
          type="button"
          onClick={dismiss}
          autoFocus
          style={{ minHeight: 56 }}
          className="mx-auto block w-full max-w-xl rounded-full bg-primary px-6 text-sm font-bold uppercase tracking-wide text-on-primary shadow-lg shadow-primary/25 active:scale-[0.98]"
        >
          Got it
        </button>
      </div>
    </div>
  );
}
