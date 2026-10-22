/**
 * Turning a pile of measured rooms into a floor plan.
 *
 * Room-by-room scanning is the reliable way to survey a house: each
 * room gets its own short session, a bad one can be redone on its
 * own, and nothing is lost if the phone is put down halfway round.
 * What it cannot do is say where the rooms are relative to each
 * other. Every scan starts its own coordinate system at whatever
 * the customer happened to be facing, so the survey arrives as a
 * stack of accurate shapes in no particular arrangement, and the
 * only way to assemble them was dragging each one into place by
 * eye on a phone screen -- which throws away the accuracy that
 * justified scanning in the first place.
 *
 * A doorway is the one thing two rooms genuinely share. Both scans
 * measured it: which wall it is in, how far along that wall, how
 * wide. So if somebody says "the kitchen's back door is the hall's
 * side door", that single fact is enough to place one room against
 * the other exactly:
 *
 *   - the shared wall must be the same line, and the two rooms must
 *     be on opposite sides of it, which fixes the rotation;
 *   - the shared door must be at the same point on that line, which
 *     fixes the position.
 *
 * Two constraints, two unknowns, no guessing and nothing dragged.
 *
 * What this does not do is close loops. A ring of rooms -- hall to
 * kitchen to diner and back to hall -- will not quite meet, because
 * each room carries its own centimetre or two of error and walking
 * the ring accumulates them. This walks a spanning tree outwards
 * from one room and accepts that the last join in a loop may be
 * slightly open; the alternative is a least-squares solve over the
 * whole graph, which is worth doing when somebody complains about
 * a visible gap and not before.
 */

import type { RoomDraft, Opening } from "./types.ts";
import type { RoomConnection } from "./connectivity.ts";
import { rotatePointM } from "./types.ts";
import { roomFootprint } from "./floorplan.ts";

export type JoinedPlacement = {
  positionM: { x: number; z: number };
  rotationDeg: number;
};

/**
 * The room's walls as line segments in its own frame.
 *
 * The real outline where there is one, the bounding rectangle
 * otherwise -- the same choice the plan editor and the DXF make, so
 * a wall index means the same thing everywhere.
 */
function wallSegments(
  room: RoomDraft,
): { a: { x: number; z: number }; b: { x: number; z: number } }[] {
  const outline = room.floorPolygonM;
  if (outline && outline.length >= 3) {
    return outline.map((a, i) => ({
      a,
      b: outline[(i + 1) % outline.length],
    }));
  }
  const { widthM, lengthM } = roomFootprint(room);
  return [
    { a: { x: 0, z: 0 }, b: { x: widthM, z: 0 } },
    { a: { x: widthM, z: 0 }, b: { x: widthM, z: lengthM } },
    { a: { x: widthM, z: lengthM }, b: { x: 0, z: lengthM } },
    { a: { x: 0, z: lengthM }, b: { x: 0, z: 0 } },
  ];
}

/**
 * Where a door sits in its room: which wall, and how far along it.
 *
 * Falls back to the middle of the wall when nobody recorded a
 * position, which is what the drawing already assumes.
 */
function doorOnWall(
  room: RoomDraft,
  doorId: string | undefined,
): { wallIndex: number; alongM: number } | null {
  if (!doorId) return null;
  const all: Opening[] = [...(room.doors ?? []), ...(room.windows ?? [])];
  const found = all.find((o) => o.id === doorId);
  if (!found) return null;

  const segs = wallSegments(room);
  const wallIndex = Math.min(Math.max(found.wallIndex ?? 0, 0), segs.length - 1);
  const seg = segs[wallIndex];
  const wallLen = Math.hypot(seg.b.x - seg.a.x, seg.b.z - seg.a.z);

  const parsed = Number.parseFloat(found.positionM ?? "");
  const alongM =
    Number.isFinite(parsed) && parsed > 0 ? parsed : wallLen / 2;

  return { wallIndex, alongM: Math.min(alongM, wallLen) };
}

