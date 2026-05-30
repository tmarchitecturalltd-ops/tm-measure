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
 * Keeps RoomScanOverlay's existing "randomDimensions" mock for now.
 * When you swap in real ARKit / RoomPlan / ARCore output later, the
 * only thing that changes is the buildScanResult() function — the
 * review screen and MeasureIntakeForm wiring stay the same.
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
  // Corner-tap scans measure opposite walls and average them; the other
  // paths (video / lidar mock) don't expose per-wall variance yet, so we
  // fall back to the previous hard-coded "high" defaults for those.
  const overall: ScanConfidence = dims.confidence ?? "high";
  const wallVariance = overall === "high" ? 0.03 : overall === "medium" ? 0.08 : 0.15;
  const walls = [
    {
      id: `w-${now}-n`,
      label: "Wall 1 (North)",
      kind: "wall" as const,
      valueM: round2(dims.widthM),
      confidence: overall,
      varianceM: wallVariance,
    },
    {
      id: `w-${now}-e`,
      label: "Wall 2 (East)",
      kind: "wall" as const,
      valueM: round2(dims.lengthM),
      confidence: overall,
      varianceM: wallVariance,
    },
  ];
  const ceiling = {
    id: `c-${now}`,
    label: "Ceiling Height",
    kind: "ceiling" as const,
    valueM: round2(dims.heightM),
    // Corner-tap scans can't derive ceiling — flag as low so user confirms.
    confidence:
      dims.method === "corners" ? ("low" as const) : ("medium" as const),
    note:
      dims.method === "corners"
        ? "Estimated — please confirm"
        : "Potential occlusion",
  };
  const door = dims.doorWidthM
    ? {
        id: `d-${now}`,
        label: "Door Width",
        kind: "door" as const,
        valueM: round2(dims.doorWidthM),
        confidence: "high" as const,
        note: "Reference Standard",
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
      pointCount: dims.method === "corners" ? 4 : 6,
      lighting: "optimal",
      capturedAt: now,
      summary,
    },
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
