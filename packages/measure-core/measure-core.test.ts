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
import { fixtureFootprintM } from "./src/types.ts";
import { validateRoom } from "./src/validation.ts";
import { scanPolygonIsUsable } from "./src/scan.ts";
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

test("a scanned room survives the draft round trip intact", async () => {
  /*
   * The scan is the expensive step: walking a house with RoomPlan, then
   * losing it because the app was backgrounded, is the worst failure
   * this form has available.
   *
   * The draft deliberately drops blob-backed media, and the risk is
   * that the scan's output gets dropped with it -- floorPolygonM is
   * what carries an awkward, non-rectangular room all the way to the
   * DXF, and measuredByScan is what tells the architect the numbers
   * came from a sensor rather than a tape. Neither is a blob, so
   * neither should be stripped. This pins that.
   */
  const { saveDraft, loadDraft } = await import("../../lib/draftStorage.ts");
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
    const scanned = {
      id: "r1",
      name: "Lounge",
      measuredByScan: true,
      ceilingHeightM: "2.41",
      walls: [
        { id: "w1", label: "Wall 1", lengthM: "4.13", photos: [] },
        { id: "w2", label: "Wall 2", lengthM: "3.07", photos: [] },
      ],
      floorPolygonM: [
        { x: 0, z: 0 },
        { x: 4.13, z: 0 },
        { x: 4.13, z: 3.07 },
        { x: 2.0, z: 3.07 },
        { x: 2.0, z: 1.5 },
        { x: 0, z: 1.5 },
      ],
      doors: [{ id: "d1", widthM: "0.81", note: "", wallIndex: 0 }],
      windows: [],
      photos: [{ id: "p1", uri: "blob:dead", name: "x.jpg" }],
      voiceMemos: [{ id: "m1", uri: "blob:dead", name: "m.m4a" }],
      irregularNotes: "",
      notes: "",
    };
    const draft = draftStub();
    draft.rooms = [scanned] as unknown as typeof draft.rooms;
    draft.placements = { r1: { positionM: { x: 1, z: 2 }, rotationDeg: 90, floor: 0 } };

    assert.equal(saveDraft(draft), true);
    const back = loadDraft();
    assert.ok(back, "draft should load");
    const room = back!.rooms[0] as Record<string, unknown>;

    // The scan's own output must come back untouched.
    assert.equal(room.measuredByScan, true);
    assert.equal(room.ceilingHeightM, "2.41");
    assert.deepEqual(room.floorPolygonM, scanned.floorPolygonM);
    assert.equal((room.walls as unknown[]).length, 2);
    assert.equal((room.doors as { widthM: string }[])[0].widthM, "0.81");
    // Six points, not four: the L-shaped bite is the whole reason the
    // polygon exists, and a round trip that squared it off would lose
    // the awkward corner silently.
    assert.equal((room.floorPolygonM as unknown[]).length, 6);
    // Placement survives too, or the scanned room comes back unplaced.
    assert.deepEqual(back!.placements, draft.placements);

    // Blob-backed media is still dropped -- restoring a dead blob URL
    // is worse than restoring nothing.
    assert.deepEqual(room.photos, []);
    assert.deepEqual(room.voiceMemos, []);
  } finally {
    if (!had) delete g.window;
  }
});

/* ── Fixtures ─────────────────────────────────────────────────────
 * Toilets, baths and kitchen units were captured nowhere at all, so a
 * bathroom reached the draughtsman as a box with a door in it. These
 * pin the two things that fail silently: the footprint after rotation,
 * and whether a placed fixture actually survives into the DXF at the
 * right place.
 */

