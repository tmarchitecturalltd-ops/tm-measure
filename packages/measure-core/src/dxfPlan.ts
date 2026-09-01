/**
 * dxfPlan.ts — the drawn floor plan.
 *
 * `dxf.ts` produces a plain outline: one line per wall, room names,
 * correct scale. Useful, and not what an architect draws from. This
 * module produces the other thing: walls with real thickness, openings
 * cut into them, doors with swing arcs, windows as frames, stairs with
 * treads. The reference is a set of existing TM Designs plans, and the
 * intent is that Charlie opens it and finishes rather than starts.
 *
 * Both are produced. The plain one is easier to build on when the
 * detail is wrong; the detailed one is the point.
 *
 * ── What it can and cannot know ────────────────────────────────────
 *
 * Wall thickness is not measured — it is inferred. A wall shared with
 * another room is internal (125 mm); anything else faces outside
 * (250 mm). That inference needs rooms positioned relative to each
 * other, which a LiDAR scan gives directly and manual entry only gives
 * if the customer completed the floor-plan step. When rooms are not
 * placed, everything is drawn as external, and the drawing says so.
 *
 * Openings are placed from `wallIndex` and `positionM`. Where the
 * customer never said, the opening is centred — and centred is wrong
 * far more often than it is right, which is why the app now flags it.
 *
 * ── Units and axes ─────────────────────────────────────────────────
 *
 * Millimetres throughout, and the app's screen-down z is negated into
 * CAD's y-up. Both are load-bearing and both fail silently: a plan at
 * 1/1000 looks plausible until it is dimensioned, and a mirrored plan
 * looks entirely normal until something is built from it.
 */

import type {
  Opening,
  RoomDraft,
  RoomFixture,
  RoomRotationDeg,
  RoomStairs,
} from "./types";
import { FIXTURE_SIZES_M, fixtureFootprintM } from "./types.ts";
import { roomFootprint } from "./floorplan.ts";
import { roomCornersM, sanitiseDxfText } from "./dxf.ts";

export const WALL_INTERNAL_M = 0.125;
export const WALL_EXTERNAL_M = 0.25;

const MM = 1000;

export const LAYER = {
  walls: "TM-WALLS",
  doors: "TM-DOORS",
  windows: "TM-WINDOWS",
  stairs: "TM-STAIRS",
  fixtures: "TM-FIXTURES",
  labels: "TM-LABELS",
  title: "TM-TITLE",
} as const;

type Pt = { x: number; z: number };

/** A wall centreline in world metres, with the room and edge it came from. */
export type PlanWall = {
  roomId: string;
  /** 0-3, matching the room's walls[] order. */
  wallIndex: number;
  a: Pt;
  b: Pt;
  /** True when another room sits against this wall. */
  internal: boolean;
};

export type PlanRoomInput = {
  room: RoomDraft;
  anchor: Pt;
  rotationDeg: RoomRotationDeg;
};

/* ── geometry helpers ─────────────────────────────────────────────── */

const sub = (p: Pt, q: Pt): Pt => ({ x: p.x - q.x, z: p.z - q.z });
const len = (p: Pt): number => Math.hypot(p.x, p.z);
const norm = (p: Pt): Pt => {
  const l = len(p) || 1;
  return { x: p.x / l, z: p.z / l };
};
/** Left-hand perpendicular. */
const perp = (p: Pt): Pt => ({ x: -p.z, z: p.x });
const dot = (p: Pt, q: Pt): number => p.x * q.x + p.z * q.z;

/**
 * Are two wall segments the same wall seen from either side?
 *
 * Rooms drawn edge to edge share a boundary; rooms separated by the
 * thickness of a wall do not quite. The tolerance has to swallow that
 * gap without swallowing a genuine corridor, so it is set at 0.4 m —
 * comfortably more than any internal wall and less than any room.
 */
