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
export type RoomShape = "rectangle" | "l-shape" | "custom";

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
};

/**
 * Optional exterior + proposal pack — captured on a dedicated step
 * after the rooms. Each side of the house has its own photo slot so
 * the architect can visualise the building envelope; the proposal
 * block lets the customer paste a short brief plus optional sketches.
 */
export type ExteriorSide = "front" | "back" | "left" | "right";

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
