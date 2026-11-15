/**
 * Where the extension goes, as geometry.
 *
 * The rules in proposal.ts say what is allowed. This works out what
 * it looks like on the plan: which wall is the back of the house,
 * how far out the new envelope projects, and where the glazing sits
 * in it.
 *
 * Everything here is derived from the survey the customer already
 * sent. Nothing is invented except the extension itself, and the
 * one thing that cannot be derived -- which face is the back -- is
 * asked rather than guessed. See rearWall.
 */

import type { Pt } from "./splitRooms.ts";
import { squareRoomsForDrawing, squareToSheet, roomOutlineM, type PlanRoomInput } from "./dxfPlan.ts";
import type { Brief } from "./proposal.ts";

export type Face = "north" | "south" | "east" | "west";

export type RearWall = {
  /** The two ends of the wall line, in the squared-up plan frame. */
  a: Pt;
  b: Pt;
  /** Unit vector pointing out of the house, away from the rooms. */
  outward: Pt;
  lengthM: number;
};

/**
 * The back of the house, as a single line.
 *
 * Taken as the outermost edge of the footprint on the face Charlie
 * nominates. Not guessed from the geometry: a house can have its
 * garden on any side, the scan has no idea which way is which, and
 * an extension drawn off the wrong wall is not a drawing with a
 * small error in it -- it is a drawing of a different building.
 *
 * Returns the full extent of the footprint on that face. A rear
 * wall that steps -- an existing outrigger, a chimney breast -- is
 * reduced to its outermost line, because that is where a new
 * envelope is measured from, and the step is left on the drawing
 * for Charlie to resolve.
 */
export function rearWall(entries: PlanRoomInput[], face: Face): RearWall | null {
  const prepared = squareToSheet(
    squareRoomsForDrawing(entries.filter((e) => e.anchor)),
  );
  const polys = prepared.map((e) => roomOutlineM(e)).filter((p) => p.length >= 3);
  const pts = polys.flat();
  if (pts.length < 3) return null;

  const along = face === "north" || face === "south" ? "x" : "z";
  const across = along === "x" ? "z" : "x";
  const outerIsMax = face === "south" || face === "east";
  const values = pts.map((p) => p[across]);
  const extreme = outerIsMax ? Math.max(...values) : Math.min(...values);

  /*
   * The wall that is actually there.
   *
   * This took the bounding box edge, which is right for a
   * rectangular house and wrong for every other kind. On an
   * L-shaped terrace with a rear outrigger the box edge runs
   * straight across the side return -- a 5.6 m wall where the
   * building is only 3.0 m wide at that point -- so the extension
   * was centred on a wall that does not exist and hung out over
   * the garden path. Reported, correctly, as "this doesn't make
   * any sense".
   *
   * So the outermost face is found first, and then only the edges
   * that actually lie on it are measured. The result is the real
   * back wall of the real building.
   *
   * 0.15 m of tolerance, because a scanned outline is a
   * measurement: two rooms whose back walls are one wall come back
   * a few centimetres apart, and treating those as two different
   * faces would halve the wall.
   */
  const TOL = 0.15;
  let lo = Infinity;
  let hi = -Infinity;
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i += 1) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      // Only edges running along the face, sitting on it.
      if (Math.abs(a[across] - b[across]) > TOL) continue;
      if (Math.abs((a[across] + b[across]) / 2 - extreme) > TOL) continue;
      lo = Math.min(lo, a[along], b[along]);
      hi = Math.max(hi, a[along], b[along]);
    }
  }
  if (!Number.isFinite(lo) || hi - lo < 0.5) return null;

  const at = (v: number): Pt =>
    along === "x" ? { x: v, z: extreme } : { x: extreme, z: v };

  // Drawn left to right as the viewer sees the face, so a
  // part-width extension centres where a person would expect.
  const forward = face === "south" || face === "west";
  const a = at(forward ? lo : hi);
  const b = at(forward ? hi : lo);

  const outward: Pt =
    face === "south"
      ? { x: 0, z: 1 }
      : face === "north"
        ? { x: 0, z: -1 }
        : face === "east"
          ? { x: 1, z: 0 }
          : { x: -1, z: 0 };

  return { a, b, outward, lengthM: hi - lo };
}

export type ProposedOpening = {
  kind: "glazing" | "door" | "window";
  /** Ends of the opening on the wall it sits in. */
  a: Pt;
  b: Pt;
  widthM: number;
  label: string;
};

export type ProposedExtension = {
  /** The new envelope, clockwise from the left end of the rear wall. */
  outline: Pt[];
  openings: ProposedOpening[];
  /** The part of the existing rear wall being removed, if any. */
  knockThrough: { a: Pt; b: Pt } | null;
  footprintM2: number;
  widthM: number;
  depthM: number;
};

const GLAZING_DEFAULT_M: Record<Brief["rearGlazing"], number> = {
  // Charlie's usual sizes. A bi-fold is specified by the opening it
  // fills rather than by leaf count, and these are the widths that
  // come up again and again on his drawings.
  bifold: 3.0,
  sliding: 3.0,
  french: 1.5,
  "picture-window": 2.4,
};