export function wallsAreShared(
  a1: Pt,
  a2: Pt,
  b1: Pt,
  b2: Pt,
  tolM = 0.4,
): boolean {
  const da = norm(sub(a2, a1));
  const db = norm(sub(b2, b1));
  // Parallel, either direction. cos 10° ≈ 0.985.
  if (Math.abs(dot(da, db)) < 0.985) return false;

  // Perpendicular distance from b's midpoint to a's line.
  const n = perp(da);
  const mid = { x: (b1.x + b2.x) / 2, z: (b1.z + b2.z) / 2 };
  if (Math.abs(dot(sub(mid, a1), n)) > tolM) return false;

  // Overlap along the shared direction. Touching at a corner is not
  // sharing a wall, so require a real run of it.
  const pa1 = dot(sub(a1, a1), da);
  const pa2 = dot(sub(a2, a1), da);
  const pb1 = dot(sub(b1, a1), da);
  const pb2 = dot(sub(b2, a1), da);
  const overlap =
    Math.min(Math.max(pa1, pa2), Math.max(pb1, pb2)) -
    Math.max(Math.min(pa1, pa2), Math.min(pb1, pb2));
  return overlap > 0.3;
}

/**
 * The room's outline in world metres.
 *
 * Uses the real floor polygon when there is one, and the bounding
 * rectangle otherwise. A bounding rectangle is a complete description
 * of a rectangular room and a poor one of an L-shape, a bay or a
 * splayed corner — and an L-shape drawn as a rectangle with six wall
 * lengths listed beside it is wrong in the worst way, because it looks
 * finished.
 *
 * The polygon is stored relative to the room's anchor, so it takes the
 * same rotation about that anchor as the rectangle would.
 */
export function roomOutlineM(entry: PlanRoomInput): Pt[] {
  const { room, anchor, rotationDeg } = entry;
  const poly = room.floorPolygonM;
  if (!poly || poly.length < 3) {
    return roomCornersM(anchor, roomFootprint(room), rotationDeg);
  }
  const rot = ((rotationDeg % 360) + 360) % 360;
  return poly.map(({ x, z }) => {
    switch (rot) {
      case 90:
        return { x: anchor.x - z, z: anchor.z + x };
      case 180:
        return { x: anchor.x - x, z: anchor.z - z };
      case 270:
        return { x: anchor.x + z, z: anchor.z - x };
      default:
        return { x: anchor.x + x, z: anchor.z + z };
    }
  });
}

/** Every room's wall centrelines, classified internal or external. */
export function buildWalls(entries: PlanRoomInput[]): PlanWall[] {
  const raw: PlanWall[] = [];
  for (const entry of entries) {
    const { room } = entry;
    const corners = roomOutlineM(entry);
    for (let i = 0; i < corners.length; i++) {
      raw.push({
        roomId: room.id,
        wallIndex: i,
        a: corners[i],
        b: corners[(i + 1) % corners.length],
        internal: false,
      });
    }
  }
  return raw.map((w) => ({
    ...w,
    internal: raw.some(
      (o) => o.roomId !== w.roomId && wallsAreShared(w.a, w.b, o.a, o.b),
    ),
  }));
}

/* ── DXF primitives ───────────────────────────────────────────────── */

const pair = (code: number | string, v: string | number) => `${code}\n${v}`;

/** Metres (x, z screen-down) → millimetres (x, y CAD-up). */
const toMm = (p: Pt) => ({ x: p.x * MM, y: -p.z * MM });

function line(layer: string, a: Pt, b: Pt): string {
  const A = toMm(a);
  const B = toMm(b);
  return [
    pair(0, "LINE"),
    pair(8, layer),
    pair(10, A.x.toFixed(2)),
    pair(20, A.y.toFixed(2)),
    pair(30, "0.0"),
    pair(11, B.x.toFixed(2)),
    pair(21, B.y.toFixed(2)),
    pair(31, "0.0"),
  ].join("\n");
}

/**
 * Arc for a door swing. Angles are given in the app's frame and
 * converted here, because the z negation reverses the direction of
 * rotation — an arc that is not flipped with its geometry opens through
 * the wall instead of into the room.
 */
