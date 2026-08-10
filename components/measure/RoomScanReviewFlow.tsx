"use client";

/**
 * components/measure/RoomScanReviewFlow.tsx
 *
 * Drop-in replacement for the place where you currently render
 * <RoomScanOverlay onApply={...} />. It inserts the Scan Review step
 * BETWEEN the scan and the dimension write-back, so users can inspect
 * confidence / variance before the form is populated.
 *
 * Flow:
 *   scanning  →  RoomScanOverlay
 *   reviewing →  ScanReviewScreen   (new)
 *   done      →  onApply fires with the accepted ScanResult
 *
 * The overlay no longer produces mock dimensions: the corner-tap and
 * span modes return real measurements from the perspective solver.
 * When native RoomPlan output is wired in, the only thing that changes
 * is buildScanResult() — the review screen and MeasureIntakeForm
 * wiring stay the same.
 */

import { useCallback, useMemo, useState } from "react";
import type {
  ScanConfidence,
  ScanResult,
  UnitPreference,
} from "@tm-designs/measure-core";
import RoomScanOverlay from "./RoomScanOverlay";
import ScanReviewScreen from "./ScanReviewScreen";

type OverlayDims = {
  widthM: number;
  lengthM: number;
  heightM: number;
  /** Optional door width — if the overlay emits one. */
  doorWidthM?: number;
  /** Scan method — "corners" yields real measured confidence. */
  method?: "corners" | "video" | "lidar";
  /** Overall confidence from the scan engine. */
  confidence?: ScanConfidence;
  /** Human-readable reasons surfaced in the review screen summary. */
  notes?: string[];
  /** Floor area from shoelace, if the engine derived one. */
  areaM2?: number;
  /** Whether the engine thought the quadrilateral was rectangular. */
  rectangular?: boolean;
};

export type RoomScanReviewFlowProps = {
  open: boolean;
  /** Human-readable room name used in the HUD + review screen headline. */
  roomLabel: string;
  roomId?: string;
  unit?: UnitPreference;
  jobReference?: string;
  /** Called when the user dismisses scanning OR rejects the review. */
  onClose: () => void;
  /** Called with the scan the user accepted. Parent should stamp into RoomDraft. */
  onApply: (scan: ScanResult) => void;
};

export default function RoomScanReviewFlow({
  open,
  roomLabel,
  roomId,
  unit = "metric",
  jobReference,
  onClose,
  onApply,
}: RoomScanReviewFlowProps) {
  const [step, setStep] = useState<"scanning" | "reviewing">("scanning");
  const [scan, setScan] = useState<ScanResult | null>(null);

  /**
   * Scan complete → write the measurements straight into the room and
   * close the overlay. We previously routed through a separate
   * "reviewing" screen, but field-testing showed users wanted to see
   * the populated form right away (the values appear inline in the
   * Walls / Ceiling inputs, where they can be tweaked). The reviewing
   * step is still wired in for future re-enablement but is no longer
   * the default path.
   */
  const handleScanComplete = useCallback(
    (dims: OverlayDims) => {
      const built = buildScanResult({ dims, roomId });
      setScan(built);
      onApply(built);
    },
    [roomId, onApply]
  );

  const handleRescan = useCallback(() => {
    setScan(null);
    setStep("scanning");
  }, []);

  const handleConfirm = useCallback(
    (accepted: ScanResult) => {
      onApply(accepted);
      // Reset for next room
      setScan(null);
      setStep("scanning");
    },
    [onApply]
  );

  const overlayProps = useMemo(
    () => ({
      open: open && step === "scanning",
      roomLabel,
      onClose,
      // NOTE: RoomScanOverlay's current signature calls onApply(dims).
      // We hijack it here so the review screen gets to vet first.
      onApply: handleScanComplete,
    }),
    [open, step, roomLabel, onClose, handleScanComplete]
  );

  if (!open) return null;

  if (step === "reviewing" && scan) {
    return (
      <ScanReviewScreen
        scan={scan}
        roomName={roomLabel}
        unit={unit}
        jobReference={jobReference}
        onConfirm={handleConfirm}
        onRescan={handleRescan}
        onBack={onClose}
      />
    );
  }

  return <RoomScanOverlay {...overlayProps} />;
}