test("a fixture's footprint swaps width and depth when turned", () => {
  const bath = (rotationDeg: 0 | 90 | 180 | 270) =>
    fixtureFootprintM({
      id: "f1",
      kind: "bath",
      positionM: { x: 1, z: 1 },
      rotationDeg,
    });
  // A standard bath is 1.70 x 0.70.
  assert.deepEqual(bath(0), { widthM: 1.7, depthM: 0.7 });
  assert.deepEqual(bath(180), { widthM: 1.7, depthM: 0.7 });
  // Turned, it occupies the other way round. A footprint that ignored
  // rotation would fit on the plan at 0 degrees and overlap the wall
  // at 90, which is the case a customer is most likely to want.
  assert.deepEqual(bath(90), { widthM: 0.7, depthM: 1.7 });
  assert.deepEqual(bath(270), { widthM: 0.7, depthM: 1.7 });
});

test("a measured size overrides the standard one", () => {
  // The distinction matters: an assumed 1.7 m bath and a measured
  // 1.7 m bath are different facts to whoever draws from this.
  const f = fixtureFootprintM({
    id: "f1",
    kind: "bath",
    positionM: { x: 0, z: 0 },
    rotationDeg: 0,
    widthM: "1.5",
    depthM: "0.75",
  });
  assert.deepEqual(f, { widthM: 1.5, depthM: 0.75 });

  // Junk in the override falls back rather than producing a zero-sized
  // fixture that vanishes from the drawing without comment.
  const junk = fixtureFootprintM({
    id: "f2",
    kind: "toilet",
    positionM: { x: 0, z: 0 },
    rotationDeg: 0,
    widthM: "",
    depthM: "abc",
  });
  assert.deepEqual(junk, { widthM: 0.4, depthM: 0.7 });
});

/**
 * Pull every LINE on a layer back out of the DXF as endpoint pairs, in
 * millimetres.
 *
 * Asserting on `dxf.includes("800.00")` looked like it tested the
 * geometry and did not: the fixture's text label carries coordinates
 * too, so a version that drew the rectangle in room-local metres --
 * the exact bug this is here to catch -- still produced a string
 * containing the right numbers and the test passed. Verified by
 * reintroducing that bug; it went green. Reading the actual entities
 * is the only version of this test that fails when it should.
 */
function dxfLinesOnLayer(
  dxf: string,
  layer: string,
): { x1: number; y1: number; x2: number; y2: number }[] {
  const out: { x1: number; y1: number; x2: number; y2: number }[] = [];
  const lines = dxf.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "LINE") continue;
    // Group codes follow as alternating code/value pairs.
    const get = (code: string): number | null => {
      for (let j = i; j < Math.min(i + 24, lines.length); j++) {
        if (lines[j].trim() === code) return Number.parseFloat(lines[j + 1]);
      }
      return null;
    };
    let onLayer = false;
    for (let j = i; j < Math.min(i + 24, lines.length); j++) {
      if (lines[j].trim() === "8" && lines[j + 1].trim() === layer) {
        onLayer = true;
        break;
      }
    }
    if (!onLayer) continue;
    const x1 = get("10"), y1 = get("20"), x2 = get("11"), y2 = get("21");
    if (x1 === null || y1 === null || x2 === null || y2 === null) continue;
    out.push({ x1, y1, x2, y2 });
  }
  return out;
}

const bathroomWith = (
  fixtures: RoomDraft["fixtures"],
  rotationDeg: 0 | 90 = 0,
) => {
  const room = planRoom("b", "Bathroom", 3, 2);
  room.fixtures = fixtures;
  return buildDetailedPlanDxf([
    { room, anchor: { x: 0, z: 0 }, rotationDeg },
  ]);
};

