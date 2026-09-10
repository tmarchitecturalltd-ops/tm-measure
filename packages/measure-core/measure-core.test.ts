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
  type TapPoint,
} from "./src/perspective.ts";
import { roomBoundingBox } from "./src/floorplan.ts";
import { buildFloorPlanDxf, roomCornersM } from "./src/dxf.ts";
import { buildWalls, buildDetailedPlanDxf, roomOutlineM } from "./src/dxfPlan.ts";
import { fixtureFootprintM } from "./src/types.ts";
import { validateRoom } from "./src/validation.ts";
import {
  scanPolygonIsUsable,
  scanOutlineWorthKeeping,
  looksLikeStrayCapture,
  outlineThumbnail,
} from "./src/scan.ts";
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

test("a wrong ceiling height scales the whole room by the same proportion", () => {
  /*
   * The non-LiDAR scan now taps ceiling corners only, because in a
   * furnished room the floor corners are behind the sofa and under the
   * rug while the ceiling ones are clean. The cost of that choice is
   * this test.
   *
   * A ceiling-plane reconstruction scales linearly with the distance
   * from the camera to the plane -- ceiling height minus camera height.
   * Get that distance wrong by 10% and every wall is wrong by 10%, in
   * the same direction, which produces a floor plan that is internally
   * consistent, perfectly rectangular, and quietly the wrong size. It
   * is the one error in this app that a human eye cannot catch on the
   * drawing.
   *
   * Hence the tick-box in the scanner insisting the height was
   * measured rather than left at 2.40. This pins the reason: it proves
   * the failure is a clean scale factor, so if this ever stops being
   * true the interface built on top of it is wrong too.
   */
  const truth: FloorPoint3D[] = [
    { xM: -2.0, zM: 1.5 },
    { xM: 2.0, zM: 1.5 },
    { xM: 2.0, zM: 4.5 },
    { xM: -2.0, zM: 4.5 },
  ];
  // Looking up at the ceiling: positive tilt, plane above the camera.
  const pose: CameraPose = { ...POSE, tiltDeg: 25 };
  const trueOffset = 0.9; // 2.40 m ceiling, phone held at 1.50 m.

  const corners = truth.map((p) => {
    const px = projectFloorToPixel(p, pose, trueOffset);
    assert.ok(px, "ceiling corner should project");
    return px;
  }) as [TapPoint, TapPoint, TapPoint, TapPoint];

  const solve = (offsetM: number) =>
    estimateRoomFromFloorTaps({ corners, pose, planeOffsetM: offsetM });

  const right = solve(trueOffset);
  assert.ok(!("error" in right), "solver should not error on exact input");
  assert.ok(Math.abs(right.wallsM[0] - 4.0) < 0.01, "4 m wall recovered");
  assert.ok(Math.abs(right.wallsM[1] - 3.0) < 0.01, "3 m wall recovered");

  // Now the same taps with the height guessed 10 cm too low. 0.10 on
  // 0.90 is 11%, and the room shrinks by exactly that.
  const wrong = solve(0.8);
  assert.ok(!("error" in wrong));
  const ratio = wrong.wallsM[0] / right.wallsM[0];
  // Tolerance is 0.005, not 0.001: wallsM is rounded to centimetres on
  // the way out, so a ratio of two rounded numbers cannot be pinned
  // tighter than the rounding that produced them.
  assert.ok(
    Math.abs(ratio - 0.8 / 0.9) < 0.005,
    `expected a clean ${(0.8 / 0.9).toFixed(3)} scale, got ${ratio.toFixed(3)}`,
  );
  // Every wall by the same factor -- which is why it looks plausible.
  assert.ok(
    Math.abs(wrong.wallsM[1] / right.wallsM[1] - ratio) < 0.005,
    "both axes must scale together",
  );
  // 11% on a 4 m wall is 44 cm. Worth stating in the assertion rather
  // than only in prose.
  assert.ok(right.wallsM[0] - wrong.wallsM[0] > 0.4);
});

