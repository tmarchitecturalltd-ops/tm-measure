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
  openings: RoomPlanOpening[];
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
   * Distance from the parent wall's `start` endpoint to the left edge
   * of the opening, along the wall's length axis. Useful for drawing
   * the door on a plan.
   */
  offsetFromWallStartM?: number;
}
