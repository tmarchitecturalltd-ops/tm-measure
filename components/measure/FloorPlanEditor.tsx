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
 * Door widths, in metres.
 *
 * 760 internal and 800 external first, because those are the two TM
 * Designs draws to and between them they cover almost every door in a
 * survey. The rest are there for the ones that are obviously neither.
 *
 * The imperial equivalents that used to be in these labels are gone.
 * They were there on the theory that a customer would recognise 2'6"
 * faster than 0.762 -- but the first thing anyone needs to know here
 * is whether the door is an inside one or an outside one, and two
 * numbers per row buried that.
 */
const DOOR_WIDTHS = [
  { value: "0.760", label: "760 mm — internal" },
  { value: "0.800", label: "800 mm — external" },
  { value: "0.610", label: "610 mm — cupboard" },
  { value: "0.686", label: "686 mm — narrow" },
  { value: "0.926", label: "926 mm — wide" },
  { value: "1.200", label: "1200 mm — double / French" },
  { value: "1.800", label: "1800 mm — patio" },
  /*
   * Bi-folds have no standard width.
   *
   * They are made to the opening: three leaves is about 1.8 m, six is
   * nearer 4, and a wide rear elevation can run to 5. A dropdown
   * cannot hold that, and picking the nearest listed size would put a
   * 1.8 m door where a 4.5 m opening is -- which on a rear extension
   * is most of the wall.
   */
  { value: "custom", label: "Bi-fold or other — type the width" },
] as const;

/** Windows vary far more than doors, so this is a ladder, not a list. */
const WINDOW_WIDTHS = [
  { value: "0.600", label: "600 mm (small / bathroom)" },
  { value: "0.900", label: "900 mm" },
  { value: "1.200", label: "1200 mm (common)" },
  { value: "1.500", label: "1500 mm" },
  { value: "1.800", label: "1800 mm (large)" },
  { value: "2.400", label: "2400 mm (bay / picture)" },
  { value: "custom", label: "Something else — type the width" },
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
  /**
   * Start measuring another room, then come back here.
   *
   * The plan is where a missing room gets noticed, and the way to add
   * one was buried in the Steps menu on another screen.
   */
  onAddRoom?: () => void;
  /**
   * True once this project's plan has been laid out (or opened with
   * rooms already on it). Held by the parent because this component
   * unmounts whenever the customer leaves the step.
   */
  seeded?: boolean;
  onSeeded?: () => void;
};

/*
 * A Disclosure component used to live here.
 *
 * It was the right idea one step too early: three collapsible rows
 * above the plan were still three rows of heading, subtitle and
 * chevron, and on a phone that left the grid a strip in the middle of
 * the screen. The controls are now chips in a single line, opening one
 * shared panel -- same content, one row of chrome instead of three.
 */
/** Default placement for a room whose entry is missing from the map. */
function defaultPlacement(floor: number = 0): RoomPlacement {
  return { positionM: null, rotationDeg: 0, floor };
}

