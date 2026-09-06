"use client";

/**
 * components/measure/MeasureIntakeForm.tsx
 *
 * Drop-in replacement for your current file. Diff against previous version:
 *   - Imports RoomScanReviewFlow instead of RoomScanOverlay
 *   - Adds applyScanResultToRoom() that consumes a structured ScanResult
 *     and preserves the audit-trail stamp in notes
 *   - Keeps the old applyScanToRoom() (unused) for one-commit rollback
 *   - Keeps the multi-room scan picker UI and `scanRoomId` state unchanged
 *
 * Everything else — project step, rooms step, review step, export buttons —
 * is byte-identical to your last uploaded version.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  projectTypeLabel,
  recordSubmission,
  type ProjectType,
} from "@/lib/recentSubmissions";
import {
  parseMeters,
  formatLengthDual,
  validateProject,
  scanOverallConfidence,
  makeRoomConnectionDraft,
  normalizeConnections,
  buildDetailedPlanDxf,
  type ConnectionKind,
  type ExteriorSide,
  type FieldIssue,
  type Opening,
  type ProjectDraft,
  type RoomConnectionDraft,
  type RoomAudio,
  type RoomDraft,
  type RoomPhoto,
  type RoomPlacement,
  type RoomShape,
  type RoomStairs,
  type ScanResult,
  type StairsShape,
  type WallSegment,
} from "@tm-designs/measure-core";
import type { ScanDimensions } from "@/components/measure/RoomScanOverlay";
import RoomScanReviewFlow from "@/components/measure/RoomScanReviewFlow";
import RoomScanOverlay from "@/components/measure/RoomScanOverlay";
import FloorPlanEditor from "@/components/measure/FloorPlanEditor";
import TutorialOverlay from "@/components/measure/TutorialOverlay";
import CustomShapeEditor from "@/components/measure/CustomShapeEditor";
import VoiceRecorder from "@/components/measure/VoiceRecorder";
import WallPositionPicker from "@/components/measure/WallPositionPicker";
import GuidedRoomFlow from "@/components/measure/GuidedRoomFlow";
import GuidedProjectFlow from "@/components/measure/GuidedProjectFlow";
import LengthHint from "@/components/measure/LengthHint";
import {
  RoomPlan,
  type RoomPlanScanResult,
} from "@tm-designs/capacitor-roomplan";
import {
  clearDraft,
  loadDraft,
  makeDebouncedSaver,
  type ProjectDraftSnapshot,
} from "@/lib/draftStorage";

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Compass hints for the wall label field.
 *
 * These are placeholders, never values. They used to be baked into the
 * default labels ("Wall 1 (e.g. North)"), which meant that unless the
 * customer retyped every one, the literal string "(e.g. North)" was
 * submitted, emailed, written to the spreadsheet and shown in the
 * architect console. The hint belongs on the input, not in the data.
 */
const WALL_HINTS = ["North", "East", "South", "West"] as const;

function wallHint(index: number): string {
  return `e.g. ${WALL_HINTS[index % WALL_HINTS.length]}`;
}

/**
 * Removes a trailing "(e.g. …)" hint from a wall label.
 *
 * Only needed for drafts autosaved before the hint moved to the input
 * placeholder — without it, a resumed draft would still submit
 * "Wall 1 (e.g. North)".
 */
function cleanWallLabel(label: string): string {
  return label.replace(/\s*\(e\.g\.[^)]*\)\s*$/i, "").trim();
}

/**
 * A stable random id for this install, used only for rate limiting.
 *
 * Not a fingerprint and not derived from anything about the device or
 * the person: it is a random string kept in local storage so repeated
 * submissions from one phone can be counted together. It is disclosed
 * as nothing because it identifies nothing — but it is worth being
 * clear in the code that this is a counter key, not analytics, so
 * nobody later mistakes it for one and starts reporting on it.
 *
 * Falls back to a fresh value when storage is unavailable (private
 * browsing, cleared data). That weakens the limit rather than breaking
 * submission, which is the right way round.
 */
const DEVICE_ID_KEY = "tm-measure:device-id:v1";

function getDeviceId(): string {
  const fresh = () =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    if (typeof window === "undefined") return fresh();
    const existing = window.localStorage.getItem(DEVICE_ID_KEY);
    if (existing && /^[A-Za-z0-9-]{8,64}$/.test(existing)) return existing;
    const id = fresh();
    window.localStorage.setItem(DEVICE_ID_KEY, id);
    return id;
  } catch {
    return fresh();
  }
}

function wallDefaults(): WallSegment[] {
  return [
    { id: newId(), label: "Wall 1", lengthM: "" },
    { id: newId(), label: "Wall 2", lengthM: "" },
    { id: newId(), label: "Wall 3", lengthM: "" },
    { id: newId(), label: "Wall 4", lengthM: "" },
  ];
}

function emptyRoom(): RoomDraft {
  return {
    id: newId(),
    name: "",
    walls: wallDefaults(),
    ceilingHeightM: "",
    doors: [],
    windows: [],
    irregularNotes: "",
    notes: "",
    photos: [],
  };
}

type Step = "project" | "rooms" | "exterior" | "proposal" | "plan" | "review";

/**
 * Camera / LiDAR scan feature flag.
 *
 * The auto-scan path is hidden in the customer-facing build until the
 * accuracy work is finished. Set `NEXT_PUBLIC_ENABLE_SCAN=1` in
 * `.env.local` to surface the buttons again for internal testing —
 * the underlying RoomScanOverlay + RoomPlan plugin code is left
 * intact so the feature can be flipped back on without a refactor.
 */
const SCAN_ENABLED = process.env.NEXT_PUBLIC_ENABLE_SCAN === "1";

