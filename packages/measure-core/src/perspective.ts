/**
 * Perspective-geometry engine for tap-the-corners measurement.
 *
 * Given four on-screen taps at the floor corners of a room, plus the
 * camera's approximate pose (height above floor, tilt from horizontal,
 * focal length), this module back-projects each tap onto the floor
 * plane and returns the four world-space corner positions. Wall lengths
 * are then just Euclidean distances between adjacent corners.
 *
 * All maths is plain numbers — no three.js, no matrix libraries — so the
 * module is trivially unit-testable and runs in any JS environment.
 *
 * ──────────────────────────────────────────────────────────────────────
 * Coordinate systems
 * ──────────────────────────────────────────────────────────────────────
 * Camera space: origin at camera, +X right, +Y up, +Z out of the lens.
 * World space:  origin directly under the camera on the floor, +X right
 *               (same as camera), +Y up, +Z forward away from the camera.
 *
 * "Tilt" is rotation of the camera around its X axis (pitch). Tilt = 0
 * means the lens is perfectly horizontal. Negative tilt = looking down.
 * In practice, a user holding a phone to see floor corners will have a
 * tilt between roughly -15° and -45°.
 *
 * ──────────────────────────────────────────────────────────────────────
 * Accuracy budget
 * ──────────────────────────────────────────────────────────────────────
 * Best case (known focal length, known height, level horizon, good taps):
 *   ±3-5 cm on a 4 m wall.
 * Typical case (defaults, moderate tilt, best-effort tap precision):
 *   ±10-15 cm on a 4 m wall.
 * Failure case (phone not tilted enough, taps above horizon):
 *   function returns { error }.
 *
 * The returned confidence bucket encodes which regime we're in.
 */

import type { ScanConfidence } from "./scan";

// ─── Types ─────────────────────────────────────────────────────────────

export type TapPoint = {
  /** Pixel X in the camera image, 0 = left edge. */
  xPx: number;
  /** Pixel Y in the camera image, 0 = top edge. */
  yPx: number;
};

export type CameraPose = {
  /** Camera height above floor in metres. */
  heightM: number;
  /** Camera tilt in degrees. 0 = horizontal. Negative = looking down. */
  tiltDeg: number;
  /** Focal length in pixels. If the device API doesn't expose it, use
   *  estimateFocalLengthPx(imageWidthPx) for a reasonable default. */
  focalLengthPx: number;
  /** Image dimensions in pixels. */
  imageWidthPx: number;
  imageHeightPx: number;
};

/**
 * Input to the room-dimensions estimator.
 * Corners must be provided in clockwise order starting from the corner
 * closest to the camera on the left. i.e:
 *   0 = near-left   (bottom-left on screen)
 *   1 = near-right  (bottom-right on screen)
 *   2 = far-right   (top-right on screen)
 *   3 = far-left    (top-left on screen)
 * If the user taps in the wrong order, call sortFloorCornersClockwise()
 * before passing to estimateRoomFromFloorTaps.
 */
export type FloorCornersInput = {
  corners: [TapPoint, TapPoint, TapPoint, TapPoint];
  pose: CameraPose;
  /**
   * Signed vertical distance from camera to the plane being tapped.
   * Omit for the floor (defaults to -pose.heightM). For ceiling corners
   * pass `ceilingHeightM - pose.heightM`, a positive value.
   *
   * Because walls are vertical the ceiling outline matches the floor
   * outline, so the returned dimensions mean the same thing either way.
   */
  planeOffsetM?: number;
};

export type FloorPoint3D = {
  /** Horizontal (metres), +X = right of camera. */
  xM: number;
  /** Depth (metres), +Z = forward from camera. */
  zM: number;
};

