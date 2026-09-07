"use client";

/**
 * components/measure/ScanToast.tsx
 *
 * A guidance message over the viewfinder that behaves like a phone
 * notification: it slides down from the top, it goes away on its own,
 * and it can be flicked up out of the way.
 *
 * What it replaces was a pill pinned to the top of the camera view for
 * the whole session, saying the same sentence whether you had read it
 * once or fifty times. Guidance that cannot be dismissed stops being
 * guidance after the first minute — it becomes furniture, and then it
 * becomes something covering the top of the room you are trying to
 * photograph.
 *
 * The gesture is the point. People already know what to do with a
 * notification: ignore it and it leaves, flick it away if it is in the
 * road. Neither needs teaching, and neither costs a deliberate tap on
 * a button while holding a phone still with one hand.
 *
 * Swipe up rather than sideways. A horizontal swipe over a camera view
 * is how most apps switch mode, and the tap target underneath is the
 * whole screen — so a sideways flick that missed would land as a
 * measurement tap in the wrong place.
 */

import { useCallback, useEffect, useRef, useState } from "react";

const HUD = "#1c1c1a";
const GOLD = "#b89650";

export type ScanToastProps = {
  /**
   * The message. Changing it shows the toast again — so the caller
   * just sets what should be said now, rather than managing
   * visibility.
   */
  message: string | null;
  /**
   * How long before it leaves by itself, in ms.
   *
   * Default 4 s: long enough to read a short sentence twice while
   * holding a phone up, short enough that it is gone before it becomes
   * something to look past. Pass 0 to leave it up until dismissed.
   */
  durationMs?: number;
  /** Fired when it goes, whether by timer or by flick. */
  onDismiss?: () => void;
  /** Emphasised styling for something that needs doing now. */
  tone?: "info" | "action";
};

export default function ScanToast({
  message,
  durationMs = 4000,
  onDismiss,
  tone = "info",
}: ScanToastProps) {
  const [shown, setShown] = useState(false);
  /** Live finger offset, negative is upwards. */
  const [dragY, setDragY] = useState(0);
  const startYRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hide = useCallback(() => {
    setShown(false);
    setDragY(0);
    onDismiss?.();
  }, [onDismiss]);

  /* eslint-disable-next-line react-hooks/set-state-in-effect */
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!message) {
      setShown(false);
      return;
    }
    setShown(true);
    setDragY(0);
    if (durationMs > 0) {
      timerRef.current = setTimeout(() => setShown(false), durationMs);
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [message, durationMs]);

  if (!message) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      // pointer-events only on the card itself. The rest of this strip
      // has to stay transparent to taps, because the whole screen under
      // it is the measurement target.
      className="pointer-events-none absolute inset-x-0 top-0 z-30 flex justify-center px-3"
      style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.5rem)" }}
    >
      <div
        className="pointer-events-auto w-full max-w-sm rounded-2xl px-4 py-3 shadow-2xl backdrop-blur-md"
        style={{
          backgroundColor: `${HUD}f0`,
          border: `1px solid ${tone === "action" ? GOLD : "rgba(255,255,255,0.12)"}`,
          // Slides in from above and rides the finger on the way out.
          // No transition while dragging, or the card lags behind the
          // thumb and the flick feels broken.
          transform: shown
            ? `translateY(${Math.min(0, dragY)}px)`
            : "translateY(-140%)",
          opacity: shown ? 1 : 0,
          transition:
            startYRef.current === null
              ? "transform 220ms cubic-bezier(0.2,0.9,0.3,1), opacity 180ms"
              : "none",
        }}
        onPointerDown={(e) => {
          startYRef.current = e.clientY;
          if (timerRef.current) clearTimeout(timerRef.current);
        }}
        onPointerMove={(e) => {
          if (startYRef.current === null) return;
          setDragY(e.clientY - startYRef.current);
        }}
        onPointerUp={(e) => {
          const start = startYRef.current;
          startYRef.current = null;
          if (start === null) return;
          const moved = e.clientY - start;
          // Up more than 24 px is a flick; anything less is a tap, and
          // a tap on a notification dismisses it too. Both end the same
          // way, which is the behaviour people expect and means a
          // half-hearted swipe is never a no-op.
          if (moved < -24 || Math.abs(moved) < 8) {
            hide();
          } else {
            setDragY(0);
            if (durationMs > 0) {
              timerRef.current = setTimeout(() => setShown(false), durationMs);
            }
          }
        }}
        onPointerCancel={() => {
          startYRef.current = null;
          setDragY(0);
        }}
      >
        <div className="flex items-start gap-3">
          <p
            className="flex-1 text-left text-base font-semibold leading-snug"
            style={{ color: tone === "action" ? GOLD : "rgba(255,255,255,0.92)" }}
          >
            {message}
          </p>
          <button
            type="button"
            onClick={hide}
            aria-label="Dismiss"
            className="-mr-1 -mt-1 shrink-0 rounded-full px-2 py-1 text-sm text-white/50"
          >
            ✕
          </button>
        </div>
        {/* The affordance, said once and quietly. A notification people
            have not realised is dismissible is just a banner. */}
        <p className="mt-1 text-left text-xs text-white/35">
          Swipe up to dismiss
        </p>
      </div>
    </div>
  );
}