export default function MeasureIntakeForm() {
  const [step, setStep] = useState<Step>("project");
  /**
   * Guided mode: one question per screen, on by default.
   *
   * The all-at-once card asks a homeowner about thirty things at once,
   * which is what a surveyor's form looks like and not what someone
   * standing in their kitchen can work through. Guided is the default
   * because most people filling this in have never done it before.
   *
   * It is a toggle rather than a replacement. If a guided step ever
   * misbehaves, someone part-way round a house must still have a route
   * to the end — "Show all at once" is that route, and it is the same
   * screen that has been shipping all along.
   */
  const [guidedMode, setGuidedMode] = useState(true);
  const [customerName, setCustomerName] = useState("");
  const [email, setEmail] = useState("");
  const [projectName, setProjectName] = useState("");
  const [projectType, setProjectType] = useState<ProjectType | null>(null);
  const [unit, setUnit] = useState<ProjectDraft["unit"]>("metric");
  const [unitLocked, setUnitLocked] = useState(false);
  /** Property-wide ceiling height. Asked once on the project step and
   *  used to pre-fill every room, which the customer can still override
   *  room by room inside the Add detail panel. */
  const [defaultCeilingHeightM, setDefaultCeilingHeightM] = useState("");

  /**
   * Capability probe — runs once on mount so the Project step can show the
   * user upfront whether AR (Apple RoomPlan) is available, or whether they
   * will be in manual-entry / corner-tap mode only. Cheap and offline-safe.
   */
  const [arSupport, setArSupport] = useState<"unknown" | "yes" | "no">("unknown");
  const [arReason, setArReason] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    // Race the RoomPlan probe against a 2 s timeout so a hung promise
    // (e.g. the Capacitor web fallback never resolving in dev mode)
    // doesn't leave the Project step stuck on "Checking AR capability…"
    // forever. After the timeout we assume corner-tap only.
    const timeout = new Promise<{ supported: false; reason: string }>((resolve) =>
      setTimeout(
        () =>
          resolve({
            supported: false,
            reason: "AR check timed out — using corner-tap mode.",
          }),
        2000,
      ),
    );
    (async () => {
      try {
        const r = await Promise.race([RoomPlan.isSupported(), timeout]);
        if (!alive) return;
        if (r.supported) {
          setArSupport("yes");
          setArReason(null);
        } else {
          setArSupport("no");
          setArReason(r.reason ?? null);
        }
      } catch {
        if (!alive) return;
        setArSupport("no");
        setArReason(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Pre-fill the project type from the home tile (e.g. /measure?type=loft).
  // Done on mount so we don't break SSR/static-export render paths.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = new URLSearchParams(window.location.search).get("type");
    const allowed: ProjectType[] = [
      "extension",
      "loft",
      "newbuild",
      "renovation",
      "garage",
      "other",
    ];
    if (raw && (allowed as string[]).includes(raw)) {
      setProjectType(raw as ProjectType);
    }
  }, []);
  const [rooms, setRooms] = useState<RoomDraft[]>([emptyRoom()]);
  // Room-to-room adjacency. Captured as form drafts; normalised at submit.
  const [connections, setConnections] = useState<RoomConnectionDraft[]>([]);
  /**
   * Floor-plan placements keyed by roomId. Kept in the form (not inside
   * each RoomDraft) so the FloorPlanEditor can edit positions without
   * racing against measurement-field edits on the Rooms step. Merged
   * into `payload.rooms[i].placement` on submission.
   */
  const [placements, setPlacements] = useState<Record<string, RoomPlacement>>({});
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  /** True after a saved draft has been offered/applied/declined. We
   *  block autosave until then so loading a draft doesn't immediately
   *  overwrite itself with an empty initial render. */
  const [draftHydrated, setDraftHydrated] = useState(false);
  /** A pending saved draft surfaced as a small banner. null while we
   *  haven't checked storage yet OR after the user has acted on it. */
  const [pendingDraft, setPendingDraft] = useState<ProjectDraftSnapshot | null>(null);
  /** Timestamp of the most recent autosave, surfaced in the header. The
   *  save itself already worked silently — showing it is what makes
   *  people willing to walk away mid-survey and come back. */
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  /** Re-render tick so the "x min ago" label ages without a save. */
  const [savedTick, setSavedTick] = useState(0);
  /**
   * Whether the last write to storage actually landed.
   *
   * null until the first attempt. false means the customer's work is
   * only in memory, which they need telling about before they close the
   * app rather than after.
   */
  const [draftSaveOk, setDraftSaveOk] = useState<boolean | null>(null);
  const draftSaver = useRef(
    makeDebouncedSaver<ProjectDraftSnapshot>(400, (ok) => {
      setDraftSaveOk(ok);
      // Only stamp the clock on a real save. Timestamping a failure
      // produces the worst outcome available: a confident "saved 2 min
      // ago" over nothing at all.
      if (ok) setLastSavedAt(Date.now());
    }),
  );
  const [scanRoomId, setScanRoomId] = useState<string | null>(null);
  /**
   * Confirmation of the last scan written into a room.
   *
   * The overlay used to close with no feedback whatsoever, so an
   * accurate scan that failed to reach the form was indistinguishable
   * from one that landed — which is exactly what was reported. Saying
   * what was written, and to which room, makes the two cases tell
   * themselves apart.
   */
  const [scanApplied, setScanApplied] = useState<string | null>(null);
  const [scanPickerOpen, setScanPickerOpen] = useState(false);
  const [submitStatus, setSubmitStatus] = useState<
    "idle" | "submitting" | "success" | "error"
  >("idle");
  const [submitError, setSubmitError] = useState<string | null>(null);
  /**
   * Media prepared / media total, while a submission is in flight.
   *
   * Every photo is decoded, resized and re-encoded on the main thread,
   * one after another, before anything is sent. A seven-room survey
   * with eleven images took about fifty seconds on a laptop — longer on
   * a phone — during which the button said only "Sending…". Someone who
   * has just spent twenty minutes measuring their house will read a
   * silent button as a crash and close the app. The loops already know
   * the counts, so show them.
   */
  const [submitProgress, setSubmitProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  /** Submission ID returned by the backend on a successful submit.
   *  Surfaced in the success card so the customer can paste it into
   *  /status if they want to check the architect's progress later. */
  const [lastSubmissionId, setLastSubmissionId] = useState<string | null>(null);

  const openBannerAutoScan = useCallback(() => {
    if (rooms.length === 0) return;
    if (rooms.length === 1) {
      // Via scanRoom, so this reaches the LiDAR scanner on a phone that
      // has one. Declared later in the file, hence the ref indirection:
      // scanRoom depends on arSupport and startRoomScan, both of which
      // are defined after this.
      scanRoomRef.current?.(rooms[0].id);
      return;
    }
    setScanPickerOpen(true);
  }, [rooms]);

  const roomDisplayLabel = useCallback((room: RoomDraft, index: number) => {
    const n = room.name.trim();
    return n ? n : `Room ${index + 1} (unnamed)`;
  }, []);

  const activeScanContext = useMemo(() => {
    if (!scanRoomId) return null;
    const index = rooms.findIndex((r) => r.id === scanRoomId);
    if (index < 0) return null;
    return { room: rooms[index], index };
  }, [scanRoomId, rooms]);

  /**
   * Legacy single-shot applier, kept for one-commit rollback.
   * No longer called — the review flow wraps the overlay and emits a
   * structured ScanResult instead of raw dimensions.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const applyScanToRoom = useCallback((roomId: string, d: ScanDimensions) => {
    const wm = d.widthM.toFixed(2);
    const lm = d.lengthM.toFixed(2);
    const hm = d.heightM.toFixed(2);
    setRooms((prev) =>
      prev.map((r) => {
        if (r.id !== roomId) return r;
        const walls = r.walls.map((w, i) => {
          if (i === 0) return { ...w, lengthM: wm };
          if (i === 1) return { ...w, lengthM: lm };
          if (i === 2) return { ...w, lengthM: wm };
          if (i === 3) return { ...w, lengthM: lm };
          return w;
        });
        const stamp = `[Auto-scan ${new Date().toISOString()} — W×L×H ${wm}×${lm}×${hm} m]`;
        return {
          ...r,
          walls,
          ceilingHeightM: hm,
          notes: r.notes.trim() ? `${r.notes.trim()}\n${stamp}` : stamp,
        };
      }),
    );
  }, []);

  /**
   * Stamp a reviewed ScanResult into a RoomDraft.
   *
   * - Walls fill the existing wall slots in order; extras are appended.
   * - Ceiling populates ceilingHeightM when present.
   * - Detected doors are appended to room.doors with a note.
   * - Audit trail (timestamp + overall confidence) is added to notes,
   *   matching the old applyScanToRoom behaviour so nothing is lost.
   */
  const applyScanResultToRoom = useCallback(
    (roomId: string, scan: ScanResult) => {
      setRooms((prev) =>
        prev.map((r) => {
          if (r.id !== roomId) return r;

          const wallMeasurements = scan.measurements.filter(
            (m) => m.kind === "wall",
          );
          const ceiling = scan.measurements.find((m) => m.kind === "ceiling");
          const doors = scan.measurements.filter((m) => m.kind === "door");
          // Windows were filtered for nowhere. A LiDAR scan detects them,
          // draws them in the model the customer is looking at, and then
          // the room arrived with an empty windows list — so a room with
          // three windows submitted as if it had none.
          const windows = scan.measurements.filter((m) => m.kind === "window");

          // A scan of a rectangular room returns two measurements —
          // width and length — but the room has four wall slots, where
          // 0/2 are the width pair and 1/3 the length pair (the same
          // contract setRectangleDim writes to).
          //
          // Filling slots in order left walls 2 and 3 empty. In
          // rectangle mode only Width and Length are shown, so the room
          // looked complete while failing validation on two walls the
          // customer could not see — and switching to L-shape suddenly
          // revealed "enter a length" against lengths already given.
          const isRect = (r.shape ?? "rectangle") === "rectangle";
          const mirrorPairs =
            isRect && wallMeasurements.length === 2 && r.walls.length >= 4;

          const nextWalls: WallSegment[] = r.walls.map((existing, i) => {
            const m = mirrorPairs
              ? wallMeasurements[i % 2]
              : wallMeasurements[i];
            return m
              ? {
                  id: existing.id,
                  // Keep the existing label on the mirrored pair; the
                  // scan only names the first two walls, and relabelling
                  // wall 3 as "Wall 1 (North)" would be wrong.
                  label: (mirrorPairs && i > 1 ? existing.label : m.label) || existing.label,
                  lengthM: m.valueM.toFixed(2),
                }
              : existing;
          });
          // Append any extra wall segments the scan produced beyond the
          // current slot count (e.g. L-shaped rooms).
          if (wallMeasurements.length > r.walls.length) {
            for (let i = r.walls.length; i < wallMeasurements.length; i++) {
              const m = wallMeasurements[i];
              nextWalls.push({
                id: newId(),
                label: m.label || `Wall ${i + 1}`,
                lengthM: m.valueM.toFixed(2),
              });
            }
          }

          const nextDoors: Opening[] = doors.length
            ? [
                ...r.doors,
                ...doors.map<Opening>((d) => ({
                  id: newId(),
                  widthM: d.valueM.toFixed(2),
                  note: d.note ?? "Detected by scan",
                })),
              ]
            : r.doors;

          const nextWindows: Opening[] = windows.length
            ? [
                ...r.windows,
                ...windows.map<Opening>((w) => ({
                  id: newId(),
                  widthM: w.valueM.toFixed(2),
                  note: w.note ?? "Detected by scan",
                })),
              ]
            : r.windows;

          const capturedAt =
            scan.context.capturedAt ?? new Date().toISOString();
          const overall = scanOverallConfidence(scan).toUpperCase();
          const wallSummary = nextWalls
            .slice(0, wallMeasurements.length)
            .map((w) => w.lengthM || "?")
            .join(" × ");
          const stamp = `[Auto-scan ${capturedAt} — ${wallSummary}${
            ceiling ? ` × ${ceiling.valueM.toFixed(2)}` : ""
          } m — overall ${overall}]`;

          return {
            ...r,
            walls: nextWalls,
            ceilingHeightM: ceiling
              ? ceiling.valueM.toFixed(2)
              : r.ceilingHeightM,
            doors: nextDoors,
            windows: nextWindows,
            // A scan that measured more than two walls has described a
            // shape a rectangle cannot hold. Rectangle mode shows only
            // Width and Length, so those extra walls would sit in the
            // payload, invisible and uneditable — the customer would be
            // submitting numbers they were never shown. Switching to
            // individual-wall editing puts every measured wall on
            // screen where it can be checked.
            shape:
              wallMeasurements.length > 2 ? "custom" : (r.shape ?? "rectangle"),
            measuredByScan: true,
            notes: r.notes.trim()
              ? `${r.notes.trim()}\n${stamp}`
              : stamp,
          };
        }),
      );
      // Same reasoning as the whole-house scan: this is the expensive
      // step and it finishes as the app returns from the native capture
      // view. Don't leave it sitting in a debounce timer.
      setTimeout(() => draftSaver.current.flush(), 0);
    },
    [],
  );

  /**
   * Turn a merged whole-property scan into rooms already placed on the plan.
   *
   * The single-room path fills in one room's dimensions and leaves the
   * customer to arrange rooms on a grid afterwards. A merged scan makes
   * that step unnecessary: every room arrives with its position in a
   * shared frame, so the floor plan is already correct and the DXF has
   * real geometry rather than rectangles someone dragged into place.
   */
  /** Rooms whose scanned measurements have been unfolded for checking. */
  const [measurementsOpen, setMeasurementsOpen] = useState<
    Record<string, boolean>
  >({});

  const [houseScanning, setHouseScanning] = useState(false);
  const [houseScanError, setHouseScanError] = useState<string | null>(null);

  /**
   * Which opening, if any, is currently being measured with the camera.
   *
   * Held as a description of where to write the answer rather than as a
   * callback, so it survives the re-renders the overlay causes while
   * the camera is running.
   */
  const [measureTarget, setMeasureTarget] = useState<{
    roomId: string;
    kind: "doors" | "windows" | "stairs";
    itemId: string;
    prompt: string;
  } | null>(null);

  const applyMeasuredDistance = useCallback(
    (metres: number) => {
      const t = measureTarget;
      if (!t) return;
      // Measured with the camera, so not approximate — but the scan's
      // own confidence caveat applies, which is why the notes ask for a
      // tape check on anything critical.
      setRooms((prev) =>
        prev.map((r) => {
          if (r.id !== t.roomId) return r;
          if (t.kind === "stairs") {
            return {
              ...r,
              stairs: (r.stairs ?? []).map((s) =>
                s.id === t.itemId
                  ? { ...s, positionM: String(metres), positionApprox: false }
                  : s,
              ),
            };
          }
          return {
            ...r,
            [t.kind]: r[t.kind].map((o) =>
              o.id === t.itemId
                ? { ...o, positionM: String(metres), positionApprox: false }
                : o,
            ),
          };
        }),
      );
      setMeasureTarget(null);
    },
    [measureTarget],
  );

  const applyHouseScan = useCallback((result: RoomPlanScanResult) => {
    const scanned = result.rooms ?? [];
    if (!scanned.length) return;

    const stamp = `[Whole-property LiDAR scan ${new Date().toISOString()} — ${scanned.length} room${scanned.length === 1 ? "" : "s"}]`;
    const nextPlacements: Record<string, RoomPlacement> = {};

    const built: RoomDraft[] = scanned.map((sr, i) => {
      const id = newId();

      // Use the individually measured walls when there are more than
      // two. Two walls means RoomPlan saw a plain rectangle, and the
      // width/length pair reads better in the form than "Wall 1, Wall 2".
      const wallLengths = (sr.walls ?? [])
        .map((w) => w.lengthM)
        .filter((n) => Number.isFinite(n) && n > 0);
      const useDetailed = wallLengths.length > 2;

      const walls: WallSegment[] = useDetailed
        ? wallLengths.map((lengthM, wi) => ({
            id: newId(),
            label: `Wall ${wi + 1}`,
            lengthM: lengthM.toFixed(2),
          }))
        : [
            { id: newId(), label: "Wall 1", lengthM: sr.widthM.toFixed(2) },
            { id: newId(), label: "Wall 2", lengthM: sr.lengthM.toFixed(2) },
            { id: newId(), label: "Wall 3", lengthM: sr.widthM.toFixed(2) },
            { id: newId(), label: "Wall 4", lengthM: sr.lengthM.toFixed(2) },
          ];

      // Rotation is snapped to a quarter turn because the plan editor
      // only models four orientations. A room scanned at 8° off-square
      // therefore sits square on screen. The measurements themselves are
      // unaffected — this is the drawn position only — but it is the one
      // place the merged scan loses information, and worth revisiting if
      // the editor ever learns arbitrary angles.
      const raw = sr.rotationDeg ?? 0;
      const snapped = (Math.round(raw / 90) * 90) % 360;
      const rotationDeg = ((snapped + 360) % 360) as 0 | 90 | 180 | 270;

      nextPlacements[id] = {
        positionM: sr.originM
          ? { x: Number(sr.originM.x.toFixed(3)), z: Number(sr.originM.z.toFixed(3)) }
          : null,
        rotationDeg,
        // RoomPlan reports no storey, so everything lands on the ground
        // floor. Moving a room upstairs is one tap in the plan editor;
        // guessing from ceiling heights would be worse than not guessing.
        floor: 0,
      };

      return {
        id,
        name: sr.name?.trim() || `Room ${i + 1}`,
        walls,
        /*
         * Ceiling height, with a fallback.
         *
         * RoomPlan does not always report a height — a room it could
         * not see the full height of comes back without one — and this
         * left the field empty. An empty ceiling height fails
         * validateCeiling, so those rooms could not be submitted, and
         * the customer had no idea which of the numbers the sensor
         * produced was the problem.
         *
         * Falling back to the property-wide default is what the manual
         * path already does for every new room. It is an assumption
         * either way; at least this one is stated once by the customer
         * rather than left blank and then complained about.
         */
        ceilingHeightM: sr.heightM
          ? sr.heightM.toFixed(2)
          : defaultCeilingHeightM.trim(),
        doors: (sr.doors ?? []).map((d) => ({
          id: newId(),
          widthM: d.widthM.toFixed(2),
          note: "Detected by scan",
        })),
        windows: (sr.windows ?? []).map((w) => ({
          id: newId(),
          widthM: w.widthM.toFixed(2),
          note: "Detected by scan",
        })),
        irregularNotes: "",
        notes: stamp,
        photos: [],
        shape: useDetailed ? "custom" : "rectangle",
        measuredByScan: true,
        // The real outline, translated from the shared frame into the
        // room's own coordinates — floorPolygonM is defined relative to
        // the room's anchor, while the scan reports it relative to the
        // whole property. Skipping that translation would place every
        // room's shape at the origin of the plan.
        //
        // Kept only when the room genuinely is not a rectangle. Storing
        // a four-corner polygon for a plain rectangular room adds a
        // second source of truth for the same shape, and the two would
        // eventually disagree.
        floorPolygonM:
          !sr.rectangular && (sr.floorPolygonM?.length ?? 0) >= 3 && sr.originM
            ? sr.floorPolygonM!.map((p) => ({
                x: Number((p.x - sr.originM!.x).toFixed(3)),
                z: Number((p.z - sr.originM!.z).toFixed(3)),
              }))
            : undefined,
      } satisfies RoomDraft;
    });

    setRooms((prev) => {
      // Drop rooms the customer never filled in — otherwise a scan of
      // six rooms lands alongside the blank starter room and they have
      // to work out which one is real.
      const kept = prev.filter(
        (r) => r.name.trim() || r.walls.some((w) => w.lengthM.trim()),
      );
      return [...kept, ...built];
    });
    setPlacements((prev) => ({ ...prev, ...nextPlacements }));
    setActiveRoomIndex(0);

    // Write it out now rather than waiting for the debounce.
    //
    // A scan is minutes of walking round a house and cannot be
    // re-taken from memory the way a mistyped wall length can. It also
    // lands at the moment the app is returning from the native capture
    // view, which is when iOS is most inclined to suspend it. The
    // 400 ms delay that makes typing feel smooth buys nothing here.
    //
    // Deferred a tick so the state updates above are committed and the
    // autosave effect has queued the new snapshot; flushing
    // synchronously would write the state as it was before the scan.
    setTimeout(() => draftSaver.current.flush(), 0);
  }, [defaultCeilingHeightM]);

  /**
   * Run a whole-property scan and fold the result into the form.
   *
   * Errors are shown inline rather than thrown away: the plugin rejects
   * with a readable reason — iOS too old, no LiDAR, or the merge failing
   * because two rooms could not be related to each other — and each of
   * those is something the person holding the phone can act on.
   */
  /**
   * LiDAR-scan a SINGLE room, straight onto the room the customer is in.
   *
   * The plugin has exposed `startScan` all along — it is declared in
   * definitions.ts and bridged in RoomPlanPlugin.m — and nothing in the
   * app ever called it. `RoomPlan.` appeared exactly twice in this file:
   * isSupported, and startHouseScan. So "Measure this room
   * automatically" opened the web corner-tap overlay, and a customer on
   * a 15 Pro got a camera and a set of crosshairs rather than the LiDAR
   * scanner their phone was bought for. Reported as not having "the
   * lidar features to submit a room", which is exactly right.
   *
   * Mapped onto the EXISTING room rather than appending a new one: the
   * customer opened this from inside a room they had already named, and
   * replacing it with "Room 1" would lose that.
   */
  const startRoomScan = useCallback(
    async (roomId: string) => {
      setHouseScanError(null);
      setHouseScanning(true);
      try {
        const result = await RoomPlan.startScan({ unit: "m" });
        const sr = result?.rooms?.[0];
        if (!sr) {
          setHouseScanError("The scan finished but no room came back.");
          return;
        }

        // Same rule as the whole-house path: more than two wall lengths
        // means RoomPlan saw something other than a plain rectangle.
        const wallLengths = (sr.walls ?? [])
          .map((w) => w.lengthM)
          .filter((n) => Number.isFinite(n) && n > 0);
        const useDetailed = wallLengths.length > 2;
        const walls: WallSegment[] = useDetailed
          ? wallLengths.map((lengthM, wi) => ({
              id: newId(),
              label: `Wall ${wi + 1}`,
              lengthM: lengthM.toFixed(2),
            }))
          : [
              { id: newId(), label: "Wall 1", lengthM: sr.widthM.toFixed(2) },
              { id: newId(), label: "Wall 2", lengthM: sr.lengthM.toFixed(2) },
              { id: newId(), label: "Wall 3", lengthM: sr.widthM.toFixed(2) },
              { id: newId(), label: "Wall 4", lengthM: sr.lengthM.toFixed(2) },
            ];

        setRooms((prev) =>
          prev.map((r) =>
            r.id !== roomId
              ? r
              : {
                  ...r,
                  walls,
                  ceilingHeightM: sr.heightM
                    ? sr.heightM.toFixed(2)
                    : r.ceilingHeightM || defaultCeilingHeightM.trim(),
                  doors: (sr.doors ?? []).map((d) => ({
                    id: newId(),
                    widthM: d.widthM.toFixed(2),
                    note: "Detected by scan",
                  })),
                  windows: (sr.windows ?? []).map((w) => ({
                    id: newId(),
                    widthM: w.widthM.toFixed(2),
                    note: "Detected by scan",
                  })),
                  shape: useDetailed ? "custom" : "rectangle",
                  measuredByScan: true,
                  // A single-room scan reports its outline in the room's
                  // own frame already — there is no shared property
                  // origin to subtract, unlike the merged house scan.
                  floorPolygonM:
                    !sr.rectangular && (sr.floorPolygonM?.length ?? 0) >= 3
                      ? sr.floorPolygonM!.map((pt) => ({
                          x: Number(pt.x.toFixed(3)),
                          z: Number(pt.z.toFixed(3)),
                        }))
                      : r.floorPolygonM,
                },
          ),
        );

        // A scan is minutes of walking, and it lands as the app returns
        // from the native capture view — the moment iOS is most likely
        // to suspend it. Don't leave it in a debounce timer.
        setTimeout(() => draftSaver.current.flush(), 0);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Cancelling is a choice, not a fault.
        if (!/cancel/i.test(message)) setHouseScanError(message);
      } finally {
        setHouseScanning(false);
      }
    },
    [defaultCeilingHeightM],
  );

  /**
   * "Measure this room" — whichever way this phone can.
   *
   * One entry point so the three buttons that offer scanning cannot
   * disagree about what scanning means. They all used to open the web
   * corner-tap overlay unconditionally, which on a LiDAR phone is the
   * worse of the two tools by a wide margin.
   */
  /**
   * Lets openBannerAutoScan reach scanRoom despite being declared
   * above it. Reordering the declarations would work too, but scanRoom
   * needs arSupport and startRoomScan, which sit lower still.
   */
  const scanRoomRef = useRef<((roomId: string) => void) | null>(null);

  const scanRoom = useCallback(
    (roomId: string) => {
      if (arSupport === "yes") {
        void startRoomScan(roomId);
        return;
      }
      setScanRoomId(roomId);
    },
    [arSupport, startRoomScan],
  );
  scanRoomRef.current = scanRoom;

  const startHouseScan = useCallback(async () => {
    setHouseScanError(null);
    setHouseScanning(true);
    try {
      const result = await RoomPlan.startHouseScan({ unit: "m" });
      applyHouseScan(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Cancelling is a choice, not a fault. Saying "Scan cancelled" in
      // red under the button reads like something went wrong.
      if (!/cancel/i.test(message)) {
        setHouseScanError(message);
      }
    } finally {
      setHouseScanning(false);
    }
  }, [applyHouseScan]);

  const setRoom = useCallback(
    (id: string, patch: Partial<RoomDraft>) => {
      setRooms((prev) =>
        prev.map((r) => (r.id === id ? { ...r, ...patch } : r)),
      );
    },
    [],
  );

  const addRoom = useCallback(() => {
    // New rooms inherit the property-wide ceiling height. Nearly every
    // home has one ceiling height throughout, so asking per room is
    // repetitive typing for no extra information.
    setRooms((prev) => [
      ...prev,
      { ...emptyRoom(), ceilingHeightM: defaultCeilingHeightM },
    ]);
  }, [defaultCeilingHeightM]);

  /* Property templates removed along with the Quick start panel.
     They pre-built a room list from an archetype, so the customer's
     first task was correcting a guess about their own house. Left as
     a note rather than silently deleted: the idea recurs, and it is
     worth knowing it was tried. */


  /**
   * Undo for deletions.
   *
   * Every delete in this form was immediate and silent. A customer who
   * mis-tapped "remove room" — on a target that until this release was
   * about 30 px across — lost a room's worth of tape work with no way
   * back, and quite possibly without noticing until the review screen.
   *
   * This keeps one snapshot of the rooms/connections/placements as they
   * were, and offers it back for a few seconds. One level only: an undo
   * stack invites a customer to hunt backwards through history, which
   * is a worse experience than "that was wrong, put it back".
   *
   * The blob URLs are the awkward part. Deleting used to revoke a
   * room's photo URLs immediately, which would make any restored room
   * come back with dead images — visually, a room whose photos have all
   * turned into broken boxes, which is arguably worse than losing it
   * cleanly. So revocation is deferred to the moment the undo window
   * closes, and cancelled if the customer takes the undo. The cost is
   * holding a few blobs for a few seconds longer.
   */
  const [undoAction, setUndoAction] = useState<{
    label: string;
    restore: () => void;
  } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRevoke = useRef<string[]>([]);

  /** Revoke whatever the lapsed deletion was holding, and clear the bar. */
  const settleUndo = useCallback(() => {
    for (const uri of pendingRevoke.current) URL.revokeObjectURL(uri);
    pendingRevoke.current = [];
    setUndoAction(null);
  }, []);

  const offerUndo = useCallback(
    (label: string, restore: () => void, revokeOnLapse: string[] = []) => {
      // A second deletion during the window settles the first: its
      // blobs are released and its snapshot is dropped, because we only
      // ever hold one.
      if (undoTimer.current) clearTimeout(undoTimer.current);
      for (const uri of pendingRevoke.current) URL.revokeObjectURL(uri);
      pendingRevoke.current = revokeOnLapse;
      setUndoAction({ label, restore });
      // Twelve seconds. Long enough to notice a mistake and reach the
      // button without hurrying; short enough that the bar is not still
      // sitting there covering the next question.
      undoTimer.current = setTimeout(settleUndo, 12000);
    },
    [settleUndo],
  );

  const takeUndo = useCallback(() => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    // Deliberately NOT revoking: the restored draft needs these URLs.
    pendingRevoke.current = [];
    undoAction?.restore();
    setUndoAction(null);
  }, [undoAction]);

  // Release anything still pending if the form unmounts mid-window,
  // rather than leaking the blobs for the life of the app process.
  useEffect(() => {
    return () => {
      if (undoTimer.current) clearTimeout(undoTimer.current);
      for (const uri of pendingRevoke.current) URL.revokeObjectURL(uri);
    };
  }, []);

  const removeRoom = useCallback(
    (id: string) => {
      // Capture only what is being removed, plus where it sat.
      //
      // Deleting a room also drops its connections and its floor-plan
      // placement, so putting back the room alone would return it
      // stranded — unplaced, and no longer recorded as leading
      // anywhere. All three come back together.
      //
      // Restoring a whole snapshot of `rooms` would be simpler and
      // wrong: the customer can keep typing during the twelve seconds
      // the offer is up, and an undo that rolls the entire form back to
      // a moment ago would silently discard those edits. Undoing a
      // deletion must undo the deletion and nothing else.
      const index = rooms.findIndex((r) => r.id === id);
      const doomed = rooms[index];
      const droppedConnections = connections.filter(
        (c) => c.roomAId === id || c.roomBId === id,
      );
      const droppedPlacement = placements[id];

      // Collected, not revoked. See offerUndo — these are released when
      // the undo window closes, so a restored room still has its
      // photographs.
      if (!doomed) return;
      const uris: string[] = [];
      for (const p of doomed.photos) uris.push(p.uri);
      for (const w of doomed.walls) {
        for (const p of w.photos ?? []) uris.push(p.uri);
      }
      for (const m of doomed.voiceMemos ?? []) uris.push(m.uri);

      setRooms((prev) => {
        const next = prev.filter((r) => r.id !== id);
        return next.length ? next : [emptyRoom()];
      });
      setConnections((prev) =>
        prev.filter((c) => c.roomAId !== id && c.roomBId !== id),
      );
      setPlacements((prev) => {
        if (!(id in prev)) return prev;
        const { [id]: _dropped, ...rest } = prev;
        return rest;
      });

      offerUndo(
        `Removed ${doomed.name?.trim() || "the room"}`,
        () => {
          setRooms((prev) => {
            // Already back (double-tapped undo, or a restore from
            // elsewhere) — do not add a duplicate.
            if (prev.some((r) => r.id === doomed.id)) return prev;
            const next = [...prev];
            // Deleting the last room substitutes a blank one; drop that
            // stand-in on the way back rather than leaving the customer
            // with an empty room they never asked for.
            const placeholder = next.findIndex(
              (r) =>
                r.name.trim() === "" &&
                r.walls.every((w) => !w.lengthM.trim()) &&
                !r.photos.length,
            );
            if (next.length === 1 && placeholder === 0) next.splice(0, 1);
            next.splice(Math.min(index, next.length), 0, doomed);
            return next;
          });
          setConnections((prev) => {
            const missing = droppedConnections.filter(
              (d) => !prev.some((c) => c.id === d.id),
            );
            return missing.length ? [...prev, ...missing] : prev;
          });
          if (droppedPlacement) {
            setPlacements((prev) =>
              doomed.id in prev
                ? prev
                : { ...prev, [doomed.id]: droppedPlacement },
            );
          }
        },
        uris,
      );
    },
    [rooms, connections, placements, offerUndo],
  );

  /**
   * Move a room up or down in the list. Order matters in the
   * architect email and the floor-plan rendering so the customer
   * gets to control the sequence.
   */
  const moveRoom = useCallback((id: string, dir: -1 | 1) => {
    setRooms((prev) => {
      const idx = prev.findIndex((r) => r.id === id);
      if (idx < 0) return prev;
      const targetIdx = idx + dir;
      if (targetIdx < 0 || targetIdx >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[targetIdx]] = [next[targetIdx], next[idx]];
      return next;
    });
  }, []);

  /**
   * Clone a room's shape — walls, doors, windows — but not its media.
   *
   * Media is deliberately not carried over, for two reasons. The blob
   * URL is a shared handle: copying it gave both rooms the same string,
   * so deleting a photo from the copy revoked the blob and silently
   * broke the original, which then failed to upload with no error.
   *
   * And even with that fixed, duplicating photos is wrong on the
   * merits — a photograph of the master bedroom is not evidence for
   * bedroom 2, and sending the same image against two rooms misleads
   * whoever reads the survey. Duplicate copies measurements; the
   * customer photographs each room itself.
   */
  const duplicateRoom = useCallback((id: string) => {
    setRooms((prev) => {
      const idx = prev.findIndex((r) => r.id === id);
      if (idx < 0) return prev;
      const src = prev[idx];
      const copy: RoomDraft = {
        ...src,
        id: newId(),
        name: src.name ? `${src.name} (copy)` : "",
        walls: src.walls.map((w) => ({
          ...w,
          id: newId(),
          photos: [],
        })),
        doors: src.doors.map((d) => ({ ...d, id: newId() })),
        windows: src.windows.map((w) => ({ ...w, id: newId() })),
        photos: [],
        voiceMemos: [],
        // Reset placement so the duplicate appears in the unplaced
        // palette instead of stacking on top of the original.
        placement: undefined,
      };
      const next = [...prev];
      next.splice(idx + 1, 0, copy);
      return next;
    });
  }, []);

  const updatePlacement = useCallback(
    (roomId: string, placement: RoomPlacement) => {
      setPlacements((prev) => ({ ...prev, [roomId]: placement }));
    },
    [],
  );

  const addConnection = useCallback(() => {
    setConnections((prev) => [...prev, makeRoomConnectionDraft()]);
  }, []);

  const updateConnection = useCallback(
    (id: string, patch: Partial<RoomConnectionDraft>) => {
      setConnections((prev) =>
        prev.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      );
    },
    [],
  );

  const removeConnection = useCallback((id: string) => {
    setConnections((prev) => prev.filter((c) => c.id !== id));
  }, []);

  /**
   * Rectangular rooms: write one dimension onto both of its opposite
   * walls. A rectangle only has two distinct measurements, so asking for
   * four numbers is asking the customer to type each one twice — and
   * gives them two chances to introduce a typo the validator can't spot.
   *
   * Slots: walls[0] and walls[2] are the width pair, walls[1] and
   * walls[3] the length pair, matching the RoomShape contract where
   * walls[0]/walls[1] are width/length.
   */
  const setRectangleDim = useCallback(
    (roomId: string, which: "width" | "length", value: string) => {
      const slots = which === "width" ? [0, 2] : [1, 3];
      setRooms((prev) =>
        prev.map((r) => {
          if (r.id !== roomId) return r;
          const walls = r.walls.map((w, i) =>
            slots.includes(i) ? { ...w, lengthM: value } : w,
          );
          return { ...r, walls };
        }),
      );
    },
    [],
  );

  /** Per-room toggle for the manual wall-by-wall editor. */
  const [openWallsRooms, setOpenWallsRooms] = useState<Record<string, boolean>>({});
  const isRectangle = (room: RoomDraft) => (room.shape ?? "rectangle") === "rectangle";
  /** Manual list is forced open for non-rectangles, and whenever a wall
   *  fails validation so the error is reachable. */
  const wallsEditorOpen = (room: RoomDraft, ri: number) =>
    // A scanned room keeps its wall list folded until the customer asks
    // to see it, whatever its shape — an eight-wall scan would otherwise
    // open to a wall of populated inputs nobody needs to touch.
    (room.measuredByScan && !measurementsOpen[room.id]
      ? false
      : !isRectangle(room)) ||
    (openWallsRooms[room.id] ??
      issues.some((i) => i.path.startsWith(`room-${ri}-wall-`)));

  const addWall = useCallback((roomId: string) => {
    setRooms((prev) =>
      prev.map((r) =>
        r.id === roomId
          ? {
              ...r,
              walls: [
                ...r.walls,
                {
                  id: newId(),
                  label: `Wall ${r.walls.length + 1}`,
                  lengthM: "",
                },
              ],
            }
          : r,
      ),
    );
  }, []);

  const removeWall = useCallback((roomId: string, wallId: string) => {
    setRooms((prev) =>
      prev.map((r) => {
        if (r.id !== roomId) return r;
        if (r.walls.length <= 3) return r;
        return { ...r, walls: r.walls.filter((w) => w.id !== wallId) };
      }),
    );
  }, []);

  /**
   * Change a room's shape, giving it the right number of wall slots.
   *
   * An L-shaped room has six walls. It was previously modelled as a
   * rectangle plus two "notch" numbers, which is a description of how
   * to cut the shape rather than a description of the room — nobody
   * stands in their lounge thinking about notch dimensions, and it
   * still presented four wall fields for a six-walled room.
   *
   * Extra slots are appended blank rather than guessed, and existing
   * lengths are never discarded: someone who types four walls and then
   * realises it is an L keeps what they entered.
   */
  const setShape = useCallback((roomId: string, shape: RoomShape) => {
    const wallsFor = (n: number, existing: WallSegment[]): WallSegment[] => {
      if (existing.length >= n) return existing;
      const added = Array.from({ length: n - existing.length }, (_, i) => ({
        id: newId(),
        label: `Wall ${existing.length + i + 1}`,
        lengthM: "",
      }));
      return [...existing, ...added];
    };
    setRooms((prev) =>
      prev.map((r) => {
        if (r.id !== roomId) return r;
        if (shape === "l-shape") {
          return { ...r, shape, walls: wallsFor(6, r.walls) };
        }
        return { ...r, shape, walls: wallsFor(4, r.walls) };
      }),
    );
  }, []);

  const addStairs = useCallback((roomId: string) => {
    setRooms((prev) =>
      prev.map((r) =>
        r.id === roomId
          ? {
              ...r,
              stairs: [
                ...(r.stairs ?? []),
                {
                  id: newId(),
                  widthM: "",
                  // Up is the common case: most rooms containing stairs
                  // are on the storey below the one they serve.
                  direction: "up",
                } satisfies RoomStairs,
              ],
            }
          : r,
      ),
    );
  }, []);

  const setStairs = useCallback(
    (roomId: string, stairsId: string, patch: Partial<RoomStairs>) => {
      setRooms((prev) =>
        prev.map((r) =>
          r.id === roomId
            ? {
                ...r,
                stairs: (r.stairs ?? []).map((s) =>
                  s.id === stairsId ? { ...s, ...patch } : s,
                ),
              }
            : r,
        ),
      );
    },
    [],
  );

  const removeStairs = useCallback(
    (roomId: string, stairsId: string) => {
      const room = rooms.find((r) => r.id === roomId);
      const at = (room?.stairs ?? []).findIndex((s) => s.id === stairsId);
      const flight = at >= 0 ? room!.stairs![at] : undefined;
      setRooms((prev) =>
        prev.map((r) =>
          r.id === roomId
            ? { ...r, stairs: (r.stairs ?? []).filter((s) => s.id !== stairsId) }
            : r,
        ),
      );
      if (!flight) return;
      offerUndo("Removed the stairs", () =>
        setRooms((prev) =>
          prev.map((r) => {
            if (r.id !== roomId) return r;
            const list = [...(r.stairs ?? [])];
            if (list.some((x) => x.id === flight.id)) return r;
            list.splice(Math.min(at, list.length), 0, flight);
            return { ...r, stairs: list };
          }),
        ),
      );
    },
    [rooms, offerUndo],
  );

  const addOpening = useCallback(
    (roomId: string, kind: "doors" | "windows") => {
      setRooms((prev) =>
        prev.map((r) =>
          r.id === roomId
            ? {
                ...r,
                [kind]: [
                  ...r[kind],
                  { id: newId(), widthM: "", note: "" } satisfies Opening,
                ],
              }
            : r,
        ),
      );
    },
    [],
  );

  const removeOpening = useCallback(
    (roomId: string, kind: "doors" | "windows", openingId: string) => {
      const room = rooms.find((r) => r.id === roomId);
      const at = room?.[kind].findIndex((o) => o.id === openingId) ?? -1;
      const opening = at >= 0 ? room![kind][at] : undefined;
      setRooms((prev) =>
        prev.map((r) => {
          if (r.id !== roomId) return r;
          const list = r[kind].filter((o) => o.id !== openingId);
          return { ...r, [kind]: list };
        }),
      );
      if (!opening) return;
      offerUndo(kind === "doors" ? "Removed a door" : "Removed a window", () =>
        setRooms((prev) =>
          prev.map((r) => {
            if (r.id !== roomId) return r;
            if (r[kind].some((o) => o.id === opening.id)) return r;
            const list = [...r[kind]];
            list.splice(Math.min(at, list.length), 0, opening);
            return { ...r, [kind]: list };
          }),
        ),
      );
    },
    [rooms, offerUndo],
  );

  /**
   * Is this picked file an image we should keep?
   *
   * iOS frequently hands over photos — HEIC ones especially — with an
   * EMPTY `type`. The obvious `type.startsWith("image/")` test then
   * rejects them silently: the picker opens, you choose a photo, and
   * nothing appears, with no error to explain it.
   *
   * So: trust an explicit image/* type, otherwise fall back to the file
   * extension, and if there's neither, accept it rather than silently
   * dropping the customer's photo.
   */
  const isImageFile = (file: File): boolean => {
    if (file.type) return file.type.startsWith("image/");
    const name = (file.name || "").toLowerCase();
    if (!name.includes(".")) return true;
    return /\.(jpe?g|png|heic|heif|webp|gif|tiff?|bmp|avif)$/.test(name);
  };

  /**
   * Turn a live FileList into plain RoomPhoto records, immediately.
   *
   * This must happen synchronously, before the caller resets the input's
   * value. A FileList is bound to its <input>, so `input.value = ""`
   * empties it — and because setState updaters run later, a deferred read
   * of `files` saw zero entries. The picker worked, a valid photo was
   * chosen, every check passed, and nothing was ever attached.
   */
  const filesToPhotos = (files: FileList | null): RoomPhoto[] => {
    if (!files?.length) return [];
    return Array.from(files)
      .filter(isImageFile)
      .map((file) => ({
        id: newId(),
        uri: URL.createObjectURL(file),
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
      }));
  };

  const attachPhotos = useCallback(
    (roomId: string, files: FileList | null) => {
      const added = filesToPhotos(files);
      if (!added.length) return;
      setRooms((prev) =>
        prev.map((r) =>
          r.id === roomId ? { ...r, photos: [...r.photos, ...added] } : r,
        ),
      );
    },
    // filesToPhotos is redefined each render but is pure, so an empty
    // dependency list is safe here.
    [],
  );

  const removePhoto = useCallback(
    (roomId: string, photoId: string) => {
      const room = rooms.find((r) => r.id === roomId);
      const at = room?.photos.findIndex((p) => p.id === photoId) ?? -1;
      const photo = at >= 0 ? room!.photos[at] : undefined;
      setRooms((prev) =>
        prev.map((r) =>
          r.id === roomId
            ? { ...r, photos: r.photos.filter((p) => p.id !== photoId) }
            : r,
        ),
      );
      if (!photo) return;
      // Revocation deferred, so an undone delete gets the image back
      // rather than a broken thumbnail.
      offerUndo(
        "Removed a photo",
        () =>
          setRooms((prev) =>
            prev.map((r) => {
              if (r.id !== roomId) return r;
              if (r.photos.some((p) => p.id === photo.id)) return r;
              const photos = [...r.photos];
              photos.splice(Math.min(at, photos.length), 0, photo);
              return { ...r, photos };
            }),
          ),
        [photo.uri],
      );
    },
    [rooms, offerUndo],
  );

  /**
   * Per-wall photo helpers. Wall-tied photos let the architect tie a
   * radiator/window/chimney photo to a specific wall on the plan.
   * We keep wall.photos optional — older drafts that don't carry the
   * field are handled gracefully via `wall.photos ?? []`.
   */
  const attachPhotosToWall = useCallback(
    (roomId: string, wallId: string, files: FileList | null) => {
      // Read the FileList now, not inside the updater — see filesToPhotos.
      const added = filesToPhotos(files);
      if (!added.length) return;
      setRooms((prev) =>
        prev.map((r) => {
          if (r.id !== roomId) return r;
          return {
            ...r,
            walls: r.walls.map((w) =>
              w.id === wallId
                ? { ...w, photos: [...(w.photos ?? []), ...added] }
                : w,
            ),
          };
        }),
      );
    },
    [],
  );

  const removePhotoFromWall = useCallback(
    (roomId: string, wallId: string, photoId: string) => {
      setRooms((prev) =>
        prev.map((r) => {
          if (r.id !== roomId) return r;
          return {
            ...r,
            walls: r.walls.map((w) => {
              if (w.id !== wallId) return w;
              const photo = (w.photos ?? []).find((p) => p.id === photoId);
              if (photo) URL.revokeObjectURL(photo.uri);
              return { ...w, photos: (w.photos ?? []).filter((p) => p.id !== photoId) };
            }),
          };
        }),
      );
    },
    [],
  );

  /** Composite "roomId/wallId" target for the shared file input. null
   *  means the next picked files go to the room (legacy path). */

  // ── Exterior (4-sides) photos ──────────────────────────────────────
  const [exteriorPhotos, setExteriorPhotos] = useState<
    Record<ExteriorSide, RoomPhoto[]>
  >({ front: [], back: [], left: [], right: [] });

  const attachExteriorPhotos = useCallback(
    (side: ExteriorSide, files: FileList | null) => {
      // Read the FileList now, not inside the updater — see filesToPhotos.
      const added = filesToPhotos(files);
      if (!added.length) return;
      setExteriorPhotos((prev) => ({
        ...prev,
        [side]: [...prev[side], ...added],
      }));
    },
    [],
  );

  const removeExteriorPhoto = useCallback((side: ExteriorSide, photoId: string) => {
    setExteriorPhotos((prev) => {
      const photo = prev[side].find((p) => p.id === photoId);
      if (photo) URL.revokeObjectURL(photo.uri);
      return { ...prev, [side]: prev[side].filter((p) => p.id !== photoId) };
    });
  }, []);

  // ── Proposal (description + sketches) ──────────────────────────────
  const [proposalDescription, setProposalDescription] = useState("");
  const [proposalSketches, setProposalSketches] = useState<RoomPhoto[]>([]);

  const attachProposalSketches = useCallback((files: FileList | null) => {
    // Read the FileList now, not inside the updater — see filesToPhotos.
    const added = filesToPhotos(files);
    if (!added.length) return;
    setProposalSketches((prev) => [...prev, ...added]);
  }, []);

  const removeProposalSketch = useCallback((photoId: string) => {
    setProposalSketches((prev) => {
      const photo = prev.find((p) => p.id === photoId);
      if (photo) URL.revokeObjectURL(photo.uri);
      return prev.filter((p) => p.id !== photoId);
    });
  }, []);

  const goRooms = () => {
    const v: FieldIssue[] = [];
    if (!customerName.trim()) v.push({ path: "name", message: "Enter your name." });
    if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      v.push({ path: "email", message: "Enter a valid email." });
    if (!projectName.trim())
      v.push({ path: "project", message: "Name your project." });
    setIssues(v);
    if (v.length) return;
    // Lock the unit once the project is committed so subsequent room/plan
    // steps can't accidentally swap metric ↔ imperial mid-survey.
    setUnitLocked(true);
    setStep("rooms");
  };

  /**
   * Force the pending save out when the app goes away.
   *
   * The saver waits 400 ms for typing to settle, and nothing was ever
   * flushing it. On iOS a backgrounded WKWebView can be suspended and
   * then killed outright, and a pending setTimeout dies with it — so
   * the last 400 ms of work was never written, and the app had already
   * been claiming it was saved.
   *
   * The window that matters most is right after a LiDAR scan: the
   * customer finishes capturing a room, the app is mid-transition back
   * from the native capture view, and that is exactly the moment iOS is
   * most likely to suspend it. A whole room's geometry sat in a 400 ms
   * timer that might never fire.
   *
   * visibilitychange covers backgrounding and app-switching; pagehide
   * covers navigation and the browser case. Both fire before suspension
   * rather than after, which is the only reason this works.
   */
  useEffect(() => {
    const saver = draftSaver.current;
    const flush = () => {
      if (document.visibilityState === "hidden") saver.flush();
    };
    const flushNow = () => saver.flush();
    document.addEventListener("visibilitychange", flush);
    window.addEventListener("pagehide", flushNow);
    return () => {
      document.removeEventListener("visibilitychange", flush);
      window.removeEventListener("pagehide", flushNow);
      // Unmounting is also a departure — write what's outstanding
      // rather than dropping it.
      saver.flush();
    };
  }, []);

  // Offer any previously-saved draft when the form first mounts.
  useEffect(() => {
    const draft = loadDraft();
    if (draft) setPendingDraft(draft);
    setDraftHydrated(true);
  }, []);

  // Autosave whenever any tracked field changes — debounced inside the
  // saver. Skips until the initial draft-offer step has settled.
  useEffect(() => {
    if (!draftHydrated || pendingDraft) return;
    draftSaver.current.schedule({
      step,
      customerName,
      email,
      projectName,
      projectType,
      unit,
      unitLocked,
      defaultCeilingHeightM,
      proposalDescription,
      rooms: rooms as unknown as Array<Record<string, unknown>>,
      connections: connections as unknown as Array<Record<string, unknown>>,
      placements: placements as unknown as Record<string, unknown>,
    });
    // No setLastSavedAt here: the write has not happened yet. The
    // saver's callback stamps it once it actually has.
  }, [
    defaultCeilingHeightM,
    proposalDescription,
    draftHydrated,
    pendingDraft,
    step,
    customerName,
    email,
    projectName,
    projectType,
    unit,
    unitLocked,
    rooms,
    connections,
    placements,
  ]);

  const applyPendingDraft = useCallback(() => {
    if (!pendingDraft) return;
    setStep(pendingDraft.step);
    setCustomerName(pendingDraft.customerName);
    setEmail(pendingDraft.email);
    setProjectName(pendingDraft.projectName);
    setProjectType(pendingDraft.projectType as ProjectType | null);
    setUnit(pendingDraft.unit);
    setUnitLocked(pendingDraft.unitLocked);
    setDefaultCeilingHeightM(pendingDraft.defaultCeilingHeightM ?? "");
    setProposalDescription(pendingDraft.proposalDescription ?? "");
    setRooms(pendingDraft.rooms as unknown as RoomDraft[]);
    setConnections(pendingDraft.connections as unknown as RoomConnectionDraft[]);
    setPlacements(pendingDraft.placements as unknown as Record<string, RoomPlacement>);
    setPendingDraft(null);
  }, [pendingDraft]);

  const discardPendingDraft = useCallback(() => {
    clearDraft();
    setPendingDraft(null);
  }, []);

  /**
   * Filter validator output so a missing photo doesn't block mid-flow
   * navigation. The hard check still runs at `submitToBackend`, but
   * during testing on iPhone Safari (where the file picker can be
   * fiddly) we don't want the user stuck on the rooms step.
   */
  const nonBlockingIssues = (rooms: RoomDraft[]) =>
    validateProject(rooms).filter((i) => !/-photos$/.test(i.path));

  /**
   * Which room the first issue belongs to, from paths like
   * "room-2-wall-0". Null when the issue isn't room-scoped.
   */
  const firstIssueRoomIndex = (list: FieldIssue[]): number | null => {
    for (const i of list) {
      const m = /^room-(\d+)-/.exec(i.path);
      if (m) {
        const ri = Number(m[1]);
        if (Number.isInteger(ri) && ri >= 0 && ri < rooms.length) return ri;
      }
    }
    return null;
  };

  /**
   * Advance a step, or send the customer to where the problem actually is.
   *
   * Two things conspired to make a failed check invisible. Every error
   * anchor lives in the project and rooms steps, so validating from the
   * plan step rendered the result on a screen the customer wasn't on.
   * And the rooms step pages one room at a time, so even landing there
   * showed the wrong room — the customer saw fields they had correctly
   * filled while being told sizes were missing, because the offending
   * room was a different page.
   *
   * So: go to the rooms step *and* page to the room at fault.
   */
  const advanceTo = (next: "plan" | "review") => {
    const v = nonBlockingIssues(rooms);
    setIssues(v);
    if (v.length) {
      const ri = firstIssueRoomIndex(v);
      if (ri !== null) setActiveRoomIndex(ri);
      setStep("rooms");
      return;
    }
    // Checks pass, so clear any earlier "not ready to send" banner
    // rather than leaving a stale complaint on a step the customer has
    // just satisfied.
    if (submitStatus === "error") {
      setSubmitStatus("idle");
      setSubmitError(null);
    }
    setStep(next);
  };

  const goPlan = () => advanceTo("plan");

  const goReview = () => advanceTo("review");

  const issueFor = (path: string) => issues.find((i) => i.path === path)?.message;

  /**
   * Every outstanding issue, labelled with the room it belongs to and
   * which page of the pager that is.
   *
   * Naming only the first problem still left the customer hunting: one
   * room shows at a time, several fields sit behind a collapsed panel,
   * and a highlight they cannot see is no better than no highlight. So
   * list all of them, and say where each one lives.
   */
  const issueSummary = useMemo(
    () =>
      issues.map((i) => {
        const m = /^room-(\d+)-/.exec(i.path);
        if (!m) return { message: i.message, where: null as string | null };
        const ri = Number(m[1]);
        const room = rooms[ri];
        return {
          message: i.message,
          where: room
            ? `${roomDisplayLabel(room, ri)} — room ${ri + 1} of ${rooms.length}`
            : null,
        };
      }),
    [issues, rooms, roomDisplayLabel],
  );

  /* ── Progressive disclosure ──────────────────────────────────────
   * Only the essentials (name, shape, wall lengths, photos) stay on
   * screen. Doors, windows, ceiling override and free-text notes live
   * behind a per-room "Add detail" panel, so a simple rectangular room
   * is a handful of fields rather than a wall of them.
   */
  const [openDetailRooms, setOpenDetailRooms] = useState<Record<string, boolean>>({});

  /** Detail-panel fields that can fail validation. If one of them does
   *  we must force the panel open, otherwise the customer is told to fix
   *  something they cannot see. */
  const roomHasDetailIssue = (ri: number) =>
    issues.some(
      (i) =>
        i.path.startsWith(`room-${ri}-`) &&
        (i.path.includes("-ceiling") ||
          i.path.includes("-door") ||
          i.path.includes("-window")),
    );

  const isDetailOpen = (roomId: string, ri: number) =>
    openDetailRooms[roomId] ?? roomHasDetailIssue(ri);

  const toggleDetail = (roomId: string, ri: number) =>
    setOpenDetailRooms((prev) => ({
      ...prev,
      [roomId]: !(prev[roomId] ?? roomHasDetailIssue(ri)),
    }));

  // Age the "saved" label once a minute.
  useEffect(() => {
    if (!lastSavedAt) return;
    const t = setInterval(() => setSavedTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, [lastSavedAt]);

  /**
   * The saved-state line.
   *
   * Always says something. It used to render nothing until the first
   * save, so the customer's first several minutes — filling in their
   * name, naming rooms, typing the first wall lengths — happened with
   * no indication that any of it was being kept. "Am I going to lose
   * this if I close it?" is the question that stops people halfway,
   * and answering it costs one line.
   *
   * Says what it means in plain terms rather than "Draft saved". A
   * draft is our word for it. "You can close the app" is the thing the
   * customer actually wants to know.
   */
  const savedLabel = useMemo(() => {
    void savedTick; // dependency: recompute as the tick advances
    if (draftSaveOk === false) {
      return "Couldn't save on this device — finish in one go if you can";
    }
    if (!lastSavedAt) return "Your answers save as you go";
    const mins = Math.floor((Date.now() - lastSavedAt) / 60_000);
    if (mins < 1) return "Saved — you can close the app and come back";
    if (mins === 1) return "Saved 1 min ago — safe to close the app";
    if (mins < 60) return `Saved ${mins} min ago — safe to close the app`;
    const hrs = Math.floor(mins / 60);
    return `Saved ${hrs} hr${hrs === 1 ? "" : "s"} ago — safe to close the app`;
  }, [lastSavedAt, savedTick, draftSaveOk]);

  /* ── Room pager ─────────────────────────────────────────────────
   * One room on screen at a time. The full list was a very long scroll
   * with no sense of progress, which is the classic driver of drop-off
   * on long forms.
   */
  const [activeRoomIndex, setActiveRoomIndex] = useState(0);
  /** Top of the rooms pager — we scroll here whenever the room changes. */
  const roomsTopRef = useRef<HTMLDivElement | null>(null);

  // Only one room renders at a time, but the browser keeps your scroll
  // position when you switch — so a new room appeared mid-page and read
  // as "more of the same long form". Jump back to the top of the card so
  // each room genuinely feels like its own page.
  useEffect(() => {
    if (typeof window === "undefined") return;
    roomsTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [activeRoomIndex]);

  // Keep the pointer in range when rooms are removed.
  useEffect(() => {
    setActiveRoomIndex((i) => Math.min(i, Math.max(0, rooms.length - 1)));
  }, [rooms.length]);

  // A validation failure on a room the customer can't see is invisible,
  // so jump the pager to the first room that has an issue.
  useEffect(() => {
    if (!issues.length) return;
    for (let i = 0; i < rooms.length; i++) {
      if (issues.some((x) => x.path.startsWith(`room-${i}-`))) {
        setActiveRoomIndex(i);
        return;
      }
    }
  }, [issues, rooms.length]);

  /** Push the property default into any room the customer hasn't given
   *  an explicit ceiling height. Runs whenever the default changes so
   *  typing it once fills every blank room, without ever clobbering a
   *  value someone deliberately set. */
  useEffect(() => {
    const v = defaultCeilingHeightM.trim();
    if (!v) return;
    setRooms((prev) => {
      if (prev.every((r) => r.ceilingHeightM.trim())) return prev;
      return prev.map((r) =>
        r.ceilingHeightM.trim() ? r : { ...r, ceilingHeightM: v },
      );
    });
  }, [defaultCeilingHeightM]);

  /** True when the room simply inherited the property default — drives
   *  the "same as property" tag so a pre-filled number never looks like
   *  something the customer typed. */
  const usesDefaultCeiling = (room: RoomDraft) =>
    !!defaultCeilingHeightM.trim() &&
    room.ceilingHeightM.trim() === defaultCeilingHeightM.trim();

  /** Short "2 windows, 1 door" badge so collapsed detail still tells the
   *  customer what's inside it. */
  const detailSummary = (room: RoomDraft): string => {
    const bits: string[] = [];
    if (room.doors.length)
      bits.push(`${room.doors.length} door${room.doors.length === 1 ? "" : "s"}`);
    if (room.windows.length)
      bits.push(
        `${room.windows.length} window${room.windows.length === 1 ? "" : "s"}`,
      );
    if ((room.notes ?? "").trim() || (room.irregularNotes ?? "").trim())
      bits.push("notes");
    return bits.join(", ");
  };

  /**
   * Auto-scroll to the first error.
   *
   * The form is long enough that a validation failure can easily land
   * off-screen, leaving the user staring at an unchanged page wondering
   * why nothing happened. Whenever the issue list or the submit banner
   * changes, jump to whichever error container sits highest in the
   * document and focus it for screen-reader users.
   *
   * The rAF + timeout pair gives React time to commit the error markup
   * (and any step change) before we measure positions.
   */
  useEffect(() => {
    const hasError = issues.length > 0 || submitStatus === "error";
    if (!hasError) return;
    if (typeof window === "undefined") return;

    let cancelled = false;
    const scroll = () => {
      if (cancelled) return;
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-error-anchor], [role="alert"]',
        ),
      ).filter((el) => el.offsetParent !== null); // skip hidden steps
      if (!candidates.length) return;
      // Highest in the document, not first in DOM order, so the topmost
      // visible problem wins regardless of markup nesting.
      const target = candidates.reduce((best, el) =>
        el.getBoundingClientRect().top < best.getBoundingClientRect().top
          ? el
          : best,
      );
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      // Make it programmatically focusable without adding it to the tab
      // order permanently.
      if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
    };

    const raf = requestAnimationFrame(() => window.setTimeout(scroll, 60));
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [issues, submitStatus, submitError, step]);

  const payload = useMemo(() => {
    const serialRooms = rooms.map((r) => {
      const p = placements[r.id];
      // Only emit the placement block when the user actually arranged
      // the room on the plan — keeps the payload tidy and keeps the
      // Apps Script side free to default-fill missing rows.
      const placement =
        p && p.positionM
          ? {
              floor: p.floor,
              rotationDeg: p.rotationDeg,
              positionM: {
                x: Number(p.positionM.x.toFixed(3)),
                z: Number(p.positionM.z.toFixed(3)),
              },
            }
          : undefined;
      return {
        id: r.id,
        name: r.name,
        walls: r.walls.map((w) => ({
          id: w.id,
          // Strips "(e.g. North)" from labels restored out of an older
          // autosaved draft, where the hint was part of the default value.
          label: cleanWallLabel(w.label),
          lengthM: parseMeters(w.lengthM),
          photos: (w.photos ?? []).map((p) => ({
            id: p.id,
            name: p.name,
            sizeBytes: p.sizeBytes,
            type: p.mimeType,
          })),
        })),
        ceilingHeightM: parseMeters(r.ceilingHeightM),
        doors: r.doors
          .filter((d) => d.widthM.trim())
          .map((d) => ({
            widthM: parseMeters(d.widthM),
            note: d.note || undefined,
            wallIndex: d.wallIndex,
            positionM: d.positionM ? parseMeters(d.positionM) : undefined,
            // Sent even when false. Whoever draws from this needs to
            // know whether a position was measured or eyeballed, and
            // omitting the flag would leave that ambiguous.
            positionApprox: d.positionM ? d.positionApprox === true : undefined,
          })),
        windows: r.windows
          .filter((w) => w.widthM.trim())
          .map((w) => ({
            widthM: parseMeters(w.widthM),
            note: w.note || undefined,
            wallIndex: w.wallIndex,
            positionM: w.positionM ? parseMeters(w.positionM) : undefined,
            positionApprox: w.positionM ? w.positionApprox === true : undefined,
          })),
        irregularShapeNotes: r.irregularNotes.trim() || undefined,
        notes: r.notes.trim() || undefined,
        stairs: (r.stairs ?? [])
          .filter((st) => st.widthM.trim())
          .map((st) => ({
            widthM: parseMeters(st.widthM),
            direction: st.direction,
            wallIndex: st.wallIndex,
            positionM: st.positionM ? parseMeters(st.positionM) : undefined,
            positionApprox: st.positionM ? st.positionApprox === true : undefined,
            treads: st.treads ? Number.parseInt(st.treads, 10) : undefined,
            notes: st.notes || undefined,
          })),
        shape: r.shape ?? "rectangle",
        // Undefined rather than false when unticked: the architect needs
        // to distinguish "the customer confirmed this is square" from
        // "nobody said", and false would collapse the two.
        cornersSquare: r.cornersSquare === true ? true : undefined,
        // Tells the architect the numbers came from the sensor rather
        // than a tape. A scanned 3.47 and a typed 3.47 were arrived at
        // very differently.
        measuredByScan: r.measuredByScan === true ? true : undefined,
        notchWidthM: r.notchWidthM ? parseMeters(r.notchWidthM) : undefined,
        notchLengthM: r.notchLengthM ? parseMeters(r.notchLengthM) : undefined,
        floorPolygonM: r.shape === "custom" ? r.floorPolygonM : undefined,
        photos: r.photos.map((p) => ({
          name: p.name,
          sizeBytes: p.sizeBytes,
          type: p.mimeType,
        })),
        placement,
      };
    });
    const serialConnections = normalizeConnections(connections).map((c) => ({
      id: c.id,
      roomAId: c.roomAId,
      roomAName: rooms.find((r) => r.id === c.roomAId)?.name?.trim() || undefined,
      roomBId: c.roomBId,
      roomBName: c.roomBId
        ? rooms.find((r) => r.id === c.roomBId)?.name?.trim() || undefined
        : undefined,
      kind: c.kind,
      stairsShape: c.stairsShape,
      widthM: c.widthM,
      notes: c.notes,
    }));
    // Exterior and proposal were collected by the form but never
    // reached this payload, so both steps were discarded on submit —
    // including the customer's description of the work they want,
    // which is the single most useful field in the survey.
    const serialExterior = (
      Object.keys(exteriorPhotos) as ExteriorSide[]
    ).reduce<Record<string, Array<Record<string, unknown>>>>((acc, side) => {
      acc[side] = exteriorPhotos[side].map((p) => ({
        id: p.id,
        name: p.name,
        sizeBytes: p.sizeBytes,
        type: p.mimeType,
      }));
      return acc;
    }, {});
    return {
      version: 1,
      submittedAt: new Date().toISOString(),
      // Lets the backend rate-limit per device instead of globally. A
      // single global counter meant one abuser could exhaust the hour's
      // allowance and lock out every real customer — the protection was
      // the attack. Random, stored locally, tied to nothing: it is not
      // an identifier for anything except "requests from this install",
      // and it is not used for tracking or analytics.
      deviceId: getDeviceId(),
      customerName: customerName.trim(),
      email: email.trim(),
      projectName: projectName.trim(),
      projectType: projectType ?? undefined,
      unitPreference: unit,
      rooms: serialRooms,
      connections: serialConnections,
      exterior: serialExterior,
      proposal: {
        description: proposalDescription.trim() || undefined,
        sketches: proposalSketches.map((p) => ({
          id: p.id,
          name: p.name,
          sizeBytes: p.sizeBytes,
          type: p.mimeType,
        })),
      },
    };
  }, [
    exteriorPhotos,
    proposalDescription,
    proposalSketches,
    rooms,
    connections,
    placements,
    customerName,
    email,
    projectName,
    projectType,
    unit,
  ]);

  /**
   * Build the CAD floor plan that travels with the submission.
   *
   * Generated at submit time rather than offered as a download: the
   * customer has no use for a DXF, and the architect had to redraw the
   * house from a list of numbers. One file, produced from measurements
   * that have already been checked on the review screen, opens straight
   * into CAD.
   *
   * Returns null when no room has been placed on the plan — an export
   * of unplaced rooms would stack every one of them at the origin,
   * which is worse than sending nothing.
   */
  type DxfFile = {
    name: string;
    mimeType: string;
    dataUri: string;
    sizeBytes: number;
  };

  const buildDxfAttachment = useCallback(():
    | (DxfFile & { plain: DxfFile })
    | null => {
    const entries = rooms
      .map((room) => {
        const p = placements[room.id];
        if (!p?.positionM) return null;
        return {
          room,
          anchor: { x: p.positionM.x, z: p.positionM.z },
          rotationDeg: p.rotationDeg ?? 0,
        };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);

    if (!entries.length) return null;

    // btoa is latin1-only and a room name can contain anything, so the
    // string is encoded as UTF-8 bytes first. Without this an accented
    // character in "Séjour" throws and takes the whole submission with
    // it.
    const encode = (dxf: string) => {
      const bytes = new TextEncoder().encode(dxf);
      let binary = "";
      bytes.forEach((b) => {
        binary += String.fromCharCode(b);
      });
      return { base64: btoa(binary), sizeBytes: bytes.length };
    };

    const safeName =
      projectName.trim().replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 40) ||
      "floor-plan";

    // Two drawings. The detailed one is what the architect works from;
    // the plain one is a clean base to build on when the detail is
    // wrong, which on a survey drawn from someone else's measurements
    // it sometimes will be.
    const detailed = buildDetailedPlanDxf(entries, {
      projectName: projectName.trim(),
      detailed: true,
    });
    const plain = buildDetailedPlanDxf(entries, {
      projectName: projectName.trim(),
      detailed: false,
    });

    const d = encode(detailed);
    const p = encode(plain);

    return {
      name: `${safeName}.dxf`,
      mimeType: "application/dxf",
      dataUri: `data:application/dxf;base64,${d.base64}`,
      sizeBytes: d.sizeBytes,
      plain: {
        name: `${safeName}-outline.dxf`,
        mimeType: "application/dxf",
        dataUri: `data:application/dxf;base64,${p.base64}`,
        sizeBytes: p.sizeBytes,
      },
    };
  }, [rooms, placements, projectName]);

  /**
   * Downscale a photo blob URL to a JPEG data URI under ~200 KB.
   *
   * Apps Script has a hard ~50 MB request body limit, and a typical
   * phone shot is 3–6 MB raw — so without compression a small project
   * could blow the limit. We canvas-resize to a max long edge of 1600 px
   * and re-encode as JPEG q=0.8. The architect still gets a clear image
   * for visual verification.
   */
  const compressPhotoForUpload = async (uri: string): Promise<string | null> => {
    try {
      const blob = await fetch(uri).then((r) => r.blob());
      const bitmap = await createImageBitmap(blob);
      const longEdge = Math.max(bitmap.width, bitmap.height);
      const scale = longEdge > 1600 ? 1600 / longEdge : 1;
      const w = Math.round(bitmap.width * scale);
      const h = Math.round(bitmap.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(bitmap, 0, 0, w, h);
      bitmap.close();
      return canvas.toDataURL("image/jpeg", 0.8);
    } catch {
      return null;
    }
  };

  const submitToBackend = async () => {
    // Architectural workflow Step 3 — anomaly gate. Run the full project
    // validator one last time before hitting the network; this catches
    // out-of-range dimensions (3-foot ceilings, 50m walls), missing
    // reference photos, and unnamed rooms. If anything fires we surface
    // it via the in-form issue panel rather than the submit-error banner,
    // and we send the user back to the rooms step to fix it.
    const anomalies = validateProject(rooms);
    if (anomalies.length) {
      setIssues(anomalies);
      // Page to the offending room, not just the rooms step — see
      // advanceTo. Landing on room 1 for a problem in room 3 reads as
      // the form rejecting values that are plainly correct.
      const ri = firstIssueRoomIndex(anomalies);
      if (ri !== null) setActiveRoomIndex(ri);
      // Leave guided mode on the way back.
      //
      // The guided takeover covers the viewport and shows one question
      // at a time, so it would hide the issue panel this branch just
      // populated — the customer would be returned to the rooms step
      // and shown no reason at all. The all-at-once view is where the
      // flagged fields are anchored.
      setGuidedMode(false);
      setStep("rooms");
      setSubmitStatus("error");
      // Name the actual problem and the room it belongs to.
      //
      // "We've highlighted them on the rooms step" told the customer
      // nothing: with one room per screen and several collapsed panels,
      // a highlight can sit somewhere they never scroll to, and the
      // commonest cause — photos dropped when a draft is resumed — has
      // no obvious connection to anything they just did.
      const first = anomalies[0];
      const where =
        ri !== null ? ` in ${roomDisplayLabel(rooms[ri], ri)}` : "";
      const more =
        anomalies.length > 1
          ? ` (${anomalies.length - 1} other${anomalies.length === 2 ? "" : "s"} to fix as well)`
          : "";
      setSubmitError(`${first.message}${where}.${more}`);
      return;
    }
    const endpoint = process.env.NEXT_PUBLIC_MEASURE_SUBMIT_URL;
    if (!endpoint) {
      setSubmitStatus("error");
      setSubmitError(
        "Submission endpoint is not configured. Please contact TM Designs at inquiries@tmdesignsltd.com.",
      );
      return;
    }
    setSubmitStatus("submitting");
    setSubmitError(null);
    // Count everything that has to be encoded before the request goes
    // out, so the customer sees movement rather than a frozen button.
    const totalMedia =
      rooms.reduce(
        (n, r) =>
          n +
          r.photos.length +
          r.walls.reduce((m, w) => m + (w.photos?.length ?? 0), 0) +
          (r.voiceMemos?.length ?? 0),
        0,
      ) +
      Object.values(exteriorPhotos).reduce((n, p) => n + p.length, 0) +
      proposalSketches.length;
    let doneMedia = 0;
    const tickMedia = async () => {
      doneMedia += 1;
      setSubmitProgress({ done: doneMedia, total: totalMedia });
      // Yield so the browser can actually paint the new count. Encoding
      // saturates the main thread, so without this the state updates but
      // the customer still sees a static number. setTimeout rather than
      // requestAnimationFrame: rAF doesn't fire in a backgrounded tab,
      // which would stall the submission indefinitely.
      await new Promise((r) => setTimeout(r, 0));
    };
    setSubmitProgress({ done: 0, total: totalMedia });
    try {
      // Walk each room's photos, compress + base64 each one, and merge
      // the dataUri back into the payload's photos array. Failures per
      // photo are silently dropped (so a corrupt photo doesn't take
      // down the whole submission).
      const photoUriByRoom: Record<string, Record<string, string>> = {};
      const wallPhotoUriByRoom: Record<string, Record<string, Record<string, string>>> = {};
      const voiceUriByRoom: Record<string, Record<string, string>> = {};

      // Audio blobs aren't down-sampled — they're already small (a 30s
      // memo at ~32 kbps is ~120 KB). Just base64 them.
      const audioToDataUri = async (uri: string): Promise<string | null> => {
        try {
          const blob = await fetch(uri).then((r) => r.blob());
          const reader = new FileReader();
          return await new Promise((resolve) => {
            reader.onload = () =>
              resolve(typeof reader.result === "string" ? reader.result : null);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(blob);
          });
        } catch {
          return null;
        }
      };
      for (const r of rooms) {
        photoUriByRoom[r.id] = {};
        wallPhotoUriByRoom[r.id] = {};
        voiceUriByRoom[r.id] = {};
        for (const p of r.photos) {
          const dataUri = await compressPhotoForUpload(p.uri);
          if (dataUri) photoUriByRoom[r.id][p.id] = dataUri;
          await tickMedia();
        }
        for (const w of r.walls) {
          wallPhotoUriByRoom[r.id][w.id] = {};
          for (const p of w.photos ?? []) {
            const dataUri = await compressPhotoForUpload(p.uri);
            if (dataUri) wallPhotoUriByRoom[r.id][w.id][p.id] = dataUri;
            await tickMedia();
          }
        }
        for (const m of r.voiceMemos ?? []) {
          const dataUri = await audioToDataUri(m.uri);
          if (dataUri) voiceUriByRoom[r.id][m.id] = dataUri;
          await tickMedia();
        }
      }
      // Exterior + proposal images, same treatment as room photos.
      const exteriorDataUris: Record<string, string> = {};
      for (const side of Object.keys(exteriorPhotos) as ExteriorSide[]) {
        for (const p of exteriorPhotos[side]) {
          const dataUri = await compressPhotoForUpload(p.uri);
          if (dataUri) exteriorDataUris[p.id] = dataUri;
          await tickMedia();
        }
      }
      const sketchDataUris: Record<string, string> = {};
      for (const p of proposalSketches) {
        const dataUri = await compressPhotoForUpload(p.uri);
        if (dataUri) sketchDataUris[p.id] = dataUri;
        await tickMedia();
      }
      const enrichedPayload = {
        ...payload,
        // The CAD drawing, generated from the measurements the customer
        // has just reviewed. Sent rather than offered as a download —
        // it is of no use to them and saves the architect redrawing the
        // house from a list of numbers. Null when nothing was placed on
        // the plan; the backend simply finds no file to upload.
        floorPlanDxf: buildDxfAttachment(),
        exterior: Object.fromEntries(
          Object.entries(payload.exterior).map(([side, photos]) => [
            side,
            photos.map((photo) => {
              const dataUri = exteriorDataUris[photo.id as string];
              return dataUri ? { ...photo, dataUri } : photo;
            }),
          ]),
        ),
        proposal: {
          ...payload.proposal,
          sketches: payload.proposal.sketches.map((photo) => {
            const dataUri = sketchDataUris[photo.id];
            return dataUri ? { ...photo, dataUri } : photo;
          }),
        },
        rooms: payload.rooms.map((r, ri) => {
          const sourceRoom = rooms[ri];
          if (!sourceRoom) return r;
          const uriMap = photoUriByRoom[sourceRoom.id] ?? {};
          const wallUriMap = wallPhotoUriByRoom[sourceRoom.id] ?? {};
          const voiceMap = voiceUriByRoom[sourceRoom.id] ?? {};
          return {
            ...r,
            photos: r.photos.map((photo, pi) => {
              const sourcePhoto = sourceRoom.photos[pi];
              const dataUri = sourcePhoto ? uriMap[sourcePhoto.id] : undefined;
              return dataUri ? { ...photo, dataUri } : photo;
            }),
            walls: r.walls.map((wall, wi) => {
              const sourceWall = sourceRoom.walls[wi];
              const wallUris = sourceWall ? wallUriMap[sourceWall.id] ?? {} : {};
              return {
                ...wall,
                photos: (wall.photos ?? []).map((photo) => {
                  const dataUri = wallUris[photo.id];
                  return dataUri ? { ...photo, dataUri } : photo;
                }),
              };
            }),
            voiceMemos: (sourceRoom.voiceMemos ?? []).map((m) => {
              const dataUri = voiceMap[m.id];
              return {
                id: m.id,
                name: m.name,
                type: m.mimeType,
                sizeBytes: m.sizeBytes,
                durationMs: m.durationMs,
                ...(dataUri ? { dataUri } : {}),
              };
            }),
          };
        }),
      };
      // Apps Script web apps reject preflighted requests. Sending as
      // text/plain keeps the request "simple" per CORS rules; the server
      // parses the body as JSON.
      const response = await fetch(endpoint, {
        method: "POST",
        mode: "cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(enrichedPayload),
      });
      if (!response.ok) {
        throw new Error(`Server responded ${response.status}`);
      }
      const data: { ok?: boolean; error?: string; submissionId?: string } =
        await response.json().catch(() => ({ ok: true }));
      if (data.ok === false) {
        throw new Error(data.error || "Submission was rejected.");
      }
      // Stamp the local "Recent submissions" log so the AppHome screen
      // can show it next time the user opens the app. Failures here
      // (quota, privacy mode) are silently ignored — the canonical
      // record lives in the Apps Script sheet.
      recordSubmission({
        id:
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        projectName: projectName.trim(),
        projectType: projectType,
        submittedAt: new Date().toISOString(),
        roomCount: rooms.length,
        remoteId: data.submissionId,
      });
      // Clear the autosaved draft now that the project is in the
      // architect's hands — next time the form opens it'll start fresh.
      clearDraft();
      setLastSubmissionId(data.submissionId ?? null);
      setSubmitProgress(null);
      setSubmitStatus("success");
    } catch (err) {
      setSubmitProgress(null);
      setSubmitStatus("error");
      // User-friendly mapping of common failure modes. Anything we
      // don't recognise falls through to the underlying message.
      const raw = err instanceof Error ? err.message : String(err);
      const name = err instanceof Error ? err.name : "";
      let friendly = raw;
      // Browsers word a failed request differently: Chrome says
      // "Failed to fetch", Safari says "Load failed", Firefox
      // "NetworkError". Only the Chrome phrasing was matched, so an
      // iPhone customer — the majority here — was shown a bare
      // "Load failed" instead of being told their draft was safe.
      // Match on the error type as well, since every one of these is
      // a TypeError however it is worded.
      if (
        name === "TypeError" ||
        /Failed to fetch|Load failed|NetworkError|network request failed|TypeError/i.test(
          raw,
        )
      ) {
        friendly = "Couldn't reach the server. Check your internet connection and try again — your draft is safe.";
      } else if (/Rate limit reached/i.test(raw)) {
        friendly = "We're rate-limited right now. Please try again in an hour — your draft is safe.";
      } else if (/Server responded 5\d\d/i.test(raw)) {
        friendly = "TM Designs' server is having a wobble. Please try again in a few minutes — your draft is safe.";
      } else if (/Server responded 4\d\d/i.test(raw)) {
        friendly = "The server refused this submission. Please email inquiries@tmdesignsltd.com if it keeps happening.";
      }
      // Keep the technical detail visible as a short reference. The
      // friendly text alone hid the HTTP status, which made a failed
      // submission impossible to diagnose without a rebuild — and it
      // gives the customer something concrete to quote in an email.
      setSubmitError(friendly === raw ? friendly : `${friendly} (ref: ${raw})`);
    }
  };

  const openMailtoFallback = () => {
    const body = encodeURIComponent(
      `TM Measure intake (summary)\n\n${JSON.stringify(payload, null, 2)}\n\nNote: attach photos from your device separately until upload is connected.`,
    );
    window.location.href = `mailto:inquiries@tmdesignsltd.com?subject=${encodeURIComponent(
      `Measurement intake — ${projectName}`,
    )}&body=${body}`;
  };

  /**
   * Is the guided takeover currently on screen?
   *
   * It covers the viewport, so the app header underneath it is not
   * merely redundant — it was rendering *over* the flow (header z-40,
   * flow z-30), which put the app title and the saved-state chip on top
   * of the guided screen and hid the menu button completely. Reported
   * as "can't see the burger options".
   *
   * Raising the flow above the header fixes the stacking; not drawing
   * the header at all is what makes the screen actually be about the
   * question, which was the point of the takeover.
   */
  const guidedActive = guidedMode && !pendingDraft && step === "rooms";
  /** Same, for the project step. */
  const guidedProjectActive = guidedMode && !pendingDraft && step === "project";
  /** Either takeover on screen — the app header stands down for both. */
  const anyTakeover = guidedActive || guidedProjectActive;

  // Clears the fixed header only. The status-bar inset is handled once
  // on the body in globals.css — adding it here as well would push the
  // content down by twice the inset.
  return (
    <div className={`min-h-screen bg-surface pb-28 ${anyTakeover ? "pt-0" : "pt-24"}`}>
      <TutorialOverlay />
      {!anyTakeover && (
      <header
        className="fixed left-0 right-0 top-0 z-40 border-b border-outline-variant/20 bg-surface/90 backdrop-blur-xl"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-4 md:px-6">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="material-symbols-outlined rounded-full p-2 text-primary transition-colors hover:bg-surface-container-low"
              aria-label="Back to home"
            >
              arrow_back
            </Link>
            <div>
              <p className="font-label text-sm font-bold uppercase tracking-widest text-primary">
                TM Measure
              </p>
              <h1 className="font-headline text-lg font-semibold text-on-surface">
                Self-measurement intake
              </h1>
            </div>
          </div>
          <span className="hidden items-center gap-1.5 rounded-full border border-outline-variant/40 bg-surface-container-lowest px-3 py-1.5 text-sm font-semibold text-on-surface-variant sm:inline-flex">
            <span
              className="material-symbols-outlined text-primary"
              style={{ fontSize: "14px" }}
              aria-hidden
            >
              schedule
            </span>
            ~15 min per room
          </span>
          {savedLabel && (
            <span
              aria-live="polite"
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold ${
                draftSaveOk === false
                  ? "bg-error/10 text-error"
                  : "bg-primary/10 text-primary"
              }`}
            >
              <span aria-hidden>{draftSaveOk === false ? "!" : "\u2713"}</span>
              {savedLabel}
            </span>
          )}
        </div>
      </header>
      )}

      <main className="mx-auto max-w-5xl px-4 md:px-6">
        <p className="mb-8 max-w-3xl text-sm leading-relaxed text-on-surface-variant">
          We&apos;ll walk you through each room —{" "}
          <strong className="font-semibold text-on-surface">
            walls, doors, windows, photos and notes
          </strong>{" "}
          — then a quick floor plan. Enter lengths in{" "}
          <strong className="font-semibold text-on-surface">metres</strong>; the
          review step shows metric and imperial side by side before anything is
          sent.
        </p>

        {/* Camera distance tool. Rendered outside the scan review flow
            because there is nothing to review: it returns one number,
            straight into the field that asked for it. */}
        {measureTarget && (
          <RoomScanOverlay
            open
            roomLabel=""
            distanceMode
            distancePrompt={measureTarget.prompt}
            onDistance={applyMeasuredDistance}
            onClose={() => setMeasureTarget(null)}
            onApply={() => setMeasureTarget(null)}
          />
        )}

        {activeScanContext && scanRoomId && (
          <RoomScanReviewFlow
            open
            roomLabel={roomDisplayLabel(
              activeScanContext.room,
              activeScanContext.index,
            )}
            roomId={scanRoomId}
            unit={unit}
            jobReference={projectName}
            onClose={() => setScanRoomId(null)}
            onApply={(scan) => {
              applyScanResultToRoom(scanRoomId, scan);
              // Show the room that was just measured. A scan can target
              // a room other than the one on screen — the banner opens
              // a picker when there are several — so measurements could
              // land correctly but out of sight.
              const updated = rooms.findIndex((r) => r.id === scanRoomId);
              if (updated >= 0) setActiveRoomIndex(updated);
              const walls = scan.measurements
                .filter((m) => m.kind === "wall")
                .map((m) => m.valueM.toFixed(2));
              const target =
                updated >= 0
                  ? roomDisplayLabel(rooms[updated], updated)
                  : "this room";
              setScanApplied(
                walls.length
                  ? `Applied ${walls.join(" × ")} m to ${target}.`
                  : `The scan returned no wall measurements, so ${target} was left unchanged.`,
              );
              setScanRoomId(null);
            }}
          />
        )}

        {scanPickerOpen && (
          <div
            className="fixed inset-0 z-[160] flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="scan-picker-title"
          >
            <button
              type="button"
              className="absolute inset-0 bg-black/55 backdrop-blur-sm"
              aria-label="Close room picker"
              onClick={() => setScanPickerOpen(false)}
            />
            <div className="relative max-h-[85vh] w-full max-w-md overflow-y-auto rounded-xl border border-outline-variant/30 bg-surface p-6 shadow-2xl">
              <h2
                id="scan-picker-title"
                className="font-headline text-xl text-on-surface"
              >
                Which room should we scan?
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-on-surface-variant">
                You have more than one room. Pick the space to measure — results
                will fill that room&apos;s wall lengths and ceiling height.
              </p>
              <ul className="mt-6 space-y-2">
                {rooms.map((room, ri) => (
                  <li key={room.id}>
                    <button
                      type="button"
                      onClick={() => {
                        scanRoom(room.id);
                        setScanPickerOpen(false);
                      }}
                      className="flex w-full items-center justify-between gap-3 rounded-lg border border-outline-variant/30 bg-surface-container-low px-4 py-4 text-left transition-colors hover:border-primary hover:bg-surface-container-high"
                    >
                      <span className="font-semibold text-on-surface">
                        {roomDisplayLabel(room, ri)}
                      </span>
                      <span className="shrink-0 rounded-full bg-inverse-surface/10 px-2.5 py-1 text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                        #{ri + 1}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => setScanPickerOpen(false)}
                className="mt-6 w-full rounded-lg border border-outline px-4 py-3 text-sm font-bold uppercase tracking-widest text-on-surface transition-colors hover:bg-surface-container-low"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Clickable step indicator. Each pill jumps to that step
            without re-running validation, so the user can flick back
            to amend earlier inputs without losing later progress.
            "review" can only be jumped to from later steps because
            the validator runs on entry to review anyway. */}
        {pendingDraft && (
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/40 bg-primary/10 p-4 text-sm text-on-surface">
            <div>
              <p className="font-semibold text-primary">Resume your previous project?</p>
              <p className="mt-1 text-sm text-on-surface-variant">
                We saved your draft from {new Date(pendingDraft.savedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })} on the <span className="font-semibold">{pendingDraft.step}</span> step. Photos aren&apos;t kept; you&apos;ll re-take any.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={applyPendingDraft}
                className="rounded-full bg-primary px-4 py-2 text-sm font-bold uppercase tracking-widest text-on-primary"
              >
                Resume
              </button>
              <button
                type="button"
                onClick={discardPendingDraft}
                className="rounded-full border border-outline-variant/40 px-4 py-2 text-sm font-bold uppercase tracking-widest text-on-surface"
              >
                Start fresh
              </button>
            </div>
          </div>
        )}

        <ol className="mb-10 flex flex-wrap gap-2 text-sm font-semibold uppercase tracking-wider text-on-surface-variant">
          {([
            { key: "project", label: "Your details" },
            { key: "rooms", label: "Rooms" },
            { key: "exterior", label: "Exterior" },
            { key: "proposal", label: "Proposal" },
            { key: "plan", label: "Floor plan" },
            { key: "review", label: "Review" },
          ] as const).map((s, i, arr) => {
            const active = step === s.key;
            // Steps before the current one render as "done" — gold tick
            // in a tinted pill — so the customer can see progress at a
            // glance. Purely visual; every pill stays clickable.
            const curIdx = arr.findIndex((x) => x.key === step);
            const done = i < curIdx;
            return (
              <li key={s.key}>
                <button
                  type="button"
                  onClick={() => setStep(s.key)}
                  aria-current={active ? "step" : undefined}
                  className={`inline-flex items-center gap-2 rounded-full py-1.5 pl-1.5 pr-4 transition ${
                    active
                      ? "bg-primary text-on-primary shadow-md shadow-primary/25"
                      : done
                        ? "border border-primary/30 bg-primary/10 text-primary hover:bg-primary/15"
                        : "border border-outline-variant/30 bg-surface-container-low hover:bg-surface-container-high"
                  }`}
                >
                  <span
                    className={`flex h-6 w-6 items-center justify-center rounded-full text-sm font-bold ${
                      active
                        ? "bg-on-primary/20 text-on-primary"
                        : done
                          ? "bg-primary/15 text-primary"
                          : "bg-surface-container-high text-on-surface-variant"
                    }`}
                    aria-hidden
                  >
                    {done ? (
                      <span
                        className="material-symbols-outlined"
                        style={{ fontSize: "14px" }}
                      >
                        check
                      </span>
                    ) : (
                      i + 1
                    )}
                  </span>
                  {s.label}
                </button>
              </li>
            );
          })}
        </ol>

        {step === "project" && !guidedProjectActive && (
          <section className="space-y-6 tm-lift rounded-2xl border border-outline-variant/30 bg-surface-container-low p-6 md:p-8">
            <h2 className="font-headline text-2xl text-on-surface">Project details</h2>
            <div className="grid gap-6 md:grid-cols-2">
              <div>
                <label className="font-label mb-2 block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                  Your name *
                </label>
                <input
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  className="w-full rounded-lg border border-outline-variant/40 bg-surface-container-lowest px-4 py-3 text-sm outline-none ring-primary/30 focus:border-primary/70 focus:ring-2"
                />
                {issueFor("name") && (
                  <p data-error-anchor className="mt-1 text-sm text-error">{issueFor("name")}</p>
                )}
              </div>
              <div>
                <label className="font-label mb-2 block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                  Email *
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-lg border border-outline-variant/40 bg-surface-container-lowest px-4 py-3 text-sm outline-none ring-primary/30 focus:border-primary/70 focus:ring-2"
                />
                {issueFor("email") && (
                  <p data-error-anchor className="mt-1 text-sm text-error">{issueFor("email")}</p>
                )}
              </div>
              <div className="md:col-span-2">
                <label className="font-label mb-2 block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                  Project name *
                </label>
                <input
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder="e.g. Rear extension — 12 Smith Street"
                  className="w-full rounded-lg border border-outline-variant/40 bg-surface-container-lowest px-4 py-3 text-sm outline-none ring-primary/30 focus:border-primary/70 focus:ring-2"
                />
                {issueFor("project") && (
                  <p data-error-anchor className="mt-1 text-sm text-error">{issueFor("project")}</p>
                )}
              </div>
              <div>
                <label className="font-label mb-2 block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                  Ceiling height throughout (m)
                </label>
                <input
                  inputMode="decimal"
                  value={defaultCeilingHeightM}
                  onChange={(e) => setDefaultCeilingHeightM(e.target.value)}
                  placeholder="e.g. 2.40"
                  className="w-full max-w-xs rounded-lg border border-outline-variant/40 bg-surface-container-lowest px-4 py-3 text-sm outline-none ring-primary/30 focus:border-primary/70 focus:ring-2"
                />
                <p className="mt-1 text-sm text-on-surface-variant">
                  Optional. Most homes are the same throughout — enter it once
                  and we&apos;ll pre-fill every room. You can change any room
                  individually under Add detail.
                </p>
              </div>
              <div>
                <span className="font-label mb-2 block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                  Display units {unitLocked && <span className="ml-1 text-primary">· locked</span>}
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => !unitLocked && setUnit("metric")}
                    disabled={unitLocked}
                    aria-disabled={unitLocked}
                    className={`rounded-lg px-4 py-2 text-sm font-semibold uppercase transition disabled:cursor-not-allowed disabled:opacity-60 ${
                      unit === "metric"
                        ? "bg-primary text-on-primary"
                        : "bg-surface-container-high text-on-surface"
                    }`}
                  >
                    Metric primary
                  </button>
                  <button
                    type="button"
                    onClick={() => !unitLocked && setUnit("imperial")}
                    disabled={unitLocked}
                    aria-disabled={unitLocked}
                    className={`rounded-lg px-4 py-2 text-sm font-semibold uppercase transition disabled:cursor-not-allowed disabled:opacity-60 ${
                      unit === "imperial"
                        ? "bg-primary text-on-primary"
                        : "bg-surface-container-high text-on-surface"
                    }`}
                  >
                    Imperial primary
                  </button>
                </div>
                <p className="mt-2 text-sm text-on-surface-variant">
                  {unitLocked
                    ? "Units are locked for this project to prevent metric/imperial mix-ups mid-survey."
                    : "Pick once — units lock when you continue. Entries are stored in metres; the review step shows both."}
                </p>
              </div>
              {SCAN_ENABLED && (
              <div>
                <span className="font-label mb-2 block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                  Device capability
                </span>
                {arSupport === "unknown" && (
                  <p className="text-sm text-on-surface-variant">Checking AR capability…</p>
                )}
                {arSupport === "yes" && (
                  <p className="rounded-md bg-primary/10 px-3 py-2 text-sm text-primary">
                    AR scan available — you&apos;ll get the option to LiDAR-scan each room.
                  </p>
                )}
                {arSupport === "no" && (
                  <p className="rounded-md bg-surface-container-high px-3 py-2 text-sm text-on-surface-variant">
                    Manual / corner-tap mode only{arReason ? ` — ${arReason}` : "."} You&apos;ll still get accurate dimensions from photo taps.
                  </p>
                )}
              </div>
              )}
            </div>
            <button
              type="button"
              onClick={goRooms}
              className="inline-flex items-center gap-3 rounded-full bg-primary px-7 py-3 text-sm font-bold uppercase tracking-widest text-on-primary shadow-lg shadow-primary/30 transition-all hover:bg-surface-tint hover:shadow-xl active:scale-[0.97]"
              aria-label="Continue to rooms"
            >
              <span>Continue to rooms</span>
              <span
                className="material-symbols-outlined text-base"
                aria-hidden
                style={{ fontSize: "20px" }}
              >
                arrow_forward
              </span>
            </button>
          </section>
        )}

        {step === "rooms" && !guidedActive && (
          <div className="space-y-10">
            {/* Why we sent you back here.
                submitError was only rendered on the review step, but a
                failed pre-submit check navigates to this one — so the
                customer was moved without explanation and saw a room
                that looked perfectly fine. */}
            {submitStatus === "error" && submitError && (
              <div
                role="alert"
                aria-live="assertive"
                data-error-anchor
                className="rounded-xl border border-error/40 bg-error/10 p-4"
              >
                <p className="text-sm font-semibold text-error">
                  Not ready to send yet
                </p>
                {issueSummary.length > 0 ? (
                  <ul className="mt-2 space-y-1.5">
                    {issueSummary.map((s, n) => (
                      <li key={n} className="text-sm text-on-surface">
                        {s.message}
                        {s.where && (
                          <span className="block text-sm text-on-surface-variant">
                            {s.where}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-sm text-on-surface">{submitError}</p>
                )}
              </div>
            )}
            {/* Result of the last scan. Closing the overlay silently
                meant a scan that reached the form and one that didn't
                looked identical. */}
            {scanApplied && (
              <div
                role="status"
                aria-live="polite"
                className="flex items-start justify-between gap-3 rounded-xl border border-primary/40 bg-primary/10 px-4 py-3"
              >
                <p className="text-sm text-on-surface">{scanApplied}</p>
                <button
                  type="button"
                  onClick={() => setScanApplied(null)}
                  className="shrink-0 text-sm font-bold uppercase tracking-widest text-on-surface-variant hover:text-on-surface"
                >
                  Dismiss
                </button>
              </div>
            )}
            {/* Whole-property scan. Shown first, and only on hardware
                that can do it, because when it is available it replaces
                nearly all of the work below — every room measured, named
                and positioned in one walk. Devices without LiDAR never
                see it rather than being offered something they cannot
                use. */}
            {arSupport === "yes" && (
              <section className="tm-lift rounded-2xl border border-primary/40 bg-surface-container-low p-5">
                <h2 className="font-headline text-lg text-on-surface">
                  Scan the whole property
                </h2>
                <p className="mt-1 text-sm leading-relaxed text-on-surface-variant">
                  Your phone has a LiDAR sensor. Walk through each room in turn
                  and it measures the walls, doors and windows for you — then
                  works out how the rooms fit together, so there&apos;s no floor
                  plan to arrange afterwards.
                </p>
                <button
                  type="button"
                  onClick={() => void startHouseScan()}
                  disabled={houseScanning}
                  className="mt-3 inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold uppercase tracking-widest text-on-primary disabled:opacity-60"
                >
                  <span
                    className="material-symbols-outlined"
                    style={{ fontSize: "18px" }}
                    aria-hidden
                  >
                    view_in_ar
                  </span>
                  {houseScanning ? "Scanning…" : "Start property scan"}
                </button>
                {houseScanError && (
                  <p className="mt-3 rounded-md bg-error/10 px-3 py-2 text-sm text-error">
                    {houseScanError}
                  </p>
                )}
              </section>
            )}

            {/* Quick-start templates removed.
                They pre-built a room list from a property archetype, so
                the customer's first job was correcting a guess about
                their own house — often slower than adding rooms as they
                walk round, and it left people with rooms they did not
                have. Rooms are added one at a time now.

                An empty rooms step needs something to press, though, or
                the page just looks broken. */}
            {rooms.length === 0 && (
              <section className="tm-lift rounded-2xl border border-outline-variant/30 bg-surface-container-low p-6 text-center">
                <h2 className="font-headline text-lg text-on-surface">
                  Add your first room
                </h2>
                <p className="mx-auto mt-1 max-w-md text-sm text-on-surface-variant">
                  Start with whichever room you&apos;re standing in. You can add
                  the rest as you go.
                </p>
                <button
                  type="button"
                  onClick={addRoom}
                  className="mt-4 rounded-full bg-primary px-6 py-2.5 text-sm font-bold uppercase tracking-widest text-on-primary"
                >
                  + Add a room
                </button>
              </section>
            )}

            {SCAN_ENABLED && (
            <div className="rounded-xl border-2 border-primary/40 bg-inverse-surface p-6 text-on-primary shadow-lg md:p-8">
              <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="font-label text-sm font-bold uppercase tracking-[0.25em] text-primary">
                    Auto-scan
                  </p>
                  <h2 className="font-headline mt-1 text-xl text-[#f7f5ef] md:text-2xl">
                    Scan your room with the camera
                  </h2>
                  {/* Customer-facing, and read by App Store review. The
                      previous wording described the implementation —
                      "LiDAR/RoomPlan placeholder", "mock AI processing" —
                      which reads as an unfinished app to a reviewer and
                      means nothing to a homeowner. */}
                  <p className="mt-2 max-w-xl text-sm text-white/65">
                    Point your camera at the room and tap the corners — we&apos;ll
                    work out the dimensions for you. With several rooms you&apos;ll
                    choose which one to update; a single room opens the scan
                    straight away.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={openBannerAutoScan}
                  className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-primary px-8 py-4 text-sm font-bold uppercase tracking-widest text-on-primary transition-colors hover:bg-surface-tint"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: "20px" }} aria-hidden>photo_camera</span>
                  Auto-Scan Room
                </button>
              </div>
            </div>
            )}

            {/* Pager header — position, progress and quick jump. */}
            <div
              ref={roomsTopRef}
              className="scroll-mt-4 rounded-xl border border-outline-variant/30 bg-surface-container-lowest p-4"
            >
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p className="font-label text-sm font-bold uppercase tracking-widest text-primary">
                  Room {Math.min(activeRoomIndex + 1, rooms.length)} of {rooms.length}
                </p>
                <p className="text-sm text-on-surface-variant">
                  {rooms[activeRoomIndex]?.name?.trim() || "Unnamed room"}
                </p>
              </div>
              <div
                className="h-1.5 w-full overflow-hidden rounded-full bg-outline-variant/30"
                role="progressbar"
                aria-valuemin={1}
                aria-valuemax={rooms.length}
                aria-valuenow={activeRoomIndex + 1}
                aria-label="Room progress"
              >
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{
                    width: `${((activeRoomIndex + 1) / Math.max(1, rooms.length)) * 100}%`,
                  }}
                />
              </div>
              {/* Jump to a room.
                  This was one numbered chip per room, which is fine for
                  four rooms and unusable for sixty — a wall of numbers
                  that says nothing about which room is which. A list
                  named by room does the same job at any length, and
                  reads as "Kitchen" rather than "17".

                  Previous/next sit alongside it because moving one room
                  at a time is the common case and should not require
                  opening a menu. */}
              {rooms.length > 1 && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setActiveRoomIndex((i) => Math.max(0, i - 1))}
                    disabled={activeRoomIndex === 0}
                    aria-label="Previous room"
                    className="rounded-full border border-outline-variant/40 px-3 py-1.5 text-sm font-bold text-on-surface-variant disabled:opacity-40"
                  >
                    ←
                  </button>
                  <select
                    value={activeRoomIndex}
                    onChange={(e) =>
                      setActiveRoomIndex(parseInt(e.target.value, 10))
                    }
                    aria-label="Jump to room"
                    className="min-w-0 flex-1 rounded-lg border border-outline-variant/40 bg-surface-container-lowest px-3 py-2 text-sm outline-none ring-primary/30 focus:border-primary/70 focus:ring-2"
                  >
                    {rooms.map((r, i) => (
                      <option key={r.id} value={i}>
                        {i + 1}. {r.name?.trim() || "Unnamed room"}
                        {issues.some((x) => x.path.startsWith(`room-${i}-`))
                          ? "  — needs attention"
                          : ""}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() =>
                      setActiveRoomIndex((i) => Math.min(rooms.length - 1, i + 1))
                    }
                    disabled={activeRoomIndex >= rooms.length - 1}
                    aria-label="Next room"
                    className="rounded-full border border-outline-variant/40 px-3 py-1.5 text-sm font-bold text-on-surface-variant disabled:opacity-40"
                  >
                    →
                  </button>
                </div>
              )}
            </div>


            {/* The whole rooms step is already gated on !guidedActive,
                so reaching here means the all-at-once view is what was
                asked for. */}
            {rooms.map((room, ri) => ri !== activeRoomIndex ? null : (
              <section
                key={room.id}
                className="tm-lift rounded-2xl border border-outline-variant/30 bg-surface-container-low p-6 md:p-8"
              >
                <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <h2 className="font-headline text-xl text-on-surface">
                      Room {ri + 1}
                    </h2>
                    {/* Multi-storey selector — small inline dropdown so
                        the customer can flag which storey this room is
                        on. Stored as `placement.floor` (integer). */}
                    <label className="inline-flex items-center gap-2 text-sm text-on-surface-variant">
                      <span className="uppercase tracking-widest">On floor</span>
                      <select
                        value={placements[room.id]?.floor ?? 0}
                        onChange={(e) => {
                          const floor = parseInt(e.target.value, 10);
                          setPlacements((prev) => ({
                            ...prev,
                            [room.id]: {
                              positionM: prev[room.id]?.positionM ?? null,
                              rotationDeg: prev[room.id]?.rotationDeg ?? 0,
                              floor,
                            },
                          }));
                        }}
                        className="rounded-lg border border-outline-variant/40 bg-surface-container-lowest px-2 py-1 text-sm text-on-surface outline-none focus:border-primary/70"
                      >
                        <option value={-1}>Basement</option>
                        <option value={0}>Ground</option>
                        <option value={1}>First</option>
                        <option value={2}>Second</option>
                        <option value={3}>Third</option>
                      </select>
                    </label>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    {SCAN_ENABLED && (
                    <button
                      type="button"
                      onClick={() => scanRoom(room.id)}
                      className="rounded-lg border border-primary bg-primary/10 px-4 py-2 text-sm font-bold uppercase tracking-widest text-primary transition-colors hover:bg-primary hover:text-on-primary"
                    >
                      Auto-Scan this room
                    </button>
                    )}
                    {/* Reorder + duplicate cluster. The duplicate helper
                        deep-clones the room (new IDs throughout) and the
                        arrows nudge it up or down in the list. */}
                    <button
                      type="button"
                      onClick={() => moveRoom(room.id, -1)}
                      disabled={ri === 0}
                      aria-label="Move room up"
                      className="rounded-lg border border-outline-variant/40 px-2.5 py-1.5 text-sm text-on-surface transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => moveRoom(room.id, 1)}
                      disabled={ri === rooms.length - 1}
                      aria-label="Move room down"
                      className="rounded-lg border border-outline-variant/40 px-2.5 py-1.5 text-sm text-on-surface transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      onClick={() => duplicateRoom(room.id)}
                      className="rounded-lg border border-outline-variant/40 px-2.5 py-1.5 text-sm font-bold uppercase tracking-widest text-on-surface transition-colors hover:border-primary hover:text-primary"
                    >
                      Duplicate
                    </button>
                    {rooms.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeRoom(room.id)}
                        className="text-sm font-bold uppercase tracking-widest text-error hover:underline"
                      >
                        Remove room
                      </button>
                    )}
                  </div>
                </div>

                <div className="mb-6">
                  <label className="font-label mb-2 block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                    Room name *
                  </label>
                  <input
                    value={room.name}
                    onChange={(e) =>
                      setRoom(room.id, { name: e.target.value })
                    }
                    placeholder="e.g. Kitchen, Master bedroom"
                    className="w-full max-w-md rounded-lg border border-outline-variant/40 bg-surface-container-lowest px-4 py-3 text-sm outline-none ring-primary/30 focus:border-primary/70 focus:ring-2"
                  />
                  {issueFor(`room-${ri}-name`) && (
                    <p data-error-anchor className="mt-1 text-sm text-error">
                      {issueFor(`room-${ri}-name`)}
                    </p>
                  )}
                </div>

                {/* Room shape selector. Most rooms are rectangular —
                    we surface that as the default and only ask for
                    the notch dimensions when the customer flips to
                    L-shape. Custom polygon is a power-user option. */}
                <div className="mb-6">
                  <h3 className="font-label mb-2 text-sm font-bold uppercase tracking-widest text-primary">
                    Room shape
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {(["rectangle", "l-shape", "custom"] as const).map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setShape(room.id, s)}
                        className={`rounded-full px-4 py-1.5 text-sm font-bold uppercase tracking-widest transition ${
                          (room.shape ?? "rectangle") === s
                            ? "bg-primary text-on-primary"
                            : "bg-surface-container-high text-on-surface"
                        }`}
                      >
                        {s === "rectangle"
                          ? "Rectangle"
                          : s === "l-shape"
                            ? "L-shape"
                            : "Custom"}
                      </button>
                    ))}
                  </div>

                  {/* Right-angle declaration.
                      Asked because the architect needs to know whether an
                      unequal pair of opposite walls is a measuring error
                      or a genuinely out-of-square room — the two look
                      identical in a list of numbers and get drawn very
                      differently. Left unset by default: silence must not
                      be read as "square", which is the assumption that
                      makes a skewed room arrive as a neat rectangle. */}
                  <label className="mt-3 flex cursor-pointer items-start gap-2.5">
                    <input
                      type="checkbox"
                      checked={room.cornersSquare === true}
                      onChange={(e) =>
                        setRoom(room.id, { cornersSquare: e.target.checked })
                      }
                      className="mt-0.5 h-4 w-4 accent-[#b89650]"
                    />
                    <span className="text-sm leading-relaxed text-on-surface-variant">
                      <span className="font-semibold text-on-surface">
                        All corners are square (90°)
                      </span>
                      <br />
                      Tick if the room is a true rectangle. Leave unticked if
                      any corner is off — a bay, a splay, an old house that has
                      moved. We&apos;ll draw it as measured either way.
                    </span>
                  </label>

                  {/* Consistency check, deliberately advisory. A mismatch
                      is either a typo or a real room that is not square,
                      and only the person standing in it knows which — so
                      this points at the discrepancy and leaves the
                      decision with them rather than blocking submission. */}
                  {(() => {
                    if (room.cornersSquare !== true) return null;
                    if (room.walls.length < 4) return null;
                    const n = (v: string) => {
                      const x = Number.parseFloat(v);
                      return Number.isFinite(x) && x > 0 ? x : null;
                    };
                    const pairs: [number, number, string][] = [
                      [0, 2, "1 and 3"],
                      [1, 3, "2 and 4"],
                    ];
                    const off = pairs.filter(([a, b]) => {
                      const x = n(room.walls[a]?.lengthM ?? "");
                      const y = n(room.walls[b]?.lengthM ?? "");
                      if (x === null || y === null) return false;
                      // 2 cm of slack: real tape measurements of the same
                      // wall rarely agree to the millimetre, and flagging
                      // that would be noise.
                      return Math.abs(x - y) > 0.02;
                    });
                    if (!off.length) return null;
                    return (
                      <p className="mt-2 rounded-md bg-amber-100/60 px-3 py-2 text-sm leading-relaxed text-amber-900">
                        You&apos;ve said the corners are square, but walls{" "}
                        {off.map(([, , label]) => label).join(" and ")} don&apos;t
                        match. In a true rectangle opposite walls are equal —
                        worth a re-measure, or untick the box if the room really
                        isn&apos;t square.
                      </p>
                    );
                  })()}

                  {/* The notch inputs are gone. They asked the customer to
                      describe an L-shaped room as "a rectangle with a bite
                      cut out of one corner, and here are the bite's
                      dimensions" — a description of how to construct the
                      shape rather than of the room. Nobody stands in their
                      lounge thinking in notches, and it still showed four
                      wall fields for a six-walled room.

                      Choosing L-shape now simply gives six walls to
                      measure, which is what the room has. */}
                  {room.shape === "l-shape" && (
                    <p className="mt-3 text-sm leading-relaxed text-on-surface-variant">
                      Six walls to measure. Work round the room in order and
                      the lengths will come back to the start — the wall
                      lengths below are numbered to match.
                    </p>
                  )}
                  {room.shape === "custom" && (
                    <CustomShapeEditor
                      room={room}
                      onPatch={(patch) => setRoom(room.id, patch)}
                    />
                  )}
                </div>

                <div className="mb-8">
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="font-label text-sm font-bold uppercase tracking-widest text-primary">
                      Wall lengths
                    </h3>
                    {wallsEditorOpen(room, ri) && (
                      <button
                        type="button"
                        onClick={() => addWall(room.id)}
                        className="text-sm font-bold uppercase tracking-widest text-primary hover:underline"
                      >
                        + Add wall segment
                      </button>
                    )}
                  </div>

                  {/* Scanned rooms: the numbers are already right, so
                      they start folded away. There is nothing here for
                      the customer to fill in, and a screen of populated
                      fields invites them to "check" measurements taken
                      by a sensor with a tape they have not got.

                      Folded, not removed. Until the scan's accuracy has
                      been checked against a tape, these figures are the
                      only chance anyone has of noticing a bad scan
                      before it becomes a drawing — so they stay one tap
                      away rather than gone. */}
                  {room.measuredByScan && !measurementsOpen[room.id] && (
                    <div className="mb-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
                      <p className="text-sm text-on-surface">
                        <span className="font-semibold">Measured by scan.</span>{" "}
                        {room.walls.filter((w) => w.lengthM.trim()).length} wall
                        {room.walls.filter((w) => w.lengthM.trim()).length === 1
                          ? ""
                          : "s"}
                        {room.ceilingHeightM.trim()
                          ? `, ceiling ${room.ceilingHeightM} m`
                          : ""}
                        {room.doors.length
                          ? `, ${room.doors.length} door${room.doors.length === 1 ? "" : "s"}`
                          : ""}
                        {room.windows.length
                          ? `, ${room.windows.length} window${room.windows.length === 1 ? "" : "s"}`
                          : ""}
                        .
                      </p>
                      <button
                        type="button"
                        onClick={() =>
                          setMeasurementsOpen((prev) => ({
                            ...prev,
                            [room.id]: true,
                          }))
                        }
                        className="mt-2 text-sm font-bold uppercase tracking-widest text-primary hover:underline"
                      >
                        Check or edit the measurements
                      </button>
                    </div>
                  )}

                  {/* Rectangular rooms only need two numbers. */}
                  {isRectangle(room) &&
                    (!room.measuredByScan || measurementsOpen[room.id]) && (
                    <div className="mb-3 rounded-lg bg-surface-container-lowest p-4">
                      <p className="mb-3 text-sm text-on-surface-variant">
                        Just the two dimensions — we&apos;ll apply them to the
                        opposite walls for you.
                      </p>
                      <div className="flex flex-col gap-3 sm:flex-row">
                        <div className="flex-1">
                          <label className="mb-1 block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                            Width (m) *
                          </label>
                          <input
                            inputMode="decimal"
                            value={room.walls[0]?.lengthM ?? ""}
                            onChange={(e) =>
                              setRectangleDim(room.id, "width", e.target.value)
                            }
                            placeholder="0.00"
                            className="w-full rounded-lg border border-outline-variant/40 bg-surface-container-lowest px-3 py-2 text-sm outline-none ring-primary/30 focus:border-primary/70 focus:ring-2"
                          />
                          {/* Wall issues were only rendered inside the
                              individual-walls list, which is collapsed for
                              a rectangle. The customer was sent to the
                              right room and shown no reason. */}
                          {issueFor(`room-${ri}-wall-0`) && (
                            <p data-error-anchor className="mt-1 text-sm text-error">
                              {issueFor(`room-${ri}-wall-0`)}
                            </p>
                          )}
                        </div>
                        <div className="flex-1">
                          <label className="mb-1 block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                            Length (m) *
                          </label>
                          <input
                            inputMode="decimal"
                            value={room.walls[1]?.lengthM ?? ""}
                            onChange={(e) =>
                              setRectangleDim(room.id, "length", e.target.value)
                            }
                            placeholder="0.00"
                            className="w-full rounded-lg border border-outline-variant/40 bg-surface-container-lowest px-3 py-2 text-sm outline-none ring-primary/30 focus:border-primary/70 focus:ring-2"
                          />
                          {issueFor(`room-${ri}-wall-1`) && (
                            <p data-error-anchor className="mt-1 text-sm text-error">
                              {issueFor(`room-${ri}-wall-1`)}
                            </p>
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          setOpenWallsRooms((prev) => ({
                            ...prev,
                            [room.id]: !wallsEditorOpen(room, ri),
                          }))
                        }
                        className="mt-3 text-sm font-bold uppercase tracking-widest text-primary hover:underline"
                      >
                        {wallsEditorOpen(room, ri)
                          ? "Hide individual walls"
                          : "Edit walls individually"}
                      </button>
                    </div>
                  )}

                  <div
                    className="space-y-3"
                    hidden={!wallsEditorOpen(room, ri)}
                  >
                    {room.walls.map((w, wi) => (
                      <div
                        key={w.id}
                        className="flex flex-col gap-2 rounded-lg bg-surface-container-lowest p-4 sm:flex-row sm:items-end"
                      >
                        <div className="min-w-0 flex-1">
                          <label className="mb-1 block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                            Label
                          </label>
                          <input
                            value={w.label}
                            placeholder={wallHint(wi)}
                            onChange={(e) => {
                              const walls = room.walls.map((x) =>
                                x.id === w.id
                                  ? { ...x, label: e.target.value }
                                  : x,
                              );
                              setRoom(room.id, { walls });
                            }}
                            className="w-full rounded-lg border border-outline-variant/40 bg-surface-container-lowest px-3 py-2 text-sm outline-none ring-primary/30 focus:border-primary/70 focus:ring-2"
                          />
                        </div>
                        <div className="w-full sm:w-40">
                          <label className="mb-1 block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                            Length (m)
                          </label>
                          <input
                            inputMode="decimal"
                            value={w.lengthM}
                            onChange={(e) => {
                              const walls = room.walls.map((x) =>
                                x.id === w.id
                                  ? { ...x, lengthM: e.target.value }
                                  : x,
                              );
                              setRoom(room.id, { walls });
                            }}
                            placeholder="0.00"
                            className="w-full rounded-lg border border-outline-variant/40 bg-surface-container-lowest px-3 py-2 text-sm outline-none ring-primary/30 focus:border-primary/70 focus:ring-2"
                          />
                          <LengthHint value={w.lengthM} kind="wall" />
                          {issueFor(`room-${ri}-wall-${wi}`) && (
                            <p data-error-anchor className="mt-1 text-sm text-error">
                              {issueFor(`room-${ri}-wall-${wi}`)}
                            </p>
                          )}
                        </div>
                        {/* Own input rather than the shared one. Routing a
                            single input by remembered target state broke
                            silently when the customer cancelled the
                            picker: no change event fires, the target is
                            never cleared, and the next photo they add
                            anywhere lands on this wall. */}
                        <label
                          className="material-symbols-outlined shrink-0 cursor-pointer rounded p-2 text-on-surface-variant hover:bg-surface-container-low hover:text-primary"
                          aria-label="Add photo of this wall"
                          title="Add photo of this wall"
                        >
                          add_a_photo
                          <input
                            type="file"
                            accept="image/*,image/jpeg,image/png,image/heic,image/heif,image/webp"
                            multiple
                            className="sr-only"
                            onChange={(e) => {
                              attachPhotosToWall(room.id, w.id, e.target.files);
                              e.target.value = "";
                            }}
                          />
                        </label>
                        {room.walls.length > 3 && (
                          <button
                            type="button"
                            onClick={() => removeWall(room.id, w.id)}
                            className="material-symbols-outlined shrink-0 rounded p-2 text-on-surface-variant hover:bg-surface-container-low hover:text-error"
                            aria-label="Remove wall"
                          >
                            close
                          </button>
                        )}
                        {(w.photos ?? []).length > 0 && (
                          <div className="basis-full flex flex-wrap gap-2 pt-2">
                            {(w.photos ?? []).map((p) => (
                              <div
                                key={p.id}
                                className="relative h-16 w-16 overflow-hidden rounded-lg border border-outline-variant/30"
                              >
                                <img
                                  src={p.uri}
                                  alt={p.name}
                                  className="h-full w-full object-cover"
                                />
                                <button
                                  type="button"
                                  onClick={() => removePhotoFromWall(room.id, w.id, p.id)}
                                  className="absolute right-0.5 top-0.5 rounded bg-inverse-surface/80 px-1 text-sm text-surface"
                                  aria-label="Remove photo"
                                >
                                  ✕
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="font-label mb-2 block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                    Photos * — corners, openings, overall context
                  </label>
                  <p className="mb-3 text-sm text-on-surface-variant">
                    Required: at least one reference photo per room so the architect can audit the measurements against what's actually there (radiators, columns, molding, etc.).
                  </p>
                  {/* A real <input type="file"> the customer taps directly,
                      rather than a button calling input.click(). iOS Safari
                      is unreliable about firing change for a programmatic
                      click — the picker opens, a photo is chosen, and
                      nothing ever arrives. Tapping the input itself always
                      works. Room photos are required, so this path has to
                      be dependable. */}
                  <label className="mb-4 inline-flex cursor-pointer items-center gap-2 rounded-full border border-primary/60 px-4 py-2 text-sm font-bold uppercase tracking-widest text-primary transition-colors hover:bg-primary hover:text-on-primary">
                    <span className="material-symbols-outlined" style={{ fontSize: "16px" }} aria-hidden>add_a_photo</span>
                    Take photo or upload
                    <input
                      type="file"
                      accept="image/*,image/jpeg,image/png,image/heic,image/heif,image/webp"
                      multiple
                      className="sr-only"
                      onChange={(e) => {
                        // attachPhotos copies the files out synchronously,
                        // so clearing the value here is safe. Clearing is
                        // what lets the same photo be picked twice in a row.
                        attachPhotos(room.id, e.target.files);
                        e.target.value = "";
                      }}
                    />
                  </label>
                  {issueFor(`room-${ri}-photos`) && (
                    <p data-error-anchor className="mb-3 text-sm text-error">
                      {issueFor(`room-${ri}-photos`)}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-3">
                    {room.photos.map((p) => (
                      <div
                        key={p.id}
                        className="relative w-28 shrink-0 overflow-hidden rounded-lg border border-outline-variant/30 bg-surface-container-high"
                      >
                        <img
                          src={p.uri}
                          alt={p.name}
                          className="aspect-square h-28 w-full object-cover"
                        />
                        <button
                          type="button"
                          onClick={() => removePhoto(room.id, p.id)}
                          className="absolute right-1 top-1 rounded bg-inverse-surface/80 px-1 text-sm text-surface"
                        >
                          ✕
                        </button>
                        <p className="truncate p-1 text-sm text-on-surface-variant">
                          {p.name}
                        </p>
                      </div>
                    ))}
                  </div>
                  <div className="mt-4 border-t border-outline-variant/20 pt-4">
                    <label className="font-label mb-1 block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                      Voice memo (optional)
                    </label>
                    <p className="mb-1 text-sm text-on-surface-variant">
                      Faster than typing. Note anything tricky — radiators,
                      chimney breasts, an awkward corner — and the architect
                      hears it in your own words.
                    </p>
                    <VoiceRecorder
                      memos={room.voiceMemos ?? []}
                      onChange={(next) => setRoom(room.id, { voiceMemos: next })}
                    />
                  </div>
                </div>


                <div className="mb-4">
                  <button
                    type="button"
                    onClick={() => toggleDetail(room.id, ri)}
                    aria-expanded={isDetailOpen(room.id, ri)}
                    className="flex w-full items-center justify-between gap-3 rounded-lg border border-outline-variant/40 bg-surface-container-lowest px-4 py-3 text-left transition-colors hover:border-primary/60"
                  >
                    <span className="font-label text-sm font-bold uppercase tracking-widest text-primary">
                      Doors &amp; windows
                    </span>
                    <span className="flex items-center gap-2">
                      {detailSummary(room) ? (
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-sm text-primary">
                          {detailSummary(room)}
                        </span>
                      ) : (
                        !isDetailOpen(room.id, ri) && (
                          /* When nothing has been added, say so. The
                             section was labelled only "Add detail",
                             which reads as optional polish rather than
                             the place doors and windows live — people
                             finished a room without ever opening it and
                             submitted rooms with no openings at all. */
                          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-sm font-semibold text-primary">
                            None added yet
                          </span>
                        )
                      )}
                      <span className="text-sm text-on-surface-variant">
                        {isDetailOpen(room.id, ri) ? "Hide" : "Ceiling, notes too"}
                      </span>
                      <span aria-hidden className="text-on-surface-variant">
                        {isDetailOpen(room.id, ri) ? "▴" : "▾"}
                      </span>
                    </span>
                  </button>
                </div>
                {isDetailOpen(room.id, ri) && (
                  <>
                <div className="mb-8">
                  <label className="font-label mb-2 flex flex-wrap items-center gap-2 text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                    Ceiling height (m) *
                    <LengthHint value={room.ceilingHeightM} kind="ceiling" />
                  {usesDefaultCeiling(room) && (
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-sm font-bold uppercase tracking-widest text-primary">
                        Same as property
                      </span>
                    )}
                  </label>
                  <input
                    inputMode="decimal"
                    value={room.ceilingHeightM}
                    onChange={(e) =>
                      setRoom(room.id, { ceilingHeightM: e.target.value })
                    }
                    placeholder="e.g. 2.45"
                    className="w-full max-w-xs rounded-lg border border-outline-variant/40 bg-surface-container-lowest px-4 py-3 text-sm outline-none ring-primary/30 focus:border-primary/70 focus:ring-2"
                  />
                  {usesDefaultCeiling(room) && (
                    <p className="mt-1 text-sm text-on-surface-variant">
                      Inherited from the property default — edit here if this
                      room differs.
                    </p>
                  )}
                  {issueFor(`room-${ri}-ceiling`) && (
                    <p data-error-anchor className="mt-1 text-sm text-error">
                      {issueFor(`room-${ri}-ceiling`)}
                    </p>
                  )}
                </div>

                <div className="mb-8 grid gap-8 md:grid-cols-2">
                  <div>
                    <div className="mb-3 flex items-center justify-between">
                      <h3 className="font-label text-sm font-bold uppercase tracking-widest text-primary">
                        Doors
                      </h3>
                      <button
                        type="button"
                        onClick={() => addOpening(room.id, "doors")}
                        className="text-sm font-bold uppercase tracking-widest text-primary hover:underline"
                      >
                        + Add door
                      </button>
                    </div>
                    {room.doors.length === 0 && (
                      <p className="text-sm text-on-surface-variant">
                        Optional — add each door opening width.
                      </p>
                    )}
                    <div className="space-y-3">
                      {room.doors.map((d, di) => (
                        <div
                          key={d.id}
                          className="flex flex-col gap-2 rounded-lg bg-surface-container-lowest p-4 sm:flex-row"
                        >
                          <div className="flex-1">
                            <label className="mb-1 block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                              Width (m)
                            </label>
                            <input
                              inputMode="decimal"
                              value={d.widthM}
                              onChange={(e) => {
                                const doors = room.doors.map((x) =>
                                  x.id === d.id
                                    ? { ...x, widthM: e.target.value }
                                    : x,
                                );
                                setRoom(room.id, { doors });
                              }}
                              className="w-full rounded-lg border border-outline-variant/40 bg-surface-container-lowest px-3 py-2 text-sm outline-none ring-primary/30 focus:border-primary/70 focus:ring-2"
                            />
                            <LengthHint value={d.widthM} kind="opening" />
                            {issueFor(`room-${ri}-door-${di}`) && (
                              <p data-error-anchor className="mt-1 text-sm text-error">
                                {issueFor(`room-${ri}-door-${di}`)}
                              </p>
                            )}
                          </div>
                          <div className="flex-1">
                            <label className="mb-1 block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                              On wall
                            </label>
                            <select
                              value={d.wallIndex ?? 0}
                              onChange={(e) => {
                                const wi = parseInt(e.target.value, 10);
                                const doors = room.doors.map((x) =>
                                  x.id === d.id ? { ...x, wallIndex: wi } : x,
                                );
                                setRoom(room.id, { doors });
                              }}
                              className="w-full rounded-lg border border-outline-variant/40 bg-surface-container-lowest px-3 py-2 text-sm outline-none ring-primary/30 focus:border-primary/70 focus:ring-2"
                            >
                              {room.walls.map((w, i) => (
                                <option key={w.id} value={i}>
                                  Wall {i + 1}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="w-full">
                            <WallPositionPicker
                              label="Where on that wall?"
                              wallLengthM={Number.parseFloat(
                                room.walls[d.wallIndex ?? 0]?.lengthM ?? "",
                              )}
                              openingWidthM={Number.parseFloat(d.widthM || "0.8")}
                              positionM={
                                d.positionM ? Number.parseFloat(d.positionM) : null
                              }
                              approx={d.positionApprox === true}
                              startCornerLabel={
                                room.walls[
                                  ((d.wallIndex ?? 0) - 1 + room.walls.length) %
                                    room.walls.length
                                ]?.label
                              }
                              endCornerLabel={
                                room.walls[
                                  ((d.wallIndex ?? 0) + 1) % room.walls.length
                                ]?.label
                              }
                              onMeasureWithCamera={
                                arSupport === "yes" || SCAN_ENABLED
                                  ? () =>
                                      setMeasureTarget({
                                        roomId: room.id,
                                        kind: "doors",
                                        itemId: d.id,
                                        prompt:
                                          "Tap the corner, then the floor below the door",
                                      })
                                  : undefined
                              }
                              onChange={(positionM, approx) => {
                                const doors = room.doors.map((x) =>
                                  x.id === d.id
                                    ? {
                                        ...x,
                                        positionM: String(positionM),
                                        positionApprox: approx,
                                      }
                                    : x,
                                );
                                setRoom(room.id, { doors });
                              }}
                            />
                          </div>
                          <div className="flex-[2]">
                            <label className="mb-1 block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                              Note (optional)
                            </label>
                            <input
                              value={d.note}
                              onChange={(e) => {
                                const doors = room.doors.map((x) =>
                                  x.id === d.id
                                    ? { ...x, note: e.target.value }
                                    : x,
                                );
                                setRoom(room.id, { doors });
                              }}
                              placeholder="e.g. Patio — sliding"
                              className="w-full rounded-lg border border-outline-variant/40 bg-surface-container-lowest px-3 py-2 text-sm outline-none ring-primary/30 focus:border-primary/70 focus:ring-2"
                            />
                          </div>
                          <button
                            type="button"
                            onClick={() =>
                              removeOpening(room.id, "doors", d.id)
                            }
                            className="material-symbols-outlined self-end rounded p-2 text-on-surface-variant hover:text-error sm:self-center"
                          >
                            close
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div className="mb-3 flex items-center justify-between">
                      <h3 className="font-label text-sm font-bold uppercase tracking-widest text-primary">
                        Windows
                      </h3>
                      <button
                        type="button"
                        onClick={() => addOpening(room.id, "windows")}
                        className="text-sm font-bold uppercase tracking-widest text-primary hover:underline"
                      >
                        + Add window
                      </button>
                    </div>
                    {room.windows.length === 0 && (
                      <p className="text-sm text-on-surface-variant">
                        Optional — rough opening widths.
                      </p>
                    )}
                    <div className="space-y-3">
                      {room.windows.map((w, wi) => (
                        <div
                          key={w.id}
                          className="flex flex-col gap-2 rounded-lg bg-surface-container-lowest p-4 sm:flex-row"
                        >
                          <div className="flex-1">
                            <label className="mb-1 block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                              Width (m)
                            </label>
                            <input
                              inputMode="decimal"
                              value={w.widthM}
                              onChange={(e) => {
                                const windows = room.windows.map((x) =>
                                  x.id === w.id
                                    ? { ...x, widthM: e.target.value }
                                    : x,
                                );
                                setRoom(room.id, { windows });
                              }}
                              className="w-full rounded-lg border border-outline-variant/40 bg-surface-container-lowest px-3 py-2 text-sm outline-none ring-primary/30 focus:border-primary/70 focus:ring-2"
                            />
                            <LengthHint value={w.widthM} kind="opening" />
                            {issueFor(`room-${ri}-window-${wi}`) && (
                              <p data-error-anchor className="mt-1 text-sm text-error">
                                {issueFor(`room-${ri}-window-${wi}`)}
                              </p>
                            )}
                          </div>
                          <div className="flex-1">
                            <label className="mb-1 block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                              On wall
                            </label>
                            <select
                              value={w.wallIndex ?? 0}
                              onChange={(e) => {
                                const idx = parseInt(e.target.value, 10);
                                const windows = room.windows.map((x) =>
                                  x.id === w.id ? { ...x, wallIndex: idx } : x,
                                );
                                setRoom(room.id, { windows });
                              }}
                              className="w-full rounded-lg border border-outline-variant/40 bg-surface-container-lowest px-3 py-2 text-sm outline-none ring-primary/30 focus:border-primary/70 focus:ring-2"
                            >
                              {room.walls.map((wallSeg, i) => (
                                <option key={wallSeg.id} value={i}>
                                  Wall {i + 1}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="w-full">
                            <WallPositionPicker
                              label="Where on that wall?"
                              wallLengthM={Number.parseFloat(
                                room.walls[w.wallIndex ?? 0]?.lengthM ?? "",
                              )}
                              openingWidthM={Number.parseFloat(w.widthM || "1.2")}
                              positionM={
                                w.positionM ? Number.parseFloat(w.positionM) : null
                              }
                              approx={w.positionApprox === true}
                              startCornerLabel={
                                room.walls[
                                  ((w.wallIndex ?? 0) - 1 + room.walls.length) %
                                    room.walls.length
                                ]?.label
                              }
                              endCornerLabel={
                                room.walls[
                                  ((w.wallIndex ?? 0) + 1) % room.walls.length
                                ]?.label
                              }
                              onMeasureWithCamera={
                                arSupport === "yes" || SCAN_ENABLED
                                  ? () =>
                                      setMeasureTarget({
                                        roomId: room.id,
                                        kind: "windows",
                                        itemId: w.id,
                                        prompt:
                                          "Tap the corner, then the floor below the window",
                                      })
                                  : undefined
                              }
                              onChange={(positionM, approx) => {
                                const windows = room.windows.map((x) =>
                                  x.id === w.id
                                    ? {
                                        ...x,
                                        positionM: String(positionM),
                                        positionApprox: approx,
                                      }
                                    : x,
                                );
                                setRoom(room.id, { windows });
                              }}
                            />
                          </div>
                          <div className="flex-[2]">
                            <label className="mb-1 block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                              Note (optional)
                            </label>
                            <input
                              value={w.note}
                              onChange={(e) => {
                                const windows = room.windows.map((x) =>
                                  x.id === w.id
                                    ? { ...x, note: e.target.value }
                                    : x,
                                );
                                setRoom(room.id, { windows });
                              }}
                              placeholder="e.g. Bay — centre"
                              className="w-full rounded-lg border border-outline-variant/40 bg-surface-container-lowest px-3 py-2 text-sm outline-none ring-primary/30 focus:border-primary/70 focus:ring-2"
                            />
                          </div>
                          <button
                            type="button"
                            onClick={() =>
                              removeOpening(room.id, "windows", w.id)
                            }
                            className="material-symbols-outlined self-end rounded p-2 text-on-surface-variant hover:text-error sm:self-center"
                          >
                            close
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Stairs.
                    Previously recordable only as a connection between two
                    rooms, which says the floors are linked and gives the
                    architect nothing to draw — no width, no direction, no
                    position. A staircase is one of the largest objects in
                    a house and one of the few that genuinely constrains a
                    design, and it was missing from every plan. */}
                <div className="mb-6">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <label className="font-label text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                      Stairs in this room
                    </label>
                    <button
                      type="button"
                      onClick={() => addStairs(room.id)}
                      className="rounded-full border border-primary px-3 py-1.5 text-sm font-bold uppercase tracking-widest text-primary"
                    >
                      + Add stairs
                    </button>
                  </div>
                  {(room.stairs ?? []).length === 0 && (
                    <p className="text-sm text-on-surface-variant">
                      Only if a flight starts, ends or passes through this room.
                    </p>
                  )}
                  <div className="space-y-4">
                    {(room.stairs ?? []).map((s) => (
                      <div
                        key={s.id}
                        className="rounded-lg border border-outline-variant/30 bg-surface-container-lowest p-4"
                      >
                        <div className="flex flex-wrap gap-3">
                          <div className="min-w-[7rem] flex-1">
                            <label className="mb-1 block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                              Width (m) *
                            </label>
                            <input
                              inputMode="decimal"
                              value={s.widthM}
                              onChange={(e) =>
                                setStairs(room.id, s.id, { widthM: e.target.value })
                              }
                              placeholder="0.90"
                              className="w-full rounded-lg border border-outline-variant/40 bg-surface-container-lowest px-3 py-2 text-sm outline-none ring-primary/30 focus:border-primary/70 focus:ring-2"
                            />
                          </div>
                          <div className="min-w-[7rem] flex-1">
                            <label className="mb-1 block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                              Going
                            </label>
                            <select
                              value={s.direction}
                              onChange={(e) =>
                                setStairs(room.id, s.id, {
                                  direction: e.target.value as "up" | "down",
                                })
                              }
                              className="w-full rounded-lg border border-outline-variant/40 bg-surface-container-lowest px-3 py-2 text-sm outline-none ring-primary/30 focus:border-primary/70 focus:ring-2"
                            >
                              <option value="up">Up from this room</option>
                              <option value="down">Down from this room</option>
                            </select>
                          </div>
                          <div className="min-w-[7rem] flex-1">
                            <label className="mb-1 block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                              Treads
                            </label>
                            <input
                              inputMode="numeric"
                              value={s.treads ?? ""}
                              onChange={(e) =>
                                setStairs(room.id, s.id, { treads: e.target.value })
                              }
                              placeholder="13"
                              className="w-full rounded-lg border border-outline-variant/40 bg-surface-container-lowest px-3 py-2 text-sm outline-none ring-primary/30 focus:border-primary/70 focus:ring-2"
                            />
                          </div>
                          <div className="min-w-[8rem] flex-1">
                            <label className="mb-1 block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                              Runs along
                            </label>
                            <select
                              value={s.wallIndex ?? 0}
                              onChange={(e) =>
                                setStairs(room.id, s.id, {
                                  wallIndex: parseInt(e.target.value, 10),
                                })
                              }
                              className="w-full rounded-lg border border-outline-variant/40 bg-surface-container-lowest px-3 py-2 text-sm outline-none ring-primary/30 focus:border-primary/70 focus:ring-2"
                            >
                              {room.walls.map((w, i) => (
                                <option key={w.id} value={i}>
                                  Wall {i + 1}
                                </option>
                              ))}
                            </select>
                          </div>
                          <button
                            type="button"
                            onClick={() => removeStairs(room.id, s.id)}
                            aria-label="Remove stairs"
                            className="material-symbols-outlined self-end rounded p-2 text-on-surface-variant hover:text-error"
                          >
                            close
                          </button>
                        </div>

                        <div className="mt-3">
                          <WallPositionPicker
                            label="Where does the flight start?"
                            wallLengthM={Number.parseFloat(
                              room.walls[s.wallIndex ?? 0]?.lengthM ?? "",
                            )}
                            openingWidthM={Number.parseFloat(s.widthM || "0.9")}
                            positionM={
                              s.positionM ? Number.parseFloat(s.positionM) : null
                            }
                            approx={s.positionApprox === true}
                            startCornerLabel={
                              room.walls[
                                ((s.wallIndex ?? 0) - 1 + room.walls.length) %
                                  room.walls.length
                              ]?.label
                            }
                            endCornerLabel={
                              room.walls[
                                ((s.wallIndex ?? 0) + 1) % room.walls.length
                              ]?.label
                            }
                            onMeasureWithCamera={
                              arSupport === "yes" || SCAN_ENABLED
                                ? () =>
                                    setMeasureTarget({
                                      roomId: room.id,
                                      kind: "stairs",
                                      itemId: s.id,
                                      prompt:
                                        "Tap the corner, then the bottom step",
                                    })
                                : undefined
                            }
                            onChange={(positionM, approx) =>
                              setStairs(room.id, s.id, {
                                positionM: String(positionM),
                                positionApprox: approx,
                              })
                            }
                          />
                        </div>

                        <div className="mt-3">
                          <label className="mb-1 block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                            Anything unusual (optional)
                          </label>
                          <input
                            value={s.notes ?? ""}
                            onChange={(e) =>
                              setStairs(room.id, s.id, { notes: e.target.value })
                            }
                            placeholder="e.g. winders at the bottom, cupboard underneath"
                            className="w-full rounded-lg border border-outline-variant/40 bg-surface-container-lowest px-3 py-2 text-sm outline-none ring-primary/30 focus:border-primary/70 focus:ring-2"
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="mb-6">
                  <label className="font-label mb-2 block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                    Irregular room — describe bays, angles, L-shape
                  </label>
                  <textarea
                    value={room.irregularNotes}
                    onChange={(e) =>
                      setRoom(room.id, { irregularNotes: e.target.value })
                    }
                    rows={3}
                    placeholder="e.g. Fifth wall 1.2 m at 135° to wall 4; bay 0.9 m deep…"
                    className="w-full rounded-lg border border-outline-variant/40 bg-surface-container-lowest px-4 py-3 text-sm outline-none ring-primary/30 focus:border-primary/70 focus:ring-2"
                  />
                </div>

                <div className="mb-6">
                  <label className="font-label mb-2 block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                    Notes for this room
                  </label>
                  <textarea
                    value={room.notes}
                    onChange={(e) => setRoom(room.id, { notes: e.target.value })}
                    rows={3}
                    placeholder="Anything else the designer should know…"
                    className="w-full rounded-lg border border-outline-variant/40 bg-surface-container-lowest px-4 py-3 text-sm outline-none ring-primary/30 focus:border-primary/70 focus:ring-2"
                  />
                </div>
                  </>
                )}

              </section>
            ))}

            {!guidedMode && (
              <button
                type="button"
                onClick={() => setGuidedMode(true)}
                className="w-full rounded-full border border-outline-variant/40 px-4 py-2 text-sm font-bold uppercase tracking-widest text-on-surface-variant"
              >
                Ask me one question at a time
              </button>
            )}

            {/* Pager navigation */}
            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => setActiveRoomIndex((i) => Math.max(0, i - 1))}
                disabled={activeRoomIndex === 0}
                className="rounded-full border border-outline-variant/40 px-5 py-2.5 text-sm font-bold uppercase tracking-widest text-on-surface transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
              >
                ← Previous room
              </button>
              <button
                type="button"
                onClick={() =>
                  setActiveRoomIndex((i) => Math.min(rooms.length - 1, i + 1))
                }
                disabled={activeRoomIndex >= rooms.length - 1}
                className="rounded-full border border-outline-variant/40 px-5 py-2.5 text-sm font-bold uppercase tracking-widest text-on-surface transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next room →
              </button>
            </div>

            <button
              type="button"
              onClick={() => {
                addRoom();
                // Jump straight to the room just created — otherwise the
                // pager stays put and the button appears to do nothing.
                setActiveRoomIndex(rooms.length);
              }}
              className="w-full rounded-xl border border-dashed border-outline py-4 text-sm font-bold uppercase tracking-widest text-primary transition-colors hover:bg-surface-container-low"
            >
              + Add another room
            </button>

            {issues.some((i) => i.path === "rooms") && (
              <p data-error-anchor className="text-sm text-error">
                {issueFor("rooms")}
              </p>
            )}

            {/* ── Room connectivity graph ───────────────────────────── */}
            <section className="rounded-xl border border-outline bg-surface-container-low p-6">
              <header className="mb-2 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-lg font-bold text-on-surface">
                    How do the rooms connect?
                  </h3>
                  <p className="mt-1 max-w-prose text-sm text-on-surface-variant">
                    Tell us which rooms open onto each other. This lets us
                    lay out the floor plan without guesswork. You can add
                    one row per door, opening, or shared wall.
                  </p>
                </div>
              </header>

              {rooms.length < 2 && (
                <p className="rounded-lg bg-surface p-3 text-sm text-on-surface-variant">
                  Add a second room above, then come back here to link them.
                </p>
              )}

              {rooms.length >= 2 && (
                <div className="space-y-3">
                  {connections.length === 0 && (
                    <p className="text-sm text-on-surface-variant">
                      No connections yet — tap{" "}
                      <span className="font-semibold">Add connection</span> below.
                    </p>
                  )}

                  {connections.map((c, idx) => {
                    const kindLabel: Record<ConnectionKind, string> = {
                      door: "Door",
                      opening: "Open archway",
                      "shared-wall": "Shared wall (no opening)",
                      stairs: "Stairs (different floors)",
                      external: "External wall",
                    };
                    return (
                      <div
                        key={c.id}
                        className="grid grid-cols-1 gap-3 rounded-lg border border-outline bg-surface p-4 md:grid-cols-12"
                      >
                        <label className="md:col-span-3">
                          <span className="block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                            Room A
                          </span>
                          <select
                            value={c.roomAId}
                            onChange={(e) =>
                              updateConnection(c.id, { roomAId: e.target.value })
                            }
                            className="mt-1 w-full rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-2 py-2 text-sm text-on-surface outline-none ring-primary/30 focus:border-primary/70 focus:ring-2"
                          >
                            <option value="">— pick a room —</option>
                            {rooms.map((r, i) => (
                              <option key={r.id} value={r.id}>
                                {roomDisplayLabel(r, i)}
                              </option>
                            ))}
                          </select>
                        </label>

                        <label className="md:col-span-3">
                          <span className="block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                            Connection
                          </span>
                          <select
                            value={c.kind}
                            onChange={(e) =>
                              updateConnection(c.id, {
                                kind: e.target.value as ConnectionKind,
                              })
                            }
                            className="mt-1 w-full rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-2 py-2 text-sm text-on-surface outline-none ring-primary/30 focus:border-primary/70 focus:ring-2"
                          >
                            {(
                              [
                                "door",
                                "opening",
                                "shared-wall",
                                "stairs",
                                "external",
                              ] as ConnectionKind[]
                            ).map((k) => (
                              <option key={k} value={k}>
                                {kindLabel[k]}
                              </option>
                            ))}
                          </select>
                          {c.kind === "stairs" && (
                            <select
                              value={c.stairsShape ?? "straight"}
                              onChange={(e) =>
                                updateConnection(c.id, {
                                  stairsShape: e.target.value as StairsShape,
                                })
                              }
                              className="mt-2 w-full rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-2 py-2 text-sm text-on-surface outline-none ring-primary/30 focus:border-primary/70 focus:ring-2"
                              aria-label="Stair shape"
                            >
                              <option value="straight">Straight flight</option>
                              <option value="winder-l">L-winder (90° turn)</option>
                              <option value="winder-single">Single winder step</option>
                            </select>
                          )}
                        </label>

                        {c.kind !== "external" && (
                          <label className="md:col-span-3">
                            <span className="block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                              Room B
                            </span>
                            <select
                              value={c.roomBId}
                              onChange={(e) =>
                                updateConnection(c.id, { roomBId: e.target.value })
                              }
                              className="mt-1 w-full rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-2 py-2 text-sm text-on-surface outline-none ring-primary/30 focus:border-primary/70 focus:ring-2"
                            >
                              <option value="">— pick a room —</option>
                              {rooms
                                .filter((r) => r.id !== c.roomAId)
                                .map((r) => {
                                  const i = rooms.indexOf(r);
                                  return (
                                    <option key={r.id} value={r.id}>
                                      {roomDisplayLabel(r, i)}
                                    </option>
                                  );
                                })}
                            </select>
                          </label>
                        )}

                        {(c.kind === "door" || c.kind === "opening") && (
                          <label className="md:col-span-2">
                            <span className="block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                              Width (m)
                            </span>
                            <input
                              type="text"
                              inputMode="decimal"
                              value={c.widthM}
                              onChange={(e) =>
                                updateConnection(c.id, { widthM: e.target.value })
                              }
                              placeholder="0.80"
                              className="mt-1 w-full rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-2 py-2 text-sm text-on-surface outline-none ring-primary/30 focus:border-primary/70 focus:ring-2"
                            />
                          </label>
                        )}

                        <div className="flex items-end justify-end md:col-span-1">
                          <button
                            type="button"
                            onClick={() => removeConnection(c.id)}
                            aria-label={`Remove connection ${idx + 1}`}
                            className="rounded-lg border border-outline px-3 py-2 text-sm font-bold uppercase tracking-widest text-on-surface-variant transition-colors hover:bg-surface-container-low"
                          >
                            ✕
                          </button>
                        </div>

                        <label className="md:col-span-12">
                          <span className="block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                            Notes (optional)
                          </span>
                          <input
                            type="text"
                            value={c.notes}
                            onChange={(e) =>
                              updateConnection(c.id, { notes: e.target.value })
                            }
                            placeholder="e.g. door is double, opens into kitchen"
                            className="mt-1 w-full rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-2 py-2 text-sm text-on-surface outline-none ring-primary/30 focus:border-primary/70 focus:ring-2"
                          />
                        </label>
                      </div>
                    );
                  })}

                  <button
                    type="button"
                    onClick={addConnection}
                    className="w-full rounded-xl border border-dashed border-outline py-3 text-sm font-bold uppercase tracking-widest text-primary transition-colors hover:bg-surface-container-low"
                  >
                    + Add connection
                  </button>
                </div>
              )}
            </section>

            <div className="flex flex-wrap items-center justify-between gap-4">
              {/* Labelled deliberately. As a bare circular arrow sitting
                  just below the room pager, this read as "previous room"
                  — and tapping it threw the customer out of the rooms
                  step back to name and email, losing their place. An
                  icon-only control that leaves the step needs to say so. */}
              <button
                type="button"
                onClick={() => setStep("project")}
                className="inline-flex items-center gap-2 rounded-full border-2 border-outline bg-surface-container-low px-5 py-2.5 text-sm font-bold uppercase tracking-widest text-on-surface shadow-md transition-all hover:bg-surface-container active:scale-[0.94]"
              >
                <span
                  className="material-symbols-outlined"
                  aria-hidden
                  style={{ fontSize: "18px" }}
                >
                  arrow_back
                </span>
                Project details
              </button>
              <button
                type="button"
                onClick={() => {
                  const v = nonBlockingIssues(rooms);
                  setIssues(v);
                  if (v.length) return;
                  setStep("exterior");
                }}
                className="inline-flex items-center gap-3 rounded-full bg-primary px-7 py-3 text-sm font-bold uppercase tracking-widest text-on-primary shadow-lg shadow-primary/30 transition-all hover:bg-surface-tint hover:shadow-xl active:scale-[0.97]"
                aria-label="Continue to exterior photos"
              >
                <span>Exterior photos</span>
                <span
                  className="material-symbols-outlined"
                  aria-hidden
                  style={{ fontSize: "20px" }}
                >
                  arrow_forward
                </span>
              </button>
            </div>
          </div>
        )}

        {step === "exterior" && (
          <section className="space-y-6 tm-lift rounded-2xl border border-outline-variant/30 bg-surface-container-low p-6 md:p-8">
            <header>
              <h2 className="font-headline text-2xl text-on-surface">
                Exterior photos
              </h2>
              <p className="mt-1 text-sm text-on-surface-variant">
                Optional but really helpful: one photo of each side of the
                house so we can see the envelope. Skip any side you can&apos;t
                access.
              </p>
            </header>
            {(["front", "back", "left", "right"] as const).map((side) => (
              <div
                key={side}
                className="rounded-lg border border-outline-variant/30 bg-surface-container-lowest p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-label text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                      {side === "front" && "Front (street side)"}
                      {side === "back" && "Back (garden side)"}
                      {side === "left" && "Left (looking at the front)"}
                      {side === "right" && "Right (looking at the front)"}
                    </p>
                    <p className="mt-1 text-sm text-on-surface-variant">
                      {exteriorPhotos[side].length} photo
                      {exteriorPhotos[side].length === 1 ? "" : "s"}
                    </p>
                  </div>
                  <label className="cursor-pointer rounded-full border border-primary/60 px-3.5 py-1.5 text-sm font-bold uppercase tracking-widest text-primary transition-colors hover:bg-primary hover:text-on-primary">
                    + Add photo
                    <input
                      type="file"
                      accept="image/*,image/jpeg,image/png,image/heic,image/heif,image/webp"
                      multiple
                      className="sr-only"
                      onChange={(e) => {
                        attachExteriorPhotos(side, e.target.files);
                        e.target.value = "";
                      }}
                    />
                  </label>
                </div>
                {exteriorPhotos[side].length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {exteriorPhotos[side].map((p) => (
                      <div
                        key={p.id}
                        className="relative h-16 w-16 overflow-hidden rounded-lg border border-outline-variant/30"
                      >
                        <img
                          src={p.uri}
                          alt={p.name}
                          className="h-full w-full object-cover"
                        />
                        <button
                          type="button"
                          onClick={() => removeExteriorPhoto(side, p.id)}
                          className="absolute right-0.5 top-0.5 rounded bg-inverse-surface/80 px-1 text-sm text-surface"
                          aria-label="Remove photo"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
            <div className="flex justify-between pt-2">
              <button
                type="button"
                onClick={() => setStep("rooms")}
                className="rounded-full border-2 border-outline-variant/40 px-5 py-2 text-sm font-bold uppercase tracking-widest text-on-surface transition-colors hover:border-primary/60 hover:bg-surface-container-low"
              >
                ← Back
              </button>
              <button
                type="button"
                onClick={() => setStep("proposal")}
                className="rounded-full bg-primary px-7 py-2 text-sm font-bold uppercase tracking-widest text-on-primary shadow-lg shadow-primary/25 transition-all hover:bg-surface-tint active:scale-[0.97]"
              >
                Proposal →
              </button>
            </div>
          </section>
        )}

        {step === "proposal" && (
          <section className="space-y-6 tm-lift rounded-2xl border border-outline-variant/30 bg-surface-container-low p-6 md:p-8">
            <header>
              <h2 className="font-headline text-2xl text-on-surface">
                What are you hoping to build?
              </h2>
              <p className="mt-1 text-sm text-on-surface-variant">
                A few sentences about the project plus any sketches,
                Pinterest images, or reference photos you&apos;ve been collecting.
              </p>
            </header>
            <div>
              <label className="font-label mb-2 block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                Description
              </label>
              <textarea
                value={proposalDescription}
                onChange={(e) => setProposalDescription(e.target.value)}
                rows={6}
                placeholder="e.g. Rear single-storey extension off the kitchen, open onto the garden, room for a 6-seat dining table…"
                className="w-full rounded-lg border border-outline-variant/40 bg-surface-container-lowest px-4 py-3 text-sm outline-none ring-primary/30 focus:border-primary/70 focus:ring-2"
              />
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between">
                <label className="font-label block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                  Sketches / inspiration
                </label>
                <label className="cursor-pointer rounded-full border border-primary/60 px-3.5 py-1.5 text-sm font-bold uppercase tracking-widest text-primary transition-colors hover:bg-primary hover:text-on-primary">
                  + Add image
                  <input
                    type="file"
                    accept="image/*,image/jpeg,image/png,image/heic,image/heif,image/webp"
                    multiple
                    className="sr-only"
                    onChange={(e) => {
                      attachProposalSketches(e.target.files);
                      e.target.value = "";
                    }}
                  />
                </label>
              </div>
              {proposalSketches.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {proposalSketches.map((p) => (
                    <div
                      key={p.id}
                      className="relative h-20 w-20 overflow-hidden rounded-lg border border-outline-variant/30"
                    >
                      <img src={p.uri} alt={p.name} className="h-full w-full object-cover" />
                      <button
                        type="button"
                        onClick={() => removeProposalSketch(p.id)}
                        className="absolute right-0.5 top-0.5 rounded bg-inverse-surface/80 px-1 text-sm text-surface"
                        aria-label="Remove sketch"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="flex justify-between pt-2">
              <button
                type="button"
                onClick={() => setStep("exterior")}
                className="rounded-full border-2 border-outline-variant/40 px-5 py-2 text-sm font-bold uppercase tracking-widest text-on-surface transition-colors hover:border-primary/60 hover:bg-surface-container-low"
              >
                ← Back
              </button>
              <button
                type="button"
                onClick={() => setStep("plan")}
                className="rounded-full bg-primary px-7 py-2 text-sm font-bold uppercase tracking-widest text-on-primary shadow-lg shadow-primary/25 transition-all hover:bg-surface-tint active:scale-[0.97]"
              >
                Floor plan →
              </button>
            </div>
          </section>
        )}

        {step === "plan" && (
          <div className="space-y-8">
            <section className="tm-lift rounded-2xl border border-outline-variant/30 bg-surface-container-low p-6 md:p-8">
              <header className="mb-4">
                <h2 className="font-headline text-2xl text-on-surface">
                  Arrange your floor plan
                </h2>
                <p className="mt-2 max-w-prose text-sm text-on-surface-variant">
                  Drag each room into place to show how they fit together.
                  Rooms snap to a 25&nbsp;cm grid. Use the ↻ chip to rotate
                  in 90° steps, and the × chip to send a room back to the
                  palette. Add extra floors or a basement for multi-storey
                  homes.
                </p>
              </header>
              <FloorPlanEditor
                rooms={rooms}
                placements={placements}
                onPlacementChange={updatePlacement}
                onRoomChange={setRoom}
              />
            </section>

            <div className="flex flex-wrap items-center justify-between gap-4">
              <button
                type="button"
                onClick={() => setStep("rooms")}
                className="inline-flex h-12 w-12 items-center justify-center rounded-full border-2 border-outline bg-surface-container-low text-on-surface shadow-md transition-all hover:bg-surface-container active:scale-[0.94]"
                aria-label="Back to rooms"
              >
                <span
                  className="material-symbols-outlined"
                  aria-hidden
                  style={{ fontSize: "24px" }}
                >
                  arrow_back
                </span>
              </button>
              <button
                type="button"
                onClick={goReview}
                className="inline-flex items-center gap-3 rounded-full bg-primary px-7 py-3 text-sm font-bold uppercase tracking-widest text-on-primary shadow-lg shadow-primary/30 transition-all hover:bg-surface-tint hover:shadow-xl active:scale-[0.97]"
                aria-label="Review and export"
              >
                <span>Review &amp; export</span>
                <span
                  className="material-symbols-outlined"
                  aria-hidden
                  style={{ fontSize: "20px" }}
                >
                  arrow_forward
                </span>
              </button>
            </div>
            <p className="text-sm text-on-surface-variant">
              The floor plan is optional — an empty layout still submits,
              but the architect will have to infer the arrangement from
              your room connections.
            </p>
          </div>
        )}

        {step === "review" && (
          <div className="space-y-10">
            <section className="tm-lift rounded-2xl border border-outline-variant/30 bg-surface-container-low p-6 md:p-8">
              <h2 className="font-headline mb-2 text-2xl text-on-surface">
                Submission summary
              </h2>
              <p className="mb-6 text-sm text-on-surface-variant">
                {customerName} · {email} · {projectName}
              </p>

              {/* Openings with no position.
                  A door or window with a width but no place on a wall is
                  drawn in the middle by default, which is silently wrong
                  far more often than it is right. This does not block
                  submission -- someone may genuinely not know, and a
                  centred guess plus a photo beats an abandoned survey --
                  but it should not pass without being said out loud. */}
              {(() => {
                const unplaced = rooms.flatMap((r) =>
                  [...r.doors, ...r.windows]
                    .filter((o) => o.widthM.trim() && !o.positionM?.trim())
                    .map(() => r.name.trim() || "an unnamed room"),
                );
                if (!unplaced.length) return null;
                const names = Array.from(new Set(unplaced));
                return (
                  <div className="mb-6 rounded-lg bg-amber-100/60 px-4 py-3 text-sm leading-relaxed text-amber-900">
                    <span className="font-semibold">
                      {unplaced.length} door{unplaced.length === 1 ? "" : "s"} or
                      window{unplaced.length === 1 ? "" : "s"} without a position
                    </span>{" "}
                    — in {names.join(", ")}. We&apos;ll draw them centred on
                    their wall, which is usually wrong. Go back and drag each
                    one roughly into place; it takes a second and saves a
                    round of questions.
                  </div>
                );
              })()}
              <div className="space-y-8">
                {rooms.map((room, ri) => (
                  <div key={room.id}>
                    <h3 className="font-headline mb-4 text-lg text-primary">
                      {room.name}
                    </h3>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      {room.walls.map((w, wi) => {
                        const m = parseMeters(w.lengthM);
                        const dual = formatLengthDual(m, unit);
                        // The badge used to read "OK" unconditionally, so a
                        // wall the validator would flag still looked
                        // approved on the screen where the customer decides
                        // to submit. Derive it from the same check instead.
                        const wallIssue = issueFor(`room-${ri}-wall-${wi}`);
                        return (
                          <div
                            key={w.id}
                            className="flex items-center justify-between rounded-lg bg-surface-container-lowest p-4 editorial-shadow"
                          >
                            <div>
                              <p className="text-sm font-bold uppercase tracking-wider text-on-surface-variant">
                                {w.label}
                              </p>
                              <p className="font-headline text-2xl text-on-surface">
                                {dual.primary}
                              </p>
                              <p className="text-sm text-on-surface-variant">
                                {dual.secondary}
                              </p>
                            </div>
                            <span
                              className={
                                wallIssue
                                  ? "text-sm font-bold text-error"
                                  : "text-sm font-bold text-emerald-700"
                              }
                              title={wallIssue ?? undefined}
                            >
                              {wallIssue ? "CHECK" : "OK"}
                            </span>
                          </div>
                        );
                      })}
                      {(() => {
                        const m = parseMeters(room.ceilingHeightM);
                        const dual = formatLengthDual(m, unit);
                        return (
                          <div className="flex items-center justify-between rounded-lg bg-surface-container-lowest p-4 editorial-shadow">
                            <div>
                              <p className="text-sm font-bold uppercase tracking-wider text-on-surface-variant">
                                Ceiling height
                              </p>
                              <p className="font-headline text-2xl text-on-surface">
                                {dual.primary}
                              </p>
                              <p className="text-sm text-on-surface-variant">
                                {dual.secondary}
                              </p>
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                    {(room.doors.length > 0 || room.windows.length > 0) && (
                      <ul className="mt-4 list-inside list-disc text-sm text-on-surface-variant">
                        {room.doors.map((d) =>
                          d.widthM.trim() ? (
                            <li key={d.id}>
                              Door {d.widthM} m{d.note ? ` — ${d.note}` : ""}
                            </li>
                          ) : null,
                        )}
                        {room.windows.map((w) =>
                          w.widthM.trim() ? (
                            <li key={w.id}>
                              Window {w.widthM} m{w.note ? ` — ${w.note}` : ""}
                            </li>
                          ) : null,
                        )}
                      </ul>
                    )}
                    {room.irregularNotes.trim() && (
                      <p className="mt-3 text-sm text-on-surface">
                        <strong>Irregular:</strong> {room.irregularNotes}
                      </p>
                    )}
                    {room.notes.trim() && (
                      <p className="mt-2 text-sm text-on-surface-variant">
                        {room.notes}
                      </p>
                    )}
                    {room.photos.length > 0 && (
                      <div className="mt-4 flex flex-wrap gap-2">
                        {room.photos.map((p) => (
                          <img
                            key={p.id}
                            src={p.uri}
                            alt=""
                            className="h-20 w-20 rounded object-cover ring-1 ring-outline-variant/30"
                          />
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* Exterior and proposal are submitted, so they belong in
                  the summary. Without them the customer could not check
                  the description of the work they want before sending
                  it — the most consequential text in the survey. */}
              {(Object.values(exteriorPhotos).some((p) => p.length > 0) ||
                proposalDescription.trim() ||
                proposalSketches.length > 0) && (
                <div className="mt-8 space-y-6 border-t border-outline-variant/30 pt-8">
                  {Object.values(exteriorPhotos).some((p) => p.length > 0) && (
                    <div>
                      <h3 className="font-headline mb-4 text-lg text-primary">
                        Exterior
                      </h3>
                      <div className="space-y-3">
                        {(Object.keys(exteriorPhotos) as ExteriorSide[]).map(
                          (side) =>
                            exteriorPhotos[side].length > 0 ? (
                              <div key={side}>
                                <p className="text-sm font-bold uppercase tracking-wider text-on-surface-variant">
                                  {side}
                                </p>
                                <div className="mt-2 flex flex-wrap gap-2">
                                  {exteriorPhotos[side].map((p) => (
                                    <img
                                      key={p.id}
                                      src={p.uri}
                                      alt=""
                                      className="h-20 w-20 rounded object-cover ring-1 ring-outline-variant/30"
                                    />
                                  ))}
                                </div>
                              </div>
                            ) : null,
                        )}
                      </div>
                    </div>
                  )}
                  {(proposalDescription.trim() ||
                    proposalSketches.length > 0) && (
                    <div>
                      <h3 className="font-headline mb-4 text-lg text-primary">
                        Proposal
                      </h3>
                      {proposalDescription.trim() && (
                        <p className="whitespace-pre-wrap text-sm text-on-surface">
                          {proposalDescription}
                        </p>
                      )}
                      {proposalSketches.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {proposalSketches.map((p) => (
                            <img
                              key={p.id}
                              src={p.uri}
                              alt=""
                              className="h-20 w-20 rounded object-cover ring-1 ring-outline-variant/30"
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </section>

            {submitStatus === "success" ? (
              <div role="status" aria-live="polite" className="tm-lift rounded-2xl border border-primary/40 bg-primary/10 p-6">
                <p className="font-headline text-lg font-semibold text-on-surface">
                  Thanks — your measurements are on their way.
                </p>
                <p className="mt-2 text-sm text-on-surface-variant">
                  We&apos;ve received the details for {projectName || "your project"} and
                  will reply to {email} within 2 working days with a design
                  quote.
                </p>
                {lastSubmissionId && (
                  <div className="mt-4 rounded-md bg-surface-container-lowest p-3 text-sm text-on-surface">
                    <p>
                      <span className="font-label text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                        Submission ID
                      </span>{" "}
                      <span className="font-mono text-base text-primary">{lastSubmissionId}</span>
                    </p>
                    <p className="mt-1 text-sm text-on-surface-variant">
                      Keep this — you can check progress any time at{" "}
                      <Link href="/status" className="text-primary underline">
                        Project status
                      </Link>{" "}
                      using this ID and the email above.
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <>
                <div className="flex flex-wrap gap-4">
                  <button
                    type="button"
                    onClick={() => setStep("rooms")}
                    disabled={submitStatus === "submitting"}
                    className="rounded-full border border-outline px-6 py-3 text-sm font-bold uppercase tracking-widest transition-colors hover:border-primary/60 hover:bg-surface-container-low disabled:opacity-50"
                  >
                    Edit measurements
                  </button>
                  <button
                    type="button"
                    onClick={() => setStep("plan")}
                    disabled={submitStatus === "submitting"}
                    className="rounded-full border border-outline px-6 py-3 text-sm font-bold uppercase tracking-widest transition-colors hover:border-primary/60 hover:bg-surface-container-low disabled:opacity-50"
                  >
                    Edit floor plan
                  </button>
                  {/* The JSON backup download used to sit here. It asked a
                      homeowner to look after a file they cannot read, to
                      guard against a failure they have no way to act on,
                      and it sat next to the button that actually finishes
                      the job. The CAD drawing it was adjacent to is now
                      generated and sent with the submission instead, which
                      is where it is useful — to the person drawing the
                      house, not the person measuring it. */}
                  <button
                    type="button"
                    onClick={submitToBackend}
                    disabled={submitStatus === "submitting"}
                    className="inline-flex items-center gap-2 rounded-full bg-primary px-6 py-3 text-sm font-bold uppercase tracking-widest text-on-primary shadow-lg shadow-primary/25 transition-all hover:bg-surface-tint active:scale-[0.97] disabled:opacity-60"
                  >
                    {submitStatus === "submitting"
                      ? submitProgress && submitProgress.total > 0
                        ? submitProgress.done < submitProgress.total
                          ? `Preparing photo ${submitProgress.done + 1} of ${submitProgress.total}…`
                          : "Sending…"
                        : "Sending…"
                      : (
                        <>
                          <span className="material-symbols-outlined" style={{ fontSize: "18px" }} aria-hidden>send</span>
                          Send to TM Designs
                        </>
                      )}
                  </button>
                </div>
                {submitStatus === "error" && submitError && (
                  <div role="alert" aria-live="assertive" className="mt-2 rounded-xl border border-error/40 bg-error/10 p-4">
                    <p className="text-sm font-semibold text-error">
                      Couldn&apos;t send right now
                    </p>
                    <p className="mt-1 text-sm text-on-surface-variant">
                      {submitError}
                    </p>
                    <p className="mt-2 text-sm text-on-surface-variant">
                      Try again, or{" "}
                      <button
                        type="button"
                        onClick={openMailtoFallback}
                        className="underline hover:text-on-surface"
                      >
                        email us manually
                      </button>
                      .
                    </p>
                  </div>
                )}
                <p className="text-sm text-on-surface-variant">
                  Photo binaries are not uploaded yet — the JSON backup includes
                  filenames only. Attach images manually if your project needs
                  them.
                </p>
              </>
            )}
          </div>
        )}
      </main>

      {/* The guided takeover, rendered as a sibling of <main> rather
          than inside the rooms step.
          It was nested in the step it replaces, which meant the rest of
          that step — the connections section, the pager, the step
          nav — stayed in the document underneath it and showed below
          the takeover's bottom edge. Covering content with a fixed
          overlay only works if the overlay is genuinely the full
          viewport in every browser; not rendering the content at all
          works everywhere. */}
      {guidedProjectActive && (
        <GuidedProjectFlow
          customerName={customerName}
          onCustomerName={setCustomerName}
          email={email}
          onEmail={setEmail}
          projectName={projectName}
          onProjectName={setProjectName}
          projectType={projectType}
          onProjectType={setProjectType}
          defaultCeilingHeightM={defaultCeilingHeightM}
          onDefaultCeilingHeightM={setDefaultCeilingHeightM}
          unit={unit}
          onUnit={setUnit}
          unitLocked={unitLocked}
          // Same handler the one-page version used, so guided mode
          // cannot get past validation the other route enforces.
          onDone={goRooms}
          onExitGuided={() => setGuidedMode(false)}
          issueFor={issueFor}
        />
      )}

      {/* guidedActive, not guidedMode: now that this sits outside the
          step blocks, only the step check keeps it off the exterior,
          plan and review screens. It also stands down while the
          "Resume your previous project?" banner is up, since a
          full-viewport takeover would hide that banner and the
          customer would answer questions on a blank project with their
          saved one waiting invisibly behind it. */}
      {guidedActive && rooms[activeRoomIndex] && (
        <GuidedRoomFlow
          key={rooms[activeRoomIndex].id}
          room={rooms[activeRoomIndex]}
          roomIndex={activeRoomIndex}
          totalRooms={rooms.length}
          onPatch={(patch) => setRoom(rooms[activeRoomIndex].id, patch)}
          onSetShape={(shape) => setShape(rooms[activeRoomIndex].id, shape)}
          onAddOpening={(kind) => addOpening(rooms[activeRoomIndex].id, kind)}
          onRemoveOpening={(kind, id) =>
            removeOpening(rooms[activeRoomIndex].id, kind, id)
          }
          onAddStairs={() => addStairs(rooms[activeRoomIndex].id)}
          onRemoveStairs={(id) => removeStairs(rooms[activeRoomIndex].id, id)}
          onSetStairs={(id, patch) =>
            setStairs(rooms[activeRoomIndex].id, id, patch)
          }
          onPhotos={(files) => attachPhotos(rooms[activeRoomIndex].id, files)}
          onDone={() => {
            // Last room finished: check the whole set before
            // leaving the step, exactly as the manual Continue
            // button does, so guided mode cannot smuggle an
            // incomplete survey past the same validation.
            if (activeRoomIndex < rooms.length - 1) {
              setActiveRoomIndex((i) => i + 1);
              return;
            }
            const v = nonBlockingIssues(rooms);
            setIssues(v);
            if (v.length) {
              // Something is wrong in a room other than this one —
              // GuidedRoomFlow has already cleared its own. The guided
              // screen shows one room at a time and cannot point at a
              // problem elsewhere, so drop to the all-at-once view
              // where every flagged field is visible and anchored.
              // Silently refusing here is what made the Finish button
              // look broken.
              setGuidedMode(false);
              const ri = firstIssueRoomIndex(v);
              if (ri !== null) setActiveRoomIndex(ri);
              return;
            }
            setStep("exterior");
          }}
          onExitGuided={() => setGuidedMode(false)}
          issueFor={(suffix) => issueFor(`room-${activeRoomIndex}-${suffix}`)}
          // Scanning is offered only where the sensor exists.
          // Passing the handler regardless would put two dead
          // entries in the menu on every non-Pro device.
          onScanRoom={
            arSupport === "yes"
        ? () => setScanRoomId(rooms[activeRoomIndex].id)
        : undefined
          }
          onScanHouse={
            arSupport === "yes" ? () => void startHouseScan() : undefined
          }
          onGoToRoom={setActiveRoomIndex}
          roomNames={rooms.map((r) => r.name)}
        />
      )}

      {/* Undo bar.
          Pinned to the bottom rather than placed where the deleted item
          used to be, because the thing that was there has gone and the
          layout has already closed over the gap — a message anchored to
          a vanished row jumps somewhere unpredictable.

          aria-live polite so a screen reader announces the deletion and
          the way back, rather than the row silently disappearing.

          pb-[env(safe-area-inset-bottom)] keeps it clear of the home
          indicator on a notched iPhone, where a bar flush to the bottom
          edge is half-covered and hard to tap. */}
      {undoAction && (
        <div
          role="status"
          aria-live="polite"
          className="fixed inset-x-0 bottom-0 z-[60] px-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
        >
          <div className="mx-auto flex max-w-lg flex-wrap items-center justify-between gap-3 rounded-2xl bg-[#1c1c1a] px-5 py-3 text-[#f7f5ef] shadow-2xl">
            <span className="text-base font-semibold">{undoAction.label}</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={takeUndo}
                className="rounded-full bg-[#e7c177] px-5 py-2 text-base font-bold text-[#1c1c1a]"
              >
                Undo
              </button>
              <button
                type="button"
                onClick={settleUndo}
                aria-label="Dismiss"
                className="rounded-full border border-[#f7f5ef]/30 px-4 py-2 text-base"
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
