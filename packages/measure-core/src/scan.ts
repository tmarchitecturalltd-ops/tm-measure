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
 * Untangle a room outline that crosses itself.
 *
 * A traced room is the corners in the order they were tapped, and
 * people do not always go round. Skip one and come back for it, tap
 * the far corner before the near one, or simply lose your place in a
 * six-sided room, and two of the edges cross — the outline becomes a
 * bowtie. Reported as an L-shaped room coming out twisted, and the
 * drawing was exactly that: a figure of eight with the right wall
 * lengths in the wrong order.
 *
 * Nothing downstream can survive it. The shoelace area of a
 * self-intersecting polygon is meaningless — the crossed lobes
 * cancel — so the floor area is wrong, the mitred wall faces fold
 * through each other, and the DXF contains a shape no room has.
 *
 * The fix is to sort the corners by their bearing from the centre.
 * Any set of points ordered that way traces a simple polygon, and
 * for the shapes a room is actually made of it is the one the
 * customer meant: going round is going round, whichever corner you
 * started from.
 *
 * Applied only when the outline genuinely crosses itself. A correct
 * polygon is returned untouched, which matters because the angular
 * sort is not always right for a deeply concave room — it will
 * straighten a tight U into something simpler but not identical. A
 * simplified room is a recoverable error; a bowtie is not.
 */
export function untangleOutline(
  polygon: { x: number; z: number }[],
): { x: number; z: number }[] {
  if (polygon.length < 4) return polygon;
  if (!polygonSelfIntersects(polygon)) return polygon;

  const cx = polygon.reduce((s, p) => s + p.x, 0) / polygon.length;
  const cz = polygon.reduce((s, p) => s + p.z, 0) / polygon.length;
  return [...polygon].sort(
    (a, b) => Math.atan2(a.z - cz, a.x - cx) - Math.atan2(b.z - cz, b.x - cx),
  );
}

/** Do any two non-adjacent edges of this closed polygon cross? */
export function polygonSelfIntersects(
  polygon: { x: number; z: number }[],
): boolean {
  const n = polygon.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a1 = polygon[i];
    const a2 = polygon[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      // Skip edges that share an endpoint — touching is not crossing.
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      if (segmentsCross(a1, a2, polygon[j], polygon[(j + 1) % n])) return true;
    }
  }
  return false;
}

function segmentsCross(
  p1: { x: number; z: number },
  p2: { x: number; z: number },
  p3: { x: number; z: number },
  p4: { x: number; z: number },
): boolean {
  const d = (
    a: { x: number; z: number },
    b: { x: number; z: number },
    c: { x: number; z: number },
  ) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);

  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);

  // Strict crossing only. Collinear and touching cases are left
  // alone: a room with two corners on the same line is odd but not
  // broken, and "fixing" it would reorder a polygon that was right.
  return (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  );
}

/**
 * Square up an outline that was meant to be square.
 *
 * Every tapped corner carries a few centimetres of error — where
 * the finger landed, where ARKit thinks the camera is. Individually
 * that is fine. Collectively it means no two walls come out
 * parallel and no corner comes out at ninety degrees, so a plain
 * rectangular bedroom reaches the drawing visibly askew. Reported
 * as the room being square but the floor plan looking wonky, which
 * is exactly right: the lengths were close and the angles were not.
 *
 * Almost every room in a British house is rectilinear — walls meet
 * at right angles and run in one of two directions. That is a very
 * strong prior, and it lets us treat the small angular errors as
 * what they are: noise around a known answer.
 *
 * So: take the longest wall as the room's axis, snap every other
 * wall to the nearest quarter turn from it, and rebuild the outline
 * from the measured lengths. Then close the loop — the snapped
 * lengths will not quite meet, and the gap is shared out across the
 * walls in proportion to their length, so a 5 m wall absorbs more
 * of it than a 1 m one.
 *
 * Decided wall by wall, not for the room as a whole.
 *
 * This used to give up entirely the moment any one wall sat more
 * than 15 degrees off an axis, on the reasoning that such a room is
 * a bay or a splay and squaring it would destroy the thing the
 * survey was for. The first half of that is right and the
 * conclusion was wrong, because it threw away the eight walls it
 * could have helped along with the two it could not. A real
 * Victorian front room — four square walls and a three-sided bay —
 * got no correction at all and reached the drawing askew, bay and
 * all. Reported as the CAD drawing being rotated.
 *
 * So the test is now per wall. A wall near an axis is noise around
 * a right angle and gets snapped; a wall well off one is a bay
 * cheek and is left at exactly the angle it was measured at. The
 * splay survives, the room around it comes out square.
 *
 * The tolerance had to come down to 8 degrees as part of that,
 * because it changed job. At 15 it was a wide net for deciding when
 * to do *nothing*, and wide was the safe direction: a shape that
 * fell outside it was returned untouched. The same number now
 * decides when to *move a wall*, where wide is the dangerous
 * direction — an 11 degree splay is inside 15, and snapping it
 * flattens a real feature of somebody's house.
 *
 * 8 is above the measurement: tap and LiDAR error put a wall one to
 * three degrees off square, so there is comfortable room for noise
 * underneath it. And it is below the architecture: a wall a joiner
 * built off square, a bay cheek, a splayed corner are all steeper
 * than 8 degrees, because nobody builds a feature that shallow.
 * Anything in between is left alone, which is the conservative
 * answer in a drawing someone is going to build from.
 */
