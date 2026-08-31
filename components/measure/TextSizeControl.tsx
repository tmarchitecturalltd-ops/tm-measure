"use client";

/**
 * components/measure/TextSizeControl.tsx
 *
 * Three buttons that make the whole app bigger.
 *
 * The alternative was to rely on pinch-zoom, and pinch-zoom in a
 * WKWebView has already failed this app once — it was disabled for a
 * whole release after users got stuck zoomed in. It is enabled again,
 * bounded, but a customer standing in their hallway squinting at a
 * wall length should not be depending on the web view behaving.
 *
 * It scales the root font size rather than only the text, so the
 * padding and tap targets grow with it. Text that grows inside a
 * button that doesn't is how you end up with a bigger label nobody can
 * hit.
 *
 * The setting is written to <html> and to localStorage. The inline
 * script in layout applies it before first paint, so the app does not
 * render small and then visibly jump.
 */

import { useEffect, useState } from "react";

export const TEXT_SIZE_KEY = "tm-measure:text-size:v1";

type Size = "normal" | "large" | "larger";

const OPTIONS: { value: Size; label: string; sample: string }[] = [
  { value: "normal", label: "Normal", sample: "A" },
  { value: "large", label: "Larger", sample: "A" },
  { value: "larger", label: "Largest", sample: "A" },
];

function apply(size: Size) {
  const root = document.documentElement;
  if (size === "normal") root.removeAttribute("data-text-size");
  else root.setAttribute("data-text-size", size);
  try {
    localStorage.setItem(TEXT_SIZE_KEY, size);
  } catch {
    // Private mode, or storage full. The size still applies for this
    // session; only the memory of it is lost. Not worth an error
    // message the customer can do nothing about.
  }
}

export default function TextSizeControl() {
  const [size, setSize] = useState<Size>("normal");

  // Read back what the pre-paint script already applied, so the
  // highlighted button matches the size actually on screen.
  useEffect(() => {
    const current = document.documentElement.getAttribute("data-text-size");
    if (current === "large" || current === "larger") setSize(current);
  }, []);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm font-semibold text-on-surface-variant">
        Text size
      </span>
      <div
        role="radiogroup"
        aria-label="Text size"
        className="flex items-stretch gap-1.5"
      >
        {OPTIONS.map((o, i) => {
          const active = size === o.value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => {
                setSize(o.value);
                apply(o.value);
              }}
              // min-h/min-w in px deliberately, not rem: this control
              // has to be comfortably tappable *before* anyone has
              // managed to make things bigger with it.
              style={{ minHeight: 44, minWidth: 48 }}
              className={`flex items-center justify-center rounded-xl border-2 px-3 leading-none transition-colors ${
                active
                  ? "border-primary bg-primary text-on-primary"
                  : "border-outline-variant/60 bg-surface-container-lowest text-on-surface"
              }`}
            >
              <span
                aria-hidden
                style={{ fontSize: [15, 19, 24][i], fontWeight: 700 }}
              >
                {o.sample}
              </span>
              <span className="sr-only">{o.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
