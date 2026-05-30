"use client";

/**
 * FloorPlanEditor — drag-and-drop floor plan canvas.
 *
 * Lets the customer arrange their rooms into a real house layout:
 *   • Rooms are scaled rectangles; size comes from RoomDraft.walls[0] × [1].
 *   • Drag to reposition (snap to 0.25 m grid).
 *   • Tap the ↻ chip to rotate in 90° steps about the top-left anchor.
 *   • Tap the 🗑 chip to send the room back to the palette (unplaced).
 *   • Floor tabs across the top let the customer split across storeys.
 *   • Unplaced rooms for the current floor sit in a palette below the
 *     canvas; tap a pill to drop it at the floor's origin, then drag
 *     it into place.
 *
 * Implementation notes
 * ──────────────────────────────────────────────────────────────────
 * • The SVG viewBox is declared in METRES, so a `<rect width="3">`
 *   really does mean 3 m wide. Grid step is 0.25 m.
 * • Strokes use `vector-effect: non-scaling-stroke` so lines stay
 *   crisp regardless of zoom.
 * • Pointer math uses the SVG's screen CTM — works for mouse, touch,
 *   stylus, uniformly. `touch-action: none` on the canvas prevents
 *   mobile scroll from eating drag gestures.
 * • No external libraries (no react-dnd, no d3) — just SVG + pointer
 *   events, so the component works identically in Next and Capacitor.
 */

import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  GRID_STEP_M,
  autoLayoutRooms,
  floorExtents,
  floorLabel,
  floorsInUse,
  roomBoundingBox,
  roomFootprint,
  sanitisePlacement,
  snapToGrid,
  type RoomDraft,
  type RoomPlacement,
  type RoomRotationDeg,
} from "@tm-designs/measure-core";

const GOLD = "#b89650";
const CREAM = "#fcf9f5";
const DARK = "#1c1c1a";
/** Minimum visible viewBox in metres so a single small room isn't tiny. */
const MIN_VIEW_M = 10;
/** Padding around placed rooms for the auto-fit viewBox, in metres. */
const VIEW_PAD_M = 2;

export type FloorPlanEditorProps = {
  rooms: RoomDraft[];
  /**
   * External placement state, keyed by roomId. The form owns this so
   * it can include it in the submission payload. If a room has no
   * entry here, it's treated as unplaced on the ground floor.
   */
  placements: Record<string, RoomPlacement>;
  onPlacementChange: (roomId: string, placement: RoomPlacement) => void;
};

/** Default placement for a room whose entry is missing from the map. */
function defaultPlacement(floor: number = 0): RoomPlacement {
  return { positionM: null, rotationDeg: 0, floor };
}

