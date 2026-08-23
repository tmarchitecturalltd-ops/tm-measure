/**
 * DXF export — floor plan out of TM Measure and into CAD.
 *
 * DXF is Autodesk's documented, text-based interchange format. AutoCAD,
 * Revit, ArchiCAD, SketchUp and QCAD all open it directly. DWG is the
 * same company's proprietary binary format; writing it legitimately
 * requires a licensed library, and for a floor plan there is no
 * practical difference to the person opening the file.
 *
 * This is the "basic" export: room outlines and names, correctly
 * scaled. Openings, swing arcs, dimension strings and a title block are
 * deliberately left out of this pass.
 *
 * ── Units ──────────────────────────────────────────────────────────
 * Everything is written in MILLIMETRES. The app works in metres, but
 * millimetres are what UK architectural CAD expects, and a plan that
 * imports at 1/1000 scale is worse than no plan at all — it looks
 * plausible until someone dimensions off it. $INSUNITS is set to 4
 * (millimetres) so receiving software knows what it has been given.
 *
 * ── Axes ───────────────────────────────────────────────────────────
 * The app's z axis runs downward on screen, which is how the layout
 * editor is drawn. CAD's y axis runs upward. z is negated on the way
 * out, otherwise every plan arrives mirrored — a mistake that survives
 * casual inspection because a mirrored rectangle is still a rectangle,
 * and only shows up once someone builds from it.
 */

import type { RoomDraft, RoomRotationDeg } from "./types";
// Explicit .ts extension: this is a value import, not a type-only one,
// so Node's native TypeScript loader has to resolve it at runtime when
// `npm test` runs the suite directly. The type imports elsewhere in
// this package get erased before that matters. tsconfig sets
// allowImportingTsExtensions, so the bundler is happy with it too.
import { roomFootprint } from "./floorplan.ts";

/** Layer names. Kept few and obvious so the file is workable on import. */
export const DXF_LAYER_WALLS = "TM-WALLS";
export const DXF_LAYER_LABELS = "TM-LABELS";

const MM_PER_M = 1000;

/** DXF group code + value, one per line. */
function pair(code: number | string, value: string | number): string {
  return `${code}\n${value}`;
}

/**
 * The four corners of a room in world metres, in draw order, closed.
 *
 * Mirrors the rotation maths in roomBoundingBox: the anchor is the
 * unrotated top-left and the rectangle is rotated clockwise about it.
 * Any disagreement between the two would put the outline somewhere the
 * overlap checks do not expect.
 */
