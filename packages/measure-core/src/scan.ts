/**
 * Scan result types — add to packages/measure-core/src/scan.ts
 * Then re-export from packages/measure-core/src/index.ts:
 *   export * from "./scan";
 *
 * These types describe what a scan (LiDAR / AR corner tap / video)
 * hands back to the UI BEFORE it is written into a RoomDraft.
 * They are intentionally optional so existing RoomDraft callers
 * are unaffected if no scan was performed.
 */

export type ScanConfidence = "high" | "medium" | "low";

/** The kind of thing a measurement refers to, so the UI can label it. */
export type ScanMeasurementKind =
  | "wall"
  | "ceiling"
  | "floor"
  | "door"
  | "window"
  | "opening"
  | "custom";

/** A single detected dimension produced by a scan. */
export type ScanMeasurement = {
  id: string;
  /** Short label e.g. "Wall 1", "Ceiling Height", "Door Width". */
  label: string;
  /** What this measurement refers to. Drives which RoomDraft field it maps to. */
  kind: ScanMeasurementKind;
  /** Value in metres. Always metres internally; format with measure-core/units. */
  valueM: number;
  /** Confidence bucket — drives chip colour in the UI. */
  confidence: ScanConfidence;
  /** +/- variance in metres, if the scanner can produce one. */
  varianceM?: number;
  /**
   * Short note shown under the chip, e.g. "Estimated — please confirm".
   *
   * Set this only for a condition the pipeline genuinely detected. It
   * previously carried "Potential occlusion" and "Reference Standard",
   * neither of which corresponded to any check that runs.
   */
  note?: string;
};

/** Overall scan context / environment notes. */
export type ScanContext = {
  /** Room floor area in m² if derivable from the scan. */
  areaM2?: number;
  /** How many raycast / feature points contributed. */
  pointCount?: number;
  /** Lighting quality as reported by ARKit/ARCore. */
  lighting?: "optimal" | "adequate" | "poor";
  /** Human-readable one-liner surfaced under the dimensions card. */
  summary?: string;
  /** ISO timestamp of when the scan finished. */
  capturedAt?: string;
};

/** Full payload handed from RoomScanOverlay → ScanReviewScreen → applyScanToRoom. */
export type ScanResult = {
  id: string;
  roomId?: string;
  measurements: ScanMeasurement[];
  context: ScanContext;
};

/** Helper: pick the worst confidence across all measurements. */
export function scanOverallConfidence(scan: ScanResult): ScanConfidence {
  if (scan.measurements.some((m) => m.confidence === "low")) return "low";
  if (scan.measurements.some((m) => m.confidence === "medium")) return "medium";
  return "high";
}

/** Helper: sum wall segments into a crude floor area if context.areaM2 absent. */
export function estimateAreaFromWalls(scan: ScanResult): number | undefined {
  const walls = scan.measurements.filter((m) => m.kind === "wall");
  if (walls.length < 2) return undefined;
  const [w, l] = walls;
  if (!Number.isFinite(w.valueM) || !Number.isFinite(l.valueM)) return undefined;
  return Number((w.valueM * l.valueM).toFixed(2));
}
