/**
 * Floor-plan helpers — used by the drag-and-drop editor and by the
 * Apps Script SVG renderer.
 *
 * Everything here is pure geometry: no React, no DOM, no side effects.
 *
 * Coordinate system
 * ──────────────────────────────────────────────────────────────────
 *   x → horizontal axis on the plan (metres, +x = right)
 *   z → vertical axis on the plan   (metres, +z = down in SVG)
 *
 * We use x/z (not x/y) to stay consistent with the perspective module
 * and RoomPlan — both use y for vertical (up in the real world).
 *
 * A room rectangle is defined by:
 *   - its `widthM` × `lengthM` (unrotated extents, widthM along +x)
 *   - its `positionM` (top-left corner of the UNROTATED rectangle)
 *   - a rotation about that top-left corner, stepped at 0/90/180/270.
 *
 * Rotating about the top-left (rather than the centre) makes grid
 * snapping trivial: whatever direction the room is facing, its anchor
 * is always on a lattice point.
 */

import type { RoomDraft, RoomRotationDeg } from "./types";

/** Snap granularity for room positions. Must divide common wall lengths cleanly. */
export const GRID_STEP_M = 0.25;

/** Generic labels for floor indices. Extend as the app adds floors. */
const DEFAULT_FLOOR_LABELS: Record<number, string> = {
  [-2]: "Sub-basement",
  [-1]: "Basement",
  [0]: "Ground floor",
  [1]: "First floor",
  [2]: "Second floor",
  [3]: "Third floor",
  [4]: "Fourth floor",
};

/** Human-friendly name for a floor index. */
export function floorLabel(index: number): string {
  if (DEFAULT_FLOOR_LABELS[index]) return DEFAULT_FLOOR_LABELS[index];
  if (index < 0) return `Basement ${-index}`;
  return `Floor ${index}`;
}

/** Snap a metre-value to the grid. */
export function snapToGrid(m: number, step: number = GRID_STEP_M): number {
  return Math.round(m / step) * step;
}

/** Parse a RoomDraft's string wall array into numeric {widthM, lengthM}. */
export function roomFootprint(room: RoomDraft): { widthM: number; lengthM: number } {
  // We assume rooms are rectangular in the floor plan even if the
  // user recorded an irregular shape elsewhere — the drag-and-drop
  // canvas treats the bounding box as the layout footprint.
  // wallOrder expected: [N, E, S, W] clockwise → width = N, length = E.
  const w = Number(room.walls[0]?.lengthM);
  const l = Number(room.walls[1]?.lengthM);
  // Fallbacks keep unplaced / incomplete rooms visible as a 3×3m box.
  return {
    widthM: Number.isFinite(w) && w > 0 ? w : 3,
    lengthM: Number.isFinite(l) && l > 0 ? l : 3,
  };
}

/**
 * Return the axis-aligned bounding box of a rotated room rectangle,
 * expressed as its top-left and bottom-right corners in world metres.
 *
 * For 0°/180° rotations, width stays along x and length along z.
 * For 90°/270°, they swap. In all cases the anchor is the unrotated
 * top-left; after rotation the rectangle occupies a bbox starting at
 * a different corner — we recompute that here so downstream code can
 * treat rooms as plain AABBs when doing overlap checks.
 */
