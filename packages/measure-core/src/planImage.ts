/**
 * The plan, as a picture anyone can look at.
 *
 * The submission email lists every room as wall lengths: "Wall 1
 * 5.50 m, Wall 2 3.91 m, Wall 3 2.01 m…". That is the whole survey
 * and it is unreadable — "this doesn't mean a lot as we can't
 * visualise it". Nine numbers do not add up to a nine-sided room in
 * anybody's head, and the DXF is a link that has to be downloaded
 * and opened in CAD before the person reading the email knows
 * whether the survey is worth anything.
 *
 * So the email carries a drawing. Same geometry as the DXF, drawn
 * small: outlines, room names, floor areas, wall dimensions, and
 * the openings marked.
 *
 * An SVG string, because that is what the app can hand to a canvas
 * to turn into a PNG. It cannot stay an SVG: Gmail strips inline
 * `<svg>` entirely, which is why the email already had a plan in it
 * that nobody has ever seen.
 */

import type { Pt } from "./splitRooms.ts";
import type { RoomDraft, Opening } from "./types.ts";
import {
  roomOutlineM,
  squareRoomsForDrawing,
  squareToSheet,
  floorName,
  type PlanRoomInput,
} from "./dxfPlan.ts";
import { outlineAreaM2 } from "./scan.ts";

/** Pixels per metre. 36 puts a 10 m house in about 400px. */
const PX_PER_M = 36;
const PAD_PX = 56;

const ink = "#1c1c1a";
const label = "#4d4639";
const gold = "#b89650";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The opening's centre along its wall, as a world point. */
function openingCentre(a: Pt, b: Pt, o: Opening): Pt {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const pos = Number.parseFloat(o.positionM ?? "");
  const t =
    Number.isFinite(pos) && len > 0 ? Math.min(Math.max(pos / len, 0), 1) : 0.5;
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
}

/**
 * One storey, as an SVG string.
 *
 * Returns null when the storey has nothing on it, so a caller can
 * skip it rather than sending an empty frame.
 */
