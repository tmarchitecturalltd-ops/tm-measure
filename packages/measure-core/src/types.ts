export type UnitPreference = "metric" | "imperial";

export type WallSegment = {
  id: string;
  label: string;
  lengthM: string;
  /**
   * Photos attached specifically to this wall. Used so the architect
   * can audit individual features per wall — radiator on Wall 1,
   * chimney breast on Wall 2, etc. Optional for older drafts which
   * carried per-room photos only.
   */
  photos?: RoomPhoto[];
};

export type Opening = {
  id: string;
  widthM: string;
  note: string;
  /**
   * Which wall the opening sits on (0 = first wall, 1 = second, …).
   * Optional so older drafts still parse; defaults to wall 0 if absent.
   */
  wallIndex?: number;
  /**
   * Distance in metres from the wall's start corner to the centre of
   * the opening. Used by FloorPlanEditor to draw the door/window in
   * the right place. Optional — half the wall length if absent.
   */
  positionM?: string;
  /**
   * True when positionM came from dragging the opening along the wall
   * diagram rather than being measured and typed.
   *
   * The two produce identical-looking numbers and mean very different
   * things: one is "about a third of the way along", the other is a
   * tape measurement. Whoever draws from this needs to know which they
   * have, or an eyeballed 1.85 gets built as though it were surveyed.
   */
  positionApprox?: boolean;
};

/** Cross-platform photo reference (web: blob URI; native: file/content URI). */
export type RoomPhoto = {
  id: string;
  uri: string;
  name: string;
  mimeType?: string;
  sizeBytes?: number;
};

/**
 * Cross-platform audio reference (voice memo). Same shape as a
 * RoomPhoto so the upload pipeline can treat them uniformly; the
 * extra `durationMs` lets the architect console show how long
 * each clip is without having to load it.
 */
export type RoomAudio = {
  id: string;
  uri: string;
  name: string;
  mimeType?: string;
  sizeBytes?: number;
  durationMs?: number;
};

/**
 * Rotation applied to a room rectangle on the floor plan canvas.
 *
 * Restricted to the four cardinal rotations so adjacent rooms can snap
 * cleanly along their walls without sub-degree drift. Free rotation
 * would require wall-segment snapping which is out of scope for v1.
 */
export type RoomRotationDeg = 0 | 90 | 180 | 270;

/**
 * Floor plan placement for a single room, in real-world metres.
 *
 * `positionM` is null while the room is still in the "unplaced" palette.
 * `floor` is integer storey number:
 *   -2, -1  = basement / sub-basement
 *    0      = ground floor
 *    1, 2…  = first floor, second floor, etc.
 * `rotationDeg` rotates the rectangle about its top-left corner.
 */
export type RoomPlacement = {
  positionM: { x: number; z: number } | null;
  rotationDeg: RoomRotationDeg;
  floor: number;
};

/**
 * Room shape. "rectangle" is the default and uses walls[0]/walls[1]
 * as width / length. "l-shape" carves an axis-aligned bite out of one
 * corner — captured with two extra numbers (notchW × notchL).
 * "custom" uses an explicit `floorPolygonM` array of (x, z) points
 * traced by the customer; falls back to rectangle if absent.
 */
/**
 * A flight of stairs within a room.
 *
 * Stairs existed only as a connection *between* rooms, which records
 * that two floors are linked but gives the architect nothing to draw —
 * no width, no direction, no position. A staircase is one of the larger
 * objects in a house and one of the few that genuinely constrains a
 * design, so it was conspicuous by its absence on every plan.
 */
export type RoomStairs = {
  id: string;
  /** Clear width of the flight, in metres (string for form binding). */
  widthM: string;
  /** Which way the flight goes when you walk onto it from this room. */
  direction: "up" | "down";
  /** Wall the flight runs along or rises from. Optional. */
  wallIndex?: number;
  /** Distance from that wall's start corner to the bottom step. */
  positionM?: string;
  /** See Opening.positionApprox — same distinction, same reason. */
  positionApprox?: boolean;
  /** Number of treads, if the customer counted them. */
  treads?: string;
  /** Winders, half-landing, spiral, cupboard beneath, and so on. */
  notes?: string;
};