/* ─── Mock scan → real ScanResult ─────────────────────────────────────── */

/**
 * Wraps the overlay's raw dimensions into a structured ScanResult with
 * plausible confidence values. Replace this with real output from ARKit
 * RoomPlan / ARCore Depth when you wire the native pipeline.
 */
function buildScanResult({
  dims,
  roomId,
}: {
  dims: OverlayDims;
  roomId?: string;
}): ScanResult {
  const now = new Date().toISOString();
  // varianceM is no longer set. It was taken from a lookup keyed on the
  // confidence bucket — 0.03 / 0.08 / 0.15 m — so the "+/-" shown next
  // to a measurement was a restatement of the bucket, not a computed
  // tolerance. Presenting it as a tolerance implied a precision that
  // had never been measured. The field is optional; set it only when
  // something genuinely derives it.
  // Default to "low", not "high". If the overlay didn't report a
  // confidence there is no evidence the scan was good — assuming the
  // best case put a "High confidence" chip next to numbers nothing had
  // validated, which is the one thing a measuring tool must not do.
  const overall: ScanConfidence = dims.confidence ?? "low";
  // No compass here. The scan measures two perpendicular walls; it has
  // no heading, so "(North)" and "(East)" were invented and travelled
  // all the way into the customer's submission.
  const walls = [
    {
      id: `w-${now}-a`,
      label: "Wall 1",
      kind: "wall" as const,
      valueM: round2(dims.widthM),
      confidence: overall,
    },
    {
      id: `w-${now}-b`,
      label: "Wall 2",
      kind: "wall" as const,
      valueM: round2(dims.lengthM),
      confidence: overall,
    },
  ];
  const ceiling = {
    id: `c-${now}`,
    label: "Ceiling Height",
    kind: "ceiling" as const,
    valueM: round2(dims.heightM),
    // Corner-tap scans can't derive ceiling height at all, so it stays
    // low. Other methods are capped at the scan's own confidence rather
    // than the flat "medium" that used to be asserted here — and the
    // old "Potential occlusion" note described a condition nothing in
    // the pipeline actually detects.
    confidence: dims.method === "corners" ? ("low" as const) : overall,
    note:
      dims.method === "corners" ? "Estimated — please confirm" : undefined,
  };
  const door = dims.doorWidthM
    ? {
        id: `d-${now}`,
        label: "Door Width",
        kind: "door" as const,
        valueM: round2(dims.doorWidthM),
        // Door width comes out of the same perspective solve as the
        // walls, so it cannot be more reliable than they are. It was
        // hard-coded "high" and labelled "Reference Standard", implying
        // it had been checked against a known door size. It hadn't.
        confidence: overall,
      }
    : null;

  const measurements = [...walls, ceiling, ...(door ? [door] : [])];

  const summary =
    dims.notes && dims.notes.length > 0
      ? dims.notes.slice(0, 3).join(" · ")
      : undefined;

  return {
    id: `scan-${now}`,
    roomId,
    measurements,
    context: {
      areaM2: round2(dims.areaM2 ?? dims.widthM * dims.lengthM),
      // pointCount and lighting are deliberately absent.
      //
      // They used to be filled in with a constant 4-or-6 and a flat
      // "optimal" — neither measured, nothing behind them. Both fields
      // exist for a real scanner to report (ARKit gives a genuine
      // lighting estimate and feature-point count); the corner-tap path
      // has neither, and asserting them dressed a guess up as sensor
      // data in a survey an architect is meant to rely on. Both are
      // optional in ScanContext, so omitting is the honest answer:
      // populate them when a real scanner is wired in.
      capturedAt: now,
      summary,
    },
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
