/**
 * Apple RoomPlan Capacitor plugin — public API.
 *
 * RoomPlan is an iOS 16+ framework that drives the LiDAR sensor on
 * iPhone Pro / iPad Pro devices to produce a real, architect-grade 3D
 * sketch of a room. It returns walls, doors, windows and openings as
 * oriented boxes with metre-accurate dimensions.
 *
 * This plugin wraps Apple's `RoomCaptureView` — the first-party guided
 * scanning UI — so we inherit the "walk around the room" coaching that
 * Apple tunes for each OS release.
 *
 * Platforms:
 *   iOS 16+ with LiDAR   → native RoomPlan
 *   everything else      → isSupported() → false, startScan() rejects.
 *                           The overlay should fall back to corner-tap
 *                           (Plan A's manual mode) on those devices.
 */

export interface RoomPlanPlugin {
  /**
   * Returns whether this device can run Apple RoomPlan right now.
   * Two things must be true: iOS 16+ AND a LiDAR-equipped device.
   *
   * `reason` is present only when `supported === false`; the overlay
   * surfaces it verbatim so the user knows why the option is greyed
   * out ("no LiDAR sensor", "iOS too old", etc.).
   */
  isSupported(): Promise<{ supported: boolean; reason?: string }>;

  /**
   * Presents Apple's full-screen RoomCaptureView, blocks until the
   * user taps "Done" (resolve with rooms) or "Cancel" (reject).
   *
   * Must be invoked from a user gesture — tapping a button is fine.
   */
  startScan(options?: RoomPlanScanOptions): Promise<RoomPlanScanResult>;

  /**
   * Scan several rooms in sequence and merge them into one plan.
   *
   * Apple's StructureBuilder puts every room, wall and opening into a
   * single coordinate system, which is the difference between a list of
   * room sizes and an actual floor plan. It is also the only practical
   * source of door and window POSITIONS — asking a customer to measure
   * where along a wall each window sits is a lot of tapping.
   *
   * Needs iOS 17 (StructureBuilder), where `startScan` needs only 16.
   * Rejects with a readable reason on anything older.
   */
  startHouseScan(options?: RoomPlanScanOptions): Promise<RoomPlanScanResult>;

  /**
   * Can this device trace a floor with ARKit?
   *
   * A far lower bar than `isSupported`, which needs LiDAR. World
   * tracking runs on an A9 chip and better — every iPhone still in
   * use — so this is true almost everywhere `isSupported` is false.
   */
  isArTraceSupported(): Promise<{ supported: boolean; reason?: string }>;

  /**
   * Trace a room by tapping its corners, to real-world scale.
   *
   * The significant thing is what it does not need. Our camera
   * scanner works out a room's proportions from perspective, but a
   * photograph carries no scale, so the app asks the customer to
   * tape-measure the ceiling and derives everything from that. It is
   * a hard gate before the scanner will start, and an error in it
   * multiplies through every dimension in the room.
   *
   * ARKit gets scale from the device's own motion instead — visual
   * and inertial, no LiDAR, no reference object, nothing to measure.
   * This is the call that lets a customer measure a room having
   * brought nothing but the phone.
   */
  startArFloorTrace(options?: ArFloorTraceOptions): Promise<ArFloorTraceResult>;

  /**
   * Measure a ceiling height with the camera: tap the floor, then
   * the ceiling above it.
   *
   * This exists because of how the alternative reads, not because
   * the number is hard to get. A customer who has just traced a room
   * without touching a tape, and is then asked to go and measure the
   * ceiling by hand, reasonably concludes the app cannot really
   * measure — and wonders why they are doing the rest of the house
   * this way.
   *
   * More forgiving than tracing corners, because only the vertical
   * gap between the two taps is used. A tap that lands off to one
   * side costs nothing.
   */
  startArHeightMeasure(
    options?: ArFloorTraceOptions,
  ): Promise<ArHeightMeasureResult>;
}

export interface ArHeightMeasureResult {
  /** Floor to ceiling, in metres. Never outside 1.8–4.5. */
  heightM: number;
  durationS: number;
  complete: boolean;
  trackingQuality: "good" | "limited" | "poor";
  estimatedPoints: number;
}

export interface ArFloorTraceOptions {
  /** Shown at the top of the camera view, e.g. the room's name. */
  title?: string;
}