/** Degrees, clockwise from +x, of a vector in the app's frame. */
function headingOf(v: { x: number; z: number }): number {
  return (Math.atan2(v.z, v.x) * 180) / Math.PI;
}

/**
 * Place every room that can be reached through a named doorway.
 *
 * Rooms already placed by the customer are left exactly where they
 * are and used as the starting points, so this never undoes
 * somebody's own arrangement -- it fills in from it. With nothing
 * placed, the room with the most doorways goes down first, because
 * starting from the hall gives the shortest path to everywhere
 * else and so the least accumulated error.
 *
 * Returns only the rooms it moved. Anything unreachable -- an
 * outbuilding, a room whose doorway nobody named -- is absent
 * rather than guessed at, and the caller can lay those out however
 * it laid them out before.
 */
export function layoutFromDoorways(
  rooms: RoomDraft[],
  connections: RoomConnection[],
  existing?: Record<string, { positionM?: { x: number; z: number } | null; rotationDeg?: number }>,
): Map<string, JoinedPlacement> {
  const byId = new Map(rooms.map((r) => [r.id, r]));
  const out = new Map<string, JoinedPlacement>();

  /** Both ends named, both rooms real, and not a room to itself. */
  const usable = connections.filter(
    (c) =>
      c.roomBId &&
      c.doorAId &&
      c.doorBId &&
      c.roomAId !== c.roomBId &&
      byId.has(c.roomAId) &&
      byId.has(c.roomBId),
  );
  if (usable.length === 0) return out;

  const neighbours = new Map<string, RoomConnection[]>();
  for (const c of usable) {
    for (const id of [c.roomAId, c.roomBId!]) {
      const list = neighbours.get(id) ?? [];
      list.push(c);
      neighbours.set(id, list);
    }
  }

  /** Position and rotation of every room we have settled so far. */
  const fixed = new Map<string, JoinedPlacement>();
  const queue: string[] = [];

  for (const r of rooms) {
    const p = existing?.[r.id];
    if (p?.positionM) {
      fixed.set(r.id, {
        positionM: p.positionM,
        rotationDeg: p.rotationDeg ?? 0,
      });
      queue.push(r.id);
    }
  }

  if (queue.length === 0) {
    let seed = "";
    let most = -1;
    for (const [id, list] of neighbours) {
      if (list.length > most) {
        most = list.length;
        seed = id;
      }
    }
    if (!seed) return out;
    const placement = { positionM: { x: 0, z: 0 }, rotationDeg: 0 };
    fixed.set(seed, placement);
    out.set(seed, placement);
    queue.push(seed);
  }

  while (queue.length) {
    const here = queue.shift()!;
    const anchor = fixed.get(here)!;

    for (const c of neighbours.get(here) ?? []) {
      // Which end of this connection is the room we have, and which
      // is the one we are placing. A connection is written from one
      // side but means the same thing read either way.
      const fromA = c.roomAId === here;
      const otherId = fromA ? c.roomBId! : c.roomAId;
      if (fixed.has(otherId)) continue;

      const known = byId.get(here)!;
      const other = byId.get(otherId)!;
      const knownDoor = doorOnWall(known, fromA ? c.doorAId : c.doorBId);
      const otherDoor = doorOnWall(other, fromA ? c.doorBId : c.doorAId);
      if (!knownDoor || !otherDoor) continue;

      const knownSeg = wallSegments(known)[knownDoor.wallIndex];
      const otherSeg = wallSegments(other)[otherDoor.wallIndex];
      const knownDir = {
        x: knownSeg.b.x - knownSeg.a.x,
        z: knownSeg.b.z - knownSeg.a.z,
      };
      const otherDir = {
        x: otherSeg.b.x - otherSeg.a.x,
        z: otherSeg.b.z - otherSeg.a.z,
      };
      const knownLen = Math.hypot(knownDir.x, knownDir.z);
      const otherLen = Math.hypot(otherDir.x, otherDir.z);
      if (knownLen < 1e-6 || otherLen < 1e-6) continue;

      /*
       * Rotation: the shared wall is one line with a room on each
       * side of it. Both outlines wind the same way round their own
       * floor, so walking the shared wall from inside one room runs
       * opposite to walking it from inside the other -- which is
       * what makes the two rooms land on opposite sides rather than
       * on top of each other.
       */
      const knownWorldHeading =
        headingOf(knownDir) + anchor.rotationDeg;
      const rotationDeg =
        ((knownWorldHeading + 180 - headingOf(otherDir)) % 360 + 360) % 360;

      /*
       * Position: the doorway is one point, so put the other room's
       * copy of it exactly on top of this room's copy.
       */
      const unit = { x: knownDir.x / knownLen, z: knownDir.z / knownLen };
      const doorLocal = {
        x: knownSeg.a.x + unit.x * knownDoor.alongM,
        z: knownSeg.a.z + unit.z * knownDoor.alongM,
      };
      const spun = rotatePointM(doorLocal, anchor.rotationDeg);
      const doorWorld = {
        x: anchor.positionM.x + spun.x,
        z: anchor.positionM.z + spun.z,
      };

      const otherUnit = { x: otherDir.x / otherLen, z: otherDir.z / otherLen };
      const otherDoorLocal = {
        x: otherSeg.a.x + otherUnit.x * otherDoor.alongM,
        z: otherSeg.a.z + otherUnit.z * otherDoor.alongM,
      };
      const otherSpun = rotatePointM(otherDoorLocal, rotationDeg);

      const placement: JoinedPlacement = {
        positionM: {
          x: Number((doorWorld.x - otherSpun.x).toFixed(3)),
          z: Number((doorWorld.z - otherSpun.z).toFixed(3)),
        },
        rotationDeg: Number(rotationDeg.toFixed(1)),
      };

      fixed.set(otherId, placement);
      out.set(otherId, placement);
      queue.push(otherId);
    }
  }

  return out;
}

