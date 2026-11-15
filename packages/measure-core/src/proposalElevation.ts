/**
 * The faces of the house with the extension on them.
 *
 * A plan is not a planning submission. The council wants to see
 * what the thing will look like from the garden and from the side,
 * and that is the drawing a neighbour objects to or does not. So
 * the proposal produces the same four faces the survey does, with
 * the new work on them in red.
 *
 * ── What is measured and what is not ───────────────────────────────
 *
 * The existing face comes from the survey, so its widths and the
 * positions of its openings are measured. The new work's width and
 * depth come from the brief, and its height from the brief as well
 * -- which is a decision rather than a measurement, and a decision
 * is exactly what it should be: Charlie typed it, and the
 * compliance report has already tested it against 4 m and 3 m.
 *
 * The roof over the new work is drawn from the form chosen in the
 * brief. A flat roof is flat, which is honest. A pitch is a guess
 * at an angle and is marked as one.
 */

import type { Pt } from "./splitRooms.ts";
import {
  buildElevation,
  acrossFaceM,
  type Elevation,
  type ElevationRoom,
  type ElevationSide,
} from "./elevation.ts";
import type { ProposedExtension } from "./proposalPlan.ts";
import type { Brief } from "./proposal.ts";

export type NewOpening = {
  kind: "glazing" | "rooflight";
  u0: number;
  u1: number;
  y0: number;
  y1: number;
  label: string;
};

export type ProposedElevation = {
  side: ElevationSide;
  /** The house as surveyed, in its own frame. */
  existing: Elevation;
  /**
   * The new work in the same frame as the existing face.
   *
   * Null when the extension does not show on this face at all --
   * the front of the house usually, and a side the extension does
   * not reach. A sheet headed "Proposed front elevation" with
   * nothing new on it is still worth producing, because "nothing
   * changes on this face" is a planning statement.
   */
  newWork: { u0: number; u1: number; y0: number; y1: number } | null;
  /** Ridge of a pitched roof over the new work, in the same frame. */
  ridge: { u: number; y: number } | null;
  newOpenings: NewOpening[];
  /** True where the new work is seen end-on: its depth, not its width. */
  seenFromTheSide: boolean;
};

const GLAZING_HEAD_M = 2.1;

/**
 * One face, with the extension on it.
 *
 * The extension's outline is projected onto the face the same way
 * the house is, so the two land in one frame: `originAcross` on the
 * existing elevation is what makes that possible without the caller
 * guessing where the face begins.
 */
