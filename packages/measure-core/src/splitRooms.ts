/**
 * Rooms, rebuilt from the walls the sensor saw.
 *
 * ── Why this exists ────────────────────────────────────────────────
 *
 * RoomPlan decides for itself where one room ends and the next
 * begins, and on a continuous walk through a house it usually decides
 * they do not. The result is a single CapturedRoom whose floor
 * polygon wanders around two bedrooms and the landing between them,
 * pinching at each doorway.
 *
 * The app built the drawing from that polygon, so a 125 mm partition
 * with rooms on both sides arrived as a single line in the middle of
 * one enormous room, and a hallway had no identity at all. Reported
 * from the field as: "this is 2 rooms with an internal wall which it
 * picks up on the scan and the 3D model while scanning, but when it
 * goes to phase two it doesn't show it."
 *
 * The important part of that report is "it picks up on the scan". The
 * partition is not missing from the data. RoomPlan reports every wall
 * it found as its own surface, internal ones included, with a
 * centreline and a thickness. It is only the floor polygon that
 * cannot express them, because a polygon has one boundary and a house
 * has interior walls.
 *
 * So the rooms are rebuilt from the walls instead: lay every wall
 * centreline down as a line segment, cut them where they cross, and
 * every enclosed region of the resulting arrangement is a room. The
 * landing between two bedrooms is enclosed by the same walls as the
 * bedrooms, so it falls out of the same operation rather than needing
 * to be looked for.
 *
 * ── What this does not do ──────────────────────────────────────────
 *
 * It does not name the rooms, decide which are worth keeping beyond a
 * minimum size, or touch the openings. Those are the caller's, and
 * the caller is also responsible for the case this returns one face:
 * a genuine single-room scan must come out exactly as it went in.
 */

export type Pt = { x: number; z: number };

export type WallLine = {
  start: Pt;
  end: Pt;
  /** Metres. Used only to size the snapping tolerance. */
  thicknessM?: number;
};

/**
 * How far apart two points can be and still be the same corner.
 *
 * RoomPlan's walls are inner faces, so two walls meeting at a corner
 * stop short of each other by roughly a wall thickness — they do not
 * share an endpoint, and an arrangement built from them would have no
 * closed region anywhere. 0.3 m covers a 250 mm external wall with
 * room to spare, and is still far below the smallest gap that means
 * something (a doorway is 0.7 m and up).
 */
export const CORNER_SNAP_M = 0.3;

/**
 * How far a wall may be extended to reach a crossing.
 *
 * Same reason as the snap, applied along the wall rather than across
 * it. The stub left behind when an extension reaches nothing is
 * pruned before the faces are read, so over-extending costs nothing
 * but arithmetic.
 */
export const WALL_EXTEND_M = 0.35;

/**
 * The smallest region that is allowed to be a room.
 *
 * Below this it is the triangle left where three walls not quite
 * meeting cross each other, or the sliver between a chimney breast
 * and the wall beside it. A real cupboard is about 0.8 m2 and a
 * downstairs loo about 1.5, so this has to stay low; the caller can
 * be stricter.
 */
export const MIN_FACE_M2 = 0.8;

const EPS = 1e-9;

function sub(a: Pt, b: Pt): Pt {
  return { x: a.x - b.x, z: a.z - b.z };
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function cross(a: Pt, b: Pt): number {
  return a.x * b.z - a.z * b.x;
}

/**
 * Signed area, in the XZ plane. Named apart from perspective.ts's
 * polygonArea, which does the same arithmetic on 3D floor points --
 * two exports of one name from the same barrel is a build error, and
 * the two are genuinely different inputs.
 */
export function polygonAreaXZ(poly: Pt[]): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    sum += a.x * b.z - b.x * a.z;
  }
  return sum / 2;
}