/** How near two doorways must be dragged before they snap together. */
export const DOORWAY_SNAP_M = 0.8;

/**
 * How far a snap is allowed to turn the room, in degrees.
 *
 * A snap tidies up what the customer has already done; it does not
 * decide what they meant. Within this the rooms were plainly being
 * lined up and the last few degrees are hand jitter. Beyond it the
 * room would visibly spin on being let go, which reads as the app
 * overruling the drag.
 */
export const DOORWAY_SNAP_MAX_TURN_DEG = 25;

/**
 * Join a room to its neighbour when it is dropped close enough.
 *
 * The connections form that used to ask which rooms open onto which
 * was taken out on the grounds that dragging says the same thing
 * far better, and that was right: two rooms touching on the grid
 * are adjacent, and nobody should have to describe their house as a
 * graph. But the drag only said it roughly -- a fingertip on a
 * phone places a room to within a few centimetres on a good day,
 * and those centimetres are the accuracy that scanning was for.
 *
 * So the drag keeps saying it and the app stops rounding it off.
 * When a room is let go with one of its doorways close to a
 * doorway of a room already on the plan, the two are taken to be
 * the same doorway and the room is placed exactly: both scans
 * measured that door, so the rooms can be fitted together to the
 * millimetre. Nothing is typed and nothing is asked.
 *
 * Deliberately a small correction. It will not turn a room more
 * than DOORWAY_SNAP_MAX_TURN_DEG, so what the customer dropped is
 * recognisably what they get -- it squares up a join they were
 * already making rather than deciding one for them.
 *
 * Returns null when there is nothing near enough, which is most
 * drags.
 */
