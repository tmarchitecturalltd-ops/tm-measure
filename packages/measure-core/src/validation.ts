// Extension required. This is a runtime import, and Node's ESM
// resolver will not guess it -- so this module could not be loaded by
// node:test at all, which is the unglamorous reason the validator was
// the one part of measure-core with no tests. The type-only imports
// elsewhere get away with it because they are erased before Node ever
// sees them.
import { parseMeters } from "./parse.ts";
import type { RoomDraft } from "./types";

export const LIMITS = {
  wallMin: 0.3,
  wallMax: 25,
  ceilingMin: 1.8,
  ceilingMax: 5.5,
  doorMin: 0.45,
  doorMax: 2,
  windowMin: 0.2,
  windowMax: 5,
} as const;

export type FieldIssue = { path: string; message: string };

export function validateWallLength(
  value: string,
  path: string,
): FieldIssue | null {
  const n = parseMeters(value);
  if (n === null) return { path, message: "Enter a length in metres." };
  if (n < LIMITS.wallMin)
    return { path, message: `Too short (min ${LIMITS.wallMin} m).` };
  if (n > LIMITS.wallMax)
    return { path, message: `Too long (max ${LIMITS.wallMax} m).` };
  return null;
}

export function validateCeiling(
  value: string,
  path: string,
): FieldIssue | null {
  const n = parseMeters(value);
  if (n === null) return { path, message: "Enter ceiling height in metres." };
  if (n < LIMITS.ceilingMin)
    return { path, message: `Below typical range (min ${LIMITS.ceilingMin} m).` };
  if (n > LIMITS.ceilingMax)
    return { path, message: `Above typical range (max ${LIMITS.ceilingMax} m).` };
  return null;
}

export function validateOpening(
  value: string,
  path: string,
  kind: "door" | "window",
): FieldIssue | null {
  const t = value.trim();
  if (!t) return null;
  const n = parseMeters(t);
  if (n === null) return { path, message: "Invalid number." };
  const lo = kind === "door" ? LIMITS.doorMin : LIMITS.windowMin;
  const hi = kind === "door" ? LIMITS.doorMax : LIMITS.windowMax;
  if (n < lo || n > hi)
    return {
      path,
      message:
        kind === "door"
          ? `Door width usually ${LIMITS.doorMin}–${LIMITS.doorMax} m.`
          : `Window width usually ${LIMITS.windowMin}–${LIMITS.windowMax} m.`,
    };
  return null;
}

export function validateRoom(room: RoomDraft, index: number): FieldIssue[] {
  const p = `room-${index}`;
  const issues: FieldIssue[] = [];
  if (!room.name.trim())
    issues.push({ path: `${p}-name`, message: "Name this room." });

  /*
   * A traced outline replaces the typed lengths.
   *
   * Every wall length was required unconditionally, including on rooms
   * the customer had drawn rather than typed — where by definition no
   * wall field is filled in. So drawing a room produced a survey that
   * could never be submitted, and the failure was silent: the Finish
   * button simply did nothing.
   *
   * The polygon carries every length implicitly, so demanding them
   * again is asking for the same information twice and then refusing
   * to proceed without it.
   */
  /*
   * A scan replaces them too, and for a sharper reason than drawing.
   *
   * The 0.3 m minimum is a typo-catcher for a human typing into a box:
   * nobody means to enter a 4 cm wall. It is not a fact about
   * buildings. A scanner reports what is actually there, including the
   * 150 mm return beside a chimney breast or the reveal of a doorway,
   * and those are genuinely shorter than 0.3 m.
   *
   * Charlie hit this and could not get past it. The room was scanned,
   * so the flow has no walls screen at all -- finishRoom looked up the
   * step that owned the failing wall, found the room does not have
   * one, and correctly stayed put. The result was a room reporting a
   * fault on a field that exists nowhere the customer can reach, on
   * every screen, for ever. An unfixable error is worse than no
   * validation: the survey simply ends there.
   */
  const drawn =
    (room.floorPolygonM?.length ?? 0) >= 3 || room.measuredByScan === true;
  if (!drawn) {
    room.walls.forEach((w, wi) => {
      const hit = validateWallLength(w.lengthM, `${p}-wall-${wi}`);
      if (hit) issues.push(hit);
    });
  }
  const c = validateCeiling(room.ceilingHeightM, `${p}-ceiling`);
  if (c) issues.push(c);
  room.doors.forEach((d, di) => {
    const hit = validateOpening(d.widthM, `${p}-door-${di}`, "door");
    if (hit) issues.push(hit);
  });
  room.windows.forEach((w, wi) => {
    const hit = validateOpening(w.widthM, `${p}-window-${wi}`, "window");
    if (hit) issues.push(hit);
  });
  /*
   * A reference photo, so the architect can audit the dimensions
   * without being on site — radiators, columns, mouldings, the things
   * a number does not carry.
   *
   * Not required on a scanned room. The scan already contains the
   * geometry the photo exists to corroborate, and rooms created by
   * applyHouseScan start with `photos: []` — so this rule made every
   * LiDAR submission impossible. A customer could walk the whole
   * property with the sensor, exactly as the feature is sold, and then
   * be told to photograph every room before they could send it. The
   * one workflow this was written to support was the one it blocked.
   */
  if (!room.measuredByScan && (!room.photos || room.photos.length === 0)) {
    issues.push({
      path: `${p}-photos`,
      message: "Add at least one reference photo of this room.",
    });
  }
  return issues;
}

export function validateProject(rooms: RoomDraft[]): FieldIssue[] {
  if (rooms.length === 0)
    return [{ path: "rooms", message: "Add at least one room." }];
  return rooms.flatMap((r, i) => validateRoom(r, i));
}