test("nothing outside plain ASCII reaches the DXF", () => {
  /*
   * We write $ACADVER AC1009 -- R12 -- for the widest compatibility,
   * and R12 predates Unicode. Any non-ASCII character goes in as raw
   * UTF-8 bytes and comes out of BricsCAD as mojibake: a real drawing
   * opened on 7 September showed "3.1 mÂ²" and "Survey data â€"".
   *
   * That had been true of every drawing the app had ever produced, and
   * it is the first thing anyone sees on opening one -- so the export
   * looked broken whether or not the geometry was right.
   *
   * A room name is the likeliest way for a stray character to get in,
   * because the customer types it. This pins the whole file rather
   * than one label.
   */
  const room = planRoom("k", "Séjour — 12m² café", 4, 3);
  const dxf = buildDetailedPlanDxf([
    { room, anchor: { x: 0, z: 0 }, rotationDeg: 0 },
  ]);

  const offenders = [...dxf].filter((ch) => ch.charCodeAt(0) > 126);
  assert.equal(
    offenders.length,
    0,
    `non-ASCII in the DXF: ${[...new Set(offenders)].join(" ")}`,
  );
  // Transliterated, not deleted: "12m2" still says what it meant, and
  // the accented letters degrade to something legible.
  assert.match(dxf, /Sjour - 12m2 caf/);
});

test("a chimney breast survives the scan instead of being flattened", () => {
  /*
   * Charlie, on a real kitchen: "the 3d picks up all windows and
   * little dog legs, the 2d floor plan shows it as a rectangle".
   *
   * The outline was being discarded whenever RoomPlan flagged the room
   * as rectangular, and that flag is area / boundingBoxArea > 0.90. A
   * chimney breast is about 0.4 m2 in a 9 m2 kitchen -- 4% -- so the
   * room scored 96%, was called rectangular, and the one feature the
   * survey existed to record was thrown away. The bigger the room, the
   * more certainly its features were lost.
   *
   * The test is now the corner count, which is what we meant all
   * along: four corners is a rectangle, five or more is a room with
   * something in it.
   */
  const w = 3.32;
  const l = 2.84;
  const breastW = 1.0;
  const breastD = 0.4;

  // The kitchen from the screenshot, with a chimney breast in the
  // middle of the top wall.
  const withBreast = [
    { x: 0, z: 0 },
    { x: (w - breastW) / 2, z: 0 },
    { x: (w - breastW) / 2, z: breastD },
    { x: (w + breastW) / 2, z: breastD },
    { x: (w + breastW) / 2, z: 0 },
    { x: w, z: 0 },
    { x: w, z: l },
    { x: 0, z: l },
  ];

  // What RoomPlan would call this: the breast is 0.4 m2 of 9.4 m2, so
  // the area ratio is about 0.96 and the old gate dropped it.
  const bboxArea = w * l;
  const realArea = bboxArea - breastW * breastD;
  assert.ok(
    realArea / bboxArea > 0.9,
    "this room is exactly the case RoomPlan calls rectangular",
  );

  assert.equal(
    scanOutlineWorthKeeping(withBreast, w, l),
    true,
    "a room with a chimney breast must keep its outline",
  );

  // A genuine rectangle still collapses to a rectangle: four corners,
  // and no second source of truth for the same shape.
  const plain = [
    { x: 0, z: 0 },
    { x: w, z: 0 },
    { x: w, z: l },
    { x: 0, z: l },
  ];
  assert.equal(scanOutlineWorthKeeping(plain, w, l), false);

  // And nonsense is still rejected, however many corners it has.
  assert.equal(
    scanOutlineWorthKeeping(
      [
        { x: 0, z: 0 },
        { x: 0.1, z: 0 },
        { x: 0.1, z: 0.05 },
        { x: 0.05, z: 0.05 },
        { x: 0, z: 0.05 },
      ],
      w,
      l,
    ),
    false,
    "a sliver is worse than a rectangle",
  );
});

