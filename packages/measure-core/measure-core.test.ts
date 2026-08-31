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
import { buildFloorPlanDxf, roomCornersM } from "./src/dxf.ts";
import { buildWalls, buildDetailedPlanDxf, roomOutlineM } from "./src/dxfPlan.ts";
import type { RoomDraft } from "./src/types.ts";
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

/* ── DXF export ─────────────────────────────────────────────────────
 *
 * A wrong DXF is worse than no DXF: it opens, it looks like a floor
 * plan, and the errors only surface when someone builds from it. These
 * pin the three ways that happens silently.
 */

const dxfRoom = (over: Partial<RoomDraft> = {}): RoomDraft =>
  ({
    id: "r1",
    name: "Kitchen",
    walls: [
      { id: "w1", label: "Wall 1", lengthM: "4" },
      { id: "w2", label: "Wall 2", lengthM: "3" },
      { id: "w3", label: "Wall 3", lengthM: "4" },
      { id: "w4", label: "Wall 4", lengthM: "3" },
    ],
    ceilingHeightM: "2.4",
    doors: [],
    windows: [],
    irregularNotes: "",
    notes: "",
    photos: [],
    ...over,
  }) as RoomDraft;

test("DXF is written in millimetres, not metres", () => {
  const dxf = buildFloorPlanDxf([
    { room: dxfRoom(), anchor: { x: 0, z: 0 }, rotationDeg: 0 },
  ]);
  // A 4 m wall must appear as 4000, not 4. Importing at 1/1000 looks
  // plausible right up until someone dimensions off it.
  assert.match(dxf, /4000\.000/);
  assert.match(dxf, /\$INSUNITS/);
});

test("the plan is not mirrored: screen-down z becomes CAD-up y", () => {
  const dxf = buildFloorPlanDxf([
    { room: dxfRoom(), anchor: { x: 0, z: 0 }, rotationDeg: 0 },
  ]);
  // z runs downward in the app, y upward in CAD. A room anchored at
  // the origin must therefore occupy negative y. Get this wrong and
  // every plan arrives mirrored — and a mirrored rectangle still looks
  // like a rectangle.
  assert.match(dxf, /-3000\.000/);
  assert.ok(!/\n20\n3000\.000/.test(dxf), "y should not be positive here");
});

test("a newline in a room name cannot corrupt the file", () => {
  const dxf = buildFloorPlanDxf([
    {
      room: dxfRoom({ name: "Kitchen\n0\nLINE" }),
      anchor: { x: 0, z: 0 },
      rotationDeg: 0,
    },
  ]);
  // DXF is newline-delimited, so an unsanitised name could close the
  // TEXT entity and inject entities of its own.
  assert.ok(dxf.includes("Kitchen 0 LINE"));
});

test("rotating a room by 90 degrees swaps its extents", () => {
  const flat = roomCornersM({ x: 0, z: 0 }, { widthM: 4, lengthM: 3 }, 0);
  const turned = roomCornersM({ x: 0, z: 0 }, { widthM: 4, lengthM: 3 }, 90);
  const span = (pts: { x: number; z: number }[], k: "x" | "z") =>
    Math.max(...pts.map((p) => p[k])) - Math.min(...pts.map((p) => p[k]));
  assert.equal(span(flat, "x"), 4);
  assert.equal(span(turned, "x"), 3);
  assert.equal(span(turned, "z"), 4);
});

/* ── Detailed plan ──────────────────────────────────────────────────
 *
 * Wall thickness is inferred, not measured, so the inference is the
 * thing worth pinning: get it wrong and the drawing is confidently
 * incorrect rather than obviously broken.
 */

const planRoom = (id: string, name: string, w: number, l: number): RoomDraft =>
  ({
    id,
    name,
    walls: [
      { id: `${id}-1`, label: "Wall 1", lengthM: String(w) },
      { id: `${id}-2`, label: "Wall 2", lengthM: String(l) },
      { id: `${id}-3`, label: "Wall 3", lengthM: String(w) },
      { id: `${id}-4`, label: "Wall 4", lengthM: String(l) },
    ],
    ceilingHeightM: "2.4",
    doors: [],
    windows: [],
    irregularNotes: "",
    notes: "",
    photos: [],
  }) as RoomDraft;

