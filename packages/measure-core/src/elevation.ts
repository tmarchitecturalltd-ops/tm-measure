/**
 * Outline elevations, built from what was measured.
 *
 * ── What this is, and what it is not ───────────────────────────────
 *
 * A photograph of a house is not an elevation. A few casual phone
 * shots will not give drawing-grade dimensions, and an elevation
 * that is nearly right is worse than none at all: it is scaled off,
 * and nothing on it says it was inferred. The same argument that
 * took the staircase out of the scan applies here with more force,
 * because an elevation is what planning drawings are judged on.
 *
 * What the survey does know is substantial. The scan gives the
 * footprint, so it gives the width of every face of the building.
 * It gives each storey's height. It gives every door and window,
 * its width, which wall it is in and how far along that wall it
 * sits. Projected onto a face, that is the horizontal half of an
 * elevation, measured rather than guessed.
 *
 * What it does not know is the vertical half: sill and head heights,
 * where the ground falls, the eaves, the ridge, the pitch. Those are
 * left as stated assumptions — one place, named below — so that the
 * drawing says what it assumed instead of implying it measured.
 *
 * So this produces an outline elevation: the silhouette of each
 * storey, the floor levels, and every opening in its true horizontal
 * position and width. A draughtsman adds the roof and corrects the
 * heights. That is a starting point worth having; a guessed roof is
 * not.
 */

import type { RoomDraft, Opening } from "./types";

/* Pt comes from splitRooms so the barrel exports one of them. */
import type { Pt } from "./splitRooms";

export type ElevationSide = "front" | "back" | "left" | "right";

/**
 * Heights nobody measured, in metres, stated once.
 *
 * UK domestic conventions, and all of them are assumptions. They are
 * here rather than scattered through the drawing code so that there
 * is a single list to show the customer, and a single list for a
 * draughtsman to disagree with.
 */
export const ASSUMED = {
  /** Floor build-up between one storey's ceiling and the next's floor. */
  slabM: 0.25,
  /** Ceiling height where a room did not report one. */
  storeyM: 2.4,
  doorHeadM: 2.04,
  windowSillM: 0.9,
  windowHeadM: 2.1,
};

export type ElevationOpening = {
  kind: "door" | "window";
  /** Horizontal extent across the face, metres from the left edge. */
  u0: number;
  u1: number;
  /** Vertical extent, metres above the lowest floor level. */
  y0: number;
  y1: number;
  cased?: boolean;
};

export type Elevation = {
  side: ElevationSide;
  /** One rectangle per storey: left, right, bottom, top. */
  storeys: { floor: number; u0: number; u1: number; y0: number; y1: number }[];
  openings: ElevationOpening[];
  /** Floor levels, for the level marks up the side of the drawing. */
  levels: { floor: number; y: number }[];
  widthM: number;
  heightM: number;
};

export type ElevationRoom = {
  room: RoomDraft;
  /** The room's outline in world metres, as drawn on the plan. */
  outline: Pt[];
  floor: number;
};

/** Which way the viewer is looking, in plan. */
function viewDirection(side: ElevationSide): Pt {
  switch (side) {
    case "front":
      return { x: 0, z: 1 };
    case "back":
      return { x: 0, z: -1 };
    case "left":
      return { x: 1, z: 0 };
    default:
      return { x: -1, z: 0 };
  }
}

/**
 * Where a point lands across the face, before the left edge is known.
 *
 * Back and left are mirrored, because an elevation is drawn as the
 * viewer sees it: walk round to the back of a house and what was on
 * your left is now on your right. Getting this wrong puts the
 * kitchen window at the wrong end of the back elevation, which is
 * the kind of error that survives all the way to a planning officer.
 */
function acrossFace(side: ElevationSide, p: Pt): number {
  switch (side) {
    case "front":
      return p.x;
    case "back":
      return -p.x;
    case "left":
      return -p.z;
    default:
      return p.z;
  }
}

/** Storey heights, lowest floor first, with the assumed fallbacks. */
export function storeyHeights(
  rooms: ElevationRoom[],
): { floor: number; heightM: number; baseY: number }[] {
  const floors = [...new Set(rooms.map((r) => r.floor))].sort((a, b) => a - b);
  let y = 0;
  return floors.map((floor) => {
    const hs = rooms
      .filter((r) => r.floor === floor)
      .map((r) => Number.parseFloat(r.room.ceilingHeightM))
      .filter((n) => Number.isFinite(n) && n > 1.5);
    const heightM = hs.length ? Math.max(...hs) : ASSUMED.storeyM;
    const out = { floor, heightM, baseY: y };
    y += heightM + ASSUMED.slabM;
    return out;
  });
}

/**
 * The walls that face the viewer, and are not behind another wall.
 *
 * A wall is on this face when its outward normal points at the
 * viewer. "Outward" is decided from the room's own centroid, which
 * works for an L-shape and a bay as well as a rectangle.
 *
 * Walls further back on the same face are kept too: on an outline
 * elevation a rear wing still contributes its openings, and
 * pretending otherwise would silently drop windows. Depth is what
 * the draughtsman adds.
 */