export type RoomShape = "rectangle" | "l-shape" | "custom";

/**
 * A fixed thing in a room: sanitaryware, kitchen units, radiators.
 *
 * These were captured nowhere at all. A bathroom arrived as a box with
 * a door and a window, and the only record that it contained a toilet
 * was whichever photograph happened to include one — so their
 * positions reached the drawing as somebody's recollection, if at all.
 * For a bathroom or kitchen the fixture layout is most of the design
 * constraint, which makes it an odd thing to have been leaving out.
 *
 * Position is the fixture's CENTRE in room-local metres, on the same
 * axes as `floorPolygonM`: x rightwards, z downwards from the room's
 * top-left corner. Storing the centre rather than a corner means
 * rotation is about the middle of the object, which is what dragging a
 * rotate handle looks like it should do.
 */
export type FixtureKind =
  | "toilet"
  | "basin"
  | "bath"
  | "shower"
  | "sink"
  | "cooker"
  | "fridge"
  | "radiator"
  | "cupboard";

export type RoomFixture = {
  id: string;
  kind: FixtureKind;
  /** Centre of the fixture, room-local metres. */
  positionM: { x: number; z: number };
  /** Cardinal rotation. Which way it faces. */
  rotationDeg: RoomRotationDeg;
  /**
   * Overrides for the standard size, in metres.
   *
   * Absent means "the usual size for this thing" (see FIXTURE_SIZES_M).
   * Present means the customer measured it and it is not standard —
   * a distinction worth keeping, because a 1.7 m bath assumed and a
   * 1.7 m bath measured are different facts to the person drawing it.
   */
  widthM?: string;
  depthM?: string;
  notes?: string;
};

/**
 * Real-world footprints in metres, width x depth, facing "up" at
 * rotation 0 — that is, the side you approach is the +z side.
 *
 * These are ordinary UK domestic sizes. They exist so a fixture drawn
 * on the plan is to scale rather than an icon of arbitrary size: a
 * plan where the bath is the same size as the toilet tells the
 * customer nothing about whether the layout works.
 */
export const FIXTURE_SIZES_M: Record<
  FixtureKind,
  { widthM: number; depthM: number; label: string }
> = {
  toilet: { widthM: 0.4, depthM: 0.7, label: "Toilet" },
  basin: { widthM: 0.55, depthM: 0.42, label: "Basin" },
  bath: { widthM: 1.7, depthM: 0.7, label: "Bath" },
  shower: { widthM: 0.9, depthM: 0.9, label: "Shower" },
  sink: { widthM: 0.6, depthM: 0.6, label: "Sink" },
  cooker: { widthM: 0.6, depthM: 0.6, label: "Cooker" },
  fridge: { widthM: 0.6, depthM: 0.65, label: "Fridge" },
  radiator: { widthM: 1.0, depthM: 0.1, label: "Radiator" },
  cupboard: { widthM: 0.6, depthM: 0.6, label: "Cupboard" },
};

/**
 * The footprint of a fixture as placed, in room-local metres.
 *
 * Returns the axis-aligned box after rotation, which for cardinal
 * rotations just means swapping width and depth at 90 and 270. Kept
 * here rather than in the editor so the plan, the DXF and any future
 * consumer agree on how big the thing is — three components each doing
 * their own version of this is how a bath ends up a different size in
 * the drawing than it was on screen.
 */