/** Is `p` inside `poly`? Ray casting; boundary counts as inside. */
export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const a = poly[i];
    const b = poly[j];
    if (
      a.z > p.z !== b.z > p.z &&
      p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Lengthen a segment at both ends.
 *
 * Walls that stop short of each other never cross, and an
 * arrangement of segments that never cross has no faces in it. Every
 * wall is pushed out a little so corners actually meet; the overshoot
 * becomes a dangling stub, and stubs are pruned.
 */
function extend(w: WallLine, byM: number): { a: Pt; b: Pt } {
  const d = sub(w.end, w.start);
  const len = Math.hypot(d.x, d.z);
  if (len < EPS) return { a: w.start, b: w.end };
  const ux = d.x / len;
  const uz = d.z / len;
  return {
    a: { x: w.start.x - ux * byM, z: w.start.z - uz * byM },
    b: { x: w.end.x + ux * byM, z: w.end.z + uz * byM },
  };
}

/** Where two segments cross, as parameters along each, or null. */
function segmentCross(
  p: Pt,
  p2: Pt,
  q: Pt,
  q2: Pt,
): { t: number; u: number } | null {
  const r = sub(p2, p);
  const s = sub(q2, q);
  const denom = cross(r, s);
  if (Math.abs(denom) < EPS) return null; // parallel or collinear
  const qp = sub(q, p);
  const t = cross(qp, s) / denom;
  const u = cross(qp, r) / denom;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return { t, u };
}

type Vertex = { id: number; p: Pt };

/**
 * Snap points onto shared vertices.
 *
 * Linear search rather than a grid: a scanned storey has tens of
 * walls, not thousands, and a grid would need its own tie-breaking at
 * cell boundaries — which is the bug this is meant to avoid.
 */
class VertexSet {
  readonly list: Vertex[] = [];
  private readonly tol: number;
  /* Written out rather than as a parameter property: the repo runs
     its tests on Node's type stripping, which does not support
     them. */
  constructor(tol: number) {
    this.tol = tol;
  }
  add(p: Pt): Vertex {
    for (const v of this.list) {
      if (dist(v.p, p) <= this.tol) return v;
    }
    const v = { id: this.list.length, p };
    this.list.push(v);
    return v;
  }
}

/**
 * Every enclosed region of the wall arrangement.
 *
 * The walls are extended, cut at every crossing, snapped onto shared
 * vertices, stripped of dangling ends, and then walked as a planar
 * graph: from each directed edge, always take the sharpest available
 * right turn at the far end. Doing that consistently traces each
 * bounded face exactly once, plus the outer boundary once in the
 * opposite direction, which is how the outer one is told apart and
 * dropped.
 */
export function wallFaces(
  walls: WallLine[],
  opts: { snapM?: number; extendM?: number; minAreaM2?: number } = {},
): Pt[][] {
  const snap = opts.snapM ?? CORNER_SNAP_M;
  const extendBy = opts.extendM ?? WALL_EXTEND_M;
  const minArea = opts.minAreaM2 ?? MIN_FACE_M2;

  const segs = walls
    .filter((w) => dist(w.start, w.end) > EPS)
    .map((w) => extend(w, extendBy));
  if (segs.length < 3) return [];

  // Cut every segment at every crossing with every other.
  const cuts: number[][] = segs.map(() => [0, 1]);
  for (let i = 0; i < segs.length; i += 1) {
    for (let j = i + 1; j < segs.length; j += 1) {
      const hit = segmentCross(segs[i].a, segs[i].b, segs[j].a, segs[j].b);
      if (!hit) continue;
      cuts[i].push(hit.t);
      cuts[j].push(hit.u);
    }
  }

  const verts = new VertexSet(snap);
  const edges = new Set<string>();
  const addEdge = (a: Vertex, b: Vertex) => {
    if (a.id === b.id) return;
    const key = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
    edges.add(key);
  };

  for (let i = 0; i < segs.length; i += 1) {
    const { a, b } = segs[i];
    const ts = [...new Set(cuts[i])].sort((x, y) => x - y);
    let prev: Vertex | null = null;
    for (const t of ts) {
      const p = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
      const v = verts.add(p);
      if (prev && prev.id !== v.id) addEdge(prev, v);
      prev = v;
    }
  }

  // Adjacency, then prune anything hanging — a dead end cannot be
  // part of a room boundary, and the extensions above create one at
  // the end of every wall that reached nothing.
  const adj = new Map<number, Set<number>>();
  for (const key of edges) {
    const [a, b] = key.split(":").map(Number);
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  }
  let pruned = true;
  while (pruned) {
    pruned = false;
    for (const [v, ns] of adj) {
      if (ns.size === 1) {
        const other = [...ns][0];
        adj.get(other)?.delete(v);
        adj.delete(v);
        pruned = true;
      } else if (ns.size === 0) {
        adj.delete(v);
        pruned = true;
      }
    }
  }
  if (adj.size < 3) return [];

  const pointOf = (id: number) => verts.list[id].p;
  const angle = (from: number, to: number) => {
    const a = pointOf(from);
    const b = pointOf(to);
    return Math.atan2(b.z - a.z, b.x - a.x);
  };

  const visited = new Set<string>();
  const faces: Pt[][] = [];
  for (const [v, ns] of adj) {
    for (const n of ns) {
      const startKey = `${v}>${n}`;
      if (visited.has(startKey)) continue;
      const loop: number[] = [];
      let cur = v;
      let next = n;
      let guard = 0;
      while (guard < 10000) {
        guard += 1;
        visited.add(`${cur}>${next}`);
        loop.push(cur);
        // Sharpest right turn: among the edges leaving `next`,
        // take the one whose direction is the smallest clockwise
        // step from the way we came in.
        const back = angle(next, cur);
        let best: number | null = null;
        let bestTurn = Infinity;
        for (const cand of adj.get(next) ?? []) {
          if (cand === cur && (adj.get(next)?.size ?? 0) > 1) continue;
          let turn = back - angle(next, cand);
          while (turn <= 0) turn += Math.PI * 2;
          while (turn > Math.PI * 2) turn -= Math.PI * 2;
          if (turn < bestTurn) {
            bestTurn = turn;
            best = cand;
          }
        }
        if (best === null) break;
        cur = next;
        next = best;
        if (cur === v && next === n) break;
      }
      if (loop.length >= 3) {
        const poly = loop.map(pointOf);
        const area = polygonAreaXZ(poly);
        // The outer boundary comes out with the opposite winding to
        // every room, which is the whole point of walking them all
        // the same way.
        if (area > minArea) faces.push(poly);
      }
    }
  }
  return faces;
}

/** Shortest distance from a point to a polygon's boundary. */
export function distanceToBoundary(p: Pt, poly: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const d = sub(b, a);
    const len2 = d.x * d.x + d.z * d.z;
    const t =
      len2 < EPS
        ? 0
        : Math.max(
            0,
            Math.min(1, ((p.x - a.x) * d.x + (p.z - a.z) * d.z) / len2),
          );
    best = Math.min(best, dist(p, { x: a.x + d.x * t, z: a.z + d.z * t }));
  }
  return best;
}