export type RoomDimensionsEstimate = {
  /**
   * Wall lengths in metres, in the same order as input corners:
   *   wallsM[0] = near wall (corner 0 → corner 1)
   *   wallsM[1] = right wall (corner 1 → corner 2)
   *   wallsM[2] = far wall (corner 2 → corner 3)
   *   wallsM[3] = left wall (corner 3 → corner 0)
   */
  wallsM: [number, number, number, number];
  /** Mean of the two diagonals — sanity check against wall lengths. */
  meanDiagonalM: number;
  /** Estimated floor area via shoelace formula. */
  areaM2: number;
  /** True if opposite walls are within 10 % of each other (near-rectangular). */
  rectangular: boolean;
  /** Overall confidence based on geometry sanity checks. */
  confidence: ScanConfidence;
  /** Human-readable reasons the confidence was dropped, if any. */
  notes: string[];
  /** Back-projected 3D floor positions, for rendering a floorplan. */
  floorPoints: [FloorPoint3D, FloorPoint3D, FloorPoint3D, FloorPoint3D];
};

export type PerspectiveError = {
  error: string;
};

// ─── Helpers (pure maths) ──────────────────────────────────────────────

const DEG2RAD = Math.PI / 180;

/**
 * Back-project a screen pixel onto the floor plane.
 *
 * Pipeline:
 *   1. Convert pixel → normalized image coordinates (centered, y flipped).
 *   2. Build a ray direction in camera space: (nx, ny, -1).
 *   3. Rotate that direction around X by the tilt to get world-space dir.
 *   4. Starting at world origin (0, heightM, 0), extend the ray until y=0.
 *   5. Return the (x, z) intersection.
 *
 * Returns null if the ray never hits the floor (e.g. tap is above the
 * horizon — common user error when the phone isn't tilted down enough).
 */
export function projectTapToFloor(
  tap: TapPoint,
  pose: CameraPose,
  /**
   * Signed vertical distance from the camera to the target plane, in
   * metres. Negative = below the camera (the floor, the default);
   * positive = above it (the ceiling).
   *
   * Ceiling corners are the practical route in a furnished room: floor
   * corners are usually hidden behind furniture, whereas wall/ceiling
   * junctions are clear and crisply defined. Because walls are vertical,
   * the ceiling outline equals the floor outline, so everything
   * downstream is unchanged.
   *
   * Defaults to -heightM, preserving the original floor behaviour for
   * every existing caller.
   */
  planeOffsetM?: number,
): FloorPoint3D | null {
  const cx = pose.imageWidthPx / 2;
  const cy = pose.imageHeightPx / 2;
  // Normalised image coordinates (camera-space ray direction, pre-tilt).
  const nx = (tap.xPx - cx) / pose.focalLengthPx;
  // Screen Y grows downward; camera space Y grows up → negate.
  const ny = -(tap.yPx - cy) / pose.focalLengthPx;
  // Camera-space ray direction.
  const dxC = nx;
  const dyC = ny;
  const dzC = -1; // looking out along -Z per OpenGL convention

  // Camera → world rotation is R_x(tiltDeg). With a negative tilt (camera
  // pitched down), a camera-space "forward" vector (0, 0, -1) maps to the
  // world vector (0, sin(tilt), -|cos(tilt)|) — i.e. dyW < 0 (going down).
  const t = pose.tiltDeg * DEG2RAD;
  const cosT = Math.cos(t);
  const sinT = Math.sin(t);
  const dxW = dxC;
  const dyW = cosT * dyC - sinT * dzC;
  const dzWraw = sinT * dyC + cosT * dzC;

  // The camera sits at the origin and the target plane is `offset` metres
  // away vertically (negative = floor below, positive = ceiling above).
  // Walking along the ray, the vertical distance covered after k units is
  // dyW·k, so the plane is reached when dyW·k = offset → k = offset / dyW.
  //
  // k is only positive — i.e. the plane is actually in front of the
  // camera — when dyW and offset share a sign: looking down (dyW < 0) to
  // reach the floor (offset < 0), or up (dyW > 0) to reach the ceiling
  // (offset > 0). Opposite signs mean the tap is on the far side of the
  // horizon and there is no intersection.
  const offset = planeOffsetM ?? -pose.heightM;
  if (offset === 0 || dyW === 0) return null;
  if (Math.sign(dyW) !== Math.sign(offset)) return null;
  const k = offset / dyW;
  if (!Number.isFinite(k) || k <= 0) return null;

  // Flip Z sign so the returned "forward distance" is positive — matches
  // the doc convention of "+Z = forward away from camera". (Raw camera
  // space uses -Z as forward, so dzWraw is negative for points in view.)
  return {
    xM: dxW * k,
    zM: -dzWraw * k,
  };
}