export function roomCornersM(
  anchor: { x: number; z: number },
  size: { widthM: number; lengthM: number },
  rotationDeg: RoomRotationDeg,
): { x: number; z: number }[] {
  const { widthM: w, lengthM: l } = size;
  // Local corners, clockwise from the anchor.
  const local: [number, number][] = [
    [0, 0],
    [w, 0],
    [w, l],
    [0, l],
  ];
  const rot = ((rotationDeg % 360) + 360) % 360;
  return local.map(([x, z]) => {
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

function lineEntity(
  layer: string,
  a: { x: number; y: number },
  b: { x: number; y: number },
): string {
  return [
    pair(0, "LINE"),
    pair(8, layer),
    pair(10, a.x.toFixed(3)),
    pair(20, a.y.toFixed(3)),
    pair(30, "0.0"),
    pair(11, b.x.toFixed(3)),
    pair(21, b.y.toFixed(3)),
    pair(31, "0.0"),
  ].join("\n");
}

function textEntity(
  layer: string,
  at: { x: number; y: number },
  heightMm: number,
  value: string,
): string {
  return [
    pair(0, "TEXT"),
    pair(8, layer),
    pair(10, at.x.toFixed(3)),
    pair(20, at.y.toFixed(3)),
    pair(30, "0.0"),
    pair(40, heightMm.toFixed(1)),
    // Centre the label on its insertion point rather than starting
    // there, so a long room name does not run off across the plan.
    pair(72, 1),
    pair(11, at.x.toFixed(3)),
    pair(21, at.y.toFixed(3)),
    pair(31, "0.0"),
    pair(1, sanitiseDxfText(value)),
  ].join("\n");
}

/**
 * DXF text is newline-delimited, so a stray newline in a room name
 * would terminate the entity early and corrupt everything after it.
 * Commas and control characters get the same treatment.
 */
export function sanitiseDxfText(raw: string): string {
  return String(raw ?? "")
    .replace(/[\r\n]+/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]/g, "")
    .trim()
    .slice(0, 120);
}

export type DxfRoomInput = {
  room: RoomDraft;
  /** Placement anchor in world metres. Rooms without one are skipped. */
  anchor: { x: number; z: number };
  rotationDeg: RoomRotationDeg;
};

/**
 * Build a complete DXF document for one floor.
 *
 * Returns a string ready to be written to a .dxf file. Rooms without a
 * placement are omitted rather than stacked at the origin, which is
 * what makes an export look like a single overlapping blob.
 */
export function buildFloorPlanDxf(
  entries: DxfRoomInput[],
  options: { floorLabel?: string } = {},
): string {
  const out: string[] = [];

  // ── HEADER ──────────────────────────────────────────────────────
  out.push(pair(0, "SECTION"));
  out.push(pair(2, "HEADER"));
  out.push(pair(9, "$ACADVER"), pair(1, "AC1009")); // R12: widest compatibility
  out.push(pair(9, "$INSUNITS"), pair(70, 4)); // 4 = millimetres
  out.push(pair(0, "ENDSEC"));

  // ── TABLES: layers ──────────────────────────────────────────────
  out.push(pair(0, "SECTION"), pair(2, "TABLES"));
  out.push(pair(0, "TABLE"), pair(2, "LAYER"), pair(70, 2));
  for (const [name, colour] of [
    [DXF_LAYER_WALLS, 7],
    [DXF_LAYER_LABELS, 3],
  ] as const) {
    out.push(
      pair(0, "LAYER"),
      pair(2, name),
      pair(70, 0),
      pair(62, colour),
      pair(6, "CONTINUOUS"),
    );
  }
  out.push(pair(0, "ENDTAB"), pair(0, "ENDSEC"));

  // ── ENTITIES ────────────────────────────────────────────────────
  out.push(pair(0, "SECTION"), pair(2, "ENTITIES"));

  for (const { room, anchor, rotationDeg } of entries) {
    const size = roomFootprint(room);
    const corners = roomCornersM(anchor, size, rotationDeg);
    // Metres → millimetres, and z (screen-down) → y (CAD-up).
    const pts = corners.map((c) => ({
      x: c.x * MM_PER_M,
      y: -c.z * MM_PER_M,
    }));

    for (let i = 0; i < pts.length; i++) {
      out.push(lineEntity(DXF_LAYER_WALLS, pts[i], pts[(i + 1) % pts.length]));
    }

    const name = room.name?.trim();
    if (name) {
      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      // Label height scales with the room so it stays readable on a
      // cupboard and does not dwarf a small plan. Clamped both ends.
      const shortestMm = Math.min(size.widthM, size.lengthM) * MM_PER_M;
      const height = Math.max(120, Math.min(400, shortestMm / 10));
      out.push(textEntity(DXF_LAYER_LABELS, { x: cx, y: cy }, height, name));
    }
  }

  if (options.floorLabel) {
    // Title sits above the plan's extents so it never lands on top of
    // a room.
    const allY = entries.flatMap(({ room, anchor, rotationDeg }) =>
      roomCornersM(anchor, roomFootprint(room), rotationDeg).map(
        (c) => -c.z * MM_PER_M,
      ),
    );
    const allX = entries.flatMap(({ room, anchor, rotationDeg }) =>
      roomCornersM(anchor, roomFootprint(room), rotationDeg).map(
        (c) => c.x * MM_PER_M,
      ),
    );
    if (allY.length && allX.length) {
      out.push(
        textEntity(
          DXF_LAYER_LABELS,
          {
            x: (Math.min(...allX) + Math.max(...allX)) / 2,
            y: Math.max(...allY) + 800,
          },
          500,
          options.floorLabel,
        ),
      );
    }
  }

  out.push(pair(0, "ENDSEC"));
  out.push(pair(0, "EOF"));

  return out.join("\n") + "\n";
}