export function buildProposedElevation(
  rooms: ElevationRoom[],
  side: ElevationSide,
  ext: ProposedExtension,
  brief: Brief,
): ProposedElevation | null {
  const existing = buildElevation(rooms, side);
  if (!existing) return null;

  const us = ext.outline.map((p) => acrossFaceM(side, p) - existing.originAcross);
  const u0 = Math.min(...us);
  const u1 = Math.max(...us);

  /*
   * Does the new work show on this face at all?
   *
   * Projected onto the front of the house, a rear extension
   * collapses to the same width as the house and would be drawn
   * across the front elevation -- which would be a drawing of a
   * building that does not exist. It only shows where it genuinely
   * stands proud of the existing face.
   *
   * The test is which way it stands: the extension projects along
   * the outward normal of its own rear wall, so on the face it was
   * built off it is in front, and on the opposite face it is
   * behind the house and hidden.
   */
  const extCentre: Pt = {
    x: ext.outline.reduce((s, p) => s + p.x, 0) / ext.outline.length,
    z: ext.outline.reduce((s, p) => s + p.z, 0) / ext.outline.length,
  };
  const houseAcross = rooms
    .flatMap((r) => r.outline)
    .map((p) => acrossFaceM(side, p));
  const extAcross = acrossFaceM(side, extCentre);

  /*
   * `acrossFace` is the horizontal axis, so it cannot say whether
   * the extension is in front of this face or behind it. Depth is
   * the other axis, and the cheapest reliable test is whether the
   * extension's own outward direction points at the viewer.
   */
  const viewer: Record<ElevationSide, Pt> = {
    front: { x: 0, z: 1 },
    back: { x: 0, z: -1 },
    left: { x: 1, z: 0 },
    right: { x: -1, z: 0 },
  };
  const v = viewer[side];
  const outwardTowardViewer =
    // The extension's outward normal is the direction from the
    // knock-through to the far edge of the envelope.
    (() => {
      if (!ext.knockThrough) return 0;
      const k = ext.knockThrough;
      const mid = { x: (k.a.x + k.b.x) / 2, z: (k.a.z + k.b.z) / 2 };
      const d = { x: extCentre.x - mid.x, z: extCentre.z - mid.z };
      const len = Math.hypot(d.x, d.z) || 1;
      return (d.x / len) * v.x + (d.z / len) * v.z;
    })();

  const facesViewer = outwardTowardViewer > 0.5;
  const endOn = Math.abs(outwardTowardViewer) < 0.5;

  // Behind the house: not drawn, and that is a statement in itself.
  if (!facesViewer && !endOn) {
    return {
      side,
      existing,
      newWork: null,
      ridge: null,
      newOpenings: [],
      seenFromTheSide: false,
    };
  }

  /*
   * Seen end-on, the extension shows its depth, not its width --
   * and only the part of it that projects past the existing face.
   * Drawing its full width on a side elevation is the error that
   * makes a 3 m extension look like a 7 m one.
   */
  const newWork = { u0, u1, y0: 0, y1: brief.heightM };
  if (endOn) {
    const houseMin = Math.min(...houseAcross) - existing.originAcross;
    const houseMax = Math.max(...houseAcross) - existing.originAcross;
    newWork.u0 = Math.max(u0, houseMin);
    newWork.u1 = Math.min(u1, houseMax);
    if (newWork.u1 - newWork.u0 < 0.3) {
      newWork.u0 = u0;
      newWork.u1 = u1;
    }
  }

  const ridge =
    brief.roof === "flat" || brief.roof === "flat-lantern"
      ? null
      : brief.roof === "mono-pitch"
        ? { u: newWork.u1, y: brief.heightM }
        : { u: (newWork.u0 + newWork.u1) / 2, y: brief.heightM };

  // A mono-pitch and a gable both start from the eaves, so the wall
  // below the roof stops there rather than at the overall height.
  if (ridge) newWork.y1 = brief.eavesHeightM;

  const newOpenings: NewOpening[] = [];
  if (facesViewer) {
    for (const o of ext.openings) {
      const a = acrossFaceM(side, o.a) - existing.originAcross;
      const b = acrossFaceM(side, o.b) - existing.originAcross;
      newOpenings.push({
        kind: "glazing",
        u0: Math.min(a, b),
        u1: Math.max(a, b),
        y0: 0,
        y1: Math.min(GLAZING_HEAD_M, brief.eavesHeightM - 0.1),
        label: o.label,
      });
    }
  }

  return { side, existing, newWork, ridge, newOpenings, seenFromTheSide: endOn };
}

/** Every face, with the extension where it shows. */
export function buildProposedElevations(
  rooms: ElevationRoom[],
  ext: ProposedExtension,
  brief: Brief,
): ProposedElevation[] {
  const sides: ElevationSide[] = ["front", "right", "back", "left"];
  return sides
    .map((s) => buildProposedElevation(rooms, s, ext, brief))
    .filter((e): e is ProposedElevation => e !== null);
}

/**
 * What to call a face on a planning drawing.
 *
 * elevation.ts names the four faces front, back, left and right
 * from the coordinate frame, which is arbitrary and was harmless
 * when the drawing only had to show four faces of a surveyed
 * house. On a proposal it is actively misleading: a rear extension
 * projected onto the +z face came out headed "Proposed front
 * elevation", which on a planning submission is a drawing of the
 * street frontage showing an extension that is not there.
 *
 * So the names come from the garden side Charlie nominated. The
 * face the extension was built off is the rear, the opposite one
 * is the front, and the other two are sides -- named left and
 * right as seen standing in the street looking at the house, which
 * is the convention and the opposite of looking at it from the
 * garden.
 */
export function proposedElevationName(
  side: ElevationSide,
  gardenFace: "north" | "south" | "east" | "west",
): string {
  // elevation.ts's sides, as compass faces: see viewDirection there.
  const asFace: Record<ElevationSide, "north" | "south" | "east" | "west"> = {
    front: "south",
    back: "north",
    left: "east",
    right: "west",
  };
  const opposite: Record<string, string> = {
    north: "south",
    south: "north",
    east: "west",
    west: "east",
  };
  const face = asFace[side];
  if (face === gardenFace) return "Rear elevation";
  if (face === opposite[gardenFace]) return "Front elevation";

  /*
   * Left and right as seen from the street, which means from the
   * face opposite the garden. Standing there, the viewer's left is
   * a quarter turn clockwise from the direction they are looking.
   */
  const order = ["north", "east", "south", "west"];
  const streetFace = opposite[gardenFace];
  const looking = order.indexOf(gardenFace); // street viewer looks this way
  const leftFace = order[(looking + 3) % 4];
  void streetFace;
  return face === leftFace ? "Left side elevation" : "Right side elevation";
}
