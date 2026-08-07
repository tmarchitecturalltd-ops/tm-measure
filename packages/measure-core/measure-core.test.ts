/**
 * Regression tests for the measurement core.
 *
 * These lock in behaviour that was verified numerically while auditing
 * the package. Each case corresponds to something that was either
 * found broken and fixed, or checked and found correct — in both cases
 * worth pinning, because none of it is obvious from reading the code
 * and all of it fails silently when wrong.
 *
 * Run with:  npm test
 *
 * No test framework: Node 22 runs TypeScript directly and ships its own
 * runner, so this adds no dependencies to the project.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  projectTapToFloor,
  projectFloorToPixel,
  estimateRoomFromFloorTaps,
  calibrateFocalLengthPx,
  distance,
  type CameraPose,
  type FloorPoint3D,
} from "./src/perspective.ts";
import { roomBoundingBox } from "./src/floorplan.ts";
import {
  normalizeConnections,
  type RoomConnectionDraft,
} from "./src/connectivity.ts";

const POSE: CameraPose = {
  heightM: 1.5,
  tiltDeg: -30,
  focalLengthPx: 1400,
  imageWidthPx: 1920,
  imageHeightPx: 1080,
};

// ── Projection ───────────────────────────────────────────────────────

test("tap → floor → pixel round-trips exactly", () => {
  for (const [xPx, yPx] of [
    [400, 800],
    [960, 700],
    [1500, 900],
    [300, 1000],
  ]) {
    const floor = projectTapToFloor({ xPx, yPx }, POSE);
    assert.ok(floor, `expected a floor point for (${xPx},${yPx})`);
    const back = projectFloorToPixel(floor, POSE);
    assert.ok(back, "expected the point to project back into frame");
    assert.ok(
      Math.hypot(back.xPx - xPx, back.yPx - yPx) < 1e-6,
      "round-trip must return to the original pixel",
    );
  }
});

test("round-trip also holds for the ceiling plane", () => {
  const up: CameraPose = { ...POSE, tiltDeg: 35 };
  const offset = 2.0; // ceiling 2 m above the camera
  const floor = projectTapToFloor({ xPx: 500, yPx: 300 }, up, offset);
  assert.ok(floor);
  const back = projectFloorToPixel(floor, up, offset);
  assert.ok(back);
  assert.ok(Math.hypot(back.xPx - 500, back.yPx - 300) < 1e-6);
});

test("taps above the horizon return null", () => {
  // Where the horizon falls depends on the tilt. At -30° it is off the
  // top of the frame entirely, so every in-frame tap legitimately hits
  // the floor — a tap near the top edge is simply a distant point.
  // Pitch down only slightly and the horizon moves into view.
  const shallow: CameraPose = { ...POSE, tiltDeg: -5 };
  // Horizon sits at y ≈ 418 here; above it the ray never meets the floor.
  assert.equal(projectTapToFloor({ xPx: 960, yPx: 100 }, shallow), null);
  // Below it, we still get an answer.
  assert.ok(projectTapToFloor({ xPx: 960, yPx: 900 }, shallow));
});

test("a known room is recovered exactly when the tilt is right", () => {
  const truth: FloorPoint3D[] = [
    { xM: -2.25, zM: 1.2 },
    { xM: 2.25, zM: 1.2 },
    { xM: 2.25, zM: 4.2 },
    { xM: -2.25, zM: 4.2 },
  ];
  const pose: CameraPose = { ...POSE, tiltDeg: -25 };
  const corners = truth.map((p) => {
    const px = projectFloorToPixel(p, pose);
    assert.ok(px);
    return px;
  });
  const out = estimateRoomFromFloorTaps({
    corners: corners as [
      (typeof corners)[0],
      (typeof corners)[0],
      (typeof corners)[0],
      (typeof corners)[0],
    ],
    pose,
  });
  assert.ok(!("error" in out), "solver should not error on exact input");
  // 4.5 m wide, 3.0 m deep.
  assert.ok(Math.abs(out.wallsM[0] - 4.5) < 0.01);
  assert.ok(Math.abs(out.wallsM[1] - 3.0) < 0.01);
  assert.equal(out.rectangular, true);
});

// ── Calibration ──────────────────────────────────────────────────────

test("calibration recovers a known focal length", () => {
  const a: FloorPoint3D = { xM: -0.5, zM: 2.2 };
  const b: FloorPoint3D = { xM: 0.5, zM: 2.2 };
  const tapA = projectFloorToPixel(a, POSE);
  const tapB = projectFloorToPixel(b, POSE);
  assert.ok(tapA && tapB);
  const { focalLengthPx: _drop, ...poseNoFocal } = POSE;
  const f = calibrateFocalLengthPx(tapA, tapB, distance(a, b), poseNoFocal);
  assert.equal(typeof f, "number");
  assert.ok(
    Math.abs((f as number) / POSE.focalLengthPx - 1) < 0.01,
    `expected ~${POSE.focalLengthPx}, got ${f}`,
  );
});

test("calibration refuses taps that are too close together", () => {
  const { focalLengthPx: _drop, ...poseNoFocal } = POSE;
  const r = calibrateFocalLengthPx(
    { xPx: 900, yPx: 800 },
    { xPx: 930, yPx: 805 },
    1,
    poseNoFocal,
  );
  assert.ok(typeof r === "object" && "error" in r);
});

// ── Floor-plan geometry ──────────────────────────────────────────────

test("roomBoundingBox agrees with the SVG rotation it is drawn with", () => {
  // The editor renders rooms as `rotate(deg 0 0)` about the anchor, so
  // the box must match that transform applied to all four corners.
  // Getting 90 and 270 transposed drew rooms where the code did not
  // think they were, which is invisible until layouts misbehave.
  const anchor = { x: 2, z: 5 };
  const w = 4;
  const l = 3;
  for (const deg of [0, 90, 180, 270] as const) {
    const a = (deg * Math.PI) / 180;
    const c = Math.round(Math.cos(a));
    const s = Math.round(Math.sin(a));
    const corners = [
      [0, 0],
      [w, 0],
      [w, l],
      [0, l],
    ].map(([x, z]) => ({ x: anchor.x + (c * x - s * z), z: anchor.z + (s * x + c * z) }));
    const expected = {
      minX: Math.min(...corners.map((p) => p.x)),
      minZ: Math.min(...corners.map((p) => p.z)),
      maxX: Math.max(...corners.map((p) => p.x)),
      maxZ: Math.max(...corners.map((p) => p.z)),
    };
    assert.deepEqual(
      roomBoundingBox(anchor, { widthM: w, lengthM: l }, deg),
      expected,
      `bounding box disagrees with the drawn rotation at ${deg}°`,
    );
  }
});

// ── Connections ──────────────────────────────────────────────────────

const draft = (o: Partial<RoomConnectionDraft>): RoomConnectionDraft => ({
  id: Math.random().toString(36).slice(2),
  roomAId: "",
  roomBId: "",
  kind: "door",
  widthM: "",
  notes: "",
  ...o,
});

test("two rooms may connect in more than one way", () => {
  // A door and a wide opening between the same pair are two different
  // facts about the building; de-duplicating on the pair lost one.
  const out = normalizeConnections([
    draft({ roomAId: "kitchen", roomBId: "hall", kind: "door", widthM: "0.85" }),
    draft({ roomAId: "kitchen", roomBId: "hall", kind: "opening", widthM: "2.1" }),
  ]);
  assert.equal(out.length, 2);
});

test("a room may have more than one external wall", () => {
  // Corner rooms have two. Which walls face outside is exactly what
  // decides where an extension can go.
  const out = normalizeConnections([
    draft({ roomAId: "living", kind: "external", notes: "front elevation" }),
    draft({ roomAId: "living", kind: "external", notes: "side elevation" }),
  ]);
  assert.equal(out.length, 2);
});

test("the same link stated from both sides still collapses", () => {
  const out = normalizeConnections([
    draft({ roomAId: "kitchen", roomBId: "hall", kind: "door", widthM: "0.85" }),
    draft({ roomAId: "hall", roomBId: "kitchen", kind: "door", widthM: "0.85" }),
  ]);
  assert.equal(out.length, 1);
});

test("self-loops and incomplete rows are dropped", () => {
  const out = normalizeConnections([
    draft({ roomAId: "kitchen", roomBId: "kitchen", kind: "door" }),
    draft({ roomAId: "", roomBId: "hall", kind: "door" }),
    draft({ roomAId: "kitchen", roomBId: "", kind: "door" }),
  ]);
  assert.equal(out.length, 0);
});
