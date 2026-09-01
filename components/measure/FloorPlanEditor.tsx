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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  FIXTURE_SIZES_M,
  fixtureFootprintM,
  type FixtureKind,
  type RoomDraft,
  type RoomFixture,
  type RoomPlacement,
  type RoomRotationDeg,
  type RoomStairs,
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
  /**
   * Write back to a room itself — fixtures and stairs live on the room,
   * not on its placement, because they stay with the room if it is
   * moved to another floor or re-placed.
   *
   * Optional so the editor still renders read-only wherever it is
   * embedded without an editing host.
   */
  onRoomChange?: (roomId: string, patch: Partial<RoomDraft>) => void;
};

/** Default placement for a room whose entry is missing from the map. */
function defaultPlacement(floor: number = 0): RoomPlacement {
  return { positionM: null, rotationDeg: 0, floor };
}

export default function FloorPlanEditor({
  rooms,
  placements,
  onPlacementChange,
  onRoomChange,
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
  /**
   * ViewBox held still for the duration of a drag.
   *
   * The viewBox auto-fits around the placed rooms, and a drag writes a
   * new position on every pointermove — so the extents changed, the
   * viewBox changed, and getScreenCTM then mapped the pointer through a
   * different scale than the one the drag started in. The room drifted
   * away from the finger, compounding the further it was dragged.
   *
   * Small layouts hid this because the view is pinned to MIN_VIEW_M
   * until the plan grows past it; any house-sized layout showed it.
   */
  const [frozenViewBox, setFrozenViewBox] = useState<{
    x: number;
    z: number;
    w: number;
    h: number;
  } | null>(null);

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

  /** What the SVG actually renders — held still mid-drag. */
  const activeViewBox = frozenViewBox ?? viewBox;

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

  /* ── Fixtures and stairs ────────────────────────────────────────
   *
   * Toilets, baths, kitchen units and radiators had no representation
   * anywhere in the app. A bathroom reached the draughtsman as a box
   * with a door in it, and the only evidence it contained a toilet was
   * whichever photo happened to catch one — so its position was
   * somebody's recollection. For a bathroom or a kitchen the fixture
   * layout is most of the design constraint.
   *
   * Placing works as arm-then-tap rather than drag-from-a-palette:
   * dragging a small icon from a list at the bottom of the screen into
   * a room at the top, on a phone, with one thumb, is a gesture that
   * fails more often than it works. Tap what you want, tap where it
   * goes.
   */
  const [tool, setTool] = useState<FixtureKind | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  /**
   * Pointer → room-local metres.
   *
   * Uses the CTM of the element the handler is bound to, which sits
   * inside the room's transform, so this already accounts for the
   * room's anchor and rotation. Doing the rotation arithmetic by hand
   * here would be a second implementation of `localToWorld` that could
   * disagree with the DXF's.
   */
  const localCoordsFromEvent = useCallback(
    (e: ReactPointerEvent): { x: number; z: number } | null => {
      const svg = svgRef.current;
      const el = e.currentTarget as SVGGraphicsElement;
      if (!svg || !el.getScreenCTM) return null;
      const ctm = el.getScreenCTM();
      if (!ctm) return null;
      const pt = svg.createSVGPoint();
      pt.x = e.clientX;
      pt.y = e.clientY;
      const t = pt.matrixTransform(ctm.inverse());
      return { x: t.x, z: t.y };
    },
    [],
  );

  /** Quarter-metre grid, matching how rooms snap. */
  const snapM = (v: number) => Math.round(v * 4) / 4;

  const addFixture = useCallback(
    (roomId: string, kind: FixtureKind, at: { x: number; z: number }) => {
      if (!onRoomChange) return;
      const room = rooms.find((r) => r.id === roomId);
      if (!room) return;
      const f: RoomFixture = {
        // crypto.randomUUID is unavailable on older WebViews, and an id
        // collision here silently merges two fixtures into one.
        id: `fx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        kind,
        positionM: { x: snapM(at.x), z: snapM(at.z) },
        rotationDeg: 0,
      };
      onRoomChange(roomId, { fixtures: [...(room.fixtures ?? []), f] });
      setSelected(f.id);
      // Disarm after one placement. Leaving the tool armed means the
      // next tap — very often an attempt to drag what was just placed —
      // drops a second toilet on top of the first.
      setTool(null);
    },
    [onRoomChange, rooms],
  );

  const patchFixture = useCallback(
    (roomId: string, fixtureId: string, patch: Partial<RoomFixture>) => {
      if (!onRoomChange) return;
      const room = rooms.find((r) => r.id === roomId);
      if (!room) return;
      onRoomChange(roomId, {
        fixtures: (room.fixtures ?? []).map((f) =>
          f.id === fixtureId ? { ...f, ...patch } : f,
        ),
      });
    },
    [onRoomChange, rooms],
  );

  const removeFixture = useCallback(
    (roomId: string, fixtureId: string) => {
      if (!onRoomChange) return;
      const room = rooms.find((r) => r.id === roomId);
      if (!room) return;
      onRoomChange(roomId, {
        fixtures: (room.fixtures ?? []).filter((f) => f.id !== fixtureId),
      });
      setSelected(null);
    },
    [onRoomChange, rooms],
  );

  /** Drag state for a fixture or a flight of stairs. */
  const itemDragRef = useRef<{
    kind: "fixture" | "stairs";
    roomId: string;
    itemId: string;
    pointerId: number;
    startLocal: { x: number; z: number };
    startPos: { x: number; z: number };
  } | null>(null);

  const onFixturePointerDown = useCallback(
    (roomId: string, f: RoomFixture, e: ReactPointerEvent) => {
      e.stopPropagation();
      const local = localCoordsFromEvent(e);
      if (!local) return;
      setSelected(f.id);
      itemDragRef.current = {
        kind: "fixture",
        roomId,
        itemId: f.id,
        pointerId: e.pointerId,
        startLocal: local,
        startPos: { ...f.positionM },
      };
      setFrozenViewBox(viewBox);
      (e.currentTarget as SVGElement).setPointerCapture(e.pointerId);
    },
    [localCoordsFromEvent, viewBox],
  );

  /**
   * Move a flight of stairs by dropping a point in the room.
   *
   * Stairs are stored as "which wall, and how far along it" rather than
   * as a free x/z, because that is how a staircase is actually built
   * and how the DXF draws it. So a drag does not set a position — it
   * finds the nearest wall to where the finger ended up and the
   * distance along that wall, which lets the customer both slide a
   * flight along a wall and move it to a different one with the same
   * gesture.
   */
  const slideStairs = useCallback(
    (roomId: string, stairsId: string, at: { x: number; z: number }) => {
      if (!onRoomChange) return;
      const room = rooms.find((r) => r.id === roomId);
      if (!room) return;
      const size = roomFootprint(room);
      // Rectangle walls in local coords: 0 top, 1 right, 2 bottom, 3 left.
      const segs: [{ x: number; z: number }, { x: number; z: number }][] = [
        [{ x: 0, z: 0 }, { x: size.widthM, z: 0 }],
        [{ x: size.widthM, z: 0 }, { x: size.widthM, z: size.lengthM }],
        [{ x: size.widthM, z: size.lengthM }, { x: 0, z: size.lengthM }],
        [{ x: 0, z: size.lengthM }, { x: 0, z: 0 }],
      ];
      let best = { index: 0, dist: Infinity, along: 0 };
      segs.forEach(([a, b], i) => {
        const vx = b.x - a.x;
        const vz = b.z - a.z;
        const lenSq = vx * vx + vz * vz;
        if (lenSq === 0) return;
        const t = Math.min(
          1,
          Math.max(0, ((at.x - a.x) * vx + (at.z - a.z) * vz) / lenSq),
        );
        const px = a.x + vx * t;
        const pz = a.z + vz * t;
        const dist = Math.hypot(at.x - px, at.z - pz);
        if (dist < best.dist) {
          best = { index: i, dist, along: t * Math.sqrt(lenSq) };
        }
      });
      onRoomChange(roomId, {
        stairs: (room.stairs ?? []).map((s) =>
          s.id === stairsId
            ? {
                ...s,
                wallIndex: best.index,
                positionM: snapM(best.along).toFixed(2),
                // Dragging is not measuring. Same distinction the
                // opening picker makes, and for the same reason.
                positionApprox: true,
              }
            : s,
        ),
      });
    },
    [onRoomChange, rooms],
  );

  const onItemPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const st = itemDragRef.current;
      if (!st || st.pointerId !== e.pointerId) return;
      e.stopPropagation();
      const local = localCoordsFromEvent(e);
      if (!local) return;
      const next = {
        x: snapM(st.startPos.x + (local.x - st.startLocal.x)),
        z: snapM(st.startPos.z + (local.z - st.startLocal.z)),
      };
      if (st.kind === "fixture") {
        patchFixture(st.roomId, st.itemId, { positionM: next });
      } else {
        slideStairs(st.roomId, st.itemId, next);
      }
    },
    // slideStairs must be listed: it closes over `rooms`, so omitting it
    // leaves a drag started before a room was added writing back to the
    // room list as it was then, silently dropping the new room.
    [localCoordsFromEvent, patchFixture, slideStairs],
  );

  const onItemPointerUp = useCallback((e: ReactPointerEvent) => {
    const st = itemDragRef.current;
    if (!st || st.pointerId !== e.pointerId) return;
    e.stopPropagation();
    itemDragRef.current = null;
    setFrozenViewBox(null);
    try {
      (e.currentTarget as SVGElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  }, []);


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
      // Pin the frame the drag is measured in, so moving the room can't
      // rescale the canvas out from under the gesture.
      setFrozenViewBox(viewBox);
      (e.currentTarget as SVGElement).setPointerCapture(e.pointerId);
    },
    [placementFor, svgCoordsFromEvent, viewBox],
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
    // Release the frame; the view re-fits to wherever things ended up.
    setFrozenViewBox(null);
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
      // Every room used to land on the origin, so placing a second one
      // dropped it exactly on top of the first. Only the topmost is
      // hittable, which made the rooms underneath look like they had
      // vanished. Seed each new room clear of what is already down;
      // the customer then drags it where it belongs.
      const existing = roomsOnFloor.map((r) => {
        const p = placementFor(r.id);
        return {
          anchor: p.positionM!,
          size: roomFootprint(r),
          rotationDeg: p.rotationDeg,
        };
      });
      const ex = floorExtents(existing);
      const seed = ex
        ? { x: ex.maxX + GRID_STEP_M * 2, z: ex.minZ }
        : { x: 0, z: 0 };
      onPlacementChange(roomId, {
        ...placementFor(roomId),
        positionM: sanitisePlacement(seed),
        floor: currentFloor,
      });
    },
    [onPlacementChange, placementFor, currentFloor, roomsOnFloor],
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

  /**
   * Lay the floor out automatically the first time it has rooms but no
   * placements.
   *
   * Dragging rectangles around a plan with a fingertip is the hardest
   * thing this app asks of anyone, and it was the *first* thing it
   * asked. Seeding a layout from the room list turns that into
   * nudging something that already looks roughly right — which most
   * people will not need to do at all.
   *
   * Only when nothing on this floor is placed, so it can never move a
   * room the customer positioned themselves. `laidOut` guards against
   * re-seeding after they deliberately clear the floor.
   */
  const laidOut = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (laidOut.current.has(currentFloor)) return;
    const onFloor = rooms.filter((r) => placementFor(r.id).floor === currentFloor);
    if (!onFloor.length) return;
    if (onFloor.some((r) => placementFor(r.id).positionM)) {
      laidOut.current.add(currentFloor);
      return;
    }
    laidOut.current.add(currentFloor);
    const seed = autoLayoutRooms(onFloor);
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
        <span className="text-sm font-bold uppercase tracking-[0.2em] text-on-surface-variant">
          Floor
        </span>
        {usedFloors.map((f) => {
          const active = f === currentFloor;
          return (
            <button
              key={f}
              type="button"
              onClick={() => setCurrentFloor(f)}
              className="rounded-full border px-3 py-1 text-sm font-semibold transition"
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
          className="rounded-full border border-dashed border-[#b89650]/60 px-3 py-1 text-sm font-semibold text-[#8a6f2f]"
        >
          + Floor up
        </button>
        <button
          type="button"
          onClick={addBasement}
          className="rounded-full border border-dashed border-[#b89650]/60 px-3 py-1 text-sm font-semibold text-[#8a6f2f]"
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
          viewBox={`${activeViewBox.x} ${activeViewBox.z} ${activeViewBox.w} ${activeViewBox.h}`}
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

          {/* Room shapes — rectangle by default; L-shape carves a
              corner notch from the bottom-right of the bounding box. */}
          {roomsOnFloor.map((r) => {
            const p = placementFor(r.id);
            if (!p.positionM) return null;
            const size = roomFootprint(r);
            const transform = `translate(${p.positionM.x} ${p.positionM.z}) rotate(${p.rotationDeg} 0 0)`;
            const w = size.widthM;
            const h = size.lengthM;
            // Build the floor polygon path. Rectangle: 4 corners.
            // L-shape: 6 corners with the bite taken from (w, h).
            let pathD = `M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z`;
            if (r.shape === "l-shape") {
              const nw = Math.min(parseFloat(r.notchWidthM ?? "0") || 0, w * 0.95);
              const nl = Math.min(parseFloat(r.notchLengthM ?? "0") || 0, h * 0.95);
              if (nw > 0 && nl > 0) {
                pathD =
                  `M 0 0 L ${w} 0 L ${w} ${h - nl} ` +
                  `L ${w - nw} ${h - nl} L ${w - nw} ${h} L 0 ${h} Z`;
              }
            } else if (r.shape === "custom" && r.floorPolygonM && r.floorPolygonM.length >= 3) {
              // Custom polygon traced on CustomShapeEditor. Points are
              // already in metres relative to the room's bounding box.
              pathD = r.floorPolygonM
                .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.z}`)
                .join(" ") + " Z";
            }
            return (
              <g key={r.id} transform={transform}>
                <path
                  d={pathD}
                  fill="#fff8ea"
                  fillOpacity={0.92}
                  stroke={GOLD}
                  strokeWidth={1.6}
                  vectorEffect="non-scaling-stroke"
                  style={{ cursor: tool ? "copy" : "grab" }}
                  onPointerDown={(e) => {
                    // With a tool armed the room body is a drop target,
                    // not a handle. Dragging the room while trying to
                    // place a toilet in it would be maddening.
                    if (tool) return;
                    onRoomPointerDown(r.id, e);
                  }}
                  onPointerMove={onRoomPointerMove}
                  onPointerUp={onRoomPointerUp}
                  onPointerCancel={onRoomPointerUp}
                  onClick={(e) => {
                    if (!tool) {
                      setSelected(null);
                      return;
                    }
                    const el = e.currentTarget as SVGGraphicsElement;
                    const ctm = el.getScreenCTM();
                    const svgEl = svgRef.current;
                    if (!ctm || !svgEl) return;
                    const pt = svgEl.createSVGPoint();
                    pt.x = e.clientX;
                    pt.y = e.clientY;
                    const t = pt.matrixTransform(ctm.inverse());
                    addFixture(r.id, tool, { x: t.x, z: t.y });
                  }}
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

                {/* Door / window tick marks. We map each opening to
                    its parent wall (0 = top, 1 = right, 2 = bottom,
                    3 = left in the rectangle's local frame) and draw a
                    short coloured segment at the offset along that
                    wall. Doors are gold-on-cream, windows are slate. */}
                {[
                  ...(r.doors || []).map((d) => ({ ...d, kind: "door" as const })),
                  ...(r.windows || []).map((wn) => ({ ...wn, kind: "window" as const })),
                ].map((op, oi) => {
                  const widthM = parseFloat(op.widthM) || 0;
                  if (widthM <= 0) return null;
                  const wallIndex = op.wallIndex ?? 0;
                  const offset = parseFloat(op.positionM ?? "") ;
                  // Resolve wall start/end points in the local frame.
                  let x1 = 0, y1 = 0, x2 = 0, y2 = 0;
                  if (wallIndex % 4 === 0) {
                    // Top wall — runs left to right at y=0
                    x1 = 0; y1 = 0; x2 = w; y2 = 0;
                  } else if (wallIndex % 4 === 1) {
                    x1 = w; y1 = 0; x2 = w; y2 = h;
                  } else if (wallIndex % 4 === 2) {
                    x1 = w; y1 = h; x2 = 0; y2 = h;
                  } else {
                    x1 = 0; y1 = h; x2 = 0; y2 = 0;
                  }
                  const wallLen = Math.hypot(x2 - x1, y2 - y1);
                  const centre = Number.isFinite(offset) && offset > 0 ? offset : wallLen / 2;
                  const t1 = Math.max(0, centre - widthM / 2) / wallLen;
                  const t2 = Math.min(wallLen, centre + widthM / 2) / wallLen;
                  const px1 = x1 + (x2 - x1) * t1;
                  const py1 = y1 + (y2 - y1) * t1;
                  const px2 = x1 + (x2 - x1) * t2;
                  const py2 = y1 + (y2 - y1) * t2;
                  const colour = op.kind === "door" ? "#b89650" : "#5a6a80";
                  return (
                    <line
                      key={`op-${oi}`}
                      x1={px1}
                      y1={py1}
                      x2={px2}
                      y2={py2}
                      stroke={colour}
                      strokeWidth={4}
                      vectorEffect="non-scaling-stroke"
                      pointerEvents="none"
                    />
                  );
                })}

                {/* ── Stairs ───────────────────────────────────────
                    Drawn on the plan for the first time. They were
                    already captured per room and already exported to
                    the DXF, but were invisible here — so the one place
                    a customer could see whether the layout made sense
                    was the one place the staircase did not appear. */}
                {(r.stairs ?? []).map((st: RoomStairs) => {
                  const wi = (st.wallIndex ?? 0) % 4;
                  const wM = Number.parseFloat(st.widthM);
                  const width = Number.isFinite(wM) && wM > 0 ? wM : 0.9;
                  const posM = Number.parseFloat(st.positionM ?? "");
                  const along = Number.isFinite(posM) ? posM : width / 2 + 0.2;
                  // Depth into the room. A flight is longer than it is
                  // wide; 13 treads at 250 mm is the usual domestic run.
                  const run = 2.6;
                  // Local rectangle for each wall, running along the
                  // wall and projecting inwards.
                  let x = 0, z = 0, bw = width, bh = run;
                  if (wi === 0) { x = along - width / 2; z = 0; bw = width; bh = run; }
                  else if (wi === 1) { x = size.widthM - run; z = along - width / 2; bw = run; bh = width; }
                  else if (wi === 2) { x = size.widthM - along - width / 2; z = size.lengthM - run; bw = width; bh = run; }
                  else { x = 0; z = size.lengthM - along - width / 2; bw = run; bh = width; }
                  const horizontal = wi === 1 || wi === 3;
                  const treads = 8;
                  return (
                    <g key={st.id}>
                      <rect
                        x={x}
                        y={z}
                        width={bw}
                        height={bh}
                        fill="#efe7d6"
                        fillOpacity={0.9}
                        stroke={DARK}
                        strokeWidth={1}
                        vectorEffect="non-scaling-stroke"
                        style={{ cursor: "grab" }}
                        onPointerDown={(e) => {
                          if (tool) return;
                          e.stopPropagation();
                          const local = localCoordsFromEvent(e);
                          if (!local) return;
                          setSelected(st.id);
                          itemDragRef.current = {
                            kind: "stairs",
                            roomId: r.id,
                            itemId: st.id,
                            pointerId: e.pointerId,
                            startLocal: local,
                            startPos: local,
                          };
                          setFrozenViewBox(viewBox);
                          (e.currentTarget as SVGElement).setPointerCapture(e.pointerId);
                        }}
                        onPointerMove={onItemPointerMove}
                        onPointerUp={onItemPointerUp}
                        onPointerCancel={onItemPointerUp}
                      />
                      {/* Tread lines, so it reads as stairs rather than
                          another cupboard. */}
                      {Array.from({ length: treads - 1 }, (_, i) => {
                        const f = (i + 1) / treads;
                        return horizontal ? (
                          <line
                            key={i}
                            x1={x + bw * f}
                            y1={z}
                            x2={x + bw * f}
                            y2={z + bh}
                            stroke={DARK}
                            strokeWidth={0.5}
                            vectorEffect="non-scaling-stroke"
                            pointerEvents="none"
                          />
                        ) : (
                          <line
                            key={i}
                            x1={x}
                            y1={z + bh * f}
                            x2={x + bw}
                            y2={z + bh * f}
                            stroke={DARK}
                            strokeWidth={0.5}
                            vectorEffect="non-scaling-stroke"
                            pointerEvents="none"
                          />
                        );
                      })}
                      <text
                        x={x + bw / 2}
                        y={z + bh / 2}
                        fontSize={0.3}
                        fill={DARK}
                        textAnchor="middle"
                        pointerEvents="none"
                      >
                        {st.direction === "down" ? "DN" : "UP"}
                      </text>
                    </g>
                  );
                })}

                {/* ── Fixtures ─────────────────────────────────────
                    Drawn to their real footprint, not as equal-sized
                    icons. A plan where the bath is the same size as the
                    toilet tells the customer nothing about whether the
                    layout fits, which is the entire question they are
                    trying to answer by looking at it. */}
                {(r.fixtures ?? []).map((f: RoomFixture) => {
                  const { widthM: fw, depthM: fd } = fixtureFootprintM(f);
                  const isSel = selected === f.id;
                  return (
                    <g key={f.id}>
                      <rect
                        x={f.positionM.x - fw / 2}
                        y={f.positionM.z - fd / 2}
                        width={fw}
                        height={fd}
                        rx={0.05}
                        fill={isSel ? "#f7ead0" : "#eef1f4"}
                        stroke={isSel ? GOLD : "#5a6a80"}
                        strokeWidth={isSel ? 2 : 1.2}
                        vectorEffect="non-scaling-stroke"
                        style={{ cursor: "grab" }}
                        onPointerDown={(e) => {
                          if (tool) return;
                          onFixturePointerDown(r.id, f, e);
                        }}
                        onPointerMove={onItemPointerMove}
                        onPointerUp={onItemPointerUp}
                        onPointerCancel={onItemPointerUp}
                      />
                      <text
                        x={f.positionM.x}
                        y={f.positionM.z + 0.08}
                        fontSize={Math.max(0.16, Math.min(0.26, Math.min(fw, fd) / 2.4))}
                        fill="#3a4654"
                        textAnchor="middle"
                        pointerEvents="none"
                      >
                        {FIXTURE_SIZES_M[f.kind].label}
                      </text>

                      {isSel && onRoomChange && (
                        <>
                          {/* Rotate. Cardinal only — a bath at 37
                              degrees is not a thing anyone is
                              reporting, and free rotation on a phone is
                              a fiddle. */}
                          <g
                            transform={`translate(${f.positionM.x - fw / 2 - 0.3} ${f.positionM.z - fd / 2 - 0.3})`}
                            style={{ cursor: "pointer" }}
                            onClick={(e) => {
                              e.stopPropagation();
                              patchFixture(r.id, f.id, {
                                rotationDeg: (((f.rotationDeg + 90) % 360) as RoomRotationDeg),
                              });
                            }}
                          >
                            <circle r={0.55} fill="transparent" />
                            <circle r={0.26} fill={DARK} pointerEvents="none" />
                            <text
                              y={0.09}
                              fontSize={0.3}
                              textAnchor="middle"
                              fill={CREAM}
                              pointerEvents="none"
                            >
                              ↻
                            </text>
                          </g>
                          <g
                            transform={`translate(${f.positionM.x + fw / 2 + 0.3} ${f.positionM.z - fd / 2 - 0.3})`}
                            style={{ cursor: "pointer" }}
                            onClick={(e) => {
                              e.stopPropagation();
                              removeFixture(r.id, f.id);
                            }}
                          >
                            <circle r={0.55} fill="transparent" />
                            <circle r={0.26} fill="#8a2f2f" pointerEvents="none" />
                            <text
                              y={0.09}
                              fontSize={0.3}
                              textAnchor="middle"
                              fill={CREAM}
                              pointerEvents="none"
                            >
                              ×
                            </text>
                          </g>
                        </>
                      )}
                    </g>
                  );
                })}

                {/* Rotate chip — top-right of the unrotated rectangle */}
                <g
                  transform={`translate(${size.widthM - 0.4} 0.4)`}
                  style={{ cursor: "pointer" }}
                  onClick={(e) => {
                    e.stopPropagation();
                    rotateRoom(r.id);
                  }}
                >
                  {/* Invisible hit area.
                      The visible chip is 0.3 m across, which on a phone
                      is roughly a 20 px target — well under the 44 px
                      floor, and these two chips sit close together, so
                      a near miss on "rotate" lands on "remove". The
                      transparent circle enlarges the target without
                      making the plan look like it is covered in
                      buttons. */}
                  <circle r={0.62} fill="transparent" />
                  <circle r={0.3} fill={DARK} pointerEvents="none" />
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
                  {/* Invisible hit area.
                      The visible chip is 0.3 m across, which on a phone
                      is roughly a 20 px target — well under the 44 px
                      floor, and these two chips sit close together, so
                      a near miss on "rotate" lands on "remove". The
                      transparent circle enlarges the target without
                      making the plan look like it is covered in
                      buttons. */}
                  <circle r={0.62} fill="transparent" />
                  <circle r={0.3} fill="#8a2f2f" pointerEvents="none" />
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
          {/* Scale bar.
              Drawn in viewBox metres, so it stretches and shrinks with
              the plan and always represents the distance it claims. A
              fixed-pixel bar would lie the moment anyone zoomed.

              The 1:100 note is about the drawing that leaves here, not
              this screen — on a phone we have no idea how many
              millimetres a pixel is, so stating a screen ratio would be
              made up. The exported plan is what gets printed to scale. */}
          {(() => {
            // Longest round number that fits comfortably across the view.
            const barM =
              [10, 5, 2, 1].find((m) => m <= activeViewBox.w * 0.3) ?? 1;
            const x0 = activeViewBox.x + activeViewBox.w * 0.04;
            const y0 = activeViewBox.z + activeViewBox.h * 0.95;
            const tick = activeViewBox.h * 0.014;
            return (
              <g pointerEvents="none" aria-hidden>
                <line
                  x1={x0}
                  y1={y0}
                  x2={x0 + barM}
                  y2={y0}
                  stroke="#6e6a5f"
                  strokeWidth={1.4}
                  vectorEffect="non-scaling-stroke"
                />
                <line
                  x1={x0}
                  y1={y0 - tick}
                  x2={x0}
                  y2={y0 + tick}
                  stroke="#6e6a5f"
                  strokeWidth={1.4}
                  vectorEffect="non-scaling-stroke"
                />
                <line
                  x1={x0 + barM}
                  y1={y0 - tick}
                  x2={x0 + barM}
                  y2={y0 + tick}
                  stroke="#6e6a5f"
                  strokeWidth={1.4}
                  vectorEffect="non-scaling-stroke"
                />
                <text
                  x={x0}
                  y={y0 - tick * 1.6}
                  fontSize={activeViewBox.h * 0.032}
                  fill="#6e6a5f"
                >
                  {barM} m · grid {GRID_STEP_M} m · plotted 1:100
                </text>
              </g>
            );
          })()}
        </svg>

        {roomsOnFloor.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <p className="rounded-lg bg-white/80 px-4 py-2 text-sm font-semibold text-[#6e6a5f] shadow-sm">
              Tap a room below to place it on {floorLabel(currentFloor)}.
            </p>
          </div>
        )}
      </div>

      {/* ── Fixture palette ─────────────────────────────────────────
          Arm one, then tap inside a room. Deliberately not a drag from
          here into the canvas: that gesture asks a thumb to travel the
          height of the phone while holding a small target, and it fails
          often enough that people conclude the feature is broken. */}
      {onRoomChange && (
        <div className="rounded-xl border border-[#e6dfd0] p-3">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-sm font-bold uppercase tracking-widest text-[#6e6a5f]">
              Add to a room
            </span>
            <span className="text-sm text-[#8a8375]">
              {tool
                ? `Now tap inside the room to place the ${FIXTURE_SIZES_M[tool].label.toLowerCase()}`
                : "Pick one, then tap where it goes"}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(FIXTURE_SIZES_M) as FixtureKind[]).map((k) => {
              const armed = tool === k;
              return (
                <button
                  key={k}
                  type="button"
                  aria-pressed={armed}
                  onClick={() => setTool(armed ? null : k)}
                  className={`rounded-full border px-4 py-2 text-sm font-semibold ${
                    armed
                      ? "border-[#b89650] bg-[#b89650] text-white"
                      : "border-[#d9d3c8] bg-white text-[#1c1c1a]"
                  }`}
                >
                  {FIXTURE_SIZES_M[k].label}
                </button>
              );
            })}
            {tool && (
              <button
                type="button"
                onClick={() => setTool(null)}
                className="rounded-full border border-[#d9d3c8] px-4 py-2 text-sm text-[#6e6a5f]"
              >
                Cancel
              </button>
            )}
          </div>
          <p className="mt-2 text-sm text-[#8a8375]">
            Sizes are the usual ones, drawn to scale. Drag anything to move
            it; tap it to rotate or remove it. Stairs come from the room
            questions and can be dragged along a wall.
          </p>
        </div>
      )}

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
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
        <span className="text-sm text-on-surface-variant">
          Grid = 25 cm · drag rooms · ↻ rotates 90° · × removes from plan
        </span>
      </div>

      {/* Palette of unplaced rooms on current floor */}
      <div
        className="rounded-lg border border-dashed border-[#d9d3c8] p-3"
        style={{ backgroundColor: "#fffdf8" }}
      >
        <p className="mb-2 text-sm font-bold uppercase tracking-[0.2em] text-on-surface-variant">
          Rooms to place on {floorLabel(currentFloor)}
        </p>
        {unplacedOnFloor.length === 0 ? (
          <p className="text-sm text-on-surface-variant">
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
                  className="rounded-lg border border-[#b89650] bg-white px-3 py-2 text-left text-sm font-semibold text-[#1c1c1a] shadow-sm transition hover:bg-[#fff8ea]"
                >
                  <span className="block">{r.name || "Room"}</span>
                  <span className="text-sm font-normal text-[#6e6a5f]">
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
        <details className="rounded-lg border border-[#e6dfd0] p-3 text-sm">
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
                    className="rounded-lg border border-[#d9d3c8] bg-white px-3 py-1.5 text-left text-sm font-semibold text-[#1c1c1a]"
                    title={`Currently on ${floorLabel(p.floor)} — click to move here`}
                  >
                    {r.name || "Room"}
                    <span className="ml-1 text-sm font-normal text-[#8a6f2f]">
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