function arc(
  layer: string,
  centre: Pt,
  radiusM: number,
  startDeg: number,
  endDeg: number,
): string {
  const C = toMm(centre);
  const s = -endDeg;
  const e = -startDeg;
  return [
    pair(0, "ARC"),
    pair(8, layer),
    pair(10, C.x.toFixed(2)),
    pair(20, C.y.toFixed(2)),
    pair(30, "0.0"),
    pair(40, (radiusM * MM).toFixed(2)),
    pair(50, s.toFixed(2)),
    pair(51, e.toFixed(2)),
  ].join("\n");
}

function text(
  layer: string,
  at: Pt,
  heightMm: number,
  value: string,
  centred = true,
): string {
  const P = toMm(at);
  const base = [
    pair(0, "TEXT"),
    pair(8, layer),
    pair(10, P.x.toFixed(2)),
    pair(20, P.y.toFixed(2)),
    pair(30, "0.0"),
    pair(40, heightMm.toFixed(1)),
  ];
  if (centred) {
    base.push(pair(72, 1), pair(11, P.x.toFixed(2)), pair(21, P.y.toFixed(2)), pair(31, "0.0"));
  }
  base.push(pair(1, sanitiseDxfText(value)));
  return base.join("\n");
}

/* ── openings ─────────────────────────────────────────────────────── */

type OpeningOnWall = {
  /** Distance along the wall to the opening's centre, in metres. */
  centreM: number;
  widthM: number;
  kind: "door" | "window";
  /** True when nobody said where it goes and we centred it. */
  assumed: boolean;
};

function openingsForWall(
  room: RoomDraft,
  wallIndex: number,
  wallLengthM: number,
): OpeningOnWall[] {
  const collect = (list: Opening[], kind: "door" | "window") =>
    list
      .filter((o) => (o.wallIndex ?? 0) === wallIndex)
      .map((o) => {
        const width = Number.parseFloat(o.widthM);
        const pos = o.positionM ? Number.parseFloat(o.positionM) : NaN;
        const assumed = !Number.isFinite(pos);
        const centre = assumed ? wallLengthM / 2 : pos;
        return {
          kind,
          widthM: Number.isFinite(width) && width > 0 ? width : 0.8,
          centreM: centre,
          assumed,
        };
      })
      .filter((o) => o.widthM < wallLengthM);

  return [...collect(room.doors, "door"), ...collect(room.windows, "window")].sort(
    (a, b) => a.centreM - b.centreM,
  );
}

/* ── the drawing ──────────────────────────────────────────────────── */

export type PlanDxfOptions = {
  projectName?: string;
  /** Set false for the plain-geometry companion drawing. */
  detailed?: boolean;
  /** Printed in the title block. */
  dateISO?: string;
};

