"use client";

/**
 * components/measure/ScanReviewScreen.tsx
 *
 * Shown after RoomScanOverlay finishes a scan, BEFORE dimensions are
 * stamped into the RoomDraft. Lets the user inspect per-measurement
 * confidence + variance and decide whether to accept ("Confirm & Proceed")
 * or run the scan again ("Rescan Room").
 *
 * Design choices:
 * - Uses the existing TM tokens from app/globals.css (gold #b89650 primary,
 *   Manrope body, Noto Serif headline, cream surfaces) so it sits naturally
 *   next to MeasureIntakeForm. The Stitch navy mockup (DESIGN.md) informs
 *   the STRUCTURE (no hard borders, confidence chips, asymmetric layout,
 *   surface-on-surface layering, ambient shadow) but not the palette.
 * - 3D wire preview reuses RoomScanWirePreview, lazy-imported to keep the
 *   initial bundle slim.
 * - No localStorage. All state in-memory. Capacitor-safe (no server APIs).
 *
 * To integrate:
 *   1. Copy this file to components/measure/ScanReviewScreen.tsx
 *   2. Copy /ScanReview/measure-core.scan.ts to packages/measure-core/src/scan.ts
 *      and re-export from packages/measure-core/src/index.ts.
 *   3. See ScanReviewScreen.integration.md for the RoomScanOverlay patch.
 */

import { useMemo, useState, lazy, Suspense } from "react";
import type {
  ScanResult,
  ScanMeasurement,
  ScanConfidence,
} from "@tm-designs/measure-core";
import {
  scanOverallConfidence,
  estimateAreaFromWalls,
  formatLengthDual,
  type UnitPreference,
} from "@tm-designs/measure-core";

// Lazy so three.js doesn't balloon the initial route chunk.
// Note: not using the existing RoomScanWirePreview here because that
// component has a fixed h-36/h-44 and its own dark border — won't fill
// the 4/3 hero panel. Keep RoomScanWirePreview for compact uses elsewhere.
const WirePreviewFill = lazy(() => import("./ScanReviewWirePreview"));

export type ScanReviewScreenProps = {
  scan: ScanResult;
  roomName: string;
  /** User's preferred unit for display. Internal values stay metric. */
  unit?: UnitPreference;
  /** Called when the user accepts the scan — parent should stamp into RoomDraft. */
  onConfirm: (scan: ScanResult) => void;
  /** Called when the user wants to re-run the scan overlay. */
  onRescan: () => void;
  /** Optional cancel / back action for the top-left chevron. Falls back to onRescan. */
  onBack?: () => void;
  /** Project / job reference to surface in the bottom action bar. Optional. */
  jobReference?: string;
};