/**
 * Which room an opening belongs to.
 *
 * A door sits *in* a wall, so its centre is on a boundary and often
 * just outside the face on one side of it — "inside" is the wrong
 * test. Nearest boundary is the right one, and a door in a partition
 * is genuinely near two rooms: it goes to the first, which is the
 * larger, because the faces are sorted by area. Drawing it twice
 * would be worse than drawing it once on the wrong side of a wall
 * that is 125 mm thick.
 */
export function faceForOpening(p: Pt, faces: Pt[][]): number {
  let best = -1;
  let bestD = Infinity;
  faces.forEach((f, i) => {
    const d = pointInPolygon(p, f) ? 0 : distanceToBoundary(p, f);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/**
 * The edges of the floor that are not already walls.
 *
 * Most of the floor outline runs along a wall, a few centimetres
 * inside it. Feeding those in as well would lay a second line
 * alongside every wall in the house and enclose a long thin sliver
 * between the two — and on a 15 m run a 0.12 m sliver is 1.8 m2,
 * which is a room by any test this file applies. A bedroom would
 * gain a phantom neighbour the shape of its own wall.
 *
 * So an edge is only kept when it is not shadowing a wall: nothing
 * running roughly parallel to it, roughly where it is. What
 * survives is the floor edge at a stairwell, a balcony or a
 * galleried landing — the places where the room genuinely has no
 * wall, which is the whole reason for doing this.
 */
export function openFloorEdges(
  floorPolygon: Pt[],
  walls: WallLine[],
  nearM = CORNER_SNAP_M,
): WallLine[] {
  const dirOf = (a: Pt, b: Pt) => {
    const d = sub(b, a);
    const len = Math.hypot(d.x, d.z) || 1;
    return { x: d.x / len, z: d.z / len };
  };
  const out: WallLine[] = [];
  for (let i = 0; i < floorPolygon.length; i += 1) {
    const a = floorPolygon[i];
    const b = floorPolygon[(i + 1) % floorPolygon.length];
    if (dist(a, b) < 0.15) continue;
    const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
    const dir = dirOf(a, b);
    const shadowed = walls.some((w) => {
      const wd = dirOf(w.start, w.end);
      // |cross| near zero means the two run the same way, whichever
      // direction each happens to be drawn in.
      if (Math.abs(cross(dir, wd)) > 0.26) return false; // ~15 degrees
      return distanceToBoundary(mid, [w.start, w.end]) <= nearM;
    });
    if (!shadowed) out.push({ start: a, end: b });
  }
  return out;
}

/**
 * Split one captured room into the rooms it actually contains.
 *
 * Returns null when there is nothing to split — fewer than two
 * usable faces, or walls too sparse to enclose anything. Null means
 * "use what you already had", never "the scan was empty": a single
 * room must survive this untouched, and the caller cannot tell the
 * difference between a failure and a genuine one-room house unless
 * this says so.
 *
 * `floorPolygon`, when given, does two jobs.
 *
 * It discards faces whose centre falls outside the floor the sensor
 * measured — the arrangement can close a region in the garden
 * between an outside wall and a fence line the scanner caught
 * through a window.
 *
 * It also joins in as boundary. Not every edge of a room is a wall:
 * a landing at the top of a staircase is open on the stairwell side,
 * and there is nothing there for the walls to close against, so the
 * landing never forms a region and the one space the customer most
 * wants named is the one that disappears. The sensor does measure
 * where the floor stops at the void, and that edge bounds the room
 * exactly as a wall would. Balconies, galleried hallways and open
 * stairwells are all the same case.
 *
 * The polygon also pinches at doorways, so in principle it can slice
 * a room in two where a doorway is. The minimum face area absorbs
 * the slivers that produces, and the review screen is where anything
 * that survives gets dropped — which is the right place, because a
 * room the customer can see and delete beats a room they were never
 * told about.
 */
export function splitRoomsByWalls(
  walls: WallLine[],
  floorPolygon?: Pt[] | null,
  opts: { minAreaM2?: number } = {},
): Pt[][] | null {
  const bounded =
    floorPolygon && floorPolygon.length >= 3
      ? [...walls, ...openFloorEdges(floorPolygon, walls)]
      : walls;
  const faces = wallFaces(bounded, opts);
  if (faces.length < 2) return null;

  const centre = (poly: Pt[]): Pt => {
    const n = poly.length;
    return {
      x: poly.reduce((s, p) => s + p.x, 0) / n,
      z: poly.reduce((s, p) => s + p.z, 0) / n,
    };
  };

  const inside =
    floorPolygon && floorPolygon.length >= 3
      ? faces.filter((f) => pointInPolygon(centre(f), floorPolygon))
      : faces;

  if (inside.length < 2) return null;
  return inside.sort((a, b) => Math.abs(polygonAreaXZ(b)) - Math.abs(polygonAreaXZ(a)));
}