export interface ArFloorTraceResult {
  /**
   * The corners the customer tapped, in metres, in the order they
   * walked them. Same shape and frame as `RoomPlanRoom.floorPolygonM`,
   * so everything downstream treats a traced room and a scanned one
   * identically.
   */
  pointsM: { x: number; z: number }[];
  /**
   * Floor-to-ceiling height, when ARKit found a plane above the
   * camera at a plausible height. Absent rather than guessed — a room
   * with no detected ceiling carries none and the app asks.
   */
  heightM?: number;
  durationS: number;
  complete: boolean;
  /**
   * The worst tracking state seen during the trace, not the last.
   *
   * A trace that lost tracking halfway and recovered has a join in
   * it, and the measurements either side may not agree. Reported so
   * the app can say when a room was traced under poor conditions
   * rather than presenting every number with equal confidence.
   */
  trackingQuality: "good" | "limited" | "poor";
  /**
   * How many corners landed on ARKit's guess at the floor rather than
   * on floor it had actually mapped.
   *
   * Corners are the least-mapped part of any real room, because they
   * are where the furniture is, so some estimating is normal. A trace
   * where most of the corners were estimated is a trace to be less
   * sure of.
   */
  estimatedPoints: number;
  /**
   * The last camera frame, base64 JPEG, no data-URL prefix.
   *
   * So the screen reporting the measurements can show the room they
   * describe. Without it the customer steps out of a live view of
   * their own kitchen onto a blank page of figures, and a survey
   * that should feel like measuring a house starts feeling like
   * filling in a form.
   *
   * Downscaled and compressed hard, because it is displayed
   * blurred. Held for one screen and dropped — deliberately never
   * written into the saved draft, which is not the place for a
   * photograph of somebody's home.
   */
  frameJpegBase64?: string;
  /**
   * Doors and windows the customer marked, two corners each.
   *
   * A phone without LiDAR cannot find an opening by itself --
   * there is no depth mesh and RoomPlan's classifier is what
   * recognises one -- so this path used to return a bare outline
   * and a ceiling height. That is most iPhones: every non-Pro
   * model is on it.
   *
   * Detecting them from the camera was the obvious idea and the
   * wrong one. Vision finds bright rectangles on walls, and so do
   * mirrors, televisions, pictures and curtains; an invented
   * window on a drawing somebody prices glazing from is worse
   * than a missing one.
   *
   * So the customer points and the sensor measures: one side,
   * then the other. The width is the distance between them and
   * the position comes from the same two points, both to ARKit's
   * own accuracy. Nothing is typed.
   *
   * In the same frame as `pointsM` -- they are marked in the same
   * session, which is what lets them be dropped straight onto the
   * outline. See placeOpeningOnOutline.
   */
  openings?: ArTracedOpening[];
}

export interface ArTracedOpening {
  /** Drawn differently: a door swings, an opening is a plain gap. */
  kind: "door" | "window" | "opening";
  /** One side of the opening, in the same XZ frame as `pointsM`. */
  aM: { x: number; z: number };
  /** The other side. The gap between them is the width. */
  bM: { x: number; z: number };
}

/** Optional knobs for `startScan`. */
export interface RoomPlanScanOptions {
  /** Preferred unit for the in-view HUD. Default "m". */
  unit?: "m" | "ft";
  /**
   * Title string shown at the top of the capture view. Useful when
   * scanning several rooms back to back — e.g. "Kitchen", "Hallway".
   */
  title?: string;
}

/** Top-level response from `startScan`. */
export interface RoomPlanScanResult {
  /**
   * RoomPlan returns a single CapturedRoom per session, but we wrap it
   * in an array so the shape is forward-compatible with the iOS 17+
   * "RoomCaptureSession.merge" flow that stitches multiple scans.
   */
  rooms: RoomPlanRoom[];
  /** Wall-clock time from view present to finished processing, in seconds. */
  durationS: number;
  /**
   * True if the user finished normally. False would indicate partial
   * output (reserved for future use — right now a failed scan rejects
   * rather than resolving with `complete: false`).
   */
  complete: boolean;
  /** True when this came from startHouseScan and rooms share one frame. */
  merged?: boolean;
}