export const SQUARE_UP_TOLERANCE_DEG = 8;

export function squareUpOutline(
  polygon: { x: number; z: number }[],
): { x: number; z: number }[] {
  const n = polygon.length;
  if (n < 4) return polygon;

  const edges = polygon.map((p, i) => {
    const q = polygon[(i + 1) % n];
    return { dx: q.x - p.x, dz: q.z - p.z };
  });
  const lengths = edges.map((e) => Math.hypot(e.dx, e.dz));
  if (lengths.some((l) => l < 1e-6)) return polygon;

  // The room's own axis: the direction of its longest wall.
  let longest = 0;
  for (let i = 1; i < n; i++) if (lengths[i] > lengths[longest]) longest = i;
  const axis = Math.atan2(edges[longest].dz, edges[longest].dx);

  /*
   * Each wall's direction: snapped to a quarter turn if it is close
   * to one, kept exactly as measured if it is not.
   */
  const dirs: { x: number; z: number }[] = [];
  let snappedAny = false;
  for (let i = 0; i < n; i++) {
    const measured = Math.atan2(edges[i].dz, edges[i].dx);
    const rel = measured - axis;
    const q = Math.round(rel / (Math.PI / 2));
    const offBy = Math.abs(rel - q * (Math.PI / 2)) * (180 / Math.PI);
    const a = offBy <= SQUARE_UP_TOLERANCE_DEG
      ? axis + q * (Math.PI / 2)
      : measured;
    if (offBy <= SQUARE_UP_TOLERANCE_DEG && offBy > 1e-9) snappedAny = true;
    dirs.push({ x: Math.cos(a), z: Math.sin(a) });
  }
  if (!snappedAny) return polygon;

  /*
   * Close the loop without touching any angle.
   *
   * Walking the snapped directions with the measured lengths leaves
   * a gap of a few centimetres, because the angles have moved and
   * the lengths have not. Only the lengths may change now — a bay
   * cheek that was kept at 40 degrees has to still be at 40
   * degrees when this is done, or the whole point of keeping it is
   * lost.
   *
   * Finding the smallest set of length changes that closes the gap
   * is two equations in n unknowns, so there are many answers and
   * we want the gentlest. Weighting each wall by its own length
   * gives it: the correction lands in proportion to how much drift
   * a wall could have accumulated, so a 5 m wall absorbs more of it
   * than a 1 m one, and nothing is nudged more than it has to be.
   *
   *   M = sum_i  L_i * (d_i outer d_i)        (2x2, symmetric)
   *   solve M . lambda = gap
   *   dL_i = L_i * (d_i . lambda)
   *
   * which satisfies sum_i d_i * dL_i = gap exactly.
   */
  let gx = 0;
  let gz = 0;
  let mxx = 0;
  let mxz = 0;
  let mzz = 0;
  for (let i = 0; i < n; i++) {
    gx -= dirs[i].x * lengths[i];
    gz -= dirs[i].z * lengths[i];
    mxx += lengths[i] * dirs[i].x * dirs[i].x;
    mxz += lengths[i] * dirs[i].x * dirs[i].z;
    mzz += lengths[i] * dirs[i].z * dirs[i].z;
  }

  // Singular only if every wall is parallel, which is not a room.
  const det = mxx * mzz - mxz * mxz;
  if (Math.abs(det) < 1e-9) return polygon;
  const lx = (mzz * gx - mxz * gz) / det;
  const lz = (mxx * gz - mxz * gx) / det;

  const scaled = lengths.map(
    (L, i) => L + L * (dirs[i].x * lx + dirs[i].z * lz),
  );
  // A correction big enough to invert a wall means the outline was
  // not a near-rectilinear room in the first place. Leave it alone
  // rather than emit something folded.
  if (scaled.some((L) => L <= 0.01)) return polygon;

  const out: { x: number; z: number }[] = [polygon[0]];
  for (let i = 0; i < n - 1; i++) {
    const prev = out[i];
    out.push({
      x: Number((prev.x + dirs[i].x * scaled[i]).toFixed(3)),
      z: Number((prev.z + dirs[i].z * scaled[i]).toFixed(3)),
    });
  }
  return out;
}

