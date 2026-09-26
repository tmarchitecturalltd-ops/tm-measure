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

/**
 * Is a scanned floor outline good enough to draw from?
 *
 * RoomPlan's floor polygon is not always the tidy room outline the
 * bounding metrics suggest. A scan that saw the floor at a glancing
 * angle, or one interrupted part-way, can return a sliver — a few
 * near-collinear points hugging one wall — while `widthM` and
 * `lengthM` remain sensible, because those come from the walls rather
 * than the floor.
 *
 * Drawn straight, that produces a room labelled "4.34 x 3.33 m" and
 * rendered as a thin spike, which is what Charlie saw. The numbers were
 * right and the shape was nonsense, and the shape is what a person
 * looks at.
 *
 * So the polygon has to earn its place. It must:
 *   - have at least three points;
 *   - span roughly the width and length the walls reported;
 *   - enclose a decent fraction of its own bounding box.
 *
 * Anything else falls back to the rectangle, which is less informative
 * and never absurd. Tolerances are loose because a genuine L-shape
 * fails a strict version of all three.
 */
export function scanPolygonIsUsable(
  polygon: { x: number; z: number }[] | undefined,
  widthM: number,
  lengthM: number,
): boolean {
  if (!polygon || polygon.length < 3) return false;
  if (!(widthM > 0) || !(lengthM > 0)) return false;

  const box = orientedExtentM(polygon);
  if (!box) return false;

  // The outline's own box should resemble the reported footprint.
  // Either order, because which of the two the plugin called "width"
  // depends on its longest wall and carries no meaning here.
  const expected = [
    [widthM, lengthM],
    [lengthM, widthM],
  ];
  const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.5, b * 0.25);
  const boxMatches = expected.some(([w, l]) => near(box.w, w) && near(box.l, l));
  if (!boxMatches) return false;

  // Shoelace area against that same box. A sliver fills almost none of
  // it; an L-shape, the worst honest case, still fills half.
  let twiceArea = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    twiceArea += a.x * b.z - b.x * a.z;
  }
  const fill = Math.abs(twiceArea) / 2 / (box.w * box.l);
  return fill >= 0.45;
}

/**
 * The smallest rectangle that contains the outline, at any angle.
 *
 * This replaces a min/max over x and z, and the difference is the
 * whole point. The polygon arrives in the scan's shared world frame,
 * but `widthM` and `lengthM` are measured along the room's own longest
 * wall — so the two were only comparable when the house happened to be
 * square to the frame, which is decided by whichever direction the
 * customer was facing when the scan started.
 *
 * A room at 45° to that frame has an axis-aligned span about 1.41x its
 * true size. The tolerance is 25%, so the outline failed the check,
 * was thrown away, and the room was drawn as a rectangle — the numbers
 * still right, because they never came from the polygon. That is
 * exactly the symptom reported: rooms coming back square for no
 * visible reason, on scans that looked fine.
 *
 * Measured by testing each edge direction in turn. The minimum-area
 * rectangle around a convex shape always lies flush with one of its
 * edges; a room outline is close enough to convex, and its edges are
 * its walls, so the winning direction is a wall direction — which is
 * the frame the reported width and length are already in.
 *
 * Exported because it answers "how big is this room, really" without
 * reference to which way the phone was pointing, which is worth having
 * on its own.
 */
export function orientedExtentM(
  polygon: { x: number; z: number }[],
): { w: number; l: number } | null {
  let best: { w: number; l: number; area: number } | null = null;

  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const edge = Math.hypot(dx, dz);
    if (edge < 1e-6) continue;

    // Unit vector along this edge, and its perpendicular.
    const ux = dx / edge;
    const uz = dz / edge;

    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of polygon) {
      const u = p.x * ux + p.z * uz;
      const v = -p.x * uz + p.z * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }

    const w = maxU - minU;
    const l = maxV - minV;
    if (!(w > 0) || !(l > 0)) continue;
    const area = w * l;
    if (!best || area < best.area) best = { w, l, area };
  }

  return best ? { w: best.w, l: best.l } : null;
}