export function fixtureFootprintM(f: RoomFixture): {
  widthM: number;
  depthM: number;
} {
  const std = FIXTURE_SIZES_M[f.kind];
  const w = Number.parseFloat(f.widthM ?? "");
  const d = Number.parseFloat(f.depthM ?? "");
  const widthM = Number.isFinite(w) && w > 0 ? w : std.widthM;
  const depthM = Number.isFinite(d) && d > 0 ? d : std.depthM;
  const turned = f.rotationDeg === 90 || f.rotationDeg === 270;
  return turned
    ? { widthM: depthM, depthM: widthM }
    : { widthM, depthM };
}

export type RoomDraft = {
  id: string;
  name: string;
  walls: WallSegment[];
  ceilingHeightM: string;
  doors: Opening[];
  windows: Opening[];
  irregularNotes: string;
  notes: string;
  photos: RoomPhoto[];
  /**
   * Floor plan placement. Optional so older drafts (and drafts from the
   * Expo client that hasn't learned this field yet) still parse. When
   * absent, the UI treats the room as unplaced on the ground floor.
   */
  placement?: RoomPlacement;
  /** Shape preset; absent → "rectangle". */
  shape?: RoomShape;
  /** L-shape notch dimensions in metres (string for form binding). */
  notchWidthM?: string;
  notchLengthM?: string;
  /** Custom polygon — array of (x, z) metre points anti-clockwise. */
  floorPolygonM?: { x: number; z: number }[];
  /** Voice memos captured for this room. Optional; defaults to none. */
  voiceMemos?: RoomAudio[];
  /** Stairs within this room. Absent on rooms without any. */
  stairs?: RoomStairs[];
  /** Toilets, baths, kitchen units and so on. Absent on rooms without. */
  fixtures?: RoomFixture[];
  /**
   * True when these dimensions came from a scan rather than being typed.
   *
   * Drives whether the measurement fields start collapsed — there is
   * nothing for the customer to fill in on a scanned room — and tells
   * the architect that the numbers were produced by the sensor. Both
   * matter: a scanned 3.47 and a typed 3.47 were arrived at very
   * differently.
   */
  measuredByScan?: boolean;
  /**
   * Customer's assertion that every corner in this room is a right
   * angle. Optional; absent means "not stated", which is different from
   * "no" — we should not infer squareness from silence.
   *
   * When set, opposite walls in a four-wall room must match, so the app
   * can flag a mistyped length that would otherwise reach the architect
   * as a genuinely out-of-square room and be drawn that way.
   */
  cornersSquare?: boolean;
};

/**
 * Optional exterior + proposal pack — captured on a dedicated step
 * after the rooms. Each side of the house has its own photo slot so
 * the architect can visualise the building envelope; the proposal
 * block lets the customer paste a short brief plus optional sketches.
 */
/**
 * Four elevations, plus two anchors that are not sides of the house at
 * all.
 *
 * "Take a photo of the outside" gets you four pictures of walls. What
 * it does not get you is the boiler, the consumer unit, or the state
 * of the guttering — and those decide whether a job is quotable from
 * the desk or needs a second visit. A customer will never think to
 * photograph a consumer unit unasked; asked directly, it costs them
 * one tap.
 *
 * They live in the same record as the elevations because everything
 * downstream — state, draft, submission payload, media counter — keys
 * off it generically, so a new anchor is one string here and one
 * screen in GuidedExtrasFlow. Both are skippable like the rest.
 */
export type ExteriorSide =
  | "front"
  | "back"
  | "left"
  | "right"
  | "services"
  | "roof";

export type ExteriorPhotos = {
  /** Photos keyed by side. Each side may have 0..N photos. */
  bySide: Record<ExteriorSide, RoomPhoto[]>;
};

export type ProposalDraft = {
  /** Plain-text description of what the customer wants. */
  description: string;
  /** Free-form sketches / inspiration photos. */
  sketches: RoomPhoto[];
};

export type ProjectDraft = {
  customerName: string;
  email: string;
  projectName: string;
  unit: UnitPreference;
  rooms: RoomDraft[];
  exterior?: ExteriorPhotos;
  proposal?: ProposalDraft;
};