export function snapToNearestDoorway(
  moving: RoomDraft,
  current: JoinedPlacement,
  others: { room: RoomDraft; placement: JoinedPlacement }[],
): JoinedPlacement | null {
  const movingDoors = moving.doors ?? [];
  if (movingDoors.length === 0) return null;

  const movingSegs = wallSegments(moving);

  /** A door's centre in world metres, under a given placement. */
  const worldDoor = (
    room: RoomDraft,
    segs: ReturnType<typeof wallSegments>,
    door: Opening,
    placement: JoinedPlacement,
  ) => {
    const spot = doorOnWall(room, door.id);
    if (!spot) return null;
    const seg = segs[spot.wallIndex];
    const len = Math.hypot(seg.b.x - seg.a.x, seg.b.z - seg.a.z);
    if (len < 1e-6) return null;
    const local = {
      x: seg.a.x + ((seg.b.x - seg.a.x) / len) * spot.alongM,
      z: seg.a.z + ((seg.b.z - seg.a.z) / len) * spot.alongM,
    };
    const spun = rotatePointM(local, placement.rotationDeg);
    return {
      world: {
        x: placement.positionM.x + spun.x,
        z: placement.positionM.z + spun.z,
      },
      local,
      seg,
    };
  };

  let best: {
    dist: number;
    mine: NonNullable<ReturnType<typeof worldDoor>>;
    theirs: NonNullable<ReturnType<typeof worldDoor>>;
    theirRotation: number;
  } | null = null;

  for (const mine of movingDoors) {
    const m = worldDoor(moving, movingSegs, mine, current);
    if (!m) continue;
    for (const { room, placement } of others) {
      if (room.id === moving.id) continue;
      const segs = wallSegments(room);
      for (const theirs of room.doors ?? []) {
        const t = worldDoor(room, segs, theirs, placement);
        if (!t) continue;
        const dist = Math.hypot(
          m.world.x - t.world.x,
          m.world.z - t.world.z,
        );
        if (dist < DOORWAY_SNAP_M && (!best || dist < best.dist)) {
          best = {
            dist,
            mine: m,
            theirs: t,
            theirRotation: placement.rotationDeg,
          };
        }
      }
    }
  }

  if (!best) return null;

  const theirDir = {
    x: best.theirs.seg.b.x - best.theirs.seg.a.x,
    z: best.theirs.seg.b.z - best.theirs.seg.a.z,
  };
  const myDir = {
    x: best.mine.seg.b.x - best.mine.seg.a.x,
    z: best.mine.seg.b.z - best.mine.seg.a.z,
  };
  if (Math.hypot(theirDir.x, theirDir.z) < 1e-6) return null;
  if (Math.hypot(myDir.x, myDir.z) < 1e-6) return null;

  // Opposite sides of one wall, same reasoning as layoutFromDoorways.
  const wanted =
    ((headingOf(theirDir) +
      best.theirRotation +
      180 -
      headingOf(myDir)) %
      360 +
      360) %
    360;

  // Refuse a snap that would visibly spin the room.
  let turn = ((wanted - current.rotationDeg) % 360 + 360) % 360;
  if (turn > 180) turn -= 360;
  if (Math.abs(turn) > DOORWAY_SNAP_MAX_TURN_DEG) return null;

  const spun = rotatePointM(best.mine.local, wanted);
  return {
    positionM: {
      x: Number((best.theirs.world.x - spun.x).toFixed(3)),
      z: Number((best.theirs.world.z - spun.z).toFixed(3)),
    },
    rotationDeg: Number(wanted.toFixed(1)),
  };
}

/**
 * The doorways nobody has matched up yet.
 *
 * Every door in every room that is not already named in a
 * connection, so the screen that asks "where does this lead?" has
 * something to ask about and stops asking once it is answered.
 *
 * External doors are the reason this is a list rather than a
 * countdown to zero: a front door leads outside and will never be
 * paired with anything, so a customer who answers every question
 * that can be answered will still be left holding some.
 */
export function unmatchedDoorways(
  rooms: RoomDraft[],
  connections: RoomConnection[],
): { roomId: string; door: Opening }[] {
  const taken = new Set<string>();
  for (const c of connections) {
    if (c.doorAId) taken.add(c.doorAId);
    if (c.doorBId) taken.add(c.doorBId);
  }
  const out: { roomId: string; door: Opening }[] = [];
  for (const r of rooms) {
    for (const d of r.doors ?? []) {
      if (!taken.has(d.id)) out.push({ roomId: r.id, door: d });
    }
  }
  return out;
}