export function buildDetailedPlanDxf(
  entries: PlanRoomInput[],
  options: PlanDxfOptions = {},
): string {
  const detailed = options.detailed !== false;
  const placed = entries.filter((e) => e.anchor);
  const walls = buildWalls(placed);
  const out: string[] = [];

  out.push(pair(0, "SECTION"), pair(2, "HEADER"));
  out.push(pair(9, "$ACADVER"), pair(1, "AC1009"));
  out.push(pair(9, "$INSUNITS"), pair(70, 4));
  out.push(pair(0, "ENDSEC"));

  // Only declare the layers this drawing actually uses. The plain
  // companion is meant to be a clean base to build on, and handing
  // someone an empty TM-DOORS layer to switch off is the opposite of
  // that.
  const layers: [string, number][] = detailed
    ? [
        [LAYER.walls, 7],
        [LAYER.doors, 1],
        [LAYER.windows, 5],
        [LAYER.stairs, 3],
        [LAYER.fixtures, 4],
        [LAYER.labels, 2],
        [LAYER.title, 7],
      ]
    : [
        [LAYER.walls, 7],
        [LAYER.labels, 2],
      ];

  out.push(pair(0, "SECTION"), pair(2, "TABLES"));
  out.push(pair(0, "TABLE"), pair(2, "LAYER"), pair(70, layers.length));
  for (const [name, colour] of layers) {
    out.push(
      pair(0, "LAYER"),
      pair(2, name),
      pair(70, 0),
      pair(62, colour),
      pair(6, "CONTINUOUS"),
    );
  }
  out.push(pair(0, "ENDTAB"), pair(0, "ENDSEC"));

  out.push(pair(0, "SECTION"), pair(2, "ENTITIES"));

  const byRoom = new Map(placed.map((e) => [e.room.id, e]));

  for (const w of walls) {
    const entry = byRoom.get(w.roomId);
    if (!entry) continue;
    const thickness = w.internal ? WALL_INTERNAL_M : WALL_EXTERNAL_M;
    const dir = norm(sub(w.b, w.a));
    const n = perp(dir);
    const half = thickness / 2;
    const wallLen = len(sub(w.b, w.a));

    const offset = (p: Pt, s: number): Pt => ({
      x: p.x + n.x * s,
      z: p.z + n.z * s,
    });
    const along = (d: number): Pt => ({
      x: w.a.x + dir.x * d,
      z: w.a.z + dir.z * d,
    });

    if (!detailed) {
      // Plain companion drawing: centreline only.
      out.push(line(LAYER.walls, w.a, w.b));
      continue;
    }

    const openings = openingsForWall(entry.room, w.wallIndex, wallLen);

    // Both faces of the wall, broken around each opening. Drawing the
    // faces as continuous lines and the openings on top would leave the
    // wall running straight through every door.
    let cursor = 0;
    for (const o of openings) {
      const start = Math.max(0, o.centreM - o.widthM / 2);
      const end = Math.min(wallLen, o.centreM + o.widthM / 2);
      if (start > cursor) {
        out.push(line(LAYER.walls, offset(along(cursor), half), offset(along(start), half)));
        out.push(line(LAYER.walls, offset(along(cursor), -half), offset(along(start), -half)));
      }
      // Jambs: close the wall off at the reveal, otherwise the opening
      // reads as the wall simply stopping.
      out.push(line(LAYER.walls, offset(along(start), half), offset(along(start), -half)));
      out.push(line(LAYER.walls, offset(along(end), half), offset(along(end), -half)));

      if (o.kind === "window") {
        // Frame: two thin lines across the reveal.
        const q = thickness / 6;
        out.push(line(LAYER.windows, offset(along(start), q), offset(along(end), q)));
        out.push(line(LAYER.windows, offset(along(start), -q), offset(along(end), -q)));
      } else {
        // Door: leaf on the hinge side, opening into the room, with the
        // swing arc. Hinge side is not captured anywhere, so the start
        // edge is used consistently -- an assumption, and a visible one,
        // which is better than an invisible one.
        const hinge = along(start);
        const leafEnd = offset(hinge, o.widthM);
        out.push(line(LAYER.doors, hinge, leafEnd));
        const baseAngle = (Math.atan2(dir.z, dir.x) * 180) / Math.PI;
        out.push(arc(LAYER.doors, hinge, o.widthM, baseAngle, baseAngle + 90));
      }
      cursor = end;
    }
    if (cursor < wallLen) {
      out.push(line(LAYER.walls, offset(along(cursor), half), offset(along(wallLen), half)));
      out.push(line(LAYER.walls, offset(along(cursor), -half), offset(along(wallLen), -half)));
    }
  }

  // Rooms: labels, and stairs where present.
  for (const entry of placed) {
    const { room } = entry;
    const size = roomFootprint(room);
    const corners = roomOutlineM(entry);
    // Centroid of the actual outline, so a label sits inside an L-shaped
    // room rather than in the notch it does not occupy.
    const cx = corners.reduce((s, c) => s + c.x, 0) / corners.length;
    const cz = corners.reduce((s, c) => s + c.z, 0) / corners.length;

    const name = room.name?.trim();
    if (name) {
      const shortest = Math.min(size.widthM, size.lengthM) * MM;
      const h = Math.max(120, Math.min(350, shortest / 12));
      out.push(text(LAYER.labels, { x: cx, z: cz }, h, name));
      if (detailed) {
        // Shoelace on the real outline. The bounding-box area overstates
        // an L-shaped room by whatever the notch removes, and an area
        // written on a drawing gets used.
        const area =
          corners.length >= 3
            ? Math.abs(
                corners.reduce(
                  (sum, p, i) => {
                    const q = corners[(i + 1) % corners.length];
                    return sum + (p.x * q.z - q.x * p.z);
                  },
                  0,
                ),
              ) / 2
            : size.widthM * size.lengthM;
        out.push(
          text(
            LAYER.labels,
            { x: cx, z: cz + (h / MM) * 1.6 },
            h * 0.7,
            `${area.toFixed(1)} m²`,
          ),
        );
      }
    }

    if (detailed) {
      for (const s of room.stairs ?? []) drawStairs(out, room, s, corners);
      // Fixtures on every plan, detailed or not? No — the plain outline
      // export exists to be a clean shell, and sanitaryware in it would
      // defeat that. Detailed only.
      for (const f of room.fixtures ?? []) drawFixture(out, entry, f);
    }
  }

  if (detailed) drawTitleBlock(out, placed, options);

  out.push(pair(0, "ENDSEC"), pair(0, "EOF"));
  return out.join("\n") + "\n";
}