export function buildFloorSvg(
  entries: PlanRoomInput[],
  floor: number,
): string | null {
  const on = entries.filter((e) => (e.floor ?? 0) === floor && e.anchor);
  if (!on.length) return null;

  const outlines = on.map((e) => ({ entry: e, poly: roomOutlineM(e) }));
  const pts = outlines.flatMap((o) => o.poly);
  if (pts.length < 3) return null;

  const minX = Math.min(...pts.map((p) => p.x));
  const maxX = Math.max(...pts.map((p) => p.x));
  const minZ = Math.min(...pts.map((p) => p.z));
  const maxZ = Math.max(...pts.map((p) => p.z));

  const w = Math.round((maxX - minX) * PX_PER_M) + PAD_PX * 2;
  const h = Math.round((maxZ - minZ) * PX_PER_M) + PAD_PX * 2;
  const X = (x: number) => (x - minX) * PX_PER_M + PAD_PX;
  const Z = (z: number) => (z - minZ) * PX_PER_M + PAD_PX;

  const parts: string[] = [];
  /*
   * One number per wall, not one per room that touches it.
   *
   * Two rooms either side of a partition each label it, and the two
   * labels land in the same place reading the same figure, so the
   * drawing shows "3.10" printed over "3.10". Positions already
   * placed are remembered to a few pixels and a repeat is skipped.
   */
  const placedLabels: { x: number; z: number; text: string }[] = [];

  for (const { entry, poly } of outlines) {
    const d =
      poly
        .map((p, i) => `${i === 0 ? "M" : "L"}${X(p.x).toFixed(1)} ${Z(p.z).toFixed(1)}`)
        .join(" ") + " Z";
    parts.push(
      `<path d="${d}" fill="#ffffff" stroke="${ink}" stroke-width="2.5" stroke-linejoin="round"/>`,
    );

    /*
     * A length on every wall, which is the point of the picture.
     *
     * Written along the outside of the wall it measures, turned to
     * match it and flipped where it would otherwise read upside
     * down. Short walls -- a 150 mm return beside a chimney breast
     * -- are left unlabelled: the number would be wider than the
     * wall and would land on top of its neighbours.
     */
    for (let i = 0; i < poly.length; i += 1) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 0.6) continue;
      const cx = (a.x + b.x) / 2;
      const cz = (a.z + b.z) / 2;
      const ux = (b.x - a.x) / len;
      const uz = (b.z - a.z) / len;
      // Outward from the room's centre, so the label sits in the
      // space around the room rather than across its name.
      const rcx = poly.reduce((s, p) => s + p.x, 0) / poly.length;
      const rcz = poly.reduce((s, p) => s + p.z, 0) / poly.length;
      let nx = -uz;
      let nz = ux;
      if (nx * (cx - rcx) + nz * (cz - rcz) < 0) {
        nx = -nx;
        nz = -nz;
      }
      let deg = (Math.atan2(uz, ux) * 180) / Math.PI;
      if (deg > 90 || deg < -90) deg += 180;
      const tx = X(cx) + nx * 13;
      const tz = Z(cz) + nz * 13;
      const text = len.toFixed(2);
      /*
       * Compared at the wall, not at the label.
       *
       * Each room pushes its label away from its own centre, so the
       * two labels on a shared partition end up on opposite sides
       * of it -- 26 pixels apart, which no sane tolerance would
       * treat as the same spot, and which reads on the drawing as
       * one slightly thick number. The wall itself is in the same
       * place for both rooms, so that is what is remembered.
       */
      const keyX = X(cx);
      const keyZ = Z(cz);
      if (
        placedLabels.some(
          (l) =>
            l.text === text &&
            Math.abs(l.x - keyX) < 6 &&
            Math.abs(l.z - keyZ) < 6,
        )
      ) {
        continue;
      }
      placedLabels.push({ x: keyX, z: keyZ, text });
      parts.push(
        `<text x="${tx.toFixed(1)}" y="${tz.toFixed(1)}" fill="${label}" font-size="11" text-anchor="middle" dominant-baseline="middle" transform="rotate(${deg.toFixed(1)} ${tx.toFixed(1)} ${tz.toFixed(1)})">${text}</text>`,
      );
    }

    // Openings, as a gold run across the wall they sit in. Not drawn
    // as a proper reveal: at this size a door and its swing would be
    // three marks in four pixels.
    const openings: { o: Opening; door: boolean }[] = [
      ...(entry.room.doors ?? []).map((o) => ({ o, door: true })),
      ...(entry.room.windows ?? []).map((o) => ({ o, door: false })),
    ];
    for (const { o, door } of openings) {
      const wi = (o.wallIndex ?? 0) % poly.length;
      const a = poly[wi];
      const b = poly[(wi + 1) % poly.length];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 1e-6) continue;
      const width = Number.parseFloat(o.widthM);
      if (!Number.isFinite(width) || width <= 0) continue;
      const c = openingCentre(a, b, o);
      const ux = (b.x - a.x) / len;
      const uz = (b.z - a.z) / len;
      const half = Math.min(width, len) / 2;
      parts.push(
        `<line x1="${X(c.x - ux * half).toFixed(1)}" y1="${Z(c.z - uz * half).toFixed(1)}" x2="${X(c.x + ux * half).toFixed(1)}" y2="${Z(c.z + uz * half).toFixed(1)}" stroke="${door ? gold : "#6aa3d8"}" stroke-width="4" stroke-linecap="butt"/>`,
      );
    }

    const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length;
    const cz = poly.reduce((s, p) => s + p.z, 0) / poly.length;
    const area = outlineAreaM2(poly);
    const name = esc(entry.room.name?.trim() || "Room");

    /*
     * A name has to fit inside the room it names.
     *
     * "Hallway" at 14px is about 60 pixels wide, and a 1.2 m
     * hallway is 43. Written centred it ran out over the kitchen
     * next door, so the drawing showed one room's name across
     * another room's floor -- on the one picture whose job is to
     * say which room is which.
     *
     * A narrow room turns its name through a quarter turn, which is
     * how a plan labels a corridor anyway. If it does not fit that
     * way either the area is dropped first, since the shape already
     * shows roughly how big the room is and the name does not.
     */
    const pxW = (Math.max(...poly.map((p) => p.x)) - Math.min(...poly.map((p) => p.x))) * PX_PER_M;
    const pxH = (Math.max(...poly.map((p) => p.z)) - Math.min(...poly.map((p) => p.z))) * PX_PER_M;
    const needed = name.length * 7.5 + 8;
    const turned = needed > pxW - 8 && pxH > pxW;
    const fits = turned ? needed < pxH - 8 : needed < pxW - 8;
    const along = turned ? pxW : pxH;

    if (fits) {
      const rot = turned
        ? ` transform="rotate(-90 ${X(cx).toFixed(1)} ${Z(cz).toFixed(1)})"`
        : "";
      parts.push(
        `<text x="${X(cx).toFixed(1)}" y="${Z(cz).toFixed(1)}" fill="${ink}" font-size="13" font-weight="600" text-anchor="middle" dominant-baseline="middle"${rot}>${name}</text>`,
      );
      if (area > 0 && along > 34) {
        const ax = turned ? X(cx) + 15 : X(cx);
        const az = turned ? Z(cz) : Z(cz) + 15;
        const rotA = turned
          ? ` transform="rotate(-90 ${ax.toFixed(1)} ${az.toFixed(1)})"`
          : "";
        parts.push(
          `<text x="${ax.toFixed(1)}" y="${az.toFixed(1)}" fill="${label}" font-size="11" text-anchor="middle" dominant-baseline="middle"${rotA}>${area.toFixed(1)} m²</text>`,
        );
      }
    }
  }

  parts.push(
    `<text x="${PAD_PX}" y="${h - 18}" fill="${label}" font-size="13">${esc(floorName(floor))} — metres</text>`,
  );

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    `<rect width="${w}" height="${h}" fill="#fcf9f5"/>`,
    ...parts,
    "</svg>",
  ].join("");
}

/**
 * Every storey with something on it, squared up the way the DXF is.
 *
 * The same preparation as the drawing -- rooms right-angled, the
 * whole plan turned square to the page -- so the picture in the
 * email and the file the draughtsman opens are the same survey.
 * Storeys are not spread onto sheets here: each one is its own
 * image, which is the email's version of a page.
 */
export function buildPlanSvgs(
  entries: PlanRoomInput[],
): { floor: number; svg: string }[] {
  const prepared = squareToSheet(
    squareRoomsForDrawing(entries.filter((e) => e.anchor)),
  );
  const floors = [...new Set(prepared.map((e) => e.floor ?? 0))].sort(
    (a, b) => a - b,
  );
  const out: { floor: number; svg: string }[] = [];
  for (const floor of floors) {
    const svg = buildFloorSvg(prepared, floor);
    if (svg) out.push({ floor, svg });
  }
  return out;
}

export type { RoomDraft };