test("a placed fixture reaches the DXF on its own layer, at the right size", () => {
  const dxf = bathroomWith([
    {
      id: "f1",
      kind: "toilet",
      // 1.0 m right, 0.5 m down from the room's top-left corner.
      positionM: { x: 1, z: 0.5 },
      rotationDeg: 0,
    },
  ]);

  assert.ok(dxf.includes("TM-FIXTURES"), "fixtures layer should exist");
  assert.ok(dxf.includes("Toilet"), "fixture should be labelled");

  const segs = dxfLinesOnLayer(dxf, "TM-FIXTURES");
  assert.equal(segs.length, 4, "a toilet is a four-sided box");

  // A 0.40 x 0.70 toilet centred at (1.00, 0.50) spans x 0.80..1.20 and
  // z 0.15..0.85 — in CAD millimetres with z negated, x 800..1200 and
  // y -150..-850.
  const xs = segs.flatMap((s) => [s.x1, s.x2]);
  const ys = segs.flatMap((s) => [s.y1, s.y2]);
  assert.equal(Math.min(...xs), 800);
  assert.equal(Math.max(...xs), 1200);
  assert.equal(Math.min(...ys), -850);
  assert.equal(Math.max(...ys), -150);
});

test("a fixture is transformed into world space with its room", () => {
  const fixtures: RoomDraft["fixtures"] = [
    {
      id: "f1",
      kind: "toilet",
      positionM: { x: 1, z: 0.5 },
      rotationDeg: 0,
    },
  ];
  const turned = dxfLinesOnLayer(bathroomWith(fixtures, 90), "TM-FIXTURES");
  assert.equal(turned.length, 4);

  // At 90 degrees the room's local +x runs along world +z and local +z
  // runs along world -x, so local (1.00, 0.50) becomes world
  // (-0.50, 1.00). The box spans world x -0.85..-0.15, z 0.80..1.20,
  // i.e. mm x -850..-150 and y -800..-1200.
  //
  // A version that wrote room-local metres straight into the drawing
  // would put this box at x 800..1200 — correct on an unrotated plan,
  // and outside the building on this one.
  const xs = turned.flatMap((s) => [s.x1, s.x2]);
  const ys = turned.flatMap((s) => [s.y1, s.y2]);
  assert.equal(Math.min(...xs), -850);
  assert.equal(Math.max(...xs), -150);
  assert.equal(Math.min(...ys), -1200);
  assert.equal(Math.max(...ys), -800);
});

/* ── Finishing a room ─────────────────────────────────────────────
 * The Finish button did nothing on a drawn room, permanently and
 * without a word: validateRoom demanded a typed length for every wall,
 * and drawing the outline never fills those fields. The customer had
 * traced the room, been told it counted, and then hit a dead button.
 */

test("a drawn room does not also need its wall lengths typed", () => {
  const drawn = planRoom("d", "Lounge", 4, 3);
  // What tracing produces: a polygon, and empty wall fields.
  drawn.walls = drawn.walls.map((w) => ({ ...w, lengthM: "" }));
  drawn.floorPolygonM = [
    { x: 0, z: 0 },
    { x: 4, z: 0 },
    { x: 4, z: 3 },
    { x: 0, z: 3 },
  ];
  drawn.photos = [{ id: "p", uri: "blob:x", name: "x.jpg" }];

  const issues = validateRoom(drawn, 0);
  assert.deepEqual(
    issues.filter((i) => i.path.includes("-wall-")),
    [],
    "the polygon already carries every length",
  );
  assert.deepEqual(issues, [], "nothing else should block either");
});

test("a typed room still needs all its wall lengths", () => {
  // The exemption is for drawn rooms specifically. Without a polygon,
  // a blank wall is still a missing measurement and the architect
  // cannot draw from it.
  const typed = planRoom("t", "Lounge", 4, 3);
  typed.walls = typed.walls.map((w, i) =>
    i === 2 ? { ...w, lengthM: "" } : w,
  );
  typed.photos = [{ id: "p", uri: "blob:x", name: "x.jpg" }];

  const issues = validateRoom(typed, 0);
  assert.equal(
    issues.filter((i) => i.path === "room-0-wall-2").length,
    1,
    "the blank wall should be flagged",
  );
});