test("a doorway caught in passing is not offered as a room", () => {
  /*
   * A whole-property scan captures whatever the sensor sees, including
   * places nobody walked into: a hallway through an open door, a
   * cupboard, half the room next door. Those arrive as rooms and the
   * customer is asked to name and photograph them.
   *
   * Floor area is the honest test. Nothing anyone deliberately surveys
   * is under a square metre and a half; the smallest real room in a
   * British house -- a downstairs loo -- is comfortably above it.
   */
  // A doorway's worth of capture.
  assert.equal(looksLikeStrayCapture(0.9, 1.0), true);
  // A downstairs loo. Small, and a real room.
  assert.equal(looksLikeStrayCapture(1.6, 1.2), false);
  assert.equal(looksLikeStrayCapture(4.2, 3.1), false);
  // Nonsense is treated as a stray rather than offered.
  assert.equal(looksLikeStrayCapture(0, 0), true);
  // An explicit floor area wins over width × length, because an
  // L-shaped room's bounding box overstates it.
  assert.equal(looksLikeStrayCapture(3, 3, 1.2), true);
});

test("an outline thumbnail keeps the room's proportions", () => {
  /*
   * The filter screen draws each room's own shape beside its size,
   * because two numbers tell you a room is 4.2 by 3.1 and the shape
   * tells you which room it is -- and whether the scan caught the
   * chimney breast, which until now could only be checked by opening
   * the DXF on a computer.
   *
   * A long thin hallway has to read as a long thin hallway. Stretching
   * each shape to fill its box would make every room look the same,
   * which is the one thing this must not do.
   */
  const hallway = [
    { x: 0, z: 0 },
    { x: 6, z: 0 },
    { x: 6, z: 1 },
    { x: 0, z: 1 },
  ];
  const t = outlineThumbnail(hallway, 40, 4);
  assert.ok(t, "a rectangle is still a drawable outline");

  const nums = t!.path.match(/-?\d+\.\d\d/g)!.map(Number);
  const xs = nums.filter((_, i) => i % 2 === 0);
  const zs = nums.filter((_, i) => i % 2 === 1);
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...zs) - Math.min(...zs);
  assert.ok(
    Math.abs(w / h - 6) < 0.01,
    `6:1 room should stay 6:1, got ${(w / h).toFixed(2)}`,
  );
  // And it fits inside the box with its padding.
  assert.ok(Math.min(...xs) >= 3.9 && Math.max(...xs) <= 36.1);

  assert.equal(outlineThumbnail(null), null);
  assert.equal(outlineThumbnail([{ x: 0, z: 0 }]), null);
});

test("an L-shaped room reaches the DXF as an L", () => {
  /*
   * "L-shape" is one of the three shapes the app offers, and choosing
   * it stores a notch width and length. Those two numbers drew the L
   * on screen and were read by nothing else -- measure-core never
   * looked at them, so the drawing that left the building was a plain
   * rectangle.
   *
   * The worst way to be wrong: the customer picked the shape, watched
   * the app draw it correctly, and Charlie received a box.
   */
  const room = planRoom("l", "Lounge", 4, 4);
  room.shape = "l-shape";
  room.notchWidthM = "1.5";
  room.notchLengthM = "1.5";
  room.floorPolygonM = undefined;

  const outline = roomOutlineM({
    room,
    anchor: { x: 0, z: 0 },
    rotationDeg: 0,
  });
  assert.equal(outline.length, 6, "an L has six corners, not four");

  // The bite is out of the bottom-right, so no corner sits at (4, 4).
  assert.ok(
    !outline.some((p) => Math.abs(p.x - 4) < 0.01 && Math.abs(p.z - 4) < 0.01),
    "the notch corner must not be part of the outline",
  );

  // And the walls follow the L rather than the bounding box.
  const dxf = buildDetailedPlanDxf([
    { room, anchor: { x: 0, z: 0 }, rotationDeg: 0 },
  ]);
  assert.match(dxf, /\n1\n2500\n/, "the short walls either side of the notch");
});