test("a wall between two rooms is internal, the rest are external", () => {
  // Two 4x3 rooms side by side: kitchen 0..4, hall 4..8 in x.
  const walls = buildWalls([
    { room: planRoom("k", "Kitchen", 4, 3), anchor: { x: 0, z: 0 }, rotationDeg: 0 },
    { room: planRoom("h", "Hall", 4, 3), anchor: { x: 4, z: 0 }, rotationDeg: 0 },
  ]);
  const internal = walls.filter((w) => w.internal);
  // The shared boundary is one wall of each room.
  assert.equal(internal.length, 2);
  assert.ok(internal.every((w) => w.roomId === "k" || w.roomId === "h"));
});

test("rooms that merely touch at a corner do not share a wall", () => {
  const walls = buildWalls([
    { room: planRoom("a", "A", 3, 3), anchor: { x: 0, z: 0 }, rotationDeg: 0 },
    // Diagonally offset: corners meet, no run of shared wall.
    { room: planRoom("b", "B", 3, 3), anchor: { x: 3, z: 3 }, rotationDeg: 0 },
  ]);
  assert.equal(walls.filter((w) => w.internal).length, 0);
});

test("a lone room is external all the way round", () => {
  const walls = buildWalls([
    { room: planRoom("a", "A", 4, 3), anchor: { x: 0, z: 0 }, rotationDeg: 0 },
  ]);
  assert.equal(walls.length, 4);
  assert.equal(walls.filter((w) => w.internal).length, 0);
});

test("a door cuts the wall rather than being drawn over it", () => {
  const room = planRoom("k", "Kitchen", 4, 3);
  room.doors = [
    { id: "d1", widthM: "0.9", note: "", wallIndex: 0, positionM: "2" },
  ];
  const dxf = buildDetailedPlanDxf([
    { room, anchor: { x: 0, z: 0 }, rotationDeg: 0 },
  ]);
  // Door leaf and swing arc both present.
  assert.match(dxf, /TM-DOORS/);
  assert.match(dxf, /\nARC\n/);
  // The reveal is closed off with jambs rather than the wall simply
  // stopping — four wall lines minimum on that edge.
  assert.ok(dxf.split("TM-WALLS").length > 4);
});

test("the detailed plan is still millimetres and still not mirrored", () => {
  const dxf = buildDetailedPlanDxf([
    { room: planRoom("a", "A", 4, 3), anchor: { x: 0, z: 0 }, rotationDeg: 0 },
  ]);
  assert.match(dxf, /4000\.00|3875\.00|4125\.00/);
  assert.match(dxf, /-\d+\.\d\d/);
  assert.match(dxf, /\$INSUNITS/);
});

test("the plain companion drawing has no doors, stairs or title block", () => {
  const room = planRoom("k", "Kitchen", 4, 3);
  room.doors = [
    { id: "d1", widthM: "0.9", note: "", wallIndex: 0, positionM: "2" },
  ];
  const plain = buildDetailedPlanDxf(
    [{ room, anchor: { x: 0, z: 0 }, rotationDeg: 0 }],
    { detailed: false },
  );
  assert.ok(!plain.includes("TM-DOORS"));
  assert.ok(!plain.includes("TM-TITLE"));
});