export function roomBoundingBox(
  anchor: { x: number; z: number },
  size: { widthM: number; lengthM: number },
  rotationDeg: RoomRotationDeg,
): { minX: number; minZ: number; maxX: number; maxZ: number } {
  const { widthM, lengthM } = size;
  let dx: number, dz: number;
  switch (rotationDeg) {
    case 0:
      dx = widthM;
      dz = lengthM;
      break;
    case 90:
      // The editor draws rooms with `rotate(deg 0 0)` after translating
      // to the anchor. SVG rotates clockwise in this z-down system, so
      // its matrix sends (x, z) to (-z, x): the far corner (w, l) lands
      // at (-l, w) — down and to the LEFT of the anchor.
      //
      // This case and 270 were previously each other's values, which
      // reflected the box through the anchor. The drawn room and its
      // bounding box then disagreed for every quarter turn, so the
      // auto-fit viewBox could scroll a rotated room out of sight and
      // overlap checks compared the wrong region of the plan.
      dx = -lengthM;
      dz = widthM;
      break;
    case 180:
      // (x, z) → (-x, -z). Symmetric, so this case was already right.
      dx = -widthM;
      dz = -lengthM;
      break;
    case 270:
      // (x, z) → (z, -x): up and to the right.
      dx = lengthM;
      dz = -widthM;
      break;
  }
  const x1 = anchor.x;
  const z1 = anchor.z;
  const x2 = anchor.x + dx;
  const z2 = anchor.z + dz;
  return {
    minX: Math.min(x1, x2),
    minZ: Math.min(z1, z2),
    maxX: Math.max(x1, x2),
    maxZ: Math.max(z1, z2),
  };
}

/** True if two axis-aligned rectangles overlap strictly (touching edges = not overlapping). */
export function aabbOverlaps(
  a: { minX: number; minZ: number; maxX: number; maxZ: number },
  b: { minX: number; minZ: number; maxX: number; maxZ: number },
): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
}

/**
 * Given all placed rooms on a floor, compute the plan bounding box
 * (used to auto-fit the SVG viewBox).
 * Returns null when the floor is empty.
 */
export function floorExtents(
  rooms: Array<{
    anchor: { x: number; z: number };
    size: { widthM: number; lengthM: number };
    rotationDeg: RoomRotationDeg;
  }>,
): { minX: number; minZ: number; maxX: number; maxZ: number } | null {
  if (rooms.length === 0) return null;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const r of rooms) {
    const bb = roomBoundingBox(r.anchor, r.size, r.rotationDeg);
    if (bb.minX < minX) minX = bb.minX;
    if (bb.minZ < minZ) minZ = bb.minZ;
    if (bb.maxX > maxX) maxX = bb.maxX;
    if (bb.maxZ > maxZ) maxZ = bb.maxZ;
  }
  return { minX, minZ, maxX, maxZ };
}

/**
 * Default placement when the user starts the floor plan for the first
 * time — lays rooms out in a simple left-to-right row on the ground
 * floor with 1 m gaps. Customers can drag them into the real layout.
 * Rooms already placed by the user are left untouched.
 */
export function autoLayoutRooms(
  rooms: RoomDraft[],
): Map<string, { positionM: { x: number; z: number }; rotationDeg: RoomRotationDeg; floor: number }> {
  const out = new Map<
    string,
    { positionM: { x: number; z: number }; rotationDeg: RoomRotationDeg; floor: number }
  >();
  let cursorX = 0;
  for (const r of rooms) {
    if (r.placement?.positionM) continue; // user already placed it
    const size = roomFootprint(r);
    out.set(r.id, {
      positionM: { x: snapToGrid(cursorX), z: 0 },
      rotationDeg: 0,
      floor: r.placement?.floor ?? 0,
    });
    cursorX += size.widthM + 1;
  }
  return out;
}

/**
 * Sanitise a pointer-drag position: snap to grid, clamp to a sensible
 * world range so the user can't drag a room a kilometre off-screen.
 */
export function sanitisePlacement(
  positionM: { x: number; z: number },
  step: number = GRID_STEP_M,
  clampM: number = 500,
): { x: number; z: number } {
  return {
    x: snapToGrid(Math.max(-clampM, Math.min(clampM, positionM.x)), step),
    z: snapToGrid(Math.max(-clampM, Math.min(clampM, positionM.z)), step),
  };
}

/**
 * List of floor indices currently in use by the room set, sorted low
 * → high. Always includes 0 (ground) even when no room is placed there
 * so the editor has a default tab to show.
 */
export function floorsInUse(rooms: RoomDraft[]): number[] {
  const set = new Set<number>([0]);
  for (const r of rooms) {
    if (r.placement?.floor !== undefined) set.add(r.placement.floor);
  }
  return [...set].sort((a, b) => a - b);
}