test("the DXF is structurally well-formed", () => {
  /*
   * The closest thing to opening the file that can be done without
   * CAD, and it exists because of what real dimensions cost.
   *
   * An R12 DIMENSION is three coupled things -- the entity, an
   * anonymous block holding its drawn form, and a DIMSTYLE it names --
   * spread across two sections that must appear in the right order.
   * Get any of it wrong and BricsCAD refuses to open the file at all
   * rather than drawing it badly, which is a far worse failure than
   * the loose lines this replaced. Nobody here has a copy of BricsCAD,
   * so the structure is checked arithmetically instead.
   */
  const a = planRoom("a", "Kitchen", 4, 3);
  const b = planRoom("b", "Hall", 2, 3);
  const dxf = buildDetailedPlanDxf([
    { room: a, anchor: { x: 0, z: 0 }, rotationDeg: 0 },
    { room: b, anchor: { x: 4, z: 0 }, rotationDeg: 0 },
  ]);
  // trimEnd: the file ends with a newline, which is correct and would
  // otherwise show up as a phantom final line.
  const lines = dxf.trimEnd().split("\n");

  // Every line is half of a group-code pair, so the count is even and
  // every even-indexed line is a numeric code.
  assert.equal(
    lines.length % 2,
    0,
    "a DXF is code/value pairs, so the line count must be even",
  );
  for (let i = 0; i < lines.length; i += 2) {
    assert.match(lines[i], /^\d+$/, `line ${i + 1} should be a group code`);
  }

  const count = (v: string) =>
    lines.filter((l, i) => i % 2 === 1 && l === v).length;

  // Sections, tables and blocks all balance.
  assert.equal(count("SECTION"), count("ENDSEC"), "SECTION/ENDSEC");
  assert.equal(count("TABLE"), count("ENDTAB"), "TABLE/ENDTAB");
  assert.equal(count("BLOCK"), count("ENDBLK"), "BLOCK/ENDBLK");

  // Order matters: HEADER, TABLES, BLOCKS, ENTITIES.
  const at = (v: string) => lines.findIndex((l) => l === v);
  assert.ok(at("HEADER") < at("TABLES"), "HEADER before TABLES");
  assert.ok(at("TABLES") < at("BLOCKS"), "TABLES before BLOCKS");
  assert.ok(at("BLOCKS") < at("ENTITIES"), "BLOCKS before ENTITIES");
  assert.ok(dxf.trimEnd().endsWith("EOF"), "file ends with EOF");

  // Every DIMENSION names a block that exists, and the style it names
  // is defined. A dangling reference is the specific way this fails.
  const blockNames = new Set(
    lines.filter((l) => /^\*D\d+$/.test(l)),
  );
  assert.ok(blockNames.size > 0, "there should be dimension blocks");
  const dimCount = count("DIMENSION");
  assert.equal(
    dimCount,
    count("BLOCK"),
    "one anonymous block per dimension entity",
  );
  assert.ok(dxf.includes("\n2\nTM\n"), "the TM dimension style is defined");
  assert.ok(dxf.includes("DIMSTYLE"), "the DIMSTYLE table is present");
});