/**
 * Put a scanned door or window on the outline it belongs to.
 *
 * RoomPlan reports an opening as a wall id plus a distance along
 * that wall, and the app believed both. Neither survives the trip
 * to the drawing.
 *
 * The wall id is matched inside the plugin by comparing the
 * opening's centre to each wall's *centre*, so a window near the
 * end of a five-metre wall is "nearest" to the midpoint of the
 * short wall round the corner, and gets drawn there. That is how a
 * front door ended up on the chimney breast.
 *
 * The distance is measured along RoomPlan's wall, which is the
 * inner face and stops short of the corners, while the drawing is
 * built from the floor outline, which does not. The two disagree by
 * the wall thickness at each end — and an opening reported as
 * centred on a wall 600 mm shorter than the edge it is drawn on
 * lands 300 mm from the middle. Which is the figure that came back
 * from a tape measure.
 *
 * Both problems come from the same place: a wall and an edge are
 * not the same object. So neither is used. The opening carries its
 * own measured centre point, and that point is dropped
 * perpendicularly onto each edge of the outline the drawing will
 * actually use. Nearest edge wins, and the distance along it comes
 * out of the same projection.
 *
 * Positions are frame-independent once they are an edge index and a
 * distance, so this is safe to run before the outline is squared or
 * rotated — rotating a shape does not renumber its edges.
 *
 * Returns null when there is no outline to place against, leaving
 * the caller to fall back to whatever the sensor said.
 */
/**
 * The sharpest corner in an outline, in degrees.
 *
 * Rooms do not have sharp corners. Almost every corner in a house
 * is 90 or 270; a bay brings 135, a splayed wall maybe 110. Nothing
 * a builder makes comes to a point.
 *
 * So a 15 degree corner is not a room, it is a mistake — and it is
 * the specific mistake that happens when one corner of a trace
 * lands somewhere the others did not expect. A hotel room with a
 * bed in one corner came back with two spikes and a 6.91 m wall
 * closing a room whose longest real wall is 4.7 m, because the
 * blocked corner could not be tapped and the outline closed across
 * the gap instead.
 */
export function sharpestCornerDeg(
  polygon: { x: number; z: number }[],
): number {
  const n = polygon.length;
  if (n < 3) return 180;

  let sharpest = 180;
  for (let i = 0; i < n; i++) {
    const a = polygon[(i + n - 1) % n];
    const b = polygon[i];
    const c = polygon[(i + 1) % n];
    const v1 = { x: a.x - b.x, z: a.z - b.z };
    const v2 = { x: c.x - b.x, z: c.z - b.z };
    const m1 = Math.hypot(v1.x, v1.z);
    const m2 = Math.hypot(v2.x, v2.z);
    if (m1 < 1e-6 || m2 < 1e-6) continue;
    const cos = Math.min(
      1,
      Math.max(-1, (v1.x * v2.x + v1.z * v2.z) / (m1 * m2)),
    );
    const deg = (Math.acos(cos) * 180) / Math.PI;
    if (deg < sharpest) sharpest = deg;
  }
  return Number(sharpest.toFixed(1));
}

/**
 * Below this, a corner is a mistake rather than a room.
 *
 * Set well clear of anything a building has. Square corners
 * measure 90 here, and so do reflex ones, because the angle is
 * taken without a sign. A bay gives 135, a splayed wall 110. The
 * shapes that come back from a trace with a corner missing are
 * down at 15 to 30, so there is a wide empty band in between and
 * no need to put the line near either edge of it.
 */