/**
 * Is a scanned outline worth keeping over a plain rectangle?
 *
 * The app used to ask RoomPlan, which reports a `rectangular` flag --
 * and anything flagged rectangular had its outline discarded. That
 * flag is `area / boundingBoxArea > 0.90`, which is a fair description
 * of a room and a poor filter for this decision, because the features
 * that make an outline worth keeping are small. A chimney breast in a
 * 9 m2 kitchen is roughly 0.4 m2: the room scores 96%, is called
 * rectangular, and the chimney breast is thrown away.
 *
 * Charlie found it on a real kitchen -- "the 3d picks up all windows
 * and little dog legs, the 2d floor plan shows it as a rectangle".
 *
 * Corner count is the better question, and the one we actually mean. A
 * genuinely rectangular room comes back with four corners. Five or
 * more means there is a feature in it: an alcove, a chimney breast, a
 * dog leg, a bay. That feature is the reason someone is paying for a
 * survey rather than pacing it out.
 *
 * scanPolygonIsUsable still has the final say, because a sliver drawn
 * faithfully is worse than a rectangle drawn approximately.
 */
export function scanOutlineWorthKeeping(
  polygon: { x: number; z: number }[] | null | undefined,
  widthM: number,
  lengthM: number,
): boolean {
  if (!polygon || polygon.length < 5) return false;
  return scanPolygonIsUsable(polygon, widthM, lengthM);
}

/**
 * Is this capture a room, or something glimpsed on the way past?
 *
 * A whole-property scan picks up whatever the sensor sees, and that
 * includes places nobody walked into: a hallway through an open door,
 * a cupboard, half the room next door. They arrive as rooms, get
 * numbered like rooms, and the customer is then asked to name and
 * photograph them.
 *
 * Floor area is the honest test. Nothing anyone deliberately surveys
 * is under a square metre and a half -- that is a doorway or a broom
 * cupboard -- while the smallest real room in a British house, a
 * downstairs loo, is comfortably above it.
 *
 * Used to pre-untick rows on the review screen, not to delete
 * anything. A cupboard genuinely being surveyed is one tap away.
 */
export const STRAY_CAPTURE_MAX_M2 = 1.5;

export function looksLikeStrayCapture(
  widthM: number,
  lengthM: number,
  floorAreaM2?: number,
): boolean {
  const area =
    Number.isFinite(floorAreaM2) && (floorAreaM2 as number) > 0
      ? (floorAreaM2 as number)
      : widthM * lengthM;
  if (!Number.isFinite(area) || area <= 0) return true;
  return area < STRAY_CAPTURE_MAX_M2;
}

/**
 * A room outline scaled into a small box, for a thumbnail.
 *
 * Returns an SVG path and the viewBox to draw it in, or null when
 * there is no outline worth drawing. Lives here rather than in the
 * component because it is geometry, and because the review screen and
 * anything else that wants to show a room's shape should agree.
 *
 * The aspect ratio is preserved and the shape is centred, so a long
 * thin hallway reads as a long thin hallway rather than being
 * stretched to fill the square.
 */
export function outlineThumbnail(
  polygon: { x: number; z: number }[] | null | undefined,
  boxPx = 40,
  padPx = 3,
): { path: string; size: number } | null {
  if (!polygon || polygon.length < 3) return null;
  const xs = polygon.map((p) => p.x);
  const zs = polygon.map((p) => p.z);
  const minX = Math.min(...xs);
  const minZ = Math.min(...zs);
  const w = Math.max(...xs) - minX;
  const h = Math.max(...zs) - minZ;
  if (!(w > 0) || !(h > 0)) return null;

  const inner = boxPx - padPx * 2;
  const scale = Math.min(inner / w, inner / h);
  const offX = padPx + (inner - w * scale) / 2;
  const offZ = padPx + (inner - h * scale) / 2;

  const path =
    polygon
      .map((p, i) => {
        const x = offX + (p.x - minX) * scale;
        const z = offZ + (p.z - minZ) * scale;
        return `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${z.toFixed(2)}`;
      })
      .join(" ") + " Z";

  return { path, size: boxPx };
}