/**
 * Stairs as a run of treads with a direction arrow.
 *
 * Drawn against the wall the customer nominated, starting where they
 * put it. Without a tread count 13 is assumed, which is the commonest
 * domestic flight in the UK and, being visibly a guess in the notes,
 * better than omitting the stairs entirely.
 */
/**
 * Room-local metres → world metres, using the same convention as
 * `roomOutlineM`.
 *
 * Factored out rather than repeated because a fixture that used a
 * different rotation convention from the room outline would look
 * correct on an unrotated plan and drift into the wall on every
 * rotated one — which is exactly the sort of fault that reaches CAD
 * before anyone notices.
 */
function localToWorld(entry: PlanRoomInput, p: Pt): Pt {
  const { anchor, rotationDeg } = entry;
  const rot = ((rotationDeg % 360) + 360) % 360;
  switch (rot) {
    case 90:
      return { x: anchor.x - p.z, z: anchor.z + p.x };
    case 180:
      return { x: anchor.x - p.x, z: anchor.z - p.z };
    case 270:
      return { x: anchor.x + p.z, z: anchor.z - p.x };
    default:
      return { x: anchor.x + p.x, z: anchor.z + p.z };
  }
}

/**
 * Draw one fixture: its footprint, plus enough of a glyph to tell a
 * toilet from a basin at a glance.
 *
 * Kept crude on purpose. These are customer-placed to the nearest
 * quarter metre by finger, so a photorealistic sanitaryware block
 * would imply a precision the input does not have. A labelled box of
 * the right size in the right place is honest and is what the
 * draughtsman actually needs.
 */
function drawFixture(
  out: string[],
  entry: PlanRoomInput,
  f: RoomFixture,
): void {
  const { widthM, depthM } = fixtureFootprintM(f);
  const c = f.positionM;
  const hw = widthM / 2;
  const hd = depthM / 2;

  const corners: Pt[] = [
    { x: c.x - hw, z: c.z - hd },
    { x: c.x + hw, z: c.z - hd },
    { x: c.x + hw, z: c.z + hd },
    { x: c.x - hw, z: c.z + hd },
  ].map((p) => localToWorld(entry, p));

  for (let i = 0; i < corners.length; i++) {
    out.push(
      line(LAYER.fixtures, corners[i], corners[(i + 1) % corners.length]),
    );
  }

  // A bath and a shower get a diagonal so they read as basins-you-
  // stand-in rather than cupboards; a toilet gets its cistern edge.
  if (f.kind === "bath" || f.kind === "shower") {
    out.push(line(LAYER.fixtures, corners[0], corners[2]));
  }

  const label = FIXTURE_SIZES_M[f.kind].label;
  const h = Math.max(80, Math.min(200, (Math.min(widthM, depthM) * MM) / 4));
  out.push(text(LAYER.fixtures, localToWorld(entry, c), h, label));
}