function facingWalls(
  rooms: ElevationRoom[],
  side: ElevationSide,
): { room: ElevationRoom; wallIndex: number; a: Pt; b: Pt }[] {
  const view = viewDirection(side);
  const out: { room: ElevationRoom; wallIndex: number; a: Pt; b: Pt }[] = [];
  for (const r of rooms) {
    const n = r.outline.length;
    if (n < 3) continue;
    const cx = r.outline.reduce((s, p) => s + p.x, 0) / n;
    const cz = r.outline.reduce((s, p) => s + p.z, 0) / n;
    for (let i = 0; i < n; i += 1) {
      const a = r.outline[i];
      const b = r.outline[(i + 1) % n];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < 0.2) continue;
      // Perpendicular, turned to point away from the centroid.
      let nx = -dz / len;
      let nz = dx / len;
      const mx = (a.x + b.x) / 2 - cx;
      const mz = (a.z + b.z) / 2 - cz;
      if (nx * mx + nz * mz < 0) {
        nx = -nx;
        nz = -nz;
      }
      // Facing the viewer: the outward normal opposes the direction
      // the viewer is looking. 0.5 is 60 degrees, which keeps a bay
      // at 45 degrees on the face it belongs to.
      if (nx * view.x + nz * view.z < -0.5) {
        out.push({ room: r, wallIndex: i, a, b });
      }
    }
  }
  return out;
}

/** The opening's centre along its wall, as a world point. */
function openingCentre(a: Pt, b: Pt, o: Opening): Pt {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const pos = Number.parseFloat(o.positionM ?? "");
  const t =
    Number.isFinite(pos) && len > 0
      ? Math.min(Math.max(pos / len, 0), 1)
      : 0.5;
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
}

/**
 * One face of the building, as an outline elevation.
 *
 * Returns null when nothing faces this way — a terraced house has no
 * left or right elevation to draw, and an empty sheet headed "Left
 * elevation" would be read as a missing drawing rather than as a
 * wall somebody else owns.
 */
export function buildElevation(
  rooms: ElevationRoom[],
  side: ElevationSide,
): Elevation | null {
  const walls = facingWalls(rooms, side);
  if (!walls.length) return null;

  const heights = storeyHeights(rooms);
  const heightOf = (floor: number) =>
    heights.find((h) => h.floor === floor) ?? {
      floor,
      heightM: ASSUMED.storeyM,
      baseY: 0,
    };

  const us = walls.flatMap((w) => [
    acrossFace(side, w.a),
    acrossFace(side, w.b),
  ]);
  const uMin = Math.min(...us);
  const uMax = Math.max(...us);
  const widthM = uMax - uMin;
  if (widthM < 0.5) return null;

  const storeys = heights
    .map((h) => {
      const on = walls.filter((w) => w.room.floor === h.floor);
      if (!on.length) return null;
      const u = on.flatMap((w) => [
        acrossFace(side, w.a),
        acrossFace(side, w.b),
      ]);
      return {
        floor: h.floor,
        u0: Math.min(...u) - uMin,
        u1: Math.max(...u) - uMin,
        y0: h.baseY,
        y1: h.baseY + h.heightM,
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);

  const openings: ElevationOpening[] = [];
  for (const w of walls) {
    const h = heightOf(w.room.floor);
    const list: { o: Opening; kind: "door" | "window" }[] = [
      ...(w.room.room.doors ?? []).map((o) => ({ o, kind: "door" as const })),
      ...(w.room.room.windows ?? []).map((o) => ({
        o,
        kind: "window" as const,
      })),
    ];
    for (const { o, kind } of list) {
      if ((o.wallIndex ?? 0) !== w.wallIndex) continue;
      const width = Number.parseFloat(o.widthM);
      if (!Number.isFinite(width) || width <= 0) continue;
      const centre = acrossFace(side, openingCentre(w.a, w.b, o)) - uMin;
      // Heights are assumed, and capped so an opening cannot poke
      // through the ceiling of a low room. See ASSUMED.
      const sill = kind === "door" ? 0 : ASSUMED.windowSillM;
      const head = Math.min(
        kind === "door" ? ASSUMED.doorHeadM : ASSUMED.windowHeadM,
        h.heightM - 0.05,
      );
      if (head <= sill) continue;
      openings.push({
        kind,
        cased: o.cased,
        u0: centre - width / 2,
        u1: centre + width / 2,
        y0: h.baseY + sill,
        y1: h.baseY + head,
      });
    }
  }

  const top = storeys.length ? Math.max(...storeys.map((s) => s.y1)) : 0;
  return {
    side,
    storeys,
    openings,
    levels: heights.map((h) => ({ floor: h.floor, y: h.baseY })),
    widthM,
    heightM: top,
  };
}

/** All four faces, skipping the ones with nothing on them. */
export function buildElevations(rooms: ElevationRoom[]): Elevation[] {
  const sides: ElevationSide[] = ["front", "right", "back", "left"];
  return sides
    .map((s) => buildElevation(rooms, s))
    .filter((e): e is Elevation => e !== null);
}

/** "Front elevation". */
export function elevationName(side: ElevationSide): string {
  return `${side[0].toUpperCase()}${side.slice(1)} elevation`;
}