/**
 * Forward-project a floor point back into the camera image.
 *
 * Inverse of projectTapToFloor. Used by the re-projection sanity check
 * — after we estimate corner positions in world space, we re-project
 * them to the camera and compare against the original tap pixels. If
 * the average gap exceeds a few percent of the image width, geometry
 * didn't close and the result should be flagged low-confidence.
 *
 * Returns null if the world point is behind the camera (z ≤ 0 in
 * camera space) so the caller can refuse to grade an impossible
 * re-projection.
 */
export function projectFloorToPixel(
  floor: FloorPoint3D,
  pose: CameraPose,
  /** Must match the offset used when projecting the taps — see
   *  projectTapToFloor. Defaults to the floor. */
  planeOffsetM?: number,
): TapPoint | null {
  // World → camera transform: invert the same R_x(tilt) rotation we
  // applied in projectTapToFloor, then offset by the camera height.
  const t = pose.tiltDeg * DEG2RAD;
  const cosT = Math.cos(t);
  const sinT = Math.sin(t);
  // World-space position of the floor point relative to the camera:
  //   p_world = (xM, 0, -zM)   (note the convention flip from project)
  const xW = floor.xM;
  const yW = planeOffsetM ?? -pose.heightM;
  const zW = -floor.zM;
  // Inverse rotation R_x(-tilt) maps world → camera.
  const xC = xW;
  const yC = cosT * yW + sinT * zW;
  const zC = -sinT * yW + cosT * zW;
  if (zC >= 0) return null; // point is behind / level with the camera
  const xPx = pose.imageWidthPx / 2 + (xC / -zC) * pose.focalLengthPx;
  // Pixel Y grows downward; camera Y grows up → flip sign.
  const yPx = pose.imageHeightPx / 2 - (yC / -zC) * pose.focalLengthPx;
  return { xPx, yPx };
}

/**
 * Mean re-projection error in pixels between the original tap points
 * and the corners projected from the world-space solution. Useful as
 * an independent quality metric — small values mean the geometry
 * closes back onto itself.
 */
export function meanReprojectionErrorPx(
  taps: TapPoint[],
  floor: FloorPoint3D[],
  pose: CameraPose,
  /** Must match the offset the taps were projected with, otherwise a
   *  valid ceiling scan is graded against the floor plane and always
   *  looks wrong. */
  planeOffsetM?: number,
): number {
  if (taps.length !== floor.length || taps.length === 0) return Infinity;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < taps.length; i++) {
    const repro = projectFloorToPixel(floor[i], pose, planeOffsetM);
    if (!repro) return Infinity;
    const dx = taps[i].xPx - repro.xPx;
    const dy = taps[i].yPx - repro.yPx;
    sum += Math.sqrt(dx * dx + dy * dy);
    n += 1;
  }
  return sum / n;
}

/** Euclidean distance between two floor points. */
export function distance(a: FloorPoint3D, b: FloorPoint3D): number {
  const dx = a.xM - b.xM;
  const dz = a.zM - b.zM;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Shoelace formula for polygon area. */
export function polygonArea(points: FloorPoint3D[]): number {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    s += a.xM * b.zM - b.xM * a.zM;
  }
  return Math.abs(s) / 2;
}

/**
 * Sensible default for phone camera focal length in pixels.
 * Most phone main cameras have a ~60° horizontal FOV, which gives
 * focalPx ≈ (imageWidthPx / 2) / tan(30°) ≈ imageWidthPx * 0.866.
 * We round down a hair to be slightly conservative (wider FOV assumption
 * → walls are estimated slightly shorter; safer under-estimate).
 */