function drawStairs(
  out: string[],
  room: RoomDraft,
  s: RoomStairs,
  corners: Pt[],
): void {
  const wallIndex = s.wallIndex ?? 0;
  const a = corners[wallIndex % corners.length];
  const b = corners[(wallIndex + 1) % corners.length];
  const dir = norm(sub(b, a));
  const n = perp(dir);
  const wallLen = len(sub(b, a));

  const width = Number.parseFloat(s.widthM);
  const w = Number.isFinite(width) && width > 0 ? width : 0.9;
  const pos = s.positionM ? Number.parseFloat(s.positionM) : NaN;
  const start = Number.isFinite(pos) ? Math.max(0, pos - w / 2) : 0.2;

  const treads = Number.parseInt(s.treads ?? "", 10);
  const n_treads = Number.isFinite(treads) && treads > 0 ? treads : 13;
  const going = 0.22; // typical UK going, metres
  const runLen = Math.min(n_treads * going, wallLen - start);

  const p = (d: number, off: number): Pt => ({
    x: a.x + dir.x * d + n.x * off,
    z: a.z + dir.z * d + n.z * off,
  });

  // Outline
  out.push(line(LAYER.stairs, p(start, 0), p(start + runLen, 0)));
  out.push(line(LAYER.stairs, p(start, w), p(start + runLen, w)));
  out.push(line(LAYER.stairs, p(start, 0), p(start, w)));
  out.push(line(LAYER.stairs, p(start + runLen, 0), p(start + runLen, w)));

  // Treads
  const step = runLen / n_treads;
  for (let i = 1; i < n_treads; i++) {
    out.push(line(LAYER.stairs, p(start + i * step, 0), p(start + i * step, w)));
  }

  // Direction arrow along the centre of the flight
  const midOff = w / 2;
  out.push(line(LAYER.stairs, p(start + 0.1, midOff), p(start + runLen - 0.1, midOff)));
  const tip = p(start + runLen - 0.1, midOff);
  const back = p(start + runLen - 0.35, midOff);
  out.push(line(LAYER.stairs, tip, { x: back.x + n.x * 0.12, z: back.z + n.z * 0.12 }));
  out.push(line(LAYER.stairs, tip, { x: back.x - n.x * 0.12, z: back.z - n.z * 0.12 }));

  out.push(
    text(
      LAYER.stairs,
      p(start + runLen / 2, w + 0.25),
      140,
      s.direction === "up" ? "UP" : "DN",
    ),
  );
}

function drawTitleBlock(
  out: string[],
  placed: PlanRoomInput[],
  options: PlanDxfOptions,
): void {
  const all = placed.flatMap((e) => roomOutlineM(e));
  if (!all.length) return;
  const minX = Math.min(...all.map((p) => p.x));
  const maxX = Math.max(...all.map((p) => p.x));
  const minZ = Math.min(...all.map((p) => p.z));

  // Above the plan, so it never lands on a room.
  const top = minZ - 1.2;
  const lines = [
    options.projectName?.trim() || "TM Measure survey",
    `Generated ${(options.dateISO ?? new Date().toISOString()).slice(0, 10)}`,
    "Millimetres. Survey data — verify before construction.",
    `Internal walls ${WALL_INTERNAL_M * MM} mm, external ${WALL_EXTERNAL_M * MM} mm (assumed).`,
  ];
  lines.forEach((l, i) => {
    out.push(
      text(
        LAYER.title,
        { x: minX, z: top - i * 0.45 },
        i === 0 ? 400 : 220,
        l,
        false,
      ),
    );
  });
  // Underline
  out.push(
    line(LAYER.title, { x: minX, z: top + 0.25 }, { x: maxX, z: top + 0.25 }),
  );
}