export default function FloorPlanEditor({
  rooms,
  placements,
  onPlacementChange,
  onRoomChange,
  onAddRoom,
  seeded = false,
  onSeeded,
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

  /**
   * A room to zoom into for a moment after something is added to it.
   *
   * Placing a door on a plan that shows the whole house means dragging
   * a 0.8 m object across a 12 m view: a wall is a couple of
   * millimetres wide on screen, the finger covers the thing being
   * moved, and quarter-metre snapping is most of the room. It was
   * accurate enough to be worth doing and fiddly enough that nobody
   * would.
   *
   * So the view goes to the room the feature just landed in, and
   * comes back when the customer taps away. Automatic, because the
   * moment you need it is the moment you have just pressed Add and
   * have one hand on the phone.
   */
  const [zoomRoomId, setZoomRoomId] = useState<string | null>(null);

  /**
   * Which control panel is showing, if any.
   *
   * One at a time, and closed by default. Three panels that could all
   * be open at once is three panels that eventually all are, and the
   * grid ends up a letterbox at the bottom of the screen.
   */
  const [openPanel, setOpenPanel] = useState<
    null | "rooms" | "feature" | "ceiling"
  >(null);

  /** Dismisses the "no doors yet" nudge for this visit. */
  const [doorPromptOff, setDoorPromptOff] = useState(false);

  /** What was just added, so the plan can say to drag it. */
  const [justAdded, setJustAdded] = useState<
    null | "door" | "window" | "stairs"
  >(null);

  /*
   * And it goes away by itself.
   *
   * It cleared on the first drag, which is fine for someone who drags
   * and useless for someone who does not -- the banner then sat over
   * the top of the plan for the rest of the session, covering the
   * thing it was pointing at. Six seconds is long enough to read
   * twice.
   */
  useEffect(() => {
    if (!justAdded) return;
    const t = setTimeout(() => setJustAdded(null), 6000);
    return () => clearTimeout(t);
  }, [justAdded]);

  const zoomViewBox = useMemo(() => {
    if (!zoomRoomId) return null;
    const room = rooms.find((r) => r.id === zoomRoomId);
    if (!room) return null;
    const p = placementFor(zoomRoomId);
    if (!p.positionM) return null;
    const b = roomBoundingBox(p.positionM, roomFootprint(room), p.rotationDeg);
    // A metre of margin: enough to see which wall is which and the
    // rooms either side, without losing the detail that is the point.
    const pad = 1;
    return {
      x: b.minX - pad,
      z: b.minZ - pad,
      w: Math.max(3, b.maxX - b.minX + pad * 2),
      h: Math.max(3, b.maxZ - b.minZ + pad * 2),
    };
  }, [zoomRoomId, rooms, placementFor]);

  /**
   * How big a "constant size" thing should be, in metres.
   *
   * Everything on this canvas is drawn in metres, so a chip with a
   * 0.3 m radius is 0.3 m of plan -- fine at the default fit, and
   * enormous the moment anyone zooms in. Zooming to one room made the
   * rotate and remove chips bigger than the doorways, which is what
   * that screenshot is showing.
   *
   * Dividing by the visible width undoes the zoom: the number of
   * metres per screen pixel changes, so the metre size changes with
   * it and the pixel size does not. 10 m is the reference fit.
   */
  /** What the SVG actually renders — held still mid-drag. */
  /**
   * A pinched / dragged view, when the customer has set one.
   *
   * Wins over every other source, because it is the only one they
   * asked for directly. Cleared by "Show whole floor".
   */
  const [manualViewBox, setManualViewBox] = useState<{
    x: number;
    z: number;
    w: number;
    h: number;
  } | null>(null);

  const activeViewBox =
    frozenViewBox ?? manualViewBox ?? zoomViewBox ?? viewBox;

  /**
   * The first room on this floor with no doors on it.
   *
   * A room-by-room survey measures each room in isolation, so nothing
   * says how they join up -- and a plan of six rooms with no doors is
   * six boxes, which is not a floor plan. A whole-property scan gets
   * this for free because RoomPlan sees the doorways; measuring one
   * room at a time does not.
   *
   * So the plan asks, one room at a time, until every room has at
   * least one. It never blocks: a customer who genuinely has a room
   * with no door in it, or who cannot face the question, presses on
   * and the survey still sends.
   */
  const roomNeedingDoor = useMemo(
    () => roomsOnFloor.find((r) => (r.doors?.length ?? 0) === 0) ?? null,
    [roomsOnFloor],
  );

  /** Metres per unit of "constant screen size". See the note above. */
  const uiScale = activeViewBox.w / 10;

  /*
   * Pinch to zoom, drag the background to pan.
   *
   * The plan auto-fits every room on the floor, which is the right
   * default and useless the moment someone wants to put a door
   * accurately on a wall -- at house scale a door is a few pixels
   * wide. There was no way to get closer except adding something and
   * letting the auto-zoom do it.
   *
   * Two fingers scale about the midpoint between them, which is what
   * every map does. One finger on the background pans; one finger on a
   * room still drags the room, because that gesture was there first
   * and is the one the step exists for.
   *
   * Clamped between 2 m and 60 m across: closer than 2 m and a wall
   * fills the screen with nothing to line it up against, wider than
   * 60 m and a house is a smudge.
   */
  /*
   * Keep the view where the drag left it.
   *
   * frozenViewBox pins the frame for the duration of a gesture, and
   * clearing it on release handed the canvas back to the auto-fit --
   * which had just been recomputed around the room's new position. So
   * every drag ended with the whole plan hopping to a new scale. The
   * freeze becomes the manual view instead, and the plan holds still
   * until someone asks for the whole floor.
   */
  const settleView = useCallback(() => {
    setFrozenViewBox((frozen) => {
      if (frozen) setManualViewBox(frozen);
      return null;
    });
  }, []);

  const gestureRef = useRef<{
    pointers: Map<number, { x: number; y: number }>;
    startDist: number;
    startBox: { x: number; z: number; w: number; h: number };
    startMid: { x: number; z: number } | null;
  }>({ pointers: new Map(), startDist: 0, startBox: viewBox, startMid: null });

  /**
   * Moves whatever is selected. Filled in below, once the functions
   * that do the moving exist.
   *
   * A door on a house-scale plan is a few pixels of line, and landing
   * a fingertip on it is the whole reason placing one felt fiddly.
   * Tapping is easy; dragging a five-pixel target is not. So the tap
   * selects, and after that a drag anywhere on the plan moves the
   * selected thing -- including drags that start well clear of it,
   * where there is room for a thumb. Tap empty grid to let go.
   */
  const moveSelectionRef = useRef<
    ((e: ReactPointerEvent) => boolean) | null
  >(null);

  const onCanvasPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      // Only the background. A pointerdown on a room, chip or opening
      // has already called stopPropagation.
      const g = gestureRef.current;
      g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      g.startBox = activeViewBox;
      if (g.pointers.size === 2) {
        const [a, b] = [...g.pointers.values()];
        g.startDist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      }
      setFrozenViewBox(null);
    },
    [activeViewBox],
  );

  const onCanvasPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const g = gestureRef.current;
      if (!g.pointers.has(e.pointerId)) return;
      const prev = g.pointers.get(e.pointerId)!;
      g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const perPx = g.startBox.w / (rect.width || 1);

      if (g.pointers.size >= 2) {
        const [a, b] = [...g.pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const factor = g.startDist / dist;
        const w = Math.min(60, Math.max(2, g.startBox.w * factor));
        const h = w * (g.startBox.h / g.startBox.w);
        // Keep the midpoint of the two fingers still.
        const midX = (a.x + b.x) / 2 - rect.left;
        const midY = (a.y + b.y) / 2 - rect.top;
        const fx = midX / (rect.width || 1);
        const fy = midY / (rect.height || 1);
        const anchorX = g.startBox.x + g.startBox.w * fx;
        const anchorZ = g.startBox.z + g.startBox.h * fy;
        setManualViewBox({
          x: anchorX - w * fx,
          z: anchorZ - h * fy,
          w,
          h,
        });
        return;
      }

      /*
       * One finger on the background: pan.
       *
       * Ignored under three pixels of travel. Fingers are not still,
       * and without a threshold every tap on the plan shifted the view
       * a little -- which on a screen where the customer is trying to
       * line a door up against a wall is worse than not panning at
       * all.
       */
      if (Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 3) return;
      const dx = (e.clientX - prev.x) * perPx;
      const dy = (e.clientY - prev.y) * perPx;

      // Something selected? The drag belongs to it, not to the view.
      if (moveSelectionRef.current?.(e)) return;
      setManualViewBox((cur) => {
        const base = cur ?? activeViewBox;
        return { ...base, x: base.x - dx, z: base.z - dy };
      });
    },
    [activeViewBox],
  );

  const onCanvasPointerUp = useCallback(
    (e: ReactPointerEvent) => {
      const g = gestureRef.current;
      const start = g.pointers.get(e.pointerId);
      g.pointers.delete(e.pointerId);
      settleView();
      /*
       * A tap on the background clears the decks.
       *
       * The panel and the Delete button are both tied to something
       * being selected, and there was no way to unselect -- so once a
       * door had been tapped the controls stayed up for the rest of
       * the session, over the plan. Tapping empty grid is the gesture
       * everyone already tries.
       *
       * Under four pixels of travel, or it fires at the end of every
       * pan.
       */
      if (
        start &&
        Math.hypot(e.clientX - start.x, e.clientY - start.y) < 4 &&
        g.pointers.size === 0
      ) {
        setSelected(null);
        setOpenPanel(null);
        setJustAdded(null);
      }
    },
    [settleView],
  );

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
   * What the bin would delete, and what to call it.
   *
   * `selected` holds whichever id was last tapped -- a room, an
   * opening or a flight of stairs -- so this works out which of the
   * three it is and produces a label the customer can check before
   * pressing. "Delete" on its own, next to a plan with eight things on
   * it, is not a question anyone should have to answer from memory.
   */
  const selectedThing = useMemo(() => {
    if (!selected) return null;
    /*
     * Features only -- not rooms.
     *
     * The Room dropdown sets `selected`, so a customer who picked a
     * room in order to add a door to it was then offered "Delete
     * kitchen" in the same row as the Add connector button. Pressing
     * it only unplaced the room, which is recoverable, but the trap is
     * obvious and the label was two words from being catastrophic.
     *
     * A room comes off the plan with its own x chip and is deleted
     * properly from the Steps menu, which names it and sits next to
     * the undo.
     */
    for (const r of rooms) {
      if ((r.doors ?? []).some((d) => d.id === selected)) {
        return { kind: "door" as const, roomId: r.id, label: "door" };
      }
      if ((r.windows ?? []).some((w) => w.id === selected)) {
        return { kind: "window" as const, roomId: r.id, label: "window" };
      }
      if ((r.stairs ?? []).some((st) => st.id === selected)) {
        return { kind: "stairs" as const, roomId: r.id, label: "stairs" };
      }
    }
    return null;
  }, [selected, rooms]);

  /**
   * Remove it.
   *
   * A room is only unplaced, not deleted -- the measurements are the
   * expensive part and this is the plan screen, not the rooms list.
   * Deleting a room outright lives in the Steps menu, where it names
   * the room and the undo is nearby. Openings and stairs are deleted
   * properly, because they were added here and nowhere else.
   */
  const deleteSelected = useCallback(() => {
    const t = selectedThing;
    if (!t || !onRoomChange) return;
    const room = rooms.find((r) => r.id === t.roomId);
    if (!room) return;
    setSelected(null);
    if (t.kind === "door") {
      onRoomChange(room.id, {
        doors: (room.doors ?? []).filter((d) => d.id !== selected),
      });
    } else if (t.kind === "window") {
      onRoomChange(room.id, {
        windows: (room.windows ?? []).filter((w) => w.id !== selected),
      });
    } else {
      onRoomChange(room.id, {
        stairs: (room.stairs ?? []).filter((st) => st.id !== selected),
      });
    }
  }, [selectedThing, selected, rooms, onRoomChange, onPlacementChange, placementFor]);

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

  /** Drag state for a door or window. */
  const openingDragRef = useRef<{
    roomId: string;
    openingId: string;
    kind: "door" | "window";
    pointerId: number;
  } | null>(null);

  /**
   * Slide an opening to the nearest wall of its room.
   *
   * The same shape of maths as slideStairs, and for the same reason: a
   * door is described by which wall it is in and how far along, not by
   * a free position, so the drag has to answer those two questions
   * rather than record where the finger stopped. Dragging across a
   * corner therefore moves the door round onto the next wall, which is
   * the behaviour that makes it feel magnetic.
   */
  const slideOpening = useCallback(
    (
      roomId: string,
      openingId: string,
      kind: "door" | "window",
      at: { x: number; z: number },
    ) => {
      if (!onRoomChange) return;
      const room = rooms.find((r) => r.id === roomId);
      if (!room) return;
      const size = roomFootprint(room);
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
        const lenSq = vx * vx + vz * vz || 1;
        const t = Math.max(
          0,
          Math.min(1, ((at.x - a.x) * vx + (at.z - a.z) * vz) / lenSq),
        );
        const px = a.x + vx * t;
        const pz = a.z + vz * t;
        const dist = Math.hypot(at.x - px, at.z - pz);
        if (dist < best.dist) {
          best = { index: i, dist, along: t * Math.sqrt(lenSq) };
        }
      });
      const patch = (list: typeof room.doors) =>
        list.map((o) =>
          o.id === openingId
            ? {
                ...o,
                wallIndex: best.index,
                positionM: snapM(best.along).toFixed(2),
                // Dragged, not measured. The draughtsman needs to know
                // which numbers were paced out.
                positionApprox: true,
              }
            : o,
        );
      onRoomChange(
        roomId,
        kind === "door"
          ? { doors: patch(room.doors ?? []) }
          : { windows: patch(room.windows ?? []) },
      );
    },
    [onRoomChange, rooms],
  );

  const onOpeningPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const st = openingDragRef.current;
      if (!st || st.pointerId !== e.pointerId) return;
      e.stopPropagation();
      const world = svgCoordsFromEvent(e);
      if (!world) return;
      const local = worldToLocal(world, placementFor(st.roomId));
      if (!local) return;
      setJustAdded(null);
      slideOpening(st.roomId, st.openingId, st.kind, local);
    },
    [svgCoordsFromEvent, worldToLocal, placementFor, slideOpening],
  );

  const onOpeningPointerUp = useCallback((e: ReactPointerEvent) => {
    const st = openingDragRef.current;
    if (!st || st.pointerId !== e.pointerId) return;
    e.stopPropagation();
    openingDragRef.current = null;
    settleView();
    try {
      (e.currentTarget as SVGElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  }, []);

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
  /**
   * The room the insert panel writes to.
   *
   * `selected` when the customer has tapped a room, and the first room
   * on the floor otherwise -- so the panel is usable the moment it is
   * seen rather than being a set of controls that quietly do nothing.
   * `selected` also holds stairs ids, which are not rooms, so it is
   * checked against the room list rather than trusted.
   */
  const insertRoomId =
    roomsOnFloor.find((r) => r.id === selected)?.id ?? roomsOnFloor[0]?.id ?? "";
  const [insertWidthM, setInsertWidthM] = useState("0.760");
  /**
   * A typed width, in metres, for anything the list cannot hold.
   *
   * Bi-folds are the reason: made to the opening, anywhere from about
   * 1.8 m to 5 m, so there is no standard size to offer.
   */
  const [customWidthM, setCustomWidthM] = useState("3.00");
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
    if (!onRoomChange || !insertRoomId) return;
    const room = rooms.find((r) => r.id === insertRoomId);
    if (!room) return;
    const target = insertRoomId;
    const id = `${insertKind[0]}-${Date.now().toString(36)}`;
    const base: {
      id: string;
      wallIndex: number;
      positionM: string;
      positionApprox: boolean;
    } = {
      id,
      wallIndex: 0,
      positionM: "0.50",
      // Placed from a plan, not measured against a wall. Same
      // distinction the opening picker makes, and for the same reason:
      // the draughtsman needs to know which numbers were paced out.
      positionApprox: true,
    };
    if (insertKind === "stairs") {
      /*
       * Placed in the middle of the room and already free.
       *
       * A flight used to arrive pinned to a wall, which meant the
       * first drag walked it round the perimeter before it would go
       * anywhere useful. Starting it loose in the middle means the
       * first drag does what a drag looks like it will do.
       */
      const p = placementFor(target);
      const size = roomFootprint(room);
      const centre = p.positionM
        ? {
            x: snapM(p.positionM.x + size.widthM / 2),
            z: snapM(p.positionM.z + size.lengthM / 2),
          }
        : undefined;
      onRoomChange(target, {
        stairs: [
          ...(room.stairs ?? []),
          {
            ...base,
            widthM: "0.90",
            direction: "up" as const,
            treads: insertTreads.trim() || "13",
            winders: insertWinders,
            ...(centre
              ? { worldM: centre, headingDeg: p.rotationDeg }
              : {}),
          },
        ],
      });
      setZoomRoomId(target);
      return;
    }
    /*
     * Put it on the wall facing the rest of the house.
     *
     * Everything landed on wall 0 -- the top edge of the room as drawn
     * -- which for a room at the top of the plan is its outside wall,
     * so a door added to connect two rooms appeared on the far side of
     * the one it was added to and had to be dragged all the way round.
     *
     * The wall whose middle is nearest the centre of the other rooms
     * is the one most likely to be shared, and it is one drag from any
     * of the others regardless. Wall 0 stays the fallback when there
     * is nothing else on the floor.
     */
    const others = roomsOnFloor.filter((rr) => rr.id !== target);
    if (others.length) {
      const pts = others
        .map((rr) => placementFor(rr.id).positionM)
        .filter((v): v is { x: number; z: number } => !!v);
      if (pts.length) {
        const hx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
        const hz = pts.reduce((a, p) => a + p.z, 0) / pts.length;
        const p = placementFor(target);
        const size = roomFootprint(room);
        const local = worldToLocal({ x: hx, z: hz }, p);
        if (local) {
          // Midpoints of walls 0..3 in the room's own frame.
          const mids = [
            { x: size.widthM / 2, z: 0 },
            { x: size.widthM, z: size.lengthM / 2 },
            { x: size.widthM / 2, z: size.lengthM },
            { x: 0, z: size.lengthM / 2 },
          ];
          let bestI = 0;
          let bestD = Infinity;
          mids.forEach((m, i) => {
            const d = Math.hypot(local.x - m.x, local.z - m.z);
            if (d < bestD) {
              bestD = d;
              bestI = i;
            }
          });
          base.wallIndex = bestI;
          base.positionM = (
            (bestI % 2 === 0 ? size.widthM : size.lengthM) / 2
          ).toFixed(2);
        }
      }
    }

    const widthM =
      insertWidthM === "custom"
        ? (Number.parseFloat(customWidthM) || 0).toFixed(3)
        : insertWidthM;
    const opening = { ...base, widthM, note: "" };
    onRoomChange(
      target,
      insertKind === "door"
        ? { doors: [...(room.doors ?? []), opening] }
        : { windows: [...(room.windows ?? []), opening] },
    );
    setSelected(id);
    setZoomRoomId(target);
    // Close the panel and say what to do next.
    //
    // The panel used to stay open on the reasoning that the next thing
    // anyone does is add a second window. What actually happens is the
    // customer looks for the thing they just added, and the panel is
    // covering the plan it landed on.
    setOpenPanel(null);
    setJustAdded(insertKind);
  }, [
    onRoomChange,
    rooms,
    insertRoomId,
    insertKind,
    insertWidthM,
    customWidthM,
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
      setJustAdded(null);
      /*
       * Stairs move freely. They do not snap to walls.
       *
       * They used to find the nearest wall of whichever room the
       * finger was over and pin themselves to it, which is how a
       * staircase is built and a miserable way to move one: dragging
       * across a room walked the flight round the perimeter, jumping
       * from wall to wall, and it was near impossible to put it in the
       * middle of a hall or across a corner where plenty of stairs
       * actually are.
       *
       * The DXF has taken a free position since the outline work, so
       * nothing downstream needs the wall. The chip on the flight
       * still snaps it back to one for anyone who wants that.
       */
      setStairsFree(st.roomId, st.itemId, {
        x: snapM(world.x),
        z: snapM(world.z),
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
    settleView();
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
      /*
       * Stop here. The canvas behind this listens for the same
       * pointerdown to pan the view, and without this both ran on one
       * finger: the room moved under the drag while the whole plan
       * slid the other way, so the room came away from the fingertip
       * at roughly double speed. The canvas pan is for the background
       * only.
       *
       * It also protected the freeze below -- the canvas handler
       * clears frozenViewBox on pointerdown, which was undoing the
       * pin one line before it was set.
       */
      e.stopPropagation();
      // Selecting is what reveals the room's own chips, and what makes
      // a later drag anywhere on the plan move this room.
      setSelected(roomId);
      dragRef.current = {
        roomId,
        pointerId: e.pointerId,
        startSvg: svg,
        startAnchor: { x: p.positionM.x, z: p.positionM.z },
      };
      /*
       * Pin the frame the drag is measured in -- the one on screen.
       *
       * This froze `viewBox`, the auto-fit around every room on the
       * floor, rather than `activeViewBox`, what the customer is
       * actually looking at. So touching a room while zoomed in threw
       * the view straight back out to the whole floor, mid-gesture,
       * and the room they were about to move jumped somewhere else on
       * the screen.
       *
       * settleView then keeps this frame afterwards, so the zoom
       * survives the drag as well.
       */
      setFrozenViewBox(activeViewBox);
      (e.currentTarget as SVGElement).setPointerCapture(e.pointerId);
    },
    [placementFor, svgCoordsFromEvent, activeViewBox],
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

  /*
   * The implementation of moveSelectionRef, now that every helper it
   * needs is defined. Assigned during render rather than in an effect,
   * so a drag on the very first frame after selecting still works.
   *
   * Returns true when it handled the move, so the canvas knows not to
   * pan as well.
   */
  moveSelectionRef.current = (e: ReactPointerEvent): boolean => {
    if (!selected) return false;
    const room = rooms.find(
      (r) =>
        r.id === selected ||
        (r.doors ?? []).some((d) => d.id === selected) ||
        (r.windows ?? []).some((w) => w.id === selected) ||
        (r.stairs ?? []).some((st) => st.id === selected),
    );
    if (!room) return false;
    const world = svgCoordsFromEvent(e);
    if (!world) return false;

    // A whole room: put its middle under the finger.
    if (room.id === selected) {
      const p = placementFor(room.id);
      if (!p.positionM) return false;
      const size = roomFootprint(room);
      onPlacementChange(room.id, {
        ...p,
        positionM: {
          x: snapToGrid(world.x - size.widthM / 2),
          z: snapToGrid(world.z - size.lengthM / 2),
        },
      });
      return true;
    }

    if ((room.stairs ?? []).some((st) => st.id === selected)) {
      // Free movement, same as the direct drag above -- see the note
      // there. Stairs go where they are put.
      setJustAdded(null);
      setStairsFree(room.id, selected, {
        x: snapM(world.x),
        z: snapM(world.z),
      });
      return true;
    }

    const kind = (room.doors ?? []).some((d) => d.id === selected)
      ? ("door" as const)
      : ("window" as const);
    const local = worldToLocal(world, placementFor(room.id));
    if (!local) return false;
    setJustAdded(null);
    slideOpening(room.id, selected, kind, local);
    return true;
  };

  const onRoomPointerUp = useCallback((e: ReactPointerEvent) => {
    const st = dragRef.current;
    if (!st || st.pointerId !== e.pointerId) return;
    dragRef.current = null;
    settleView();
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
    /*
     * Once per project, not once per visit.
     *
     * `laidOut` is a ref in a component that unmounts every time the
     * customer leaves the plan step, so it forgets. A floor they had
     * deliberately cleared would be laid out again the moment they
     * came back -- the same silent rewrite as the late-room placement
     * above, just a step further along. The parent owns the flag, so
     * it survives.
     */
    if (seeded) return;
    if (laidOut.current.has(currentFloor)) return;
    const onFloor = rooms.filter((r) => placementFor(r.id).floor === currentFloor);
    if (!onFloor.length) return;
    if (onFloor.some((r) => placementFor(r.id).positionM)) {
      laidOut.current.add(currentFloor);
      onSeeded?.();
      return;
    }
    laidOut.current.add(currentFloor);
    onSeeded?.();
    const seed = autoLayoutRooms(onFloor);
    for (const [id, placement] of seed.entries()) {
      onPlacementChange(id, placement);
    }
  }, [rooms, placementFor, currentFloor, onPlacementChange, seeded, onSeeded]);

  /*
   * Rooms added later are NOT placed automatically any more.
   *
   * There was an effect here that dropped any unplaced room onto the
   * plan, on the reasoning that a room measured after the plan was
   * first opened would otherwise sit in "To place" and get forgotten.
   *
   * It rewrote the customer's drawing behind their back. The state it
   * used to decide what counted as "new" lived in refs inside this
   * component, and leaving the plan step unmounts it -- so on coming
   * back, every unplaced room looked new. Place one room, go to
   * Review, press Back, and the plan now had all of them on it. The
   * customer had arranged one room and been given six.
   *
   * Reported exactly that way, and it is the right complaint: the plan
   * is the customer's, and nothing should move on it without them
   * asking. Every route that puts a room on the plan is now something
   * they press -- "To place", "Add to plan" on the review warning, or
   * the buttons on an empty floor.
   */


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
    <div className="flex flex-col gap-2">
      {/* ── Floor, room, feature ────────────────────────────────────
          Three controls in one line.

          The floor used to be a row of tabs plus "+ Floor up" and
          "+ Basement" buttons, which is fine for a house with three
          storeys and a whole line of the screen for a bungalow. It is
          a select now, with adding a floor as an option inside it.

          The room select is new, and it is what the Add feature panel
          used to ask for on its own. Choosing the room first means the
          panel opens already pointed at somewhere, and it doubles as a
          way to find a room on a busy plan -- picking one highlights
          it and zooms to it. */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label className="flex items-center gap-1.5">
          <span className="font-bold uppercase tracking-[0.15em] text-on-surface-variant">
            Floor
          </span>
          <select
            value={currentFloor}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "__up") {
                const next = Math.max(...usedFloors) + 1;
                setExtraFloors((prev) => [...prev, next]);
                setCurrentFloor(next);
                return;
              }
              if (v === "__down") {
                const next = Math.min(...usedFloors) - 1;
                setExtraFloors((prev) => [...prev, next]);
                setCurrentFloor(next);
                return;
              }
              setCurrentFloor(Number(v));
            }}
            style={{ minHeight: 40 }}
            className="rounded-full border border-[#b89650] bg-white px-3 font-semibold text-[#8a6f2f]"
          >
            {usedFloors.map((f) => (
              <option key={f} value={f}>
                {floorLabel(f)}
              </option>
            ))}
            <option value="__up">+ Add floor above</option>
            <option value="__down">+ Add basement</option>
          </select>
        </label>

        {roomsOnFloor.length > 0 && (
          <label className="flex min-w-0 items-center gap-1.5">
            <span className="font-bold uppercase tracking-[0.15em] text-on-surface-variant">
              Room
            </span>
            <select
              value={insertRoomId}
              onChange={(e) => {
                setSelected(e.target.value);
                setZoomRoomId(e.target.value);
              }}
              style={{ minHeight: 40 }}
              className="min-w-0 max-w-[10rem] truncate rounded-full border border-[#b89650] bg-white px-3 font-semibold text-[#8a6f2f]"
            >
              {roomsOnFloor.map((r, i) => (
                <option key={r.id} value={r.id}>
                  {r.name?.trim() || `Room ${i + 1}`}
                </option>
              ))}
            </select>
          </label>
        )}

        {onRoomChange && roomsOnFloor.length > 0 && (
          <button
            type="button"
            onClick={() =>
              setOpenPanel((cur) => (cur === "feature" ? null : "feature"))
            }
            style={{ minHeight: 40 }}
            className={`rounded-full border px-3.5 font-semibold ${
              openPanel === "feature"
                ? "border-[#b89650] bg-[#b89650] text-white"
                : "border-[#b89650] text-[#8a6f2f]"
            }`}
          >
            Add feature
          </button>
        )}

        {/* Delete whatever is selected.
            Rooms had an x chip on the plan; a door, window or flight of
            stairs had nothing at all -- add one by mistake and it was
            there for good, because the panel that created it has no
            list of what it has created. One bin, acting on the thing
            the customer last touched, is the smallest way to say
            "that one, get rid of it". */}
        {onRoomChange && selectedThing && (
          <button
            type="button"
            onClick={deleteSelected}
            style={{ minHeight: 40 }}
            className="ml-auto flex items-center gap-1.5 rounded-full border border-[#a33] px-3.5 font-semibold text-[#a33]"
          >
            <span
              className="material-symbols-outlined"
              style={{ fontSize: "18px" }}
              aria-hidden
            >
              delete
            </span>
            Delete {selectedThing.label}
          </button>
        )}
      </div>


      {/* ── Controls and the folded detail, above the plan ─────────
          The plan is the point of this screen, so it gets the space
          and everything else sits above it as a strip of controls.

          They used to be underneath: auto-layout, then three folded
          rows, then the rooms waiting to be placed -- so the way to
          put a room on the plan was below the plan, off the bottom of
          the screen on a phone, and a customer looking at an empty
          grid had nothing in view telling them what to do next. Now
          the actions are where you look first and the grid fills what
          is left. */}
      {/* Controls */}
      {/* ── One strip of controls, one panel at a time ──────────────
          The plan is the page. Everything else is a chip along the
          top that opens a single panel beneath it, and opening one
          closes the others -- so the controls take one line of height
          when nothing is open and never more than one panel's worth
          when something is.

          Three stacked disclosures were better than three stacked
          cards and still wrong: even shut they were three rows of
          heading, subtitle and chevron above the grid, which on a
          phone left the plan a strip in the middle of the screen. The
          grid is the thing being worked on and should have the space.

          Each chip carries its own state in its label -- the number of
          rooms still to place, the ceiling height in metres -- so the
          floor can be read without opening anything. */}
      {/* No "+ Room" here.
          It sat in this row and threw the customer back to "What's
          this room called?" with a plan half arranged behind them,
          which read as the app losing their place. It is offered on
          the empty floor instead, where there is no place to lose. */}
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        {/* Only what is left over.
            Rooms now place themselves, so "To place" appears only when
            something genuinely could not be, and Auto-layout and Clear
            are recovery tools rather than steps -- they sit at the end
            of the row, quieter than the three that matter. */}
        {([
          {
            key: "rooms" as const,
            label: `To place (${unplacedOnFloor.length})`,
            show: unplacedOnFloor.length > 0,
          },
          {
            key: "ceiling" as const,
            label: ceilingIsMixed ? "Ceiling: mixed" : `Ceiling ${floorCeiling || "2.40"} m`,
            show: !!onRoomChange && roomsOnFloor.length > 0,
          },
        ] as const)
          .filter((c) => c.show)
          .map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setOpenPanel((cur) => (cur === c.key ? null : c.key))}
              style={{ minHeight: 40 }}
              className={`rounded-full border px-3.5 font-semibold ${
                openPanel === c.key
                  ? "border-[#b89650] bg-[#b89650] text-white"
                  : "border-[#b89650] text-[#8a6f2f]"
              }`}
            >
              {c.label}
            </button>
          ))}
        <button
          type="button"
          onClick={applyAutoLayout}
          style={{ minHeight: 40 }}
          className="rounded-full border border-[#d9d3c8] px-3.5 font-semibold text-[#6e6a5f]"
        >
          Auto-layout
        </button>
        <button
          type="button"
          onClick={clearFloor}
          style={{ minHeight: 40 }}
          className="rounded-full border border-[#d9d3c8] px-3.5 font-semibold text-[#6e6a5f]"
        >
          Clear
        </button>
        {(zoomRoomId || manualViewBox) && (
          <button
            type="button"
            onClick={() => {
              setZoomRoomId(null);
              setManualViewBox(null);
            }}
            style={{ minHeight: 40 }}
            className="rounded-full border border-[#b89650] px-3.5 font-semibold text-[#8a6f2f]"
          >
            Whole floor
          </button>
        )}
      </div>

      {/* Canvas */}
      <div
        /*
         * A fixed band, not a growing one.
         *
         * minHeight alone let the canvas grow with the layout, so a
         * house with a few rooms pushed the whole step past the bottom
         * of the screen -- and the plan is the one thing on it that
         * should never need scrolling to. It now takes the height it
         * is given and the viewBox fits the rooms into that.
         */
        className="relative overflow-hidden rounded-xl border border-[#d9d3c8]"
        /*
         * Fills whatever the controls and the bottom bar leave.
         *
         * A fixed band stopped the step scrolling and left the plan a
         * letterbox with cream space under it. The subtraction is the
         * chrome above and below: app bar and progress, two rows of
         * controls, the bottom Back/Steps/Next bar and the card
         * padding. dvh rather than vh so the iOS address bar
         * collapsing does not change the answer mid-drag.
         */
        style={{
          backgroundColor: CREAM,
          height: "max(260px, calc(100dvh - 310px))",
        }}
      >
        {/* Over the plan, not above it.
            A panel that pushes the canvas down resizes the drawing
            every time it opens and closes, so the plan jumps twice per
            door. As an overlay the layout never changes: the grid is
            the same size whatever is on top of it, and closing the
            panel gives the space straight back. */}
        {openPanel && (
          <div
            className="absolute inset-x-2 top-2 z-20 max-h-[70%] overflow-y-auto rounded-xl border border-[#b89650]/60 p-3 shadow-xl"
            style={{ backgroundColor: "#fffdf8f2" }}
          >
          {openPanel === "rooms" && (
            <>
        {unplacedOnFloor.length === 0 ? (
          <p className="text-sm text-on-surface-variant">
            Every room you have measured is on the plan.
          </p>
        ) : (
          <>
          {/* These are rooms that have already been measured. Tapping
              one puts it on the plan -- it does not ask for anything
              new. Said out loud because "add room" was read as "go and
              measure another one", which is what the button next to it
              used to do. */}
          <p className="mb-2 text-sm text-[#6e6a5f]">
            Tap a room to put it on the plan.
          </p>
          <div className="flex flex-wrap gap-2">
            {unplacedOnFloor.map((r) => {
              const size = roomFootprint(r);
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => {
                    placeRoomOnCurrentFloor(r.id);
                    // Last one? Nothing left to choose from, so get the
                    // panel off the plan.
                    if (unplacedOnFloor.length === 1) setOpenPanel(null);
                  }}
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
          </>
        )}
            </>
          )}
          {openPanel === "feature" && (
            <>
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
      <>
          <div className="flex flex-wrap items-end gap-2">
            {/* The room is picked here rather than by tapping the plan.
                The panel used to appear only once a room was selected,
                which meant the way to find out that doors and windows
                could be added at all was to tap a room and notice
                something new had appeared underneath — so the honest
                answer to "where is the button?" was that there wasn't
                one until you had already guessed. Tapping a room still
                sets this, because that is the quicker gesture once you
                know it works. */}
            <label className="text-sm">
              <span className="mb-1 block font-semibold text-[#6e6a5f]">
                Room
              </span>
              <select
                value={insertRoomId}
                onChange={(e) => setSelected(e.target.value)}
                className="rounded-lg border border-[#d9d3c8] bg-white px-3 py-2 text-sm"
              >
                {roomsOnFloor.map((r, i) => (
                  <option key={r.id} value={r.id}>
                    {r.name?.trim() || `Room ${i + 1}`}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-semibold text-[#6e6a5f]">
                Feature
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
                  if (next === "door") setInsertWidthM("0.760");
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

            {/* The typed width, shown only when the list cannot help.
                Metres, to two decimals, because that is what every
                other measurement in this app is in -- asking for
                millimetres here and metres everywhere else is how a
                4.5 m bi-fold gets entered as 4500 m. */}
            {insertKind !== "stairs" && insertWidthM === "custom" && (
              <label className="text-sm">
                <span className="mb-1 block font-semibold text-[#6e6a5f]">
                  Width in metres
                </span>
                <input
                  inputMode="decimal"
                  value={customWidthM}
                  onChange={(e) => setCustomWidthM(e.target.value)}
                  placeholder="4.20"
                  style={{ minHeight: 40 }}
                  className="w-24 rounded-lg border border-[#d9d3c8] bg-white px-3 text-sm"
                />
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
      </>
            </>
          )}
          {openPanel === "ceiling" && (
            <>
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
      <div className="flex flex-wrap items-end gap-3">
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
            </>
          )}
          </div>
        )}
        <svg
          ref={svgRef}
          viewBox={`${activeViewBox.x} ${activeViewBox.z} ${activeViewBox.w} ${activeViewBox.h}`}
          preserveAspectRatio="xMidYMid meet"
          className="block h-full w-full"
          style={{ touchAction: "none", userSelect: "none" }}
          aria-label={`Floor plan editor for ${floorLabel(currentFloor)}`}
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onCanvasPointerMove}
          onPointerUp={onCanvasPointerUp}
          onPointerCancel={onCanvasPointerUp}
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
                const at = st.worldM!;
                const heading = st.headingDeg ?? 0;
                const treads = 8;
                /*
                 * A flight that turns is drawn as an L.
                 *
                 * "Turns a corner" was a tick box that changed a note
                 * in the drawing and nothing on the plan, so a corner
                 * staircase looked exactly like a straight one and
                 * there was no way to show where the turn was. Most
                 * UK stairs turn at least once.
                 *
                 * The long leg runs along the heading and the short
                 * one turns left off its end -- a quarter-turn, which
                 * is the common case. Rotating the flight in 90-degree
                 * steps puts the turn on whichever side it needs.
                 */
                const turns = st.winders === true;
                const run = turns ? 1.9 : 2.6;
                const leg = turns ? 1.3 : 0;
                return (
                  <g
                    key={st.id}
                    transform={`translate(${at.x} ${at.z}) rotate(${heading} 0 0)`}
                  >
                    {turns && (
                      <>
                        {/* The second leg, and its treads. */}
                        <rect
                          x={run - width}
                          y={-width / 2 - leg}
                          width={width}
                          height={leg}
                          fill="#efe7d6"
                          fillOpacity={0.95}
                          stroke={DARK}
                          strokeWidth={1.5}
                          vectorEffect="non-scaling-stroke"
                          pointerEvents="none"
                        />
                        {Array.from({ length: 3 }, (_, i) => {
                          const y = -width / 2 - (leg * (i + 1)) / 4;
                          return (
                            <line
                              key={`leg-${i}`}
                              x1={run - width}
                              y1={y}
                              x2={run}
                              y2={y}
                              stroke={DARK}
                              strokeWidth={0.5}
                              vectorEffect="non-scaling-stroke"
                              pointerEvents="none"
                            />
                          );
                        })}
                      </>
                    )}
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
                        setFrozenViewBox(activeViewBox);
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
                  /*
                   * Draggable, and magnetic to the walls.
                   *
                   * An opening was drawn and then frozen -- pointer
                   * events off -- so adding a door put a gold mark
                   * halfway along whichever wall happened to be first
                   * and left the customer no way to move it. The panel
                   * said "drag it to where it really is" and the thing
                   * could not be dragged.
                   *
                   * The drag does not set a free position. It finds the
                   * nearest wall to the finger and how far along that
                   * wall it landed, so an opening cannot end up
                   * floating in the middle of a room -- which is both
                   * what the DXF needs and what a door actually does.
                   * Same behaviour as the stairs, and the same reason.
                   *
                   * The invisible wide stroke underneath is the target:
                   * a 4px line is about a millimetre of screen and no
                   * thumb finds it.
                   */
                  const isSel = selected === op.id;
                  const mx = (px1 + px2) / 2;
                  const my = (py1 + py2) / 2;
                  // Unit vector from the opening towards the middle of
                  // the room, for placing the delete chip.
                  const towardX = w / 2 - mx;
                  const towardZ = h / 2 - my;
                  const towardLen = Math.hypot(towardX, towardZ) || 1;
                  const inX = towardX / towardLen;
                  const inZ = towardZ / towardLen;
                  return (
                    <g key={`op-${oi}`}>
                      <line
                        x1={px1}
                        y1={py1}
                        x2={px2}
                        y2={py2}
                        stroke="transparent"
                        strokeWidth={40}
                        strokeLinecap="round"
                        vectorEffect="non-scaling-stroke"
                        style={{ cursor: "grab" }}
                        onPointerDown={(e) => {
                          if (!onRoomChange) return;
                          e.stopPropagation();
                          setSelected(op.id);
                          openingDragRef.current = {
                            roomId: r.id,
                            openingId: op.id,
                            kind: op.kind,
                            pointerId: e.pointerId,
                          };
                          setFrozenViewBox(activeViewBox);
                          (e.currentTarget as SVGElement).setPointerCapture(
                            e.pointerId,
                          );
                        }}
                        onPointerMove={onOpeningPointerMove}
                        onPointerUp={onOpeningPointerUp}
                        onPointerCancel={onOpeningPointerUp}
                      />
                      {/* The opening itself, and a handle to move it by.
                          A 4px line the colour of the wall it sits in,
                          on a plan of a whole house, is a couple of
                          millimetres of glass -- findable if you know
                          it is there and invisible if you do not. It is
                          now drawn thicker, with white jambs either
                          side so it reads as a gap in the wall rather
                          than a mark on it, and a solid dot in the
                          middle that is the thing to drag. The dot is
                          sized off uiScale, so it stays thumb-sized
                          however far in the plan is zoomed. */}
                      <line
                        x1={px1}
                        y1={py1}
                        x2={px2}
                        y2={py2}
                        stroke={CREAM}
                        strokeWidth={9}
                        strokeLinecap="butt"
                        vectorEffect="non-scaling-stroke"
                        pointerEvents="none"
                      />
                      <line
                        x1={px1}
                        y1={py1}
                        x2={px2}
                        y2={py2}
                        stroke={colour}
                        strokeWidth={isSel ? 7 : 5}
                        vectorEffect="non-scaling-stroke"
                        pointerEvents="none"
                      />
                      <circle
                        cx={mx}
                        cy={my}
                        r={(isSel ? 0.28 : 0.22) * uiScale}
                        fill={colour}
                        stroke={CREAM}
                        strokeWidth={2}
                        vectorEffect="non-scaling-stroke"
                        pointerEvents="none"
                      />
                      {/* Delete, on the thing itself.
                          Getting rid of a door meant tapping it, then
                          finding the Delete button in the control row
                          above the plan and reading which of the eight
                          things on screen it was going to remove. The
                          x appears on the selected opening, just
                          inside the room so it never sits over the
                          wall, and there is no doubt what it applies
                          to. */}
                      {isSel && onRoomChange && (
                        <g
                          transform={`translate(${mx + inX * 0.55 * uiScale} ${my + inZ * 0.55 * uiScale})`}
                          style={{ cursor: "pointer" }}
                          onPointerDown={(ev) => ev.stopPropagation()}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            setSelected(null);
                            onRoomChange(
                              r.id,
                              op.kind === "door"
                                ? {
                                    doors: (r.doors ?? []).filter(
                                      (d) => d.id !== op.id,
                                    ),
                                  }
                                : {
                                    windows: (r.windows ?? []).filter(
                                      (wn) => wn.id !== op.id,
                                    ),
                                  },
                            );
                          }}
                        >
                          <circle r={0.55 * uiScale} fill="transparent" />
                          <circle
                            r={0.3 * uiScale}
                            fill="#8a2f2f"
                            stroke={CREAM}
                            strokeWidth={2}
                            vectorEffect="non-scaling-stroke"
                          />
                          <text
                            x={0}
                            y={0.11 * uiScale}
                            fontSize={0.36 * uiScale}
                            textAnchor="middle"
                            fill={CREAM}
                            pointerEvents="none"
                          >
                            ×
                          </text>
                        </g>
                      )}
                    </g>
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
                          setFrozenViewBox(activeViewBox);
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

                {/* ── Room chips, only on the selected room ──────────
                    These were on every room all the time, in the two
                    corners -- which is exactly where a door on the top
                    or right wall sits, so tapping a door near a corner
                    hit "rotate" or "remove from plan" instead. Four
                    rooms meant eight chips permanently over the
                    drawing, and none of them was wanted until a room
                    had been chosen.

                    They appear on the selected room only, and they sit
                    outside it now -- above the top edge, clear of the
                    walls entirely. Inside the room they still landed
                    on whatever was drawn there: a door on the top
                    wall, a window on the right, the room's own name.
                    Outside, there is nothing to hit by accident. */}
                {selected === r.id && (
                <>
                <g
                  transform={`translate(${size.widthM - 1.5 * uiScale} ${-0.75 * uiScale})`}
                  style={{ cursor: "pointer" }}
                  onPointerDown={(e) => e.stopPropagation()}
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
                  <circle r={0.62 * uiScale} fill="transparent" />
                  <circle r={0.3 * uiScale} fill={DARK} pointerEvents="none" />
                  <text
                    x={0}
                    y={0.1 * uiScale}
                    fontSize={0.35 * uiScale}
                    textAnchor="middle"
                    fill={CREAM}
                  >
                    ↻
                  </text>
                </g>

                {/* Unplace chip — beside rotate, above the room. */}
                <g
                  transform={`translate(${size.widthM - 0.35 * uiScale} ${-0.75 * uiScale})`}
                  style={{ cursor: "pointer" }}
                  onPointerDown={(e) => e.stopPropagation()}
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
                  <circle r={0.62 * uiScale} fill="transparent" />
                  <circle r={0.3 * uiScale} fill="#8a2f2f" pointerEvents="none" />
                  <text
                    x={0}
                    y={0.1 * uiScale}
                    fontSize={0.35 * uiScale}
                    textAnchor="middle"
                    fill={CREAM}
                  >
                    ×
                  </text>
                </g>
                </>
                )}
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

        {/* Say where it went and what to do with it.
            Along the bottom, not the top -- "Show whole floor" lives up
            there, and the two were landing on top of each other.
            An opening lands on the first wall, half a metre along,
            which is almost never where it belongs -- so the moment it
            appears is the moment to say that it moves. It clears on
            the first drag, and on any tap of the plan. */}
        {justAdded && (
          <div
            className="pointer-events-none absolute inset-x-3 bottom-3 z-10 rounded-xl px-4 py-2.5 text-center text-sm font-semibold shadow-sm"
            style={{ backgroundColor: "#1c1c1ae8", color: "#fff8ea" }}
          >
            {justAdded === "stairs" ? "Stairs" : justAdded === "door" ? "Door" : "Window"}{" "}
            added — drag it to where it goes
          </div>
        )}

        {/* Ask for the doors, one room at a time.
            Same slot as the "added" banner and only when that is not
            showing, so the plan never has two things talking over it.
            Dismissable, and it comes back next time the step is
            opened -- a nudge, not a gate. */}
        {!justAdded && !doorPromptOff && roomNeedingDoor && onRoomChange && (
          <div
            className="absolute inset-x-3 bottom-3 z-10 flex items-center gap-2 rounded-xl px-3 py-2 shadow-sm"
            style={{ backgroundColor: "#1c1c1ae8", color: "#fff8ea" }}
          >
            <span className="min-w-0 flex-1 text-sm font-semibold">
              {roomNeedingDoor.name?.trim() || "This room"} has no doors yet —
              they tell us how the rooms join up
            </span>
            <button
              type="button"
              onClick={() => {
                setSelected(roomNeedingDoor.id);
                setZoomRoomId(roomNeedingDoor.id);
                setInsertKind("door");
                setInsertWidthM("0.760");
                setOpenPanel("feature");
              }}
              style={{ minHeight: 36 }}
              className="shrink-0 rounded-full bg-[#b89650] px-3.5 text-sm font-bold uppercase tracking-widest text-white"
            >
              Add
            </button>
            <button
              type="button"
              onClick={() => setDoorPromptOff(true)}
              aria-label="Stop asking"
              style={{ minHeight: 36, minWidth: 36 }}
              className="shrink-0 rounded-full text-white/60"
            >
              ✕
            </button>
          </div>
        )}

        {/* The way back out of the zoom.
            Automatic on add, manual to leave: a view that snapped back
            on its own would do it halfway through the drag it exists
            to make possible. */}
        {/* The "Whole floor" button used to float on this edge. It
            is in the control row next to Clear now -- both put the
            view back, and a button sitting on the drawing is one more
            thing between the customer and the plan. */}
        {/* An empty floor, with the rooms that belong on it.
            "Add room" was the wrong word here twice over: it created a
            new room and sent the customer off to measure it, when what
            they wanted -- and what the screen was telling them there
            were five of -- was to put rooms they had *already*
            measured onto the plan.

            So the primary action places them. Measuring another room
            is offered underneath, worded so it cannot be mistaken for
            the other thing, and only really belongs here when there is
            nothing waiting. */}
        {roomsOnFloor.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 px-6">
            {unplacedOnFloor.length > 0 ? (
              <>
                <button
                  type="button"
                  onClick={applyAutoLayout}
                  style={{ minHeight: 48 }}
                  className="rounded-full bg-[#b89650] px-6 text-sm font-bold uppercase tracking-widest text-white shadow-lg"
                >
                  Put my {unplacedOnFloor.length} room
                  {unplacedOnFloor.length === 1 ? "" : "s"} on the plan
                </button>
                <button
                  type="button"
                  onClick={() => setOpenPanel("rooms")}
                  style={{ minHeight: 44 }}
                  className="rounded-full border-2 border-[#b89650] bg-white/90 px-5 text-sm font-bold uppercase tracking-widest text-[#8a6f2f]"
                >
                  One at a time
                </button>
              </>
            ) : (
              onAddRoom && (
                <button
                  type="button"
                  onClick={onAddRoom}
                  style={{ minHeight: 48 }}
                  className="rounded-full border-2 border-[#b89650] bg-white/90 px-6 text-sm font-bold uppercase tracking-widest text-[#8a6f2f]"
                >
                  Measure another room
                </button>
              )
            )}
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