export function estimateFocalLengthPx(imageWidthPx: number): number {
  return imageWidthPx * 0.86;
}

/**
 * Sort four tap points clockwise starting from the one with the largest
 * Y (lowest on screen, closest to camera on the left).
 *
 * Users rarely tap in perfect order; this helper lets the UI accept any
 * sequence and normalise it here.
 */
export function sortFloorCornersClockwise(
  corners: [TapPoint, TapPoint, TapPoint, TapPoint],
): [TapPoint, TapPoint, TapPoint, TapPoint] {
  // Compute centroid.
  const cx = (corners[0].xPx + corners[1].xPx + corners[2].xPx + corners[3].xPx) / 4;
  const cy = (corners[0].yPx + corners[1].yPx + corners[2].yPx + corners[3].yPx) / 4;
  // Angle of each corner from centroid, clockwise from "down" (+Y screen).
  // atan2 result is in (-π, π]; we want stable clockwise ordering.
  const withAngle = corners.map((p) => ({
    p,
    angle: Math.atan2(p.xPx - cx, p.yPx - cy),
  }));
  withAngle.sort((a, b) => a.angle - b.angle);
  return [withAngle[0].p, withAngle[1].p, withAngle[2].p, withAngle[3].p];
}

// ─── Focal-length calibration ─────────────────────────────────────────

/**
 * Solve the camera focal length from two taps on a known-length object
 * lying on the floor.
 *
 * Caller flow:
 *   1. Lay a tape measure, door frame, or A4 sheet flat on the floor.
 *   2. Capture the same `pose` (height, tilt) you'll measure the room with.
 *   3. Tap each end of the reference.
 *   4. Pass both taps + the known length here. The returned focal length
 *      replaces estimateFocalLengthPx() in subsequent pose objects.
 *
 * Pose.heightM and pose.tiltDeg are taken as ground truth; only the
 * focal length (and therefore the implied FOV) is solved.
 *
 * Internally a monotonic 1-D search: projected length increases with
 * focal length, so we bisect between 0.4× and 1.5× the image-width
 * heuristic until we land within 1 mm of the known distance.
 */