test("every wall of every room is dimensioned", () => {
  /*
   * Charlie was receiving a correctly-scaled outline with no numbers
   * on it, so the first thing he had to do with each survey was
   * measure the drawing to find out what it said -- when the
   * measurements were the whole point of sending it.
   *
   * Dimensions are exploded lines and text rather than DXF DIMENSION
   * entities: R12 dimensions need a style table and a block per
   * dimension, and if any of it is subtly wrong the file will not open
   * at all. This pins that the numbers are present and correct in
   * millimetres, on their own layer so they can be switched off.
   */
  const room = planRoom("k", "Kitchen", 4.2, 3.1);
  const dxf = buildDetailedPlanDxf([
    { room, anchor: { x: 0, z: 0 }, rotationDeg: 0 },
  ]);

  assert.match(dxf, /TM-DIMS/, "dimensions need their own layer");
  // 4.20 m and 3.10 m, in millimetres, as their own TEXT values.
  assert.match(dxf, /\n1\n4200\n/, "the 4.2 m wall should read 4200");
  assert.match(dxf, /\n1\n3100\n/, "the 3.1 m wall should read 3100");

  // Not on the plain companion, which exists to be a clean shell.
  const plain = buildDetailedPlanDxf(
    [{ room, anchor: { x: 0, z: 0 }, rotationDeg: 0 }],
    { detailed: false },
  );
  assert.ok(!plain.includes("TM-DIMS"));
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

test("a staircase that turns says so on the drawing", () => {
  /*
   * A flight is drawn as a straight run whether or not it turns --
   * the plan has no geometry for winders and inventing some would be
   * worse than saying nothing. So the fact has to reach Charlie as
   * text, on the drawing, next to the flight it belongs to. Carrying
   * it only in the submission payload means it is in an email above a
   * DXF that contradicts it, and the DXF is the thing that gets
   * opened.
   */
  const room = planRoom("h", "Hall", 4, 3);
  room.stairs = [
    {
      id: "s1",
      widthM: "0.9",
      direction: "up",
      wallIndex: 0,
      positionM: "0.5",
      treads: "13",
      winders: true,
    },
  ];
  const dxf = buildDetailedPlanDxf([
    { room, anchor: { x: 0, z: 0 }, rotationDeg: 0 },
  ]);
  assert.match(dxf, /UP \(WINDERS\)/);

  // And a straight flight is not labelled as turning.
  room.stairs[0].winders = false;
  const straight = buildDetailedPlanDxf([
    { room, anchor: { x: 0, z: 0 }, rotationDeg: 0 },
  ]);
  assert.ok(!straight.includes("WINDERS"));
  assert.match(straight, /\nUP\n/);
});

test("a staircase dragged clear of a room is drawn where it was put", () => {
  /*
   * Plenty of staircases are not in a room: a stairwell in a hall, a
   * flight on an open landing, a run between two rooms that belongs to
   * neither. All of them were impossible to record while a flight
   * could only be pinned to a wall of whichever room it happened to be
   * entered in -- drag it out and it snapped straight back.
   *
   * `worldM` has to win over the wall fields, and it has to win in the
   * DXF and not only on screen. A flight the customer sees in the hall
   * and Charlie receives in the bedroom is worse than one that was
   * never movable.
   */
  const room = planRoom("h", "Hall", 4, 3);
  const flight = {
    id: "s1",
    widthM: "0.9",
    direction: "up" as const,
    // Deliberately left set. They are the values the flight had before
    // it was dragged out, and the point is that they are now ignored.
    wallIndex: 0,
    positionM: "0.5",
    treads: "13",
  };
  room.stairs = [{ ...flight, worldM: { x: 20, z: 12 }, headingDeg: 0 }];

  const dxf = buildDetailedPlanDxf([
    { room, anchor: { x: 0, z: 0 }, rotationDeg: 0 },
  ]);

  // Millimetres, and z negated for CAD's y-up — so 20 m across and
  // 12 m down is x=20000, y=-12000. The room sits at the origin and is
  // only 4 m wide, so nothing wall-anchored could reach out there:
  // finding those coordinates at all proves worldM was honoured.
  assert.match(dxf, /\n20000\.00\n/, "run should start at x = 20 m");
  assert.match(dxf, /\n-12000\.00\n/, "and at z = 12 m, negated for CAD");
  // 13 treads at the 220 mm going is a 2.86 m run, so the far end
  // lands at 22860 — which also pins that a free flight is not clipped
  // to a wall length it no longer has.
  assert.match(dxf, /\n22860\.00\n/, "run should be its full length");
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
  // "m2", not "m²". An R12 DXF has no Unicode, so the superscript went
  // in as raw UTF-8 and came out of BricsCAD as "12.0 mÂ²" -- on every
  // drawing this app has ever produced. See sanitiseDxfText.
  assert.match(dxf, /12\.0 m2/);
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

test("a short wall on a scanned room does not trap the customer", () => {
  /*
   * Charlie could not get past the photo step. A scanned room reported
   * "Too short (min 0.3 m)" on a wall -- and a scanned room has no
   * walls screen, so the flow had nowhere to send him. The error named
   * a box that exists nowhere he could reach, on every screen, with no
   * way out. The survey simply ended there.
   *
   * The minimum is a typo-catcher for someone typing into a field.
   * Nobody means to enter a 4 cm wall. It is not a fact about
   * buildings: a scanner reports the 150 mm return beside a chimney
   * breast because it is really there.
   */
  const scanned = planRoom("s", "Lounge", 4, 3);
  scanned.measuredByScan = true;
  scanned.photos = [];
  scanned.floorPolygonM = undefined;
  scanned.walls = [
    { id: "w1", label: "Wall 1", lengthM: "4.00", photos: [] },
    { id: "w2", label: "Wall 2", lengthM: "0.15", photos: [] },
  ] as typeof scanned.walls;

  assert.deepEqual(
    validateRoom(scanned, 0).filter((i) => i.path.includes("-wall-")),
    [],
    "a measurement from the sensor is not a typo",
  );
});

test("a short wall typed by hand is still caught", () => {
  // The exemption must not reach typed rooms: 0.15 in a box the
  // customer filled in is a slipped decimal point, and catching it
  // while they are stood in the room is the entire point.
  const typed = planRoom("t", "Lounge", 4, 3);
  typed.floorPolygonM = undefined;
  typed.walls = [
    { id: "w1", label: "Wall 1", lengthM: "0.15", photos: [] },
  ] as typeof typed.walls;

  assert.equal(
    validateRoom(typed, 0).filter((i) => i.path === "room-0-wall-0").length,
    1,
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

/* ── wall faces and doors ─────────────────────────────────────────── */

/**
 * Every LINE in the file, as metres in the app's frame.
 *
 * The DXF is written in millimetres with z negated, so this undoes
 * both — otherwise every expectation below would have to be written
 * in the file's units, which is how a sign error survives a test.
 */
function planLines(dxf: string): { a: Pt2; b: Pt2; layer: string }[] {
  const out: { a: Pt2; b: Pt2; layer: string }[] = [];
  const lines = dxf.trimEnd().split("\n");
  for (let i = 0; i < lines.length - 1; i += 2) {
    if (lines[i] !== "0" || lines[i + 1] !== "LINE") continue;
    const f: Record<string, string> = {};
    for (let j = i + 2; j < lines.length - 1; j += 2) {
      if (lines[j] === "0") break;
      f[lines[j]] = lines[j + 1];
    }
    out.push({
      layer: f["8"] ?? "",
      a: { x: Number(f["10"]) / 1000, z: -Number(f["20"]) / 1000 },
      b: { x: Number(f["11"]) / 1000, z: -Number(f["21"]) / 1000 },
    });
  }
  return out;
}

type Pt2 = { x: number; z: number };

/** Is a point strictly inside a polygon? Ray casting, no frills. */
function inside(poly: Pt2[], p: Pt2): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (
      a.z > p.z !== b.z > p.z &&
      p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x
    ) {
      hit = !hit;
    }
  }
  return hit;
}

test("wall corners are mitred, so a room closes", () => {
  /*
   * The bug this pins down drew every wall from its own centreline
   * ends, so at each corner the outer faces stopped short of each
   * other and the inner faces crossed. It looked like a box with the
   * corners chewed off, and nothing in the old suite noticed because
   * nothing checked where a face ended -- only that lines of roughly
   * the right length existed.
   *
   * A 4x3 room, all walls external at 250mm: the inner face is the
   * rectangle inset by 125mm on every side, and its four corners are
   * exact. If the corners are not mitred, no line ends at (0.125,
   * 0.125), because the top wall's inner face starts at x=0.
   */
  const dxf = buildDetailedPlanDxf([
    { room: planRoom("m", "Kitchen", 4, 3), anchor: { x: 0, z: 0 }, rotationDeg: 0 },
  ]);
  const walls = planLines(dxf).filter((l) => l.layer === "TM-WALLS");

  const corners: Pt2[] = [
    { x: 0.125, z: 0.125 },
    { x: 3.875, z: 0.125 },
    { x: 3.875, z: 2.875 },
    { x: 0.125, z: 2.875 },
  ];
  for (const c of corners) {
    const meeting = walls.filter(
      (l) =>
        (Math.abs(l.a.x - c.x) < 0.002 && Math.abs(l.a.z - c.z) < 0.002) ||
        (Math.abs(l.b.x - c.x) < 0.002 && Math.abs(l.b.z - c.z) < 0.002),
    );
    assert.equal(
      meeting.length,
      2,
      `two inner faces must meet at (${c.x}, ${c.z}), found ${meeting.length}`,
    );
  }

  // And the outer face likewise, 125mm the other way.
  const outer = walls.filter(
    (l) =>
      (Math.abs(l.a.x + 0.125) < 0.002 && Math.abs(l.a.z + 0.125) < 0.002) ||
      (Math.abs(l.b.x + 0.125) < 0.002 && Math.abs(l.b.z + 0.125) < 0.002),
  );
  assert.equal(outer.length, 2, "two outer faces must meet at the outer corner");
});

test("an L-shaped room's faces close at the reflex corner too", () => {
  /*
   * The corner that turns the other way is the one the old code got
   * most visibly wrong: the overshoot landed inside the room. Six
   * corners, six mitres, and every face endpoint shared with exactly
   * one other face.
   */
  const room = {
    ...planRoom("l2", "Lounge", 4, 4),
    shape: "l-shape",
    notchWidthM: "1.5",
    notchLengthM: "1.5",
  } as RoomDraft;
  const dxf = buildDetailedPlanDxf([
    { room, anchor: { x: 0, z: 0 }, rotationDeg: 0 },
  ]);
  const walls = planLines(dxf).filter((l) => l.layer === "TM-WALLS");
  assert.equal(walls.length, 12, "six walls, two faces each, no openings");

  // Every endpoint is shared by exactly two faces: that is what a
  // closed chain means, and an unmitred one has twelve loose ends.
  const key = (p: Pt2) => `${p.x.toFixed(3)},${p.z.toFixed(3)}`;
  const counts = new Map<string, number>();
  for (const l of walls) {
    for (const p of [l.a, l.b]) {
      counts.set(key(p), (counts.get(key(p)) ?? 0) + 1);
    }
  }
  const loose = [...counts.entries()].filter(([, n]) => n !== 2);
  assert.deepEqual(loose, [], "no face may end anywhere but at a mitre");
});

test("a door swings into its room, with a leaf that has thickness", () => {
  /*
   * The old door was one line and an arc struck from the wall's
   * centreline -- so on a 250mm wall it began 125mm inside the room,
   * and the arc cut through the jamb. This checks the two things that
   * makes a door read as a door: a closed leaf, and a swing that is
   * inside the room rather than out on the pavement.
   */
  const room = {
    ...planRoom("d", "Kitchen", 4, 3),
    doors: [{ id: "d1", widthM: "0.76", wallIndex: 0, positionM: "2.0" }],
  } as unknown as RoomDraft;
  const entry = { room, anchor: { x: 0, z: 0 }, rotationDeg: 0 as const };
  const dxf = buildDetailedPlanDxf([entry]);
  const doors = planLines(dxf).filter((l) => l.layer === "TM-DOORS");

  // Four lines: a rectangle. Three would be an open leaf, one is the
  // stray line this replaced.
  assert.equal(doors.length, 4, "the leaf is drawn as a closed rectangle");

  const poly = roomOutlineM(entry);
  const far = doors
    .flatMap((l) => [l.a, l.b])
    .filter((p) => inside(poly, p));
  assert.ok(
    far.length >= 4,
    "the leaf must stand inside the room, not out through the wall",
  );

  // The leaf is a real 44mm door, not a zero-width line.
  const thin = doors.filter((l) => {
    const d = Math.hypot(l.a.x - l.b.x, l.a.z - l.b.z);
    return Math.abs(d - 0.044) < 0.001;
  });
  assert.equal(thin.length, 2, "two ends of a 44mm leaf");

  // And the swing is an arc of the clear width, not of something else.
  assert.match(dxf, /\n0\nARC\n/, "a door has a swing arc");
});

test("the swing arc opens on the room side of the wall", () => {
  /*
   * The arc's own angles are the easiest thing in this file to get
   * backwards, because `arc` flips them to undo the z negation. A
   * wrong flip draws a perfectly convincing door opening into the
   * garden. Sampled at its midpoint rather than trusting the numbers.
   */
  const room = {
    ...planRoom("d2", "Kitchen", 4, 3),
    doors: [{ id: "d1", widthM: "0.9", wallIndex: 0, positionM: "2.0" }],
  } as unknown as RoomDraft;
  const entry = { room, anchor: { x: 0, z: 0 }, rotationDeg: 0 as const };
  const dxf = buildDetailedPlanDxf([entry]);

  const lines = dxf.trimEnd().split("\n");
  const i = lines.findIndex((l, n) => n % 2 === 1 && l === "ARC" && lines[n - 1] === "0");
  assert.ok(i > 0, "there is an arc");
  const f: Record<string, string> = {};
  for (let j = i + 1; j < lines.length - 1; j += 2) {
    if (lines[j] === "0") break;
    f[lines[j]] = lines[j + 1];
  }
  const cx = Number(f["10"]) / 1000;
  const cy = Number(f["20"]) / 1000;
  const r = Number(f["40"]) / 1000;
  const s = Number(f["50"]);
  const e = Number(f["51"]);
  // Sweep CCW from s to e in CAD's own frame, and look at the middle.
  const mid = ((s + ((e - s + 360) % 360) / 2) * Math.PI) / 180;
  const p = { x: cx + r * Math.cos(mid), z: -(cy + r * Math.sin(mid)) };

  assert.ok(
    inside(roomOutlineM(entry), p),
    `the swing must sweep through the room, not outside it (got ${p.x.toFixed(2)}, ${p.z.toFixed(2)})`,
  );
});

test("an opening's reveals are square to the wall and its true width", () => {
  /*
   * Mitring makes the inner face shorter than the centreline and the
   * outer face longer. The first version of it placed openings as a
   * fraction of each face's own run, which put the two sides of one
   * reveal 47mm apart on a 4m external wall -- a splayed jamb, and a
   * door 712mm wide on the room side and 810 on the other. It looked
   * intentional, which is exactly why it needed a test.
   *
   * A 760 door centred at 2.0 on a 4m wall: both reveals run straight
   * across the wall at x=1.62 and x=2.38, and they are 760 apart.
   */
  const room = {
    ...planRoom("rv", "Kitchen", 4, 3),
    doors: [{ id: "d1", widthM: "0.76", wallIndex: 0, positionM: "2.0" }],
  } as unknown as RoomDraft;
  const dxf = buildDetailedPlanDxf([
    { room, anchor: { x: 0, z: 0 }, rotationDeg: 0 },
  ]);
  // A jamb is the short line across the wall: vertical here, and
  // exactly one wall thick. The side walls' faces are vertical too and
  // metres long, which is what distinguishes them.
  const jambs = planLines(dxf).filter(
    (l) =>
      l.layer === "TM-WALLS" &&
      Math.abs(l.a.x - l.b.x) < 1e-6 &&
      Math.abs(Math.abs(l.a.z - l.b.z) - 0.25) < 1e-6,
  );
  const xs = jambs.map((l) => Number(l.a.x.toFixed(3))).sort((p, q) => p - q);
  assert.deepEqual(xs, [1.62, 2.38], "both reveals run straight across the wall");
  assert.equal(
    Number((xs[1] - xs[0]).toFixed(3)),
    0.76,
    "and the opening is the width the customer gave",
  );
});
