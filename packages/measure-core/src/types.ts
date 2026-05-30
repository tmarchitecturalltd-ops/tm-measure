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
};

export type ProjectDraft = {
  customerName: string;
  email: string;
  projectName: string;
  unit: UnitPreference;
  rooms: RoomDraft[];
};