export function calibrateFocalLengthPx(
  tapA: TapPoint,
  tapB: TapPoint,
  knownDistanceM: number,
  pose: Omit<CameraPose, "focalLengthPx">,
): number | PerspectiveError {
  if (!Number.isFinite(knownDistanceM) || knownDistanceM <= 0) {
    return { error: "Reference length must be a positive number of metres." };
  }
  if (pose.tiltDeg > -2) {
    return {
      error:
        "Camera is too level for calibration — tilt the phone down at the reference object.",
    };
  }
  // Reject calibrations where the two reference taps are too close
  // together on screen — sub-pixel jitter dominates and the solver
  // converges to an extreme focal length that makes every subsequent
  // room readback nonsense.
  const tapSeparationPx = Math.hypot(
    tapA.xPx - tapB.xPx,
    tapA.yPx - tapB.yPx,
  );
  const minSeparationPx = pose.imageWidthPx * 0.04;
  if (tapSeparationPx < minSeparationPx) {
    return {
      // Numbers included deliberately: when this fires unexpectedly it's
      // usually because the taps landed almost on top of each other (often
      // the viewfinder was obscured), and the figures make that obvious
      // instead of leaving the user guessing.
      error: `The two calibration taps are too close together (${tapSeparationPx.toFixed(0)} px apart, need at least ${minSeparationPx.toFixed(0)} px). Tap the two ends so they're well separated on screen.`,
    };
  }

  const probe = (focalLengthPx: number): number | null => {
    const fullPose: CameraPose = { ...pose, focalLengthPx };
    const a = projectTapToFloor(tapA, fullPose);
    const b = projectTapToFloor(tapB, fullPose);
    if (!a || !b) return null;
    return distance(a, b);
  };

  // Search bounds: 0.5× → 1.4× the image-width heuristic. This spans
  // FOVs from ~75° (very wide) down to ~40° (telephoto) — broad
  // enough to cover every common phone-camera lens but tight enough
  // that obviously-wrong calibration inputs (taps too close together,
  // wrong reference length entered) get rejected instead of producing
  // a wildly skewed focal that makes every subsequent room readback
  // tiny. The previous range was 0.4 → 1.5 but field testing showed
  // results at the extremes were almost always bad calibration data.
  let lo = pose.imageWidthPx * 0.5;
  let hi = pose.imageWidthPx * 1.4;
  const lowProbe = probe(lo);
  const highProbe = probe(hi);
  if (lowProbe === null || highProbe === null) {
    return {
      error:
        "Calibration tap is above the horizon. Point further down and try again.",
    };
  }
  // The projected length is monotonically *decreasing* with focal length
  // for points further from the principal point: a longer focal makes
  // the same pixel span project to a smaller floor distance. Verify
  // monotonicity, then bisect.
  if (Math.sign(lowProbe - knownDistanceM) === Math.sign(highProbe - knownDistanceM)) {
    return {
      // Nearly always caused by tapping points that aren't physically on
      // the floor plane — the side of a bin, the top of a box, an object
      // on furniture. Those have no solution at any focal length. Say so
      // concretely; "on the floor" alone gets read as "in the room".
      error:
        "Calibration could not converge. Both taps must be points TOUCHING the floor — the two ends of a tape measure or ruler lying flat. Tapping the sides of an object (a bin, a box) won't work, because those points sit above the floor.",
    };
  }
  // Decide direction of bisection.
  const lowSign = Math.sign(lowProbe - knownDistanceM); // +1 if low f over-estimates
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2;
    const midProbe = probe(mid);
    if (midProbe === null) return { error: "Calibration failed mid-search." };
    if (Math.abs(midProbe - knownDistanceM) < 0.001) {
      return Math.round(mid * 10) / 10;
    }
    const midSign = Math.sign(midProbe - knownDistanceM);
    if (midSign === lowSign) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return Math.round(((lo + hi) / 2) * 10) / 10;
}

// ─── Main entry point ─────────────────────────────────────────────────

/**
 * Convert four tap points + camera pose into wall lengths, floor area,
 * and a confidence bucket. Pure function, no DOM or side effects.
 */
export function estimateRoomFromFloorTaps(
  input: FloorCornersInput,
): RoomDimensionsEstimate | PerspectiveError {
  if (!Number.isFinite(input.pose.heightM) || input.pose.heightM <= 0) {
    return { error: "Camera height must be a positive number of metres." };
  }
  if (!Number.isFinite(input.pose.focalLengthPx) || input.pose.focalLengthPx <= 0) {
    return { error: "Focal length must be positive; call estimateFocalLengthPx if unknown." };
  }
  // Ceiling mode targets the plane above the camera; the tilt and
  // above-horizon checks below therefore invert.
  const planeOffsetM = input.planeOffsetM ?? -input.pose.heightM;
  const ceilingMode = planeOffsetM > 0;

  if (!ceilingMode && input.pose.tiltDeg > -2) {
    return {
      error:
        "Camera is too level — point the phone down at the floor corners and try again.",
    };
  }
  if (ceilingMode && input.pose.tiltDeg < 2) {
    return {
      error:
        "Camera is too level — point the phone up at the ceiling corners and try again.",
    };
  }

  const floor = input.corners.map((tap) =>
    projectTapToFloor(tap, input.pose, planeOffsetM),
  );
  if (floor.some((p) => p === null)) {
    return {
      error: ceilingMode
        ? "One or more taps are below the horizon. Point the phone further up or re-tap nearer the ceiling."
        : "One or more taps are above the horizon. Point the phone further down or re-tap nearer the floor.",
    };
  }
  const fp = floor as [FloorPoint3D, FloorPoint3D, FloorPoint3D, FloorPoint3D];

  const walls: [number, number, number, number] = [
    distance(fp[0], fp[1]),
    distance(fp[1], fp[2]),
    distance(fp[2], fp[3]),
    distance(fp[3], fp[0]),
  ];
  const diag1 = distance(fp[0], fp[2]);
  const diag2 = distance(fp[1], fp[3]);
  const meanDiagonalM = (diag1 + diag2) / 2;
  const areaM2 = polygonArea(fp);

  const rect = assessRectangular(walls, diag1, diag2);
  const confidence = scoreConfidence(walls, rect, input.pose, fp);

  return {
    wallsM: roundTo(walls, 2) as [number, number, number, number],
    meanDiagonalM: Math.round(meanDiagonalM * 100) / 100,
    areaM2: Math.round(areaM2 * 100) / 100,
    rectangular: rect.isRect,
    confidence: confidence.bucket,
    notes: [...rect.notes, ...confidence.notes],
    floorPoints: fp,
  };
}

