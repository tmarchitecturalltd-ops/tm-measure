"use client";

/**
 * components/measure/CustomShapeEditor.tsx
 *
 * Tap-to-trace polygon editor for rooms whose shape isn't a
 * rectangle or a simple L. The customer:
 *
 *   1. Enters the overall bounding box (width × length) so the
 *      polygon has real-world units.
 *   2. Taps each corner in order on the SVG canvas.
 *   3. Hits "Close shape" to seal the polygon — it then renders on
 *      the floor plan canvas at scale alongside any rectangular
 *      rooms in the project.
 *
 * The polygon is stored as an array of `{ x, z }` metre points and
 * fed into `RoomDraft.floorPolygonM`. Rendering is handled inside
 * FloorPlanEditor + the Apps Script email SVG.
 */

import { useMemo, useState } from "react";
import type { RoomDraft } from "@tm-designs/measure-core";

const GOLD = "#b89650";
const DARK = "#1c1c1a";
const CANVAS_PX = 300; // SVG viewport edge

export type CustomShapeEditorProps = {
  room: RoomDraft;
  /** Setter that mutates the room — uses the form's shared setter. */
  onPatch: (patch: Partial<RoomDraft>) => void;
};

export default function CustomShapeEditor({ room, onPatch }: CustomShapeEditorProps) {
  const polygon = room.floorPolygonM ?? [];
  const [bboxWidthM, setBboxWidthM] = useState<string>(
    room.notchWidthM ?? "5",
  );
  const [bboxLengthM, setBboxLengthM] = useState<string>(
    room.notchLengthM ?? "5",
  );
  const w = Math.max(0.5, parseFloat(bboxWidthM) || 5);
  const h = Math.max(0.5, parseFloat(bboxLengthM) || 5);

  const scale = useMemo(() => CANVAS_PX / Math.max(w, h), [w, h]);

  const handleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    // The SVG is styled maxWidth:100%/height:auto, so on a phone it
    // renders narrower than CANVAS_PX. `scale` is derived from
    // CANVAS_PX, so converting raw client pixels directly overstated
    // every coordinate by the ratio between nominal and rendered
    // width — custom shapes drawn on a phone came out too big.
    // Map into viewBox units first.
    const xPx = ((e.clientX - rect.left) * CANVAS_PX) / rect.width;
    const zPx = ((e.clientY - rect.top) * CANVAS_PX) / rect.height;
    // Snap to nearest 0.1 m so the architect doesn't end up with
    // wall lengths like 3.71234 m.
    const x = Math.round((xPx / scale) * 10) / 10;
    const z = Math.round((zPx / scale) * 10) / 10;
    onPatch({ floorPolygonM: [...polygon, { x, z }] });
  };

  const undoLast = () =>
    onPatch({ floorPolygonM: polygon.slice(0, -1) });

  const clearAll = () => onPatch({ floorPolygonM: [] });

  const pointsAttr = polygon
    .map((p) => `${p.x * scale},${p.z * scale}`)
    .join(" ");

  return (
    <div className="mt-3 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-on-surface-variant">
          Bounding width (m)
          <input
            inputMode="decimal"
            value={bboxWidthM}
            onChange={(e) => {
              setBboxWidthM(e.target.value);
              onPatch({ notchWidthM: e.target.value });
            }}
            placeholder="5.00"
            className="mt-1 w-full rounded border border-outline-variant/30 bg-surface px-3 py-2 text-sm"
          />
        </label>
        <label className="text-xs text-on-surface-variant">
          Bounding length (m)
          <input
            inputMode="decimal"
            value={bboxLengthM}
            onChange={(e) => {
              setBboxLengthM(e.target.value);
              onPatch({ notchLengthM: e.target.value });
            }}
            placeholder="5.00"
            className="mt-1 w-full rounded border border-outline-variant/30 bg-surface px-3 py-2 text-sm"
          />
        </label>
      </div>

      <p className="text-[11px] text-on-surface-variant">
        Tap inside the box to place each corner of the room in order
        (clockwise or anti-clockwise, doesn&apos;t matter). Hit Close
        shape when you&apos;re done. Snaps to 10 cm.
      </p>

      <div
        className="rounded-md border border-outline-variant/30 bg-surface-container-lowest p-2"
        style={{ width: CANVAS_PX + 16, maxWidth: "100%" }}
      >
        <svg
          width={CANVAS_PX}
          height={CANVAS_PX}
          viewBox={`0 0 ${CANVAS_PX} ${CANVAS_PX}`}
          onClick={handleClick}
          style={{ cursor: "crosshair", maxWidth: "100%", height: "auto" }}
          role="img"
          aria-label="Tap to place room corners"
        >
          {/* Soft grid in metres */}
          {Array.from({ length: Math.ceil(w) + 1 }).map((_, i) => (
            <line
              key={`vx-${i}`}
              x1={i * scale}
              y1={0}
              x2={i * scale}
              y2={CANVAS_PX}
              stroke="#ebe5d3"
              strokeWidth={1}
            />
          ))}
          {Array.from({ length: Math.ceil(h) + 1 }).map((_, i) => (
            <line
              key={`hz-${i}`}
              x1={0}
              y1={i * scale}
              x2={CANVAS_PX}
              y2={i * scale}
              stroke="#ebe5d3"
              strokeWidth={1}
            />
          ))}
          {/* Polygon fill — auto-closes for preview */}
          {polygon.length >= 3 && (
            <polygon
              points={pointsAttr}
              fill="#fff8ea"
              fillOpacity={0.85}
              stroke={GOLD}
              strokeWidth={1.5}
            />
          )}
          {polygon.length === 2 && (
            <polyline
              points={pointsAttr}
              fill="none"
              stroke={GOLD}
              strokeWidth={1.5}
            />
          )}
          {polygon.map((p, i) => (
            <g key={`pt-${i}`}>
              <circle
                cx={p.x * scale}
                cy={p.z * scale}
                r={4}
                fill={GOLD}
                stroke={DARK}
                strokeWidth={1}
              />
              <text
                x={p.x * scale + 6}
                y={p.z * scale - 6}
                fontSize={11}
                fill={DARK}
              >
                {i + 1}
              </text>
            </g>
          ))}
        </svg>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={undoLast}
          disabled={!polygon.length}
          className="rounded-full border border-outline-variant/40 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-on-surface disabled:opacity-40"
        >
          Undo last
        </button>
        <button
          type="button"
          onClick={clearAll}
          disabled={!polygon.length}
          className="rounded-full border border-outline-variant/40 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-on-surface disabled:opacity-40"
        >
          Clear all
        </button>
        <span className="rounded-full bg-surface-container-high px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
          {polygon.length} corner{polygon.length === 1 ? "" : "s"}
        </span>
      </div>
    </div>
  );
}