export const SPIKE_CORNER_DEG = 40;

/**
 * Something is wrong with this outline, in words, or null.
 *
 * Written to be read by a homeowner standing in the room, because
 * that is the only place and time it can still be fixed. The review
 * screen used to say "Nothing to type. The scan measured all of
 * this. Have a quick look and carry on." over a drawing that was
 * visibly not the room — which is the app being confidently wrong,
 * and worse than saying nothing.
 *
 * Deliberately a warning rather than a block. The customer is the
 * one who can see the room; if they say the shape is right, it is
 * right, and plenty of odd-shaped rooms exist.
 */
export function outlineProblem(
  polygon: { x: number; z: number }[] | undefined,
): string | null {
  if (!polygon || polygon.length < 3) return null;

  const sharp = sharpestCornerDeg(polygon);
  if (sharp < SPIKE_CORNER_DEG) {
    return (
      "One corner of this shape comes to a sharp point, which rooms " +
      "don't usually do. A corner that couldn't be tapped — behind a " +
      "bed or a sofa — does exactly this. Worth tracing again."
    );
  }

  /*
   * A wall longer than the room it is in.
   *
   * The giveaway when a corner is missing altogether: the outline
   * closes straight across the room, so the closing wall is longer
   * than anything that could fit along an edge of it.
   */
  const xs = polygon.map((p) => p.x);
  const zs = polygon.map((p) => p.z);
  const diagonal = Math.hypot(
    Math.max(...xs) - Math.min(...xs),
    Math.max(...zs) - Math.min(...zs),
  );
  const n = polygon.length;
  let longest = 0;
  for (let i = 0; i < n; i++) {
    const q = polygon[(i + 1) % n];
    longest = Math.max(
      longest,
      Math.hypot(q.x - polygon[i].x, q.z - polygon[i].z),
    );
  }
  if (diagonal > 0.1 && longest > diagonal * 0.98) {
    return (
      "One wall runs the full width of this shape, which usually " +
      "means a corner was missed and the outline closed across the " +
      "room. Worth tracing again."
    );
  }

  return null;
}

export function placeOpeningOnOutline(
  centreM: { x: number; z: number },
  polygon: { x: number; z: number }[] | undefined,
): { wallIndex: number; positionM: number } | null {
  if (!polygon || polygon.length < 3) return null;

  const n = polygon.length;
  let bestIndex = -1;
  let bestDist = Infinity;
  let bestAlong = 0;

  for (let i = 0; i < n; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % n];
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const len2 = ex * ex + ez * ez;
    if (len2 < 1e-9) continue;

    // How far along the edge the foot of the perpendicular sits,
    // clamped so an opening slightly past a corner lands at the
    // corner rather than off the end of the wall.
    const tRaw = ((centreM.x - a.x) * ex + (centreM.z - a.z) * ez) / len2;
    const t = Math.max(0, Math.min(1, tRaw));
    const dx = centreM.x - (a.x + ex * t);
    const dz = centreM.z - (a.z + ez * t);
    const d = Math.hypot(dx, dz);
    if (d < bestDist) {
      bestDist = d;
      bestIndex = i;
      bestAlong = t * Math.sqrt(len2);
    }
  }

  if (bestIndex < 0) return null;
  return {
    wallIndex: bestIndex,
    positionM: Number(bestAlong.toFixed(3)),
  };
}

/**
 * Turn an outline so its longest wall runs horizontal.
 *
 * A traced room is drawn at whatever compass heading the customer
 * happened to be facing when the session started. That heading says
 * nothing about the house — it is an artefact of where they stood —
 * so a perfectly rectangular bedroom lands on the plan at a random
 * tilt and looks wrong to everybody who sees it.
 *
 * Rotating the outline is turning the sheet of paper, not redrawing
 * the room: every wall length, every angle between walls and the
 * floor area are untouched.
 *
 * The heading is returned rather than thrown away, because it is a
 * real measurement even though it is not a useful one here. Rooms
 * arrive unplaced and the customer arranges them on the plan, so
 * nothing downstream currently uses the angle between one room and
 * the next. The day they do — a merged whole-house trace, say —
 * this is the number that puts them back in their true relative
 * orientation.
 */