export interface RoomPlanRoom {
  id: string;
  /** Present on merged house scans: "Room 1", "Room 2", ... */
  name?: string;
  /**
   * A small JPEG of the room, taken the moment Done was pressed.
   *
   * Whole-property scans only. The camera is already in the room
   * and pointed at it, so the picture costs nothing -- and without
   * it the survey ends upstairs and the customer walks back down to
   * every room to photograph it. It is also the only thing that
   * tells somebody which room "Room 3 of 7" is.
   */
  frameJpegBase64?: string;
  /**
   * Which storey the room is probably on, from how high the phone
   * was when the room was finished.
   *
   * The shared AR session keeps one origin for the whole house, so
   * the phone's height is comparable between rooms and a staircase
   * moves it by far more than anything else a survey involves.
   * Counted up from the lowest room, so a basement start gives
   * 0, 1, 2 rather than making every floor wrong by one.
   *
   * A guess. The app confirms it rather than acting on it quietly.
   */
  floorGuess?: number;
  /**
   * Footprint corner in the SHARED coordinate system, present only on
   * merged house scans. This is where the room sits on the plan; the
   * width/length below are its size. Absent on single-room scans, where
   * there is no shared frame for a position to mean anything in.
   */
  originM?: { x: number; z: number };
  /**
   * Bearing of the room's longest wall in degrees clockwise from +X.
   * Merged scans only.
   */
  rotationDeg?: number;
  /**
   * The room's actual floor outline in the shared frame, corner by
   * corner. Merged scans only.
   *
   * width/length describe a bounding box, which is all a rectangular
   * room needs and a poor description of an L-shape, a bay or a splayed
   * corner. This is the real shape, and it is the main thing a scan can
   * record that somebody with a tape measure and a form cannot.
   */
  floorPolygonM?: { x: number; z: number }[];
  /** Longest axis-aligned dimension of the floor bounding box (metres). */
  widthM: number;
  /** Shorter axis-aligned dimension of the floor bounding box (metres). */
  lengthM: number;
  /** Tallest wall height (metres). */
  heightM: number;
  /** Shoelace area of the floor polygon (m²). */
  floorAreaM2: number;
  /** True if the floor polygon fills ≥ 90 % of its bounding rectangle. */
  rectangular: boolean;
  walls: RoomPlanWall[];
  doors: RoomPlanOpening[];
  windows: RoomPlanOpening[];
  /**
   * Cased openings: a doorway with no door in it.
   *
   * Reported separately by RoomPlan because it is a different thing
   * to draw — a gap in a wall with reveals and no leaf and no swing.
   * Common between a kitchen and a diner, and structurally the most
   * interesting of the three, since it is often where somebody has
   * already taken a wall out.
   */
  openings: RoomPlanOpening[];
  /**
   * Staircases, as boxes on the floor.
   *
   * Absent on older plugin builds, so treat an empty list and a
   * missing one the same way.
   */
  stairs?: RoomPlanStairs[];
  /**
   * Ids of the doorways the customer walked through, in order.
   *
   * This is how one room gets joined to the next without anybody
   * being asked a question. Each room is scanned in its own
   * coordinate system and has no idea where the others are, but
   * the doorway they walked out of this room by is the same
   * doorway they walk into the next room through -- and naming one
   * doorway from both sides is enough to fit two rooms together
   * exactly. See layoutFromDoorways in measure-core.
   *
   * Ids are from this room's own `doors` array, and only doorways
   * that survived into the finished capture appear: RoomPlan drops
   * and merges detections as its fit improves.
   *
   * Absent on older plugin builds.
   */
  doorwaysPassed?: string[];
}

/**
 * A flight of stairs, as the sensor saw it.
 *
 * Position, width and bearing, which is the part nobody can
 * reconstruct afterwards. Not which way is up: RoomPlan does not
 * report a direction of travel and the geometry does not imply one,
 * so the app asks.
 */
export interface RoomPlanStairs {
  id: string;
  /** Across the treads — the clear width, in metres. */
  widthM: number;
  /** How far the run travels horizontally, in metres. */
  runM: number;
  /** Centre of the flight, in the same XZ frame as the walls. */
  midpoint: { x: number; z: number };
  /** Bearing of the run in degrees clockwise from +X. */
  headingDeg: number;
  /** False when RoomPlan was only medium-confident it is a staircase. */
  confident: boolean;
}

export interface RoomPlanWall {
  id: string;
  /** Wall centre in room-local XZ metres (Y is vertical and ignored). */
  midpoint: { x: number; z: number };
  /** Start endpoint of the wall base line. */
  start: { x: number; z: number };
  /** End endpoint of the wall base line. */
  end: { x: number; z: number };
  lengthM: number;
  heightM: number;
  thicknessM: number;
}

export interface RoomPlanOpening {
  id: string;
  /** UUID of the wall this opening sits in, if the plugin could resolve it. */
  parentWallId?: string;
  widthM: number;
  heightM: number;
  /**
   * The opening's centre, in the same XZ frame as the walls and the
   * floor polygon.
   *
   * Prefer this over the wall id and offset below. A wall and a
   * floor-outline edge are different objects — RoomPlan's walls are
   * inner faces that stop short of the corners — so an offset
   * measured along one and applied to the other lands in the wrong
   * place, by the wall thickness at each end. A point does not have
   * that problem. See `placeOpeningOnOutline` in measure-core.
   */
  midpoint?: { x: number; z: number };
  /**
   * Distance from the parent wall's `start` endpoint to the CENTRE
   * of the opening, along the wall's length axis.
   *
   * This said "to the left edge" for a long time and the plugin has
   * always reported the centre. Nothing was broken by it — the app
   * reads it as the centre too — but it cost an afternoon of hunting
   * a half-width error that was never there.
   */
  offsetFromWallStartM?: number;
}
