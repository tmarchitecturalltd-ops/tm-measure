"use client";

/**
 * components/measure/RoomsSoFar.tsx
 *
 * The rooms measured so far, drawn at their real proportions.
 *
 * ## Why
 *
 * A survey is forty questions and, until the very end, nothing to
 * show for them. The customer answers, and answers, and the screen
 * looks the same each time — which is why it reads as a form rather
 * than as measuring a house. Meanwhile the app is quietly
 * accumulating the one thing they actually want: a drawing of their
 * home.
 *
 * So it shows it. Each room appears as it is measured, at the size
 * and shape the sensor or the tape reported, and by the fourth room
 * there is something on screen that is recognisably theirs. It also
 * answers "how much longer" better than a progress bar does, because
 * you can see what is missing.
 *
 * ## What it is not
 *
 * Not a floor plan, and it does not claim to be. Rooms have no
 * position relative to one another until the customer arranges them
 * on the plan step, which happens after all the measuring. Until
 * then they are packed left to right in the order they were done.
 * The shapes and relative sizes are real; the arrangement is not,
 * and the label says "rooms" rather than "plan" for that reason.
 *
 * Once placements exist they are used, so the same strip becomes a
 * true plan on the way back through.
 */

import type { RoomDraft, RoomPlacement } from "@tm-designs/measure-core";
import { roomFootprint, rotatePointM } from "@tm-designs/measure-core";

type Props = {
  rooms: RoomDraft[];
  /** Real positions, where the customer has set them. */
  placements?: Record<string, RoomPlacement>;
  /** Drawn slightly stronger — the one just finished. */
  highlightRoomId?: string;
  /** Drawing height in px. The width is whatever the parent gives. */
  height?: number;
};

/**
 * A room is worth drawing once it has been measured.
 *
 * The test used to be roomFootprint's width and length, which looks
 * right and is not: that helper falls back to a 3x3 m box so an
 * incomplete room stays visible on the plan canvas, where being
 * draggable matters more than being accurate. Here the fallback is
 * exactly wrong -- it gave every untouched room a size, so the
 * starter room nobody had looked at was drawn as a 3 m square and
 * counted.
 *
 * Reported from a hotel: one room scanned, and the strip said "2
 * rooms measured" with a phantom box next to the real outline.
 *
 * So the question asked is whether anyone measured a wall, which is
 * the thing roomFootprint is reading and then papering over.
 */
function outlineOf(room: RoomDraft): { x: number; z: number }[] | null {
  if (room.floorPolygonM && room.floorPolygonM.length >= 3) {
    return room.floorPolygonM;
  }
  const measured =
    Number(room.walls[0]?.lengthM) > 0 && Number(room.walls[1]?.lengthM) > 0;
  if (!measured) return null;
  const { widthM, lengthM } = roomFootprint(room);
  if (!(widthM > 0) || !(lengthM > 0)) return null;
  return [
    { x: 0, z: 0 },
    { x: widthM, z: 0 },
    { x: widthM, z: lengthM },
    { x: 0, z: lengthM },
  ];
}

export default function RoomsSoFar({
  rooms,
  placements,
  highlightRoomId,
  height = 72,
}: Props) {
  /*
   * Place each room, then fit the lot into the box.
   *
   * Two sources of position, and the real one wins. A room the
   * customer has already put on the plan is drawn where they put it,
   * so the strip turns into an actual plan as the survey goes on.
   * Everything else is packed left to right with a half-metre gap,
   * in the order it was measured — which is not where the rooms are,
   * and is why this is labelled "rooms" and not "plan".
   */
  let cursor = 0;
  const placed = rooms
    .map((room) => {
      const local = outlineOf(room);
      if (!local) return null;

      const p = placements?.[room.id];
      if (p?.positionM) {
        return {
          id: room.id,
          pts: local.map((pt) => {
            const r = rotatePointM(pt, p.rotationDeg ?? 0);
            return { x: p.positionM!.x + r.x, z: p.positionM!.z + r.z };
          }),
        };
      }

      const { widthM } = roomFootprint(room);
      const offset = cursor;
      cursor += widthM + 0.5;
      return {
        id: room.id,
        pts: local.map((pt) => ({ x: offset + pt.x, z: pt.z })),
      };
    })
    .filter((r): r is { id: string; pts: { x: number; z: number }[] } => r !== null);

  if (placed.length === 0) return null;

  const all = placed.flatMap((r) => r.pts);
  const minX = Math.min(...all.map((p) => p.x));
  const maxX = Math.max(...all.map((p) => p.x));
  const minZ = Math.min(...all.map((p) => p.z));
  const maxZ = Math.max(...all.map((p) => p.z));
  const w = maxX - minX;
  const h = maxZ - minZ;
  if (!(w > 0) || !(h > 0)) return null;

  /*
   * One scale for every room, which is the whole point.
   *
   * Scaling each room to fit its own space would draw a cupboard the
   * same size as a lounge and quietly tell the customer something
   * false about their house. The rooms are in metres; they stay in
   * proportion to each other.
   */
  const box = { w: 640, h: height * (640 / 640) };
  const pad = 4;
  const scale = Math.min((box.w - pad * 2) / w, (height - pad * 2) / h);
  const offX = pad + (box.w - pad * 2 - w * scale) / 2;
  const offZ = pad + (height - pad * 2 - h * scale) / 2;

  const path = (pts: { x: number; z: number }[]) =>
    pts
      .map((p, i) => {
        const x = offX + (p.x - minX) * scale;
        const z = offZ + (p.z - minZ) * scale;
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${z.toFixed(1)}`;
      })
      .join(" ") + " Z";

  const done = placed.length;

  return (
    <div className="border-t border-outline-variant/30 pt-2">
      <svg
        viewBox={`0 0 ${box.w} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={`${done} room${done === 1 ? "" : "s"} measured so far`}
        className="block"
      >
        {placed.map((r) => {
          const isLatest = r.id === highlightRoomId;
          return (
            <path
              key={r.id}
              d={path(r.pts)}
              // The room just finished is filled a little stronger,
              // so the customer sees their own contribution land
              // rather than hunting for what changed.
              fill={
                isLatest ? "rgba(241,91,34,0.22)" : "rgba(241,91,34,0.10)"
              }
              stroke="#f15b22"
              strokeWidth={isLatest ? 1.6 : 1.1}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
      </svg>
      <p className="mt-1 text-sm text-on-surface-variant">
        {done} room{done === 1 ? "" : "s"} measured
      </p>
    </div>
  );
}