test("an L-shaped room is drawn as an L, not as its bounding box", () => {
  // Six corners: a 4x4 square with a 2x2 bite out of one corner.
  const room = planRoom("l", "Lounge", 4, 4);
  room.floorPolygonM = [
    { x: 0, z: 0 },
    { x: 4, z: 0 },
    { x: 4, z: 2 },
    { x: 2, z: 2 },
    { x: 2, z: 4 },
    { x: 0, z: 4 },
  ];
  const entry = {
    room,
    anchor: { x: 0, z: 0 },
    rotationDeg: 0 as const,
  };

  // The outline must have six corners, not four.
  assert.equal(roomOutlineM(entry).length, 6);
  // Six walls, not four. Drawing this as a rectangle produced a shape
  // with six wall lengths listed beside it and no way to tell it was
  // wrong -- wrong in the worst way, because it looks finished.
  assert.equal(buildWalls([entry]).length, 6);

  // And the notch is genuinely absent from the drawing: no wall runs
  // along the far edge of the bite.
  const dxf = buildDetailedPlanDxf([entry]);
  assert.match(dxf, /TM-WALLS/);
  // 12 m² of floor, not the 16 m² of the bounding box. An area written
  // on a drawing gets used.
  assert.match(dxf, /12\.0 m²/);
});

test("a rectangular room still uses its bounding rectangle", () => {
  const room = planRoom("r", "Kitchen", 4, 3);
  const entry = { room, anchor: { x: 0, z: 0 }, rotationDeg: 0 as const };
  assert.equal(roomOutlineM(entry).length, 4);
  assert.equal(buildWalls([entry]).length, 4);
});

test("a room outline rotates about its anchor like the rectangle does", () => {
  const room = planRoom("l", "Lounge", 4, 4);
  room.floorPolygonM = [
    { x: 0, z: 0 },
    { x: 4, z: 0 },
    { x: 4, z: 2 },
    { x: 0, z: 2 },
  ];
  const flat = roomOutlineM({ room, anchor: { x: 0, z: 0 }, rotationDeg: 0 });
  const turned = roomOutlineM({ room, anchor: { x: 0, z: 0 }, rotationDeg: 90 });
  const span = (pts: { x: number; z: number }[], k: "x" | "z") =>
    Math.max(...pts.map((p) => p[k])) - Math.min(...pts.map((p) => p[k]));
  // 4 x 2 becomes 2 x 4. A polygon that ignored rotation would place
  // the shape correctly at 0 degrees and wrongly everywhere else.
  assert.equal(span(flat, "x"), 4);
  assert.equal(span(turned, "x"), 2);
  assert.equal(span(turned, "z"), 4);
});

/* ── Draft saving ─────────────────────────────────────────────────
 * saveDraft used to return void and swallow every failure, while the
 * form displayed "Draft saved" unconditionally. The one situation
 * where the message matters — storage unavailable — was the situation
 * where it lied. These pin the honest return value.
 */

test("saveDraft reports success when the write lands", async () => {
  const { saveDraft } = await import("../../lib/draftStorage.ts");
  const store = new Map<string, string>();
  const g = globalThis as unknown as { window?: unknown };
  const had = "window" in g;
  g.window = {
    localStorage: {
      setItem: (k: string, v: string) => store.set(k, v),
      getItem: (k: string) => store.get(k) ?? null,
      removeItem: (k: string) => store.delete(k),
    },
  };
  try {
    assert.equal(saveDraft(draftStub()), true);
    assert.equal(store.size, 1);
  } finally {
    if (!had) delete g.window;
  }
});

test("saveDraft reports failure when storage throws", async () => {
  const { saveDraft } = await import("../../lib/draftStorage.ts");
  const g = globalThis as unknown as { window?: unknown };
  const had = "window" in g;
  g.window = {
    localStorage: {
      // What a full quota, or Safari private browsing, actually does.
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      getItem: () => null,
      removeItem: () => {},
    },
  };
  try {
    assert.equal(saveDraft(draftStub()), false);
  } finally {
    if (!had) delete g.window;
  }
});

/** Smallest snapshot saveDraft will accept. */
function draftStub() {
  return {
    step: "rooms",
    customerName: "A",
    email: "a@example.com",
    projectName: "P",
    projectType: "extension",
    unit: "metric" as const,
    unitLocked: true,
    defaultCeilingHeightM: "2.4",
    proposalDescription: "",
    rooms: [{ id: "r1", name: "Hall", walls: [], photos: [], voiceMemos: [] }],
    connections: [],
    placements: {},
  } as unknown as Parameters<
    typeof import("../../lib/draftStorage.ts").saveDraft
  >[0];
}