export default function ScanReviewScreen({
  scan,
  roomName,
  unit = "metric",
  onConfirm,
  onRescan,
  onBack,
  jobReference,
}: ScanReviewScreenProps) {
  const [preview, setPreview] = useState<"3d" | "plan">("3d");

  const overall = useMemo(() => scanOverallConfidence(scan), [scan]);
  const areaM2 = useMemo(
    () => scan.context.areaM2 ?? estimateAreaFromWalls(scan),
    [scan]
  );

  // Pull the two longest wall segments + ceiling to drive the wire preview.
  const wirePreviewDims = useMemo(() => {
    const walls = scan.measurements
      .filter((m) => m.kind === "wall")
      .sort((a, b) => b.valueM - a.valueM);
    const ceiling = scan.measurements.find((m) => m.kind === "ceiling");
    const widthM = walls[0]?.valueM ?? 3.5;
    const lengthM = walls[1]?.valueM ?? 3;
    const heightM = ceiling?.valueM ?? 2.5;
    return { widthM, lengthM, heightM };
  }, [scan]);

  const pointsLabel = scan.context.pointCount
    ? `${scan.context.pointCount} Points Captured`
    : `${scan.measurements.length} Dimensions`;

  /**
   * What the scan actually found, stated plainly.
   *
   * The list below shows every measurement, but as an undifferentiated
   * run of rows it is easy to scroll past a door or miss that no
   * windows were detected at all. A LiDAR scan draws doors and windows
   * in the 3D model the customer just watched being built, so "did it
   * get my windows?" is the first thing they want answered — and the
   * answer needs to be visible before they accept the scan, not after.
   */
  const foundSummary = useMemo(() => {
    const count = (k: string) =>
      scan.measurements.filter((m) => m.kind === k).length;
    const parts: string[] = [];
    const walls = count("wall");
    const doors = count("door");
    const windows = count("window");
    if (walls) parts.push(`${walls} wall${walls === 1 ? "" : "s"}`);
    if (doors) parts.push(`${doors} door${doors === 1 ? "" : "s"}`);
    parts.push(
      windows
        ? `${windows} window${windows === 1 ? "" : "s"}`
        : "no windows detected",
    );
    return parts.join(" · ");
  }, [scan]);

  return (
    <div className="min-h-screen bg-surface text-on-surface font-body">
      {/* ─── Top app bar ───────────────────────────────────────────────── */}
      <header className="fixed top-0 inset-x-0 z-40 backdrop-blur-lg bg-surface/80">
        <div className="mx-auto max-w-7xl flex items-center justify-between px-6 h-16">
          <div className="flex items-center gap-3">
            <button
              type="button"
              aria-label="Back"
              onClick={onBack ?? onRescan}
              className="material-symbols-outlined text-on-surface hover:bg-surface-container-low rounded-full p-2 transition-colors active:scale-95"
            >
              arrow_back
            </button>
            <span className="font-headline text-lg tracking-tight text-on-surface">
              TM Measure
            </span>
          </div>
          <button
            type="button"
            aria-label="Help"
            className="material-symbols-outlined text-on-surface hover:bg-surface-container-low rounded-full p-2 transition-colors active:scale-95"
          >
            help
          </button>
        </div>
      </header>

      {/* ─── Main grid ─────────────────────────────────────────────────── */}
      <main className="mx-auto max-w-7xl px-6 pt-24 pb-40">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          {/* Left column: editorial header + 3D preview */}
          <div className="lg:col-span-7 space-y-8">
            <section>
              <p className="eyebrow-line !mb-4">Scan Review</p>
              <h1 className="font-headline text-4xl lg:text-5xl font-bold leading-[1.08] tracking-tight text-on-surface">
                {splitRoomName(roomName).main}
                {splitRoomName(roomName).sub && (
                  <>
                    <br />
                    <span className="text-on-surface-variant">
                      {splitRoomName(roomName).sub}
                    </span>
                  </>
                )}
              </h1>
            </section>

            {/* 3D / plan preview — surface-on-surface, no border */}
            <div className="relative aspect-[4/3] w-full overflow-hidden rounded-xl bg-surface-container-low editorial-shadow">
              <Suspense fallback={<PreviewFallback />}>
                {preview === "3d" ? (
                  <WirePreviewFill
                    widthM={wirePreviewDims.widthM}
                    lengthM={wirePreviewDims.lengthM}
                    heightM={wirePreviewDims.heightM}
                  />
                ) : (
                  <PlanPreview {...wirePreviewDims} />
                )}
              </Suspense>

              {/* 3D / Plan pill — glassmorphism per DESIGN.md */}
              <div className="absolute top-5 left-5 flex gap-2">
                <PreviewPill
                  icon="view_in_ar"
                  label="3D Model"
                  active={preview === "3d"}
                  onClick={() => setPreview("3d")}
                />
                <PreviewPill
                  icon="grid_on"
                  label="Plan"
                  active={preview === "plan"}
                  onClick={() => setPreview("plan")}
                />
              </div>

              {/* Fullscreen button — primary accent, ambient shadow */}
              <button
                type="button"
                aria-label="Expand preview"
                className="absolute bottom-5 right-5 flex items-center justify-center w-14 h-14 rounded-full bg-primary text-on-primary shadow-[0_12px_28px_rgba(184,150,80,0.35)] hover:scale-105 transition-transform active:scale-95"
              >
                <span className="material-symbols-outlined">fullscreen</span>
              </button>
            </div>
          </div>

          {/* Right column: dimensions + summary */}
          <div className="lg:col-span-5 space-y-6">
            <div className="bg-surface-container-low rounded-xl p-8 space-y-7">
              <div className="flex items-end justify-between gap-4">
                <h2 className="font-headline text-xl font-bold text-on-surface">
                  Detected Dimensions
                </h2>
                <span className="text-sm font-medium text-on-surface-variant tracking-wider uppercase">
                  {pointsLabel}
                </span>
              </div>

              <p className="-mt-2 mb-4 text-sm text-on-surface-variant">
                Found: <span className="font-semibold text-on-surface">{foundSummary}</span>.
                Anything missing or wrong can be corrected after you confirm.
              </p>

              <ul className="space-y-3">
                {scan.measurements.map((m) => (
                  <MeasurementRow key={m.id} measurement={m} unit={unit} />
                ))}
              </ul>

              {/* Tonal summary box — primary/5 background, no border */}
              <div className="bg-[rgba(184,150,80,0.08)] rounded-lg p-5 flex gap-4 items-start">
                <span
                  className="material-symbols-outlined text-primary mt-0.5"
                  aria-hidden
                >
                  info
                </span>
                <p className="text-sm leading-relaxed text-on-surface-variant">
                  {scan.context.summary ?? defaultSummary({ areaM2, overall })}
                </p>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* ─── Sticky action bar ─────────────────────────────────────────── */}
      <div className="fixed bottom-0 inset-x-0 z-40 backdrop-blur-xl bg-surface/85 shadow-[0_-8px_30px_rgba(0,0,0,0.04)]">
        <div className="mx-auto max-w-7xl px-6 py-5 flex flex-col md:flex-row gap-4 justify-between items-center">
          {jobReference ? (
            <div className="hidden md:block">
              <p className="text-sm font-semibold tracking-[0.2em] uppercase text-on-surface-variant">
                Job Reference
              </p>
              <p className="font-headline text-sm font-bold text-on-surface">
                {jobReference}
              </p>
            </div>
          ) : (
            <span className="hidden md:block" />
          )}

          <div className="flex flex-col sm:flex-row gap-3 w-full md:w-auto">
            <button
              type="button"
              onClick={onRescan}
              className="px-8 py-4 rounded-lg font-semibold text-sm bg-surface-container-high text-on-surface hover:bg-surface-container-highest transition-colors active:scale-95"
            >
              Rescan Room
            </button>
            <button
              type="button"
              onClick={() => onConfirm(scan)}
              className="px-10 py-4 rounded-lg font-semibold text-sm text-on-primary bg-gradient-to-r from-primary to-[#d9c292] shadow-[0_10px_24px_rgba(184,150,80,0.25)] hover:shadow-[0_14px_32px_rgba(184,150,80,0.4)] transition-all active:scale-95"
            >
              Confirm &amp; Proceed
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Sub-components ─────────────────────────────────────────────────── */

function MeasurementRow({
  measurement,
  unit,
}: {
  measurement: ScanMeasurement;
  unit: UnitPreference;
}) {
  // formatLengthDual returns { primary, secondary } as formatted strings,
  // e.g. { primary: "4.20 m", secondary: "≈ 13' 9\"" }. We split the primary
  // into a big number + small unit so the mockup's typographic hierarchy holds.
  const { primary, secondary } = formatLengthDual(measurement.valueM, unit);
  const { bigValue, smallUnit } = splitPrimaryDisplay(primary);
  const { tone, bg, dot, label } = confidenceChipStyle(measurement.confidence);
  const noteText =
    measurement.note ??
    (measurement.varianceM !== undefined
      ? `±${measurement.varianceM.toFixed(2)}m variance`
      : undefined);

  return (
    <li className="bg-surface-container-lowest rounded-lg p-5 flex items-center justify-between gap-4 hover:bg-white transition-colors">
      <div className="min-w-0">
        <p className="text-sm font-semibold uppercase tracking-wider text-on-surface-variant mb-1.5 truncate">
          {measurement.label}
        </p>
        <p className="font-headline text-3xl font-bold leading-none text-on-surface">
          {bigValue}
          {smallUnit ? (
            <span className="text-sm font-normal text-on-surface-variant ml-1.5">
              {smallUnit}
            </span>
          ) : null}
        </p>
        {secondary ? (
          <p className="text-sm text-on-surface-variant mt-1">{secondary}</p>
        ) : null}
      </div>
      <div className="text-right shrink-0">
        <div
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full ${bg}`}
        >
          <span className={`text-sm font-bold tracking-wider ${tone}`}>
            {label}
          </span>
          <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
        </div>
        {noteText ? (
          <p className="text-sm text-on-surface-variant mt-1.5">
            {noteText}
          </p>
        ) : null}
      </div>
    </li>
  );
}

function PreviewPill({
  icon,
  label,
  active,
  onClick,
}: {
  icon: string;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`backdrop-blur-md px-4 py-2 rounded-full flex items-center gap-2 transition-colors active:scale-95 ${
        active
          ? "bg-surface-container-lowest/90 text-on-surface"
          : "bg-surface-container-lowest/60 text-on-surface-variant hover:bg-surface-container-lowest/80"
      }`}
    >
      <span
        className="material-symbols-outlined text-base"
        style={{ fontVariationSettings: "'FILL' 1" }}
      >
        {icon}
      </span>
      <span className="text-sm font-semibold uppercase tracking-wider">
        {label}
      </span>
    </button>
  );
}

function PreviewFallback() {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="flex flex-col items-center gap-2 text-on-surface-variant">
        <span className="material-symbols-outlined text-3xl animate-pulse">
          view_in_ar
        </span>
        <span className="text-sm uppercase tracking-wider">Rendering model…</span>
      </div>
    </div>
  );
}

function PlanPreview({
  widthM,
  lengthM,
}: {
  widthM: number;
  lengthM: number;
  // heightM is accepted for a uniform caller signature but unused on 2D plan.
  heightM?: number;
}) {
  // Very small SVG top-down fallback. Keeps the screen useful even before
  // the 3D chunk hydrates on slow devices / Capacitor WebView.
  const pad = 24;
  const viewW = 320;
  const viewH = 240;
  const scale = Math.min((viewW - pad * 2) / widthM, (viewH - pad * 2) / lengthM);
  const rectW = widthM * scale;
  const rectH = lengthM * scale;
  const x = (viewW - rectW) / 2;
  const y = (viewH - rectH) / 2;
  return (
    <svg
      viewBox={`0 0 ${viewW} ${viewH}`}
      className="absolute inset-0 w-full h-full"
      role="img"
      aria-label="Floor plan preview"
    >
      <rect
        x={x}
        y={y}
        width={rectW}
        height={rectH}
        fill="rgba(184,150,80,0.08)"
        stroke="#b89650"
        strokeWidth={1.5}
        strokeDasharray="4 4"
      />
      <text
        x={viewW / 2}
        y={y + rectH + 16}
        textAnchor="middle"
        className="fill-current text-on-surface-variant"
        style={{ fontSize: 10, letterSpacing: 2, textTransform: "uppercase" }}
      >
        {widthM.toFixed(2)}m × {lengthM.toFixed(2)}m
      </text>
    </svg>
  );
}

/* ─── Helpers ─────────────────────────────────────────────────────────── */

function confidenceChipStyle(c: ScanConfidence) {
  switch (c) {
    case "high":
      return {
        label: "HIGH CONFIDENCE",
        tone: "text-[#1f6b3a]",
        bg: "bg-[rgba(31,107,58,0.08)]",
        dot: "bg-[#1f6b3a]",
      };
    case "medium":
      return {
        label: "MEDIUM",
        tone: "text-[#7a5800]",
        bg: "bg-[rgba(184,150,80,0.14)]",
        dot: "bg-[#b89650]",
      };
    case "low":
      return {
        label: "LOW",
        tone: "text-[#8b1a1a]",
        bg: "bg-[rgba(186,26,26,0.08)]",
        dot: "bg-[#ba1a1a]",
      };
  }
}

function defaultSummary({
  areaM2,
  overall,
}: {
  areaM2: number | undefined;
  overall: ScanConfidence;
}): string {
  const areaPart = areaM2
    ? `The scan identifies an area of ${areaM2.toFixed(2)} m².`
    : "Area could not be derived automatically — please verify wall lengths.";
  // These three lines used to claim things the app cannot know. "All
  // primary wall structures were verified with high precision" — nothing
  // verifies them; the bucket comes from geometry sanity checks, not a
  // ground truth. "Some measurements may be occluded" — there is no
  // occlusion detection anywhere in the pipeline. "Re-scan in better
  // lighting" — lighting is never sampled. Telling a customer their
  // measurements were verified when they were not is the worst thing
  // this screen could do, so each line now describes the check that
  // actually ran and asks them to confirm against a tape.
  const confidencePart =
    overall === "high"
      ? "The corners formed a consistent rectangle. Please still check one wall against a tape before confirming."
      : overall === "medium"
      ? "The geometry checks passed with some slack — check the Medium-confidence rows against a tape."
      : "The geometry checks did not agree. Treat these as rough and measure by hand, or re-scan taking more care over the corner taps.";
  return `${areaPart} ${confidencePart}`;
}

/**
 * Split a formatLengthDual primary string like "4.20 m" or "13' 9\"" into
 * a big numeric portion and a small trailing unit. Works for metric and
 * imperial; falls back to showing the whole string as bigValue if it can't
 * find a clean split.
 */
function splitPrimaryDisplay(primary: string): {
  bigValue: string;
  smallUnit: string | null;
} {
  const trimmed = primary.trim();
  if (!trimmed) return { bigValue: "—", smallUnit: null };
  // Metric case: "4.20 m" — split on last space
  const lastSpace = trimmed.lastIndexOf(" ");
  if (lastSpace > 0 && /^[\d.,\-]+$/.test(trimmed.slice(0, lastSpace))) {
    return {
      bigValue: trimmed.slice(0, lastSpace),
      smallUnit: trimmed.slice(lastSpace + 1),
    };
  }
  // Imperial case: leave as-is ("13' 9\"")
  return { bigValue: trimmed, smallUnit: null };
}

/** Split "Master Bedroom North Wing" → main + sub so the display headline can wrap editorially. */
function splitRoomName(name: string): { main: string; sub: string | null } {
  const trimmed = name.trim();
  if (!trimmed) return { main: "Room", sub: null };
  const parts = trimmed.split(/\s+/);
  if (parts.length <= 2) return { main: trimmed, sub: null };
  const halfway = Math.ceil(parts.length / 2);
  return {
    main: parts.slice(0, halfway).join(" "),
    sub: parts.slice(halfway).join(" "),
  };
}
