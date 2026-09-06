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
  type RoomDraft,
  type RoomPlacement,
  type RoomRotationDeg,
  type RoomStairs,
} from "@tm-designs/measure-core";

/**
 * Standard UK leaf widths, in metres, labelled the way a merchant
 * lists them. Imperial in brackets because that is what is written on
 * the door in most houses built before the 1980s, and because a
 * customer holding a tape will recognise 2'6" faster than 0.762.
 */
const DOOR_WIDTHS = [
  { value: "0.610", label: "610 mm · 2'0\" (cupboard)" },
  { value: "0.686", label: "686 mm · 2'3\"" },
  { value: "0.762", label: "762 mm · 2'6\" (common)" },
  { value: "0.838", label: "838 mm · 2'9\" (common)" },
  { value: "0.926", label: "926 mm · 3'0\" (wide / front)" },
  { value: "1.200", label: "1200 mm (double / French)" },
  { value: "1.800", label: "1800 mm (patio / bi-fold)" },
] as const;

/** Windows vary far more than doors, so this is a ladder, not a list. */
const WINDOW_WIDTHS = [
  { value: "0.600", label: "600 mm (small / bathroom)" },
  { value: "0.900", label: "900 mm" },
  { value: "1.200", label: "1200 mm (common)" },
  { value: "1.500", label: "1500 mm" },
  { value: "1.800", label: "1800 mm (large)" },
  { value: "2.400", label: "2400 mm (bay / picture)" },
] as const;

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

  /* ── Stairs on the plan ─────────────────────────────────────────
   *
   * Stairs are captured in the room questions and drawn here so the
   * customer can see whether the layout makes sense — dragging one
   * finds the nearest wall rather than setting a free position,
   * because that is how a staircase is built and how the DXF draws it.
   *
   * A fixture palette lived here too — toilet, basin, bath and so on,
   * placed by tapping into a room. It was removed on review: the plan
   * step is for saying where the rooms are, and a nine-item palette
   * under a canvas someone is already unsure about was the wrong place
   * to ask about sanitaryware. The data model, the DXF layer and their
   * tests are kept in measure-core, so the same information can be
   * collected from the room questions later without rebuilding it.
   */
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

  /** Drag state for a flight of stairs. */
  const itemDragRef = useRef<{
    roomId: string;
    itemId: string;
    pointerId: number;
    startLocal: { x: number; z: number };
    startPos: { x: number; z: number };
  } | null>(null);

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
  /**
   * World metres → a room's own coordinates.
   *
   * The inverse of the `translate(...) rotate(...)` the room group is
   * drawn with. Written against that string deliberately: if the two
   * ever disagree, a flight lands somewhere the customer did not drop
   * it, which is the sort of thing that looks like a bug in the drag
   * rather than in the maths.
   */
  const worldToLocal = useCallback(
    (world: { x: number; z: number }, p: RoomPlacement) => {
      if (!p.positionM) return null;
      const dx = world.x - p.positionM.x;
      const dz = world.z - p.positionM.z;
      const rad = (-p.rotationDeg * Math.PI) / 180;
      return {
        x: dx * Math.cos(rad) - dz * Math.sin(rad),
        z: dx * Math.sin(rad) + dz * Math.cos(rad),
      };
    },
    [],
  );

  /**
   * Which placed room on this floor a world point falls inside.
   *
   * Bounding boxes, not exact outlines. An L-shaped room's notch will
   * claim a point that is technically outside it, which is wrong and
   * harmless: the flight then snaps to that room's nearest wall, a
   * quarter of a metre from where it was dropped, and can be dragged
   * again. Getting it exactly right would mean point-in-polygon
   * against every room on every pointer move.
   */
  const roomAtPoint = useCallback(
    (world: { x: number; z: number }) =>
      roomsOnFloor.find((r) => {
        const p = placementFor(r.id);
        if (!p.positionM) return false;
        const b = roomBoundingBox(p.positionM, roomFootprint(r), p.rotationDeg);
        return (
          world.x >= b.minX &&
          world.x <= b.maxX &&
          world.z >= b.minZ &&
          world.z <= b.maxZ
        );
      }) ?? null,
    [roomsOnFloor, placementFor],
  );

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
                // Back against a wall, so the free position and its
                // frozen heading are dropped. Leaving them would mean
                // a flight that reads as wall-anchored in the form and
                // draws somewhere else entirely in the DXF, where
                // worldM wins.
                worldM: undefined,
                headingDeg: undefined,
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

  /**
   * Take a flight out of one room and put it in another, unchanged.
   *
   * Width, direction, tread count and notes travel with it — the only
   * things that do not are the wall and the distance along it, which
   * are meaningless in a room they did not come from and are set by
   * the drag immediately afterwards.
   */
  const moveStairsToRoom = useCallback(
    (fromId: string, toId: string, stairsId: string) => {
      if (!onRoomChange) return;
      const from = rooms.find((r) => r.id === fromId);
      const to = rooms.find((r) => r.id === toId);
      if (!from || !to) return;
      const flight = (from.stairs ?? []).find((s) => s.id === stairsId);
      if (!flight) return;
      onRoomChange(fromId, {
        stairs: (from.stairs ?? []).filter((s) => s.id !== stairsId),
      });
      onRoomChange(toId, { stairs: [...(to.stairs ?? []), flight] });
    },
    [onRoomChange, rooms],
  );

  /**
   * The one height on this floor, or "" when the rooms disagree.
   *
   * Derived rather than held in state, so it cannot drift from the
   * rooms it describes — switching floors, adding a room or editing a
   * single room's height all show up here without anything to keep in
   * sync.
   */
  const floorCeilings = roomsOnFloor.map((r) => (r.ceilingHeightM ?? "").trim());
  const ceilingIsMixed =
    floorCeilings.length > 1 &&
    new Set(floorCeilings.filter(Boolean)).size > 1;
  const floorCeiling = ceilingIsMixed ? "" : (floorCeilings[0] ?? "");

  /** Set every room on this floor to the same height. */
  const setFloorCeilingForFloor = useCallback(
    (value: string) => {
      if (!onRoomChange) return;
      for (const r of roomsOnFloor) {
        onRoomChange(r.id, { ceilingHeightM: value });
      }
    },
    [onRoomChange, roomsOnFloor],
  );

  const [insertKind, setInsertKind] = useState<"door" | "window" | "stairs">(
    "door",
  );
  const [insertWidthM, setInsertWidthM] = useState("0.838");
  const [insertTreads, setInsertTreads] = useState("13");
  const [insertWinders, setInsertWinders] = useState(false);

  /**
   * Put the chosen thing on the selected room's first wall.
   *
   * Everything lands on wall 0 at half a metre along, marked
   * approximate, and is then dragged. Guessing a better starting wall
   * from the layout would be guessing: the plan knows where the rooms
   * are, not where the customer walks. Half a metre in from a corner
   * is at least visibly wrong, which is what prompts the drag.
   */
  const insertIntoSelected = useCallback(() => {
    if (!onRoomChange || !selected) return;
    const room = rooms.find((r) => r.id === selected);
    if (!room) return;
    const id = `${insertKind[0]}-${Date.now().toString(36)}`;
    const base = {
      id,
      wallIndex: 0,
      positionM: "0.50",
      // Placed from a plan, not measured against a wall. Same
      // distinction the opening picker makes, and for the same reason:
      // the draughtsman needs to know which numbers were paced out.
      positionApprox: true,
    };
    if (insertKind === "stairs") {
      onRoomChange(selected, {
        stairs: [
          ...(room.stairs ?? []),
          {
            ...base,
            widthM: "0.90",
            direction: "up" as const,
            treads: insertTreads.trim() || "13",
            winders: insertWinders,
          },
        ],
      });
      return;
    }
    const opening = { ...base, widthM: insertWidthM, note: "" };
    onRoomChange(
      selected,
      insertKind === "door"
        ? { doors: [...(room.doors ?? []), opening] }
        : { windows: [...(room.windows ?? []), opening] },
    );
  }, [
    onRoomChange,
    rooms,
    selected,
    insertKind,
    insertWidthM,
    insertTreads,
    insertWinders,
  ]);

  /**
   * Cut a flight loose from its wall and pin it to the plan.
   *
   * The heading is frozen on the way out, from the wall it was last
   * against and the rotation of the room it was in, so a staircase
   * drawn running north-south does not swing round to east-west the
   * moment it clears the doorway. Once free it keeps that heading
   * until it is dropped back into a room.
   */
  const setStairsFree = useCallback(
    (roomId: string, stairsId: string, worldM: { x: number; z: number }) => {
      if (!onRoomChange) return;
      const room = rooms.find((r) => r.id === roomId);
      if (!room) return;
      const p = placementFor(roomId);
      onRoomChange(roomId, {
        stairs: (room.stairs ?? []).map((s) => {
          if (s.id !== stairsId) return s;
          // Wall 0 runs +x, 1 runs +z, 2 runs -x, 3 runs -z, before
          // the room's own rotation is added.
          const heading =
            s.headingDeg ?? ((s.wallIndex ?? 0) * 90 + p.rotationDeg) % 360;
          return { ...s, worldM, headingDeg: heading, positionApprox: true };
        }),
      });
    },
    [onRoomChange, rooms, placementFor],
  );

  /** Put a freed flight back against a wall. */
  const clearStairsFree = useCallback(
    (roomId: string, stairsId: string) => {
      if (!onRoomChange) return;
      const room = rooms.find((r) => r.id === roomId);
      if (!room) return;
      onRoomChange(roomId, {
        stairs: (room.stairs ?? []).map((s) =>
          s.id === stairsId
            ? { ...s, worldM: undefined, headingDeg: undefined }
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
      /*
       * Drop it wherever it belongs, including in another room.
       *
       * A flight used to snap to the nearest wall of the room it was
       * created in, and only that room — so a staircase entered
       * against a bedroom, which is where the customer was standing
       * when they thought of it, could never be moved to the landing
       * where it actually is. Dragging it out of the room did nothing
       * except pin it to whichever bedroom wall was closest.
       *
       * Now the drop point decides. Land inside another room and the
       * flight moves to it; land on nothing and it stays where it was,
       * because a staircase in the garden is not a thing we can draw.
       */
      const world = svgCoordsFromEvent(e);
      if (!world) return;
      const target = roomAtPoint(world);

      /*
       * Dropped outside every room — leave it there.
       *
       * A stairwell in a hall, a flight on an open landing, a run
       * between two rooms that belongs to neither: all real, and all
       * impossible while a flight could only be pinned to a wall of
       * the room it happened to be entered in. Dragging one clear now
       * frees it, and dragging it back into a room re-anchors it to
       * the nearest wall.
       */
      if (!target) {
        setStairsFree(st.roomId, st.itemId, {
          x: snapM(world.x),
          z: snapM(world.z),
        });
        return;
      }

      const local = worldToLocal(world, placementFor(target.id));
      if (!local) return;

      if (target.id !== st.roomId) {
        moveStairsToRoom(st.roomId, target.id, st.itemId);
        // The id is preserved by the move, so the drag keeps hold of
        // the same flight and the next pointermove slides it.
        itemDragRef.current = { ...st, roomId: target.id };
      }
      slideStairs(target.id, st.itemId, {
        x: snapM(local.x),
        z: snapM(local.z),
      });
    },
    // slideStairs must be listed: it closes over `rooms`, so omitting it
    // leaves a drag started before a room was added writing back to the
    // room list as it was then, silently dropping the new room.
    [
      svgCoordsFromEvent,
      roomAtPoint,
      worldToLocal,
      placementFor,
      moveStairsToRoom,
      rooms,
      slideStairs,
    ],
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

          {/* ── Stairs that belong to no room ────────────────────────
              Drawn at plan level rather than inside a room's group,
              because that is exactly what makes them free: their
              position is in world metres and does not move when the
              room they are filed under moves. A stairwell in a hall is
              the ordinary case, not an exotic one.

              ↻ rotates the run in 90° steps and ⌖ puts it back against
              a wall, both as taps rather than gestures — a flight is
              small on screen and a rotate handle on it would be a
              two-millimetre target. */}
          {roomsOnFloor.flatMap((r) =>
            (r.stairs ?? [])
              .filter((st) => st.worldM)
              .map((st: RoomStairs) => {
                const wM = Number.parseFloat(st.widthM);
                const width = Number.isFinite(wM) && wM > 0 ? wM : 0.9;
                const run = 2.6;
                const at = st.worldM!;
                const heading = st.headingDeg ?? 0;
                const treads = 8;
                return (
                  <g
                    key={st.id}
                    transform={`translate(${at.x} ${at.z}) rotate(${heading} 0 0)`}
                  >
                    <rect
                      x={0}
                      y={-width / 2}
                      width={run}
                      height={width}
                      fill="#efe7d6"
                      fillOpacity={0.95}
                      stroke={DARK}
                      strokeWidth={1.5}
                      vectorEffect="non-scaling-stroke"
                      style={{ cursor: "grab" }}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        setSelected(st.id);
                        itemDragRef.current = {
                          roomId: r.id,
                          itemId: st.id,
                          pointerId: e.pointerId,
                          startLocal: { x: 0, z: 0 },
                          startPos: { x: 0, z: 0 },
                        };
                        setFrozenViewBox(viewBox);
                        (e.currentTarget as SVGElement).setPointerCapture(
                          e.pointerId,
                        );
                      }}
                      onPointerMove={onItemPointerMove}
                      onPointerUp={onItemPointerUp}
                      onPointerCancel={onItemPointerUp}
                    />
                    {Array.from({ length: treads - 1 }, (_, i) => {
                      const x = (run * (i + 1)) / treads;
                      return (
                        <line
                          key={i}
                          x1={x}
                          y1={-width / 2}
                          x2={x}
                          y2={width / 2}
                          stroke={DARK}
                          strokeWidth={0.5}
                          vectorEffect="non-scaling-stroke"
                          pointerEvents="none"
                        />
                      );
                    })}
                    <text
                      x={run / 2}
                      y={0.1}
                      fontSize={0.3}
                      fill={DARK}
                      textAnchor="middle"
                      pointerEvents="none"
                    >
                      {st.direction === "down" ? "DN" : "UP"}
                    </text>
                    {onRoomChange && (
                      <>
                        <text
                          x={run + 0.3}
                          y={0.1}
                          fontSize={0.45}
                          fill={GOLD}
                          textAnchor="middle"
                          style={{ cursor: "pointer" }}
                          onClick={(e) => {
                            e.stopPropagation();
                            onRoomChange(r.id, {
                              stairs: (r.stairs ?? []).map((s) =>
                                s.id === st.id
                                  ? { ...s, headingDeg: (heading + 90) % 360 }
                                  : s,
                              ),
                            });
                          }}
                        >
                          ↻
                        </text>
                        <text
                          x={-0.3}
                          y={0.1}
                          fontSize={0.4}
                          fill={GOLD}
                          textAnchor="middle"
                          style={{ cursor: "pointer" }}
                          onClick={(e) => {
                            e.stopPropagation();
                            clearStairsFree(r.id, st.id);
                          }}
                        >
                          ⌖
                        </text>
                      </>
                    )}
                  </g>
                );
              }),
          )}

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
                  style={{ cursor: "grab" }}
                  onPointerDown={(e) => onRoomPointerDown(r.id, e)}
                  onPointerMove={onRoomPointerMove}
                  onPointerUp={onRoomPointerUp}
                  onPointerCancel={onRoomPointerUp}
                  onClick={() => setSelected(null)}
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
                {(r.stairs ?? []).filter((st) => !st.worldM).map((st: RoomStairs) => {
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
                          e.stopPropagation();
                          const local = localCoordsFromEvent(e);
                          if (!local) return;
                          setSelected(st.id);
                          itemDragRef.current = {
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
        {/* Add things from the plan, not only from the questions.
            Someone looking at the layout is the person best placed to
            notice a missing staircase or a door they walked through
            and never recorded — and until now the only way to add
            either was to go back through the room questions and find
            the right room. Adds to the selected room, because "which
            room?" is a question the plan can already answer: the one
            you tapped. */}
        <span className="text-sm text-on-surface-variant">
          {onRoomChange && !selected
            ? "Tap a room to add a door, window or stairs to it · "
            : ""}
          Grid = 25 cm · drag rooms · ↻ rotates 90° · × removes from plan
        </span>
      </div>

      {/* ── Insert into the selected room ───────────────────────────
          Someone looking at the layout is the person best placed to
          notice a missing staircase or a door they walked through and
          never recorded — and until now the only way to add either was
          to go back through the room questions and find the right
          room.

          Sizes are offered as a list rather than a box to type in. A
          door is one of about four widths, a customer measuring one
          with a tape gets 0.81 where the real answer is 0.838, and
          "which of these is it closest to" is both easier to answer
          and closer to the truth. The width can still be corrected in
          the room questions if the door really is a one-off. */}
      {onRoomChange && selected && (
        <div
          className="rounded-lg border border-[#b89650]/50 p-3"
          style={{ backgroundColor: "#fffdf8" }}
        >
          <p className="mb-2 text-sm font-bold uppercase tracking-[0.2em] text-on-surface-variant">
            Add to {rooms.find((r) => r.id === selected)?.name || "this room"}
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-sm">
              <span className="mb-1 block font-semibold text-[#6e6a5f]">
                What
              </span>
              <select
                value={insertKind}
                onChange={(e) => {
                  const next = e.target.value as "door" | "window" | "stairs";
                  setInsertKind(next);
                  // Reset the width to that list's default. Without
                  // this, switching to Window leaves 0.838 selected --
                  // a value the window list does not contain, so the
                  // dropdown shows 600 mm and inserts 838.
                  if (next === "door") setInsertWidthM("0.838");
                  if (next === "window") setInsertWidthM("1.200");
                }}
                className="rounded-lg border border-[#d9d3c8] bg-white px-3 py-2 text-sm"
              >
                <option value="door">Door</option>
                <option value="window">Window</option>
                <option value="stairs">Stairs</option>
              </select>
            </label>

            {insertKind !== "stairs" && (
              <label className="text-sm">
                <span className="mb-1 block font-semibold text-[#6e6a5f]">
                  Width
                </span>
                <select
                  value={insertWidthM}
                  onChange={(e) => setInsertWidthM(e.target.value)}
                  className="rounded-lg border border-[#d9d3c8] bg-white px-3 py-2 text-sm"
                >
                  {(insertKind === "door" ? DOOR_WIDTHS : WINDOW_WIDTHS).map(
                    (w) => (
                      <option key={w.value} value={w.value}>
                        {w.label}
                      </option>
                    ),
                  )}
                </select>
              </label>
            )}

            {insertKind === "stairs" && (
              <>
                <label className="text-sm">
                  <span className="mb-1 block font-semibold text-[#6e6a5f]">
                    Steps
                  </span>
                  <input
                    inputMode="numeric"
                    value={insertTreads}
                    onChange={(e) => setInsertTreads(e.target.value)}
                    placeholder="13"
                    className="w-20 rounded-lg border border-[#d9d3c8] bg-white px-3 py-2 text-sm"
                  />
                </label>
                <label className="flex items-center gap-2 py-2 text-sm font-semibold text-[#6e6a5f]">
                  <input
                    type="checkbox"
                    checked={insertWinders}
                    onChange={(e) => setInsertWinders(e.target.checked)}
                    className="h-5 w-5"
                  />
                  Turns a corner
                </label>
              </>
            )}

            <button
              type="button"
              onClick={insertIntoSelected}
              className="rounded-full bg-[#b89650] px-4 py-2 text-sm font-bold uppercase tracking-widest text-white"
            >
              Add
            </button>
          </div>
          <p className="mt-2 text-sm text-[#6e6a5f]">
            It lands on the first wall — drag it to where it really is.
          </p>
        </div>
      )}

      {/* ── Ceiling height for this floor ──────────────────────────
          Asked here rather than once for the whole property, because
          here is the only place the floors exist. One number for a
          whole house is wrong in most of them -- a Victorian ground
          floor and its bedrooms are rarely the same, and a loft never
          is -- and the old project-step question was asked before the
          customer had told us there was an upstairs at all.

          It writes straight through to every room on the floor. Rooms
          have carried their own height all along; this sets them in
          one go rather than introducing a second place the number can
          live and disagree with itself. */}
      {onRoomChange && roomsOnFloor.length > 0 && (
        <div className="flex flex-wrap items-end gap-3 rounded-lg border border-[#e6dfd0] p-3">
          <label className="text-sm">
            <span className="mb-1 block font-semibold text-[#6e6a5f]">
              Ceiling height on {floorLabel(currentFloor)} (m)
            </span>
            <input
              inputMode="decimal"
              value={floorCeiling}
              onChange={(e) => setFloorCeilingForFloor(e.target.value)}
              placeholder={ceilingIsMixed ? "Mixed" : "2.40"}
              className="w-28 rounded-lg border border-[#d9d3c8] bg-white px-3 py-2 text-sm"
            />
          </label>
          <p className="flex-1 py-2 text-sm text-[#6e6a5f]">
            {ceilingIsMixed
              ? "Rooms on this floor differ. Typing here sets them all to the same."
              : "Applies to every room on this floor. Change a single room in its own questions."}
          </p>
        </div>
      )}

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