test("a two-point polygon is not treated as a drawn room", () => {
  // Two points is a line, not a floor. Accepting it would exempt the
  // room from wall checks and produce a submission with no dimensions
  // at all -- worse than the bug being fixed.
  const half = planRoom("h", "Lounge", 4, 3);
  half.walls = half.walls.map((w) => ({ ...w, lengthM: "" }));
  half.floorPolygonM = [
    { x: 0, z: 0 },
    { x: 4, z: 0 },
  ];
  half.photos = [{ id: "p", uri: "blob:x", name: "x.jpg" }];

  const issues = validateRoom(half, 0);
  assert.ok(
    issues.some((i) => i.path.includes("-wall-")),
    "an unfinished outline must not exempt the wall lengths",
  );
});

test("a scanned room can be submitted without a photograph", () => {
  /*
   * The photo rule blocked every LiDAR submission. Rooms from
   * applyHouseScan start with `photos: []`, and the rule required one
   * per room unconditionally -- so a customer could walk the whole
   * property with the sensor, exactly as the feature is sold, and then
   * be told to photograph every room before they could send it.
   */
  const scanned = planRoom("s", "Kitchen", 4, 3);
  scanned.photos = [];
  scanned.measuredByScan = true;

  assert.deepEqual(
    validateRoom(scanned, 0),
    [],
    "a scan is its own reference",
  );
});

test("a typed room still needs a photograph", () => {
  // The exemption is for scanned rooms only. On a typed room the photo
  // is the sole means the architect has of auditing the numbers.
  const typed = planRoom("t", "Kitchen", 4, 3);
  typed.photos = [];

  assert.equal(
    validateRoom(typed, 0).filter((i) => i.path === "room-0-photos").length,
    1,
  );
});

/* ── Scanned outlines ─────────────────────────────────────────────
 * A room came back labelled "4.34 x 3.33 m" and drawn as a thin
 * spike. The width and length are derived from the walls and were
 * fine; the floor polygon was not, and the polygon is what gets drawn.
 */

test("a sane rectangular outline is usable", () => {
  const poly = [
    { x: 0, z: 0 },
    { x: 4.34, z: 0 },
    { x: 4.34, z: 3.33 },
    { x: 0, z: 3.33 },
  ];
  assert.equal(scanPolygonIsUsable(poly, 4.34, 3.33), true);
});

test("an L-shape is usable — it is the whole point of keeping polygons", () => {
  // 4 x 3 with a 1.5 x 1 bite out of one corner: 10.5 of a 12 m² box.
  const poly = [
    { x: 0, z: 0 },
    { x: 4, z: 0 },
    { x: 4, z: 2 },
    { x: 2.5, z: 2 },
    { x: 2.5, z: 3 },
    { x: 0, z: 3 },
  ];
  assert.equal(scanPolygonIsUsable(poly, 4, 3), true);
});

test("a sliver is rejected even when the reported size is right", () => {
  // What a glancing or interrupted scan produces: a few near-collinear
  // points hugging one wall. Spans nothing like 4.34 x 3.33.
  const sliver = [
    { x: 0, z: 0 },
    { x: 0.18, z: 0 },
    { x: 0.18, z: 2.5 },
    { x: 0, z: 2.5 },
  ];
  assert.equal(scanPolygonIsUsable(sliver, 4.34, 3.33), false);
});

test("a hollow outline that fills too little of its box is rejected", () => {
  // Right bounding box, wrong shape — a thin Z spanning the room.
  const zig = [
    { x: 0, z: 0 },
    { x: 4, z: 0 },
    { x: 4, z: 0.2 },
    { x: 0.2, z: 0.2 },
    { x: 0.2, z: 3 },
    { x: 0, z: 3 },
  ];
  assert.equal(scanPolygonIsUsable(zig, 4, 3), false);
});

test("fewer than three points is never usable", () => {
  assert.equal(scanPolygonIsUsable([{ x: 0, z: 0 }, { x: 4, z: 0 }], 4, 3), false);
  assert.equal(scanPolygonIsUsable(undefined, 4, 3), false);
});