export default function FloorPlanEditor({
  rooms,
  placements,
  onPlacementChange,
}: FloorPlanEditorProps) {
  /** Which floor is currently visible. */
  const [currentFloor, setCurrentFloor] = useState(0);
  /** Explicit list of floors user has created (so empty floors survive). */
  const [extraFloors, setExtraFloors] = useState<number[]>([]);
  /** Drag state for the currently-moving room. */
  const dragRef = useRef<{
    roomId: string;
    pointerId: number;
    startSvg: { x: number; z: number };
    startAnchor: { x: number; z: number };
  } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // ── Derived data ─────────────────────────────────────────────────
  const usedFloors = useMemo(() => {
    const fromRooms = floorsInUse(rooms);
    const all = new Set<number>([...fromRooms, ...extraFloors, currentFloor]);
    return [...all].sort((a, b) => a - b);
  }, [rooms, extraFloors, currentFloor]);

  const placementFor = useCallback(
    (roomId: string): RoomPlacement => placements[roomId] ?? defaultPlacement(0),
    [placements],
  );

  const roomsOnFloor = useMemo(
    () =>
      rooms.filter((r) => placementFor(r.id).floor === currentFloor && placementFor(r.id).positionM),
    [rooms, placementFor, currentFloor],
  );

  const unplacedOnFloor = useMemo(
    () =>
      rooms.filter((r) => {
        const p = placementFor(r.id);
        return p.floor === currentFloor && !p.positionM;
      }),
    [rooms, placementFor, currentFloor],
  );

  // Auto-fit viewBox around placed rooms + padding. Min 10×10 m.
  const viewBox = useMemo(() => {
    const bboxes = roomsOnFloor.map((r) => {
      const p = placementFor(r.id);
      const size = roomFootprint(r);
      return { anchor: p.positionM!, size, rotationDeg: p.rotationDeg };
    });
    const ex = floorExtents(bboxes);
    if (!ex) {
      return { x: -MIN_VIEW_M / 2, z: -MIN_VIEW_M / 2, w: MIN_VIEW_M, h: MIN_VIEW_M };
    }
    const x = ex.minX - VIEW_PAD_M;
    const z = ex.minZ - VIEW_PAD_M;
    const w = Math.max(MIN_VIEW_M, ex.maxX - ex.minX + VIEW_PAD_M * 2);
    const h = Math.max(MIN_VIEW_M, ex.maxZ - ex.minZ + VIEW_PAD_M * 2);
    return { x, z, w, h };
  }, [roomsOnFloor, placementFor]);

  // ── Pointer → SVG-coord helper (SVG units are metres) ────────────
  const svgCoordsFromEvent = useCallback(
    (e: ReactPointerEvent): { x: number; z: number } | null => {
      const svg = svgRef.current;
      if (!svg) return null;
      const ctm = svg.getScreenCTM();
      if (!ctm) return null;
      const pt = svg.createSVGPoint();
      pt.x = e.clientX;
      pt.y = e.clientY;
      const t = pt.matrixTransform(ctm.inverse());
      return { x: t.x, z: t.y };
    },
    [],
  );

  // ── Room-level interactions ──────────────────────────────────────
  const onRoomPointerDown = useCallback(
    (roomId: string, e: ReactPointerEvent) => {
      const p = placementFor(roomId);
      if (!p.positionM) return;
      const svg = svgCoordsFromEvent(e);
      if (!svg) return;
      dragRef.current = {
        roomId,
        pointerId: e.pointerId,
        startSvg: svg,
        startAnchor: { x: p.positionM.x, z: p.positionM.z },
      };
      (e.currentTarget as SVGElement).setPointerCapture(e.pointerId);
    },
    [placementFor, svgCoordsFromEvent],
  );

  const onRoomPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const st = dragRef.current;
      if (!st || st.pointerId !== e.pointerId) return;
      const svg = svgCoordsFromEvent(e);
      if (!svg) return;
      const dx = svg.x - st.startSvg.x;
      const dz = svg.z - st.startSvg.z;
      const raw = {
        x: st.startAnchor.x + dx,
        z: st.startAnchor.z + dz,
      };
      const snapped = sanitisePlacement(raw);
      onPlacementChange(st.roomId, {
        ...placementFor(st.roomId),
        positionM: snapped,
      });
    },
    [onPlacementChange, placementFor, svgCoordsFromEvent],
  );

  const onRoomPointerUp = useCallback((e: ReactPointerEvent) => {
    const st = dragRef.current;
    if (!st || st.pointerId !== e.pointerId) return;
    dragRef.current = null;
    try {
      (e.currentTarget as SVGElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released — fine */
    }
  }, []);

  const rotateRoom = useCallback(
    (roomId: string) => {
      const p = placementFor(roomId);
      const nextDeg: RoomRotationDeg = (((p.rotationDeg + 90) % 360) as RoomRotationDeg);
      onPlacementChange(roomId, { ...p, rotationDeg: nextDeg });
    },
    [onPlacementChange, placementFor],
  );

  const unplaceRoom = useCallback(
    (roomId: string) => {
      const p = placementFor(roomId);
      onPlacementChange(roomId, { ...p, positionM: null });
    },
    [onPlacementChange, placementFor],
  );

  const placeRoomOnCurrentFloor = useCallback(
    (roomId: string) => {
      onPlacementChange(roomId, {
        ...placementFor(roomId),
        positionM: { x: 0, z: 0 },
        floor: currentFloor,
      });
    },
    [onPlacementChange, placementFor, currentFloor],
  );

  const moveRoomToFloor = useCallback(
    (roomId: string, floor: number) => {
      onPlacementChange(roomId, { ...placementFor(roomId), floor });
    },
    [onPlacementChange, placementFor],
  );

  // ── Floor tab interactions ───────────────────────────────────────
  const addFloor = useCallback(() => {
    const maxFloor = Math.max(0, ...usedFloors);
    const next = maxFloor + 1;
    setExtraFloors((prev) => [...prev, next]);
    setCurrentFloor(next);
  }, [usedFloors]);

  const addBasement = useCallback(() => {
    const minFloor = Math.min(0, ...usedFloors);
    const next = minFloor - 1;
    setExtraFloors((prev) => [...prev, next]);
    setCurrentFloor(next);
  }, [usedFloors]);

  const applyAutoLayout = useCallback(() => {
    const seed = autoLayoutRooms(
      rooms.filter((r) => placementFor(r.id).floor === currentFloor),
    );
    for (const [id, placement] of seed.entries()) {
      onPlacementChange(id, placement);
    }
  }, [rooms, placementFor, currentFloor, onPlacementChange]);

  const clearFloor = useCallback(() => {
    for (const r of rooms) {
      const p = placementFor(r.id);
      if (p.floor === currentFloor && p.positionM) {
        onPlacementChange(r.id, { ...p, positionM: null });
      }
    }
  }, [rooms, placementFor, currentFloor, onPlacementChange]);

  // ── Render ───────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-3">
      {/* Floor tabs */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
          Floor
        </span>
        {usedFloors.map((f) => {
          const active = f === currentFloor;
          return (
            <button
              key={f}
              type="button"
              onClick={() => setCurrentFloor(f)}
              className="rounded-full border px-3 py-1 text-xs font-semibold transition"
              style={{
                borderColor: active ? GOLD : "#d9d3c8",
                backgroundColor: active ? GOLD : "transparent",
                color: active ? DARK : "#5a5750",
              }}
            >
              {floorLabel(f)}
            </button>
          );
        })}
        <button
          type="button"
          onClick={addFloor}
          className="rounded-full border border-dashed border-[#b89650]/60 px-3 py-1 text-xs font-semibold text-[#8a6f2f]"
        >
          + Floor up
        </button>
        <button
          type="button"
          onClick={addBasement}
          className="rounded-full border border-dashed border-[#b89650]/60 px-3 py-1 text-xs font-semibold text-[#8a6f2f]"
        >
          + Basement
        </button>
      </div>

      {/* Canvas */}
      <div
        className="relative overflow-hidden rounded-xl border border-[#d9d3c8]"
        style={{ backgroundColor: CREAM, minHeight: 360 }}
      >
        <svg
          ref={svgRef}
          viewBox={`${viewBox.x} ${viewBox.z} ${viewBox.w} ${viewBox.h}`}
          preserveAspectRatio="xMidYMid meet"
          className="block h-[420px] w-full"
          style={{ touchAction: "none", userSelect: "none" }}
          aria-label={`Floor plan editor for ${floorLabel(currentFloor)}`}
        >
          <defs>
            <pattern
              id="fpe-grid-minor"
              width={GRID_STEP_M}
              height={GRID_STEP_M}
              patternUnits="userSpaceOnUse"
            >
              <path
                d={`M ${GRID_STEP_M} 0 L 0 0 0 ${GRID_STEP_M}`}
                fill="none"
                stroke="#e6dfd0"
                strokeWidth={0.5}
                vectorEffect="non-scaling-stroke"
              />
            </pattern>
            <pattern
              id="fpe-grid-major"
              width={1}
              height={1}
              patternUnits="userSpaceOnUse"
            >
              <rect width={1} height={1} fill="url(#fpe-grid-minor)" />
              <path
                d={`M 1 0 L 0 0 0 1`}
                fill="none"
                stroke="#c9c0ab"
                strokeWidth={0.8}
                vectorEffect="non-scaling-stroke"
              />
            </pattern>
          </defs>

          {/* Grid backdrop, sized to match viewBox */}
          <rect
            x={viewBox.x}
            y={viewBox.z}
            width={viewBox.w}
            height={viewBox.h}
            fill="url(#fpe-grid-major)"
          />

          {/* Metre ruler — one mark per metre along top and left */}
          {Array.from({ length: Math.ceil(viewBox.w) + 1 }, (_, i) => {
            const x = Math.floor(viewBox.x) + i;
            return (
              <text
                key={`rx-${x}`}
                x={x + 0.05}
                y={viewBox.z + 0.6}
                fontSize={0.35}
                fill="#9a8f74"
              >
                {x}
              </text>
            );
          })}
          {Array.from({ length: Math.ceil(viewBox.h) + 1 }, (_, i) => {
            const z = Math.floor(viewBox.z) + i;
            return (
              <text
                key={`rz-${z}`}
                x={viewBox.x + 0.1}
                y={z + 0.35}
                fontSize={0.35}
                fill="#9a8f74"
              >
                {z}
              </text>
            );
          })}

          {/* Room rectangles */}
          {roomsOnFloor.map((r) => {
            const p = placementFor(r.id);
            if (!p.positionM) return null;
            const size = roomFootprint(r);
            // SVG rotation rotates about the origin; we translate so
            // the room's top-left anchor lands at positionM then rotate
            // about that anchor (rotationDeg, 0 0).
            const transform = `translate(${p.positionM.x} ${p.positionM.z}) rotate(${p.rotationDeg} 0 0)`;
            return (
              <g key={r.id} transform={transform}>
                <rect
                  x={0}
                  y={0}
                  width={size.widthM}
                  height={size.lengthM}
                  fill="#fff8ea"
                  fillOpacity={0.92}
                  stroke={GOLD}
                  strokeWidth={1.6}
                  vectorEffect="non-scaling-stroke"
                  rx={0.05}
                  style={{ cursor: "grab" }}
                  onPointerDown={(e) => onRoomPointerDown(r.id, e)}
                  onPointerMove={onRoomPointerMove}
                  onPointerUp={onRoomPointerUp}
                  onPointerCancel={onRoomPointerUp}
                />
                <text
                  x={size.widthM / 2}
                  y={size.lengthM / 2 - 0.05}
                  fontSize={0.42}
                  fill={DARK}
                  fontWeight={600}
                  textAnchor="middle"
                  pointerEvents="none"
                >
                  {r.name || "Room"}
                </text>
                <text
                  x={size.widthM / 2}
                  y={size.lengthM / 2 + 0.45}
                  fontSize={0.3}
                  fill="#6e6a5f"
                  textAnchor="middle"
                  pointerEvents="none"
                >
                  {size.widthM.toFixed(2)} × {size.lengthM.toFixed(2)} m
                </text>

                {/* Rotate chip — top-right of the unrotated rectangle */}
                <g
                  transform={`translate(${size.widthM - 0.4} 0.4)`}
                  style={{ cursor: "pointer" }}
                  onClick={(e) => {
                    e.stopPropagation();
                    rotateRoom(r.id);
                  }}
                >
                  <circle r={0.3} fill={DARK} />
                  <text
                    x={0}
                    y={0.1}
                    fontSize={0.35}
                    textAnchor="middle"
                    fill={CREAM}
                  >
                    ↻
                  </text>
                </g>

                {/* Unplace chip — bottom-right */}
                <g
                  transform={`translate(${size.widthM - 0.4} ${size.lengthM - 0.4})`}
                  style={{ cursor: "pointer" }}
                  onClick={(e) => {
                    e.stopPropagation();
                    unplaceRoom(r.id);
                  }}
                >
                  <circle r={0.3} fill="#8a2f2f" />
                  <text
                    x={0}
                    y={0.1}
                    fontSize={0.35}
                    textAnchor="middle"
                    fill={CREAM}
                  >
                    ×
                  </text>
                </g>
              </g>
            );
          })}
        </svg>

        {roomsOnFloor.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <p className="rounded-lg bg-white/80 px-4 py-2 text-xs font-semibold text-[#6e6a5f] shadow-sm">
              Tap a room below to place it on {floorLabel(currentFloor)}.
            </p>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button
          type="button"
          onClick={applyAutoLayout}
          className="rounded-full border border-[#b89650] px-3 py-1 font-semibold text-[#8a6f2f]"
        >
          Auto-layout this floor
        </button>
        <button
          type="button"
          onClick={clearFloor}
          className="rounded-full border border-[#d9d3c8] px-3 py-1 font-semibold text-[#6e6a5f]"
        >
          Clear layout
        </button>
        <span className="text-[11px] text-on-surface-variant">
          Grid = 25 cm · drag rooms · ↻ rotates 90° · × removes from plan
        </span>
      </div>

      {/* Palette of unplaced rooms on current floor */}
      <div
        className="rounded-lg border border-dashed border-[#d9d3c8] p-3"
        style={{ backgroundColor: "#fffdf8" }}
      >
        <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
          Rooms to place on {floorLabel(currentFloor)}
        </p>
        {unplacedOnFloor.length === 0 ? (
          <p className="text-xs text-on-surface-variant">
            All rooms on this floor are placed. Switch floors or add a new one above.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {unplacedOnFloor.map((r) => {
              const size = roomFootprint(r);
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => placeRoomOnCurrentFloor(r.id)}
                  className="rounded-lg border border-[#b89650] bg-white px-3 py-2 text-left text-xs font-semibold text-[#1c1c1a] shadow-sm transition hover:bg-[#fff8ea]"
                >
                  <span className="block">{r.name || "Room"}</span>
                  <span className="text-[10px] font-normal text-[#6e6a5f]">
                    {size.widthM.toFixed(2)} × {size.lengthM.toFixed(2)} m
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Rooms on other floors — quick floor-move affordance */}
      {rooms.some((r) => placementFor(r.id).floor !== currentFloor) && (
        <details className="rounded-lg border border-[#e6dfd0] p-3 text-xs">
          <summary className="cursor-pointer font-semibold text-[#6e6a5f]">
            Rooms on other floors ({rooms.filter((r) => placementFor(r.id).floor !== currentFloor).length})
          </summary>
          <div className="mt-2 flex flex-wrap gap-2">
            {rooms
              .filter((r) => placementFor(r.id).floor !== currentFloor)
              .map((r) => {
                const p = placementFor(r.id);
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => moveRoomToFloor(r.id, currentFloor)}
                    className="rounded-lg border border-[#d9d3c8] bg-white px-3 py-1.5 text-left text-[11px] font-semibold text-[#1c1c1a]"
                    title={`Currently on ${floorLabel(p.floor)} — click to move here`}
                  >
                    {r.name || "Room"}
                    <span className="ml-1 text-[10px] font-normal text-[#8a6f2f]">
                      ({floorLabel(p.floor)} → {floorLabel(currentFloor)})
                    </span>
                  </button>
                );
              })}
          </div>
        </details>
      )}
    </div>
  );
}

// Keep helpers reachable from parent without a second import — barrel
// exports from the form side can import { snapToGrid, roomFootprint }
// from here if needed.
export { snapToGrid, roomFootprint };