export function axisAlignOutline(polygon: { x: number; z: number }[]): {
  polygon: { x: number; z: number }[];
  headingDeg: number;
} {
  const n = polygon.length;
  if (n < 3) return { polygon, headingDeg: 0 };

  let longest = 0;
  let best = -1;
  for (let i = 0; i < n; i++) {
    const q = polygon[(i + 1) % n];
    const d = Math.hypot(q.x - polygon[i].x, q.z - polygon[i].z);
    if (d > best) {
      best = d;
      longest = i;
    }
  }

  const a = polygon[longest];
  const b = polygon[(longest + 1) % n];
  const heading = Math.atan2(b.z - a.z, b.x - a.x);
  const cos = Math.cos(-heading);
  const sin = Math.sin(-heading);

  const turned = polygon.map((p) => ({
    x: p.x * cos - p.z * sin,
    z: p.x * sin + p.z * cos,
  }));

  /*
   * Brought back to its own corner, here rather than by the caller.
   *
   * The rotation is about the origin, so an outline that was
   * already sitting at (0,0) does not stay there -- it swings out
   * to wherever the turn puts it, often with every coordinate
   * negative. Every caller wants room-local points, measured from
   * the outline's own top-left, because that is what the plan
   * editor and the DXF both assume.
   *
   * One caller did this itself and one did not, and the one that
   * did not shipped: a scanned kitchen drew its outline floating
   * above the plan while its doors, windows and name label stayed
   * down on the anchor, as though the room and its openings were
   * two different rooms. Normalising inside the rotation is the
   * only version of this that cannot be got wrong, because the two
   * halves can no longer be separated.
   */
  const minX = Math.min(...turned.map((p) => p.x));
  const minZ = Math.min(...turned.map((p) => p.z));

  return {
    polygon: turned.map((p) => ({
      x: Number((p.x - minX).toFixed(3)),
      z: Number((p.z - minZ).toFixed(3)),
    })),
    headingDeg: Number((((heading * 180) / Math.PI + 360) % 360).toFixed(1)),
  };
}

/**
 * Is this one room, or several the sensor joined together?
 *
 * The opposite failure to looksLikeStrayCapture, and the more
 * expensive one. RoomPlan decides for itself where one room ends and
 * the next begins, and through a wide opening or an open-plan ground
 * floor it often decides they do not — returning a single room 8 m by
 * 7 m with five doors and seven windows in it. That reached the
 * drawing as one rectangle the size of a house, and nothing anywhere
 * said so: it was only spotted by reading the dimensions on a
 * submission and thinking they looked odd.
 *
 * Two tests, either of which is enough:
 *
 * Area. The largest room in an ordinary British house is a through
 * lounge or a kitchen-diner at around 35 m2. Above 45 there is a good
 * chance the sensor has joined two spaces. Not a certainty — genuine
 * open-plan extensions run to 60 — which is why this warns and never
 * deletes.
 *
 * Openings. Doors are the better signal, because a room's door count
 * is bounded by how houses are built in a way its area is not: two or
 * three is normal, four is a hall, and five means the capture has
 * swallowed the hall and what opens off it. Counted together with
 * windows because a merged capture usually has too many of both.
 *
 * The point is not to be right. It is that the only person who can
 * fix a merged capture is the customer, while they are still in the
 * house, and they cannot fix what nobody told them about.
 */
export const MERGED_CAPTURE_MIN_M2 = 45;
export const MERGED_CAPTURE_MIN_DOORS = 5;
export const MERGED_CAPTURE_MIN_OPENINGS = 9;

export function looksLikeMergedCapture(opts: {
  widthM: number;
  lengthM: number;
  floorAreaM2?: number;
  doorCount?: number;
  windowCount?: number;
}): boolean {
  const { widthM, lengthM, floorAreaM2, doorCount = 0, windowCount = 0 } = opts;
  const area =
    Number.isFinite(floorAreaM2) && (floorAreaM2 as number) > 0
      ? (floorAreaM2 as number)
      : widthM * lengthM;

  if (Number.isFinite(area) && area >= MERGED_CAPTURE_MIN_M2) return true;
  if (doorCount >= MERGED_CAPTURE_MIN_DOORS) return true;
  return doorCount + windowCount >= MERGED_CAPTURE_MIN_OPENINGS;
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
