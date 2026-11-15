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
  const pts = prepared.flatMap((e) => roomOutlineM(e));
  if (pts.length < 3) return null;

  const minX = Math.min(...pts.map((p) => p.x));
  const maxX = Math.max(...pts.map((p) => p.x));
  const minZ = Math.min(...pts.map((p) => p.z));
  const maxZ = Math.max(...pts.map((p) => p.z));

  switch (face) {
    case "south":
      return {
        a: { x: minX, z: maxZ },
        b: { x: maxX, z: maxZ },
        outward: { x: 0, z: 1 },
        lengthM: maxX - minX,
      };
    case "north":
      return {
        a: { x: maxX, z: minZ },
        b: { x: minX, z: minZ },
        outward: { x: 0, z: -1 },
        lengthM: maxX - minX,
      };
    case "east":
      return {
        a: { x: maxX, z: maxZ },
        b: { x: maxX, z: minZ },
        outward: { x: 1, z: 0 },
        lengthM: maxZ - minZ,
      };
    default:
      return {
        a: { x: minX, z: minZ },
        b: { x: minX, z: maxZ },
        outward: { x: -1, z: 0 },
        lengthM: maxZ - minZ,
      };
  }
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