/**
 * The extension, drawn off the rear wall.
 *
 * Full width sits on the whole rear face. Part width is centred,
 * which is the usual case and the one worth defaulting to: an
 * off-centre extension is a decision, and a decision belongs to
 * Charlie rather than to an arithmetic convenience.
 *
 * The glazing is centred on the new rear wall. The knock-through is
 * reported as the span of existing wall inside the new envelope,
 * which is what gets a steel over it -- the size of that steel is
 * emphatically not calculated here.
 */
export function buildRearExtension(
  wall: RearWall,
  brief: Brief,
): ProposedExtension {
  const dirX = (wall.b.x - wall.a.x) / wall.lengthM;
  const dirZ = (wall.b.z - wall.a.z) / wall.lengthM;

  const width =
    brief.width === "full"
      ? wall.lengthM
      : Math.min(brief.widthM ?? wall.lengthM, wall.lengthM);
  const start = (wall.lengthM - width) / 2;

  const along = (t: number): Pt => ({
    x: wall.a.x + dirX * t,
    z: wall.a.z + dirZ * t,
  });
  const out = (p: Pt, d: number): Pt => ({
    x: p.x + wall.outward.x * d,
    z: p.z + wall.outward.z * d,
  });

  const c0 = along(start);
  const c1 = along(start + width);
  const outline = [c0, c1, out(c1, brief.depthM), out(c0, brief.depthM)];

  const glazingWidth = Math.min(
    brief.rearGlazingWidthM ?? GLAZING_DEFAULT_M[brief.rearGlazing],
    width - 0.6,
  );
  const gStart = start + (width - glazingWidth) / 2;
  const openings: ProposedOpening[] = [
    {
      kind: "glazing",
      a: out(along(gStart), brief.depthM),
      b: out(along(gStart + glazingWidth), brief.depthM),
      widthM: glazingWidth,
      label:
        brief.rearGlazing === "bifold"
          ? "Bi-fold doors"
          : brief.rearGlazing === "sliding"
            ? "Sliding doors"
            : brief.rearGlazing === "french"
              ? "French doors"
              : "Picture window",
    },
  ];

  return {
    outline,
    openings,
    knockThrough: { a: c0, b: c1 },
    footprintM2: Number((width * brief.depthM).toFixed(2)),
    widthM: Number(width.toFixed(2)),
    depthM: brief.depthM,
  };
}

/**
 * Where a beam is needed, and how far it spans.
 *
 * ── The line this draws ────────────────────────────────────────────
 *
 * Working out *that* a beam is needed and *how far it spans* is
 * geometry: a wall is being removed, the span is the opening, and
 * both come straight off the drawing. Working out *what size* it
 * should be is structural design -- it depends on what is above,
 * what the floor is made of, whether the wall was load-bearing at
 * all, and it carries professional liability that belongs to
 * somebody who has signed for it.
 *
 * So this marks the position, measures the span, and leaves the
 * section blank for Charlie to fill from his calculations. Marked
 * `B1`, `B2` in the order they appear, which is how his drawings
 * already label them.
 *
 * The alternative -- an indicative size from a span table -- was
 * considered and rejected. An indicative section printed on a
 * drawing is indistinguishable from a calculated one by the time it
 * reaches a builder, and "indicative" in small type has never
 * stopped anybody ordering steel.
 */
export type ProposedBeam = {
  /** B1, B2 — the order they appear on the drawing. */
  ref: string;
  a: Pt;
  b: Pt;
  spanM: number;
  /** Charlie's section, from his calculations. Empty until he fills it. */
  section: string;
  /** What the beam is carrying, as far as the drawing can tell. */
  supports: string;
  /** Bearing each end, mm. 150 is the usual minimum onto masonry. */
  bearingMm: number;
};

/**
 * Beams implied by the work.
 *
 * One over the knock-through, always: a new envelope opened into
 * the existing house removes a span of external wall, and that wall
 * was carrying whatever is above it. Whether it was load-bearing is
 * not for this to decide -- the beam is marked and the engineer
 * confirms or removes it.
 *
 * A second where the opening is wide enough that Charlie's drawings
 * consistently show a column rather than a single clear span. Over
 * 5 m is where that starts on his precedents, so the note says a
 * column may be required and lets the calculations settle it.
 */
export function beamsForExtension(ext: ProposedExtension): ProposedBeam[] {
  const out: ProposedBeam[] = [];
  const k = ext.knockThrough;
  if (!k) return out;

  const span = Math.hypot(k.b.x - k.a.x, k.b.z - k.a.z);
  out.push({
    ref: "B1",
    a: k.a,
    b: k.b,
    spanM: Number(span.toFixed(2)),
    section: "",
    supports:
      span > 5
        ? "Existing rear wall over, and the floor and roof above. A " +
          "mid-span column or a pair of beams may be required — see the " +
          "structural calculations."
        : "Existing rear wall over, and the floor and roof above.",
    bearingMm: 150,
  });

  return out;
}

/** "B1 — 4.20 m span — section to be confirmed" */
export function beamScheduleLine(b: ProposedBeam): string {
  return (
    `${b.ref} — ${b.spanM.toFixed(2)} m clear span — ` +
    (b.section
      ? b.section
      : "section to be confirmed by structural calculation") +
    ` — ${b.bearingMm} mm minimum bearing each end`
  );
}