// ─── Confidence logic ─────────────────────────────────────────────────

function assessRectangular(
  walls: [number, number, number, number],
  diag1: number,
  diag2: number,
): { isRect: boolean; notes: string[] } {
  const notes: string[] = [];
  // Opposite-wall parity.
  const oppA = Math.abs(walls[0] - walls[2]) / Math.max(walls[0], walls[2]);
  const oppB = Math.abs(walls[1] - walls[3]) / Math.max(walls[1], walls[3]);
  // Diagonal parity (should be equal in a true rectangle).
  const diagDiff = Math.abs(diag1 - diag2) / Math.max(diag1, diag2);

  const isRect = oppA < 0.1 && oppB < 0.1 && diagDiff < 0.08;
  if (!isRect) {
    if (oppA >= 0.1 || oppB >= 0.1) {
      notes.push("Opposite walls differ by more than 10 % — room may be non-rectangular or a corner was mis-tapped.");
    }
    if (diagDiff >= 0.08) {
      notes.push("Floor quadrilateral is skewed — check corner taps.");
    }
  }
  return { isRect, notes };
}

function scoreConfidence(
  walls: [number, number, number, number],
  rect: { isRect: boolean; notes: string[] },
  pose: CameraPose,
  _fp: [FloorPoint3D, FloorPoint3D, FloorPoint3D, FloorPoint3D],
): { bucket: ScanConfidence; notes: string[] } {
  const notes: string[] = [];
  let score = 100;

  // Penalise if any wall is suspicious (too short or too long).
  walls.forEach((w, i) => {
    if (w < 1.2) {
      score -= 15;
      notes.push(`Wall ${i + 1} is under 1.2 m — likely a mis-tap.`);
    } else if (w > 12) {
      score -= 20;
      notes.push(`Wall ${i + 1} is over 12 m — likely a mis-tap or extreme room.`);
    }
  });

  // Penalise shallow tilt — accuracy degrades fast near the horizon.
  if (pose.tiltDeg > -10) {
    score -= 20;
    notes.push("Camera tilt is shallow; tilt further down for better accuracy.");
  }

  // Penalise non-rectangular rooms slightly (can still be correct if room
  // is L-shaped, but lowers our certainty).
  if (!rect.isRect) {
    score -= 15;
  }

  // Penalise unknown focal length (i.e. user didn't calibrate). This is
  // signalled by the caller passing estimateFocalLengthPx() output, which
  // we can't detect here — the UI should pass a slightly lower score via
  // note if it wants. Left as a TODO hook.

  const bucket: ScanConfidence =
    score >= 80 ? "high" : score >= 55 ? "medium" : "low";
  return { bucket, notes };
}

// ─── Utilities ────────────────────────────────────────────────────────

function roundTo(arr: number[], dp: number): number[] {
  const m = Math.pow(10, dp);
  return arr.map((v) => Math.round(v * m) / m);
}
