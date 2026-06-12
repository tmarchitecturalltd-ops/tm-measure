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
  type ScanResult,
  type StairsShape,
  type WallSegment,
} from "@tm-designs/measure-core";
import type { ScanDimensions } from "@/components/measure/RoomScanOverlay";
import RoomScanReviewFlow from "@/components/measure/RoomScanReviewFlow";
import FloorPlanEditor from "@/components/measure/FloorPlanEditor";
import TutorialOverlay from "@/components/measure/TutorialOverlay";
import CustomShapeEditor from "@/components/measure/CustomShapeEditor";
import VoiceRecorder from "@/components/measure/VoiceRecorder";
import { RoomPlan } from "@tm-designs/capacitor-roomplan";
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

function wallDefaults(): WallSegment[] {
  return [
    { id: newId(), label: "Wall 1 (e.g. North)", lengthM: "" },
    { id: newId(), label: "Wall 2 (e.g. East)", lengthM: "" },
    { id: newId(), label: "Wall 3 (e.g. South)", lengthM: "" },
    { id: newId(), label: "Wall 4 (e.g. West)", lengthM: "" },
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

export default function MeasureIntakeForm() {
  const [step, setStep] = useState<Step>("project");
  const [customerName, setCustomerName] = useState("");
  const [email, setEmail] = useState("");
  const [projectName, setProjectName] = useState("");
  const [projectType, setProjectType] = useState<ProjectType | null>(null);
  const [unit, setUnit] = useState<ProjectDraft["unit"]>("metric");
  const [unitLocked, setUnitLocked] = useState(false);

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
  const draftSaver = useRef(makeDebouncedSaver<ProjectDraftSnapshot>(400));
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [photoTargetRoomId, setPhotoTargetRoomId] = useState<string | null>(
    null,
  );
  const [scanRoomId, setScanRoomId] = useState<string | null>(null);
  const [scanPickerOpen, setScanPickerOpen] = useState(false);
  const [submitStatus, setSubmitStatus] = useState<
    "idle" | "submitting" | "success" | "error"
  >("idle");
  const [submitError, setSubmitError] = useState<string | null>(null);
  /** Submission ID returned by the backend on a successful submit.
   *  Surfaced in the success card so the customer can paste it into
   *  /status if they want to check the architect's progress later. */
  const [lastSubmissionId, setLastSubmissionId] = useState<string | null>(null);

  const openBannerAutoScan = useCallback(() => {
    if (rooms.length === 0) return;
    if (rooms.length === 1) {
      setScanRoomId(rooms[0].id);
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

          // Fill wall slots in order; keep labels from the scan, fall back to
          // existing label if the scan had fewer values than current walls.
          const nextWalls: WallSegment[] = r.walls.map((existing, i) => {
            const m = wallMeasurements[i];
            return m
              ? {
                  id: existing.id,
                  label: m.label || existing.label,
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
            notes: r.notes.trim()
              ? `${r.notes.trim()}\n${stamp}`
              : stamp,
          };
        }),
      );
    },
    [],
  );

  const setRoom = useCallback(
    (id: string, patch: Partial<RoomDraft>) => {
      setRooms((prev) =>
        prev.map((r) => (r.id === id ? { ...r, ...patch } : r)),
      );
    },
    [],
  );

  const addRoom = useCallback(() => {
    setRooms((prev) => [...prev, emptyRoom()]);
  }, []);

  /**
   * Project templates — pre-built room sets for the most common UK
   * residential typologies. Skipping the empty-state ten-minute-think
   * is the goal; the customer still tweaks dimensions per room.
   *
   * Each entry returns an array of {name, floor} pairs. Wall slots
   * and ceiling default to the empty-room blanks so the user has to
   * type the actual dimensions, but the structure is laid out.
   */
  const TEMPLATES: Record<string, { name: string; rooms: { name: string; floor: number }[] }> = {
    flat1: {
      name: "1-bed flat",
      rooms: [
        { name: "Living / kitchen", floor: 0 },
        { name: "Bedroom", floor: 0 },
        { name: "Bathroom", floor: 0 },
        { name: "Hallway", floor: 0 },
      ],
    },
    flat2: {
      name: "2-bed flat",
      rooms: [
        { name: "Living room", floor: 0 },
        { name: "Kitchen", floor: 0 },
        { name: "Bedroom 1", floor: 0 },
        { name: "Bedroom 2", floor: 0 },
        { name: "Bathroom", floor: 0 },
        { name: "Hallway", floor: 0 },
      ],
    },
    semi3: {
      name: "3-bed semi-detached",
      rooms: [
        { name: "Living room", floor: 0 },
        { name: "Kitchen / diner", floor: 0 },
        { name: "Downstairs WC", floor: 0 },
        { name: "Hallway", floor: 0 },
        { name: "Bedroom 1", floor: 1 },
        { name: "Bedroom 2", floor: 1 },
        { name: "Bedroom 3", floor: 1 },
        { name: "Bathroom", floor: 1 },
        { name: "Landing", floor: 1 },
      ],
    },
    detached4: {
      name: "4-bed detached",
      rooms: [
        { name: "Living room", floor: 0 },
        { name: "Dining room", floor: 0 },
        { name: "Kitchen", floor: 0 },
        { name: "Utility", floor: 0 },
        { name: "Downstairs WC", floor: 0 },
        { name: "Hallway", floor: 0 },
        { name: "Bedroom 1 (master)", floor: 1 },
        { name: "Ensuite", floor: 1 },
        { name: "Bedroom 2", floor: 1 },
        { name: "Bedroom 3", floor: 1 },
        { name: "Bedroom 4", floor: 1 },
        { name: "Family bathroom", floor: 1 },
        { name: "Landing", floor: 1 },
      ],
    },
  };

  const applyTemplate = useCallback(
    (key: keyof typeof TEMPLATES) => {
      const t = TEMPLATES[key];
      if (!t) return;
      setRooms((prev) => {
        // Replace blank first room if it's truly empty, otherwise
        // append the template after whatever's already there.
        const allBlank =
          prev.length === 1 &&
          !prev[0].name.trim() &&
          prev[0].walls.every((w) => !w.lengthM.trim()) &&
          !prev[0].ceilingHeightM.trim();
        const generated: RoomDraft[] = t.rooms.map((r) => ({
          ...emptyRoom(),
          name: r.name,
        }));
        // Stamp the floor onto placements so the multi-storey selector
        // already reflects the template's assumption.
        const ids = generated.map((g) => g.id);
        setPlacements((pp) => {
          const next = { ...pp };
          generated.forEach((g, i) => {
            next[ids[i]] = {
              positionM: null,
              rotationDeg: 0,
              floor: t.rooms[i].floor,
            };
          });
          return next;
        });
        return allBlank ? generated : [...prev, ...generated];
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const removeRoom = useCallback((id: string) => {
    setRooms((prev) => {
      const next = prev.filter((r) => r.id !== id);
      return next.length ? next : [emptyRoom()];
    });
    // Drop any connections referencing a deleted room.
    setConnections((prev) =>
      prev.filter((c) => c.roomAId !== id && c.roomBId !== id),
    );
    // Drop any floor-plan placement so stale entries don't haunt the payload.
    setPlacements((prev) => {
      if (!(id in prev)) return prev;
      const { [id]: _dropped, ...rest } = prev;
      return rest;
    });
  }, []);

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
   * Clone a room. Re-IDs the room, its walls, doors, windows, photos
   * and voice memos so references stay disjoint. Photos and audio
   * blobs are shared via URL — the blob backs both entries until the
   * page reloads, which is fine for the submit-then-clear lifecycle.
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
          photos: (w.photos ?? []).map((p) => ({ ...p, id: newId() })),
        })),
        doors: src.doors.map((d) => ({ ...d, id: newId() })),
        windows: src.windows.map((w) => ({ ...w, id: newId() })),
        photos: src.photos.map((p) => ({ ...p, id: newId() })),
        voiceMemos: (src.voiceMemos ?? []).map((m) => ({ ...m, id: newId() })),
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
      setRooms((prev) =>
        prev.map((r) => {
          if (r.id !== roomId) return r;
          const list = r[kind].filter((o) => o.id !== openingId);
          return { ...r, [kind]: list };
        }),
      );
    },
    [],
  );

  const attachPhotos = useCallback(
    (roomId: string, files: FileList | null) => {
      if (!files?.length) return;
      setRooms((prev) =>
        prev.map((r) => {
          if (r.id !== roomId) return r;
          const next: RoomPhoto[] = [...r.photos];
          for (let i = 0; i < files.length; i++) {
            const file = files[i];
            if (!file.type.startsWith("image/")) continue;
            next.push({
              id: newId(),
              uri: URL.createObjectURL(file),
              name: file.name,
              mimeType: file.type,
              sizeBytes: file.size,
            });
          }
          return { ...r, photos: next };
        }),
      );
    },
    [],
  );

  const removePhoto = useCallback((roomId: string, photoId: string) => {
    setRooms((prev) =>
      prev.map((r) => {
        if (r.id !== roomId) return r;
        const photo = r.photos.find((p) => p.id === photoId);
        if (photo) URL.revokeObjectURL(photo.uri);
        return { ...r, photos: r.photos.filter((p) => p.id !== photoId) };
      }),
    );
  }, []);

  /**
   * Per-wall photo helpers. Wall-tied photos let the architect tie a
   * radiator/window/chimney photo to a specific wall on the plan.
   * We keep wall.photos optional — older drafts that don't carry the
   * field are handled gracefully via `wall.photos ?? []`.
   */
  const attachPhotosToWall = useCallback(
    (roomId: string, wallId: string, files: FileList | null) => {
      if (!files?.length) return;
      setRooms((prev) =>
        prev.map((r) => {
          if (r.id !== roomId) return r;
          return {
            ...r,
            walls: r.walls.map((w) => {
              if (w.id !== wallId) return w;
              const next: RoomPhoto[] = [...(w.photos ?? [])];
              for (let i = 0; i < files.length; i++) {
                const file = files[i];
                if (!file.type.startsWith("image/")) continue;
                next.push({
                  id: newId(),
                  uri: URL.createObjectURL(file),
                  name: file.name,
                  mimeType: file.type,
                  sizeBytes: file.size,
                });
              }
              return { ...w, photos: next };
            }),
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
  const [photoTargetWall, setPhotoTargetWall] = useState<{ roomId: string; wallId: string } | null>(null);

  // ── Exterior (4-sides) photos ──────────────────────────────────────
  const [exteriorPhotos, setExteriorPhotos] = useState<
    Record<ExteriorSide, RoomPhoto[]>
  >({ front: [], back: [], left: [], right: [] });
  const [exteriorTargetSide, setExteriorTargetSide] = useState<ExteriorSide | null>(null);

  const attachExteriorPhotos = useCallback(
    (side: ExteriorSide, files: FileList | null) => {
      if (!files?.length) return;
      setExteriorPhotos((prev) => {
        const next = [...prev[side]];
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          if (!file.type.startsWith("image/")) continue;
          next.push({
            id: newId(),
            uri: URL.createObjectURL(file),
            name: file.name,
            mimeType: file.type,
            sizeBytes: file.size,
          });
        }
        return { ...prev, [side]: next };
      });
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
  const [proposalSketchTarget, setProposalSketchTarget] = useState(false);

  const attachProposalSketches = useCallback((files: FileList | null) => {
    if (!files?.length) return;
    setProposalSketches((prev) => {
      const next = [...prev];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (!file.type.startsWith("image/")) continue;
        next.push({
          id: newId(),
          uri: URL.createObjectURL(file),
          name: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
        });
      }
      return next;
    });
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
      rooms: rooms as unknown as Array<Record<string, unknown>>,
      connections: connections as unknown as Array<Record<string, unknown>>,
      placements: placements as unknown as Record<string, unknown>,
    });
  }, [
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

  const goPlan = () => {
    const v = nonBlockingIssues(rooms);
    setIssues(v);
    if (v.length) return;
    setStep("plan");
  };

  const goReview = () => {
    const v = nonBlockingIssues(rooms);
    setIssues(v);
    if (v.length) return;
    setStep("review");
  };

  const issueFor = (path: string) => issues.find((i) => i.path === path)?.message;

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
          label: w.label,
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
          })),
        windows: r.windows
          .filter((w) => w.widthM.trim())
          .map((w) => ({
            widthM: parseMeters(w.widthM),
            note: w.note || undefined,
            wallIndex: w.wallIndex,
            positionM: w.positionM ? parseMeters(w.positionM) : undefined,
          })),
        irregularShapeNotes: r.irregularNotes.trim() || undefined,
        notes: r.notes.trim() || undefined,
        shape: r.shape ?? "rectangle",
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
    return {
      version: 1,
      submittedAt: new Date().toISOString(),
      customerName: customerName.trim(),
      email: email.trim(),
      projectName: projectName.trim(),
      projectType: projectType ?? undefined,
      unitPreference: unit,
      rooms: serialRooms,
      connections: serialConnections,
    };
  }, [
    rooms,
    connections,
    placements,
    customerName,
    email,
    projectName,
    projectType,
    unit,
  ]);

  const downloadJson = () => {
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `tm-measure-${projectName.replace(/\s+/g, "-").slice(0, 40) || "export"}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

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
      setStep("rooms");
      setSubmitStatus("error");
      setSubmitError(
        `Found ${anomalies.length} issue${anomalies.length === 1 ? "" : "s"} that need fixing before submission. We've highlighted them on the rooms step.`,
      );
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
        }
        for (const w of r.walls) {
          wallPhotoUriByRoom[r.id][w.id] = {};
          for (const p of w.photos ?? []) {
            const dataUri = await compressPhotoForUpload(p.uri);
            if (dataUri) wallPhotoUriByRoom[r.id][w.id][p.id] = dataUri;
          }
        }
        for (const m of r.voiceMemos ?? []) {
          const dataUri = await audioToDataUri(m.uri);
          if (dataUri) voiceUriByRoom[r.id][m.id] = dataUri;
        }
      }
      const enrichedPayload = {
        ...payload,
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
      setSubmitStatus("success");
    } catch (err) {
      setSubmitStatus("error");
      // User-friendly mapping of common failure modes. Anything we
      // don't recognise falls through to the underlying message.
      const raw = err instanceof Error ? err.message : String(err);
      let friendly = raw;
      if (/Failed to fetch|NetworkError|TypeError/i.test(raw)) {
        friendly = "Couldn't reach the server. Check your internet connection and try again — your draft is safe.";
      } else if (/Rate limit reached/i.test(raw)) {
        friendly = "We're rate-limited right now. Please try again in an hour — your draft is safe.";
      } else if (/Server responded 5\d\d/i.test(raw)) {
        friendly = "TM Designs' server is having a wobble. Please try again in a few minutes — your draft is safe.";
      } else if (/Server responded 4\d\d/i.test(raw)) {
        friendly = "The server refused this submission. Please email inquiries@tmdesignsltd.com if it keeps happening.";
      }
      setSubmitError(friendly);
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

  return (
    <div className="min-h-screen bg-surface pb-28 pt-24">
      <TutorialOverlay />
      <header className="fixed left-0 right-0 top-0 z-40 border-b border-outline-variant/20 bg-surface/90 backdrop-blur-xl">
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
              <p className="font-label text-[10px] font-bold uppercase tracking-widest text-primary">
                TM Measure
              </p>
              <h1 className="font-headline text-lg font-semibold text-on-surface">
                Self-measurement intake
              </h1>
            </div>
          </div>
          <span className="hidden text-xs text-on-surface-variant sm:block">
            Web · Manual entry (PRD §4.2)
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 md:px-6">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          // `capture="environment"` forced the rear camera and hid the
          // photo-library / file-picker options on iOS — testers were
          // stuck if the camera dialog misbehaved. Without it, iOS
          // shows its standard Take Photo / Photo Library action sheet.
          className="hidden"
          onChange={(e) => {
            // Targets routed in priority order. Set by the button the
            // user just tapped — wall, room, exterior side, proposal.
            if (photoTargetWall) {
              attachPhotosToWall(photoTargetWall.roomId, photoTargetWall.wallId, e.target.files);
              setPhotoTargetWall(null);
            } else if (exteriorTargetSide) {
              attachExteriorPhotos(exteriorTargetSide, e.target.files);
              setExteriorTargetSide(null);
            } else if (proposalSketchTarget) {
              attachProposalSketches(e.target.files);
              setProposalSketchTarget(false);
            } else if (photoTargetRoomId) {
              attachPhotos(photoTargetRoomId, e.target.files);
            }
            setPhotoTargetRoomId(null);
            e.target.value = "";
          }}
        />
        <p className="mb-8 max-w-3xl text-sm leading-relaxed text-on-surface-variant">
          Guided room capture per{" "}
          <strong className="text-on-surface">FR-01–FR-04</strong>: walls, doors,
          windows, validation, notes, and photos. Use{" "}
          <strong className="text-on-surface">Auto-Scan Room</strong> for camera-led
          capture (video / corner / LiDAR placeholder), then refine in{" "}
          <strong className="text-on-surface">metres</strong> (imperial shown on
          review per FR-25).
        </p>

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
                        setScanRoomId(room.id);
                        setScanPickerOpen(false);
                      }}
                      className="flex w-full items-center justify-between gap-3 rounded-lg border border-outline-variant/30 bg-surface-container-low px-4 py-4 text-left transition-colors hover:border-primary hover:bg-surface-container-high"
                    >
                      <span className="font-semibold text-on-surface">
                        {roomDisplayLabel(room, ri)}
                      </span>
                      <span className="shrink-0 rounded bg-inverse-surface/10 px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
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
              <p className="mt-1 text-xs text-on-surface-variant">
                We saved your draft from {new Date(pendingDraft.savedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })} on the <span className="font-semibold">{pendingDraft.step}</span> step. Photos aren&apos;t kept; you&apos;ll re-take any.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={applyPendingDraft}
                className="rounded-full bg-primary px-4 py-2 text-xs font-bold uppercase tracking-widest text-on-primary"
              >
                Resume
              </button>
              <button
                type="button"
                onClick={discardPendingDraft}
                className="rounded-full border border-outline-variant/40 px-4 py-2 text-xs font-bold uppercase tracking-widest text-on-surface"
              >
                Start fresh
              </button>
            </div>
          </div>
        )}

        <ol className="mb-10 flex flex-wrap gap-3 text-xs font-semibold uppercase tracking-wider text-on-surface-variant">
          {([
            { key: "project", label: "1. Your details" },
            { key: "rooms", label: "2. Rooms" },
            { key: "exterior", label: "3. Exterior" },
            { key: "proposal", label: "4. Proposal" },
            { key: "plan", label: "5. Floor plan" },
            { key: "review", label: "6. Review" },
          ] as const).map((s) => {
            const active = step === s.key;
            return (
              <li key={s.key}>
                <button
                  type="button"
                  onClick={() => setStep(s.key)}
                  aria-current={active ? "step" : undefined}
                  className={`rounded-full px-4 py-2 transition ${active ? "bg-primary text-on-primary shadow-sm" : "bg-surface-container-low hover:bg-surface-container-high"}`}
                >
                  {s.label}
                </button>
              </li>
            );
          })}
        </ol>

        {step === "project" && (
          <section className="space-y-6 rounded-xl bg-surface-container-low p-6 md:p-8">
            <h2 className="font-headline text-2xl text-on-surface">Project details</h2>
            <div className="grid gap-6 md:grid-cols-2">
              <div>
                <label className="font-label mb-2 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                  Your name *
                </label>
                <input
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  className="w-full rounded border border-outline-variant/30 bg-surface-container-lowest px-4 py-3 text-sm outline-none ring-primary/40 focus:ring-2"
                />
                {issueFor("name") && (
                  <p className="mt-1 text-xs text-error">{issueFor("name")}</p>
                )}
              </div>
              <div>
                <label className="font-label mb-2 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                  Email *
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded border border-outline-variant/30 bg-surface-container-lowest px-4 py-3 text-sm outline-none ring-primary/40 focus:ring-2"
                />
                {issueFor("email") && (
                  <p className="mt-1 text-xs text-error">{issueFor("email")}</p>
                )}
              </div>
              <div className="md:col-span-2">
                <label className="font-label mb-2 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                  Project name *
                </label>
                <input
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder="e.g. Rear extension — 12 Smith Street"
                  className="w-full rounded border border-outline-variant/30 bg-surface-container-lowest px-4 py-3 text-sm outline-none ring-primary/40 focus:ring-2"
                />
                {issueFor("project") && (
                  <p className="mt-1 text-xs text-error">{issueFor("project")}</p>
                )}
              </div>
              <div>
                <span className="font-label mb-2 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                  Display units {unitLocked && <span className="ml-1 text-primary">· locked</span>}
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => !unitLocked && setUnit("metric")}
                    disabled={unitLocked}
                    aria-disabled={unitLocked}
                    className={`rounded px-4 py-2 text-xs font-semibold uppercase transition disabled:cursor-not-allowed disabled:opacity-60 ${
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
                    className={`rounded px-4 py-2 text-xs font-semibold uppercase transition disabled:cursor-not-allowed disabled:opacity-60 ${
                      unit === "imperial"
                        ? "bg-primary text-on-primary"
                        : "bg-surface-container-high text-on-surface"
                    }`}
                  >
                    Imperial primary
                  </button>
                </div>
                <p className="mt-2 text-xs text-on-surface-variant">
                  {unitLocked
                    ? "Units are locked for this project to prevent metric/imperial mix-ups mid-survey."
                    : "Pick once — units lock when you continue. Entries are stored in metres; the review step shows both."}
                </p>
              </div>
              <div>
                <span className="font-label mb-2 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                  Device capability
                </span>
                {arSupport === "unknown" && (
                  <p className="text-xs text-on-surface-variant">Checking AR capability…</p>
                )}
                {arSupport === "yes" && (
                  <p className="rounded-md bg-primary/10 px-3 py-2 text-xs text-primary">
                    AR scan available — you'll get the option to LiDAR-scan each room.
                  </p>
                )}
                {arSupport === "no" && (
                  <p className="rounded-md bg-surface-container-high px-3 py-2 text-xs text-on-surface-variant">
                    Manual / corner-tap mode only{arReason ? ` — ${arReason}` : "."} You'll still get accurate dimensions from photo taps.
                  </p>
                )}
              </div>
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

        {step === "rooms" && (
          <div className="space-y-10">
            {/* Quick-start templates — pre-build the room list for the
                most common UK property types. The customer still tweaks
                wall lengths / ceilings, but skips the typing. */}
            <section className="rounded-xl border border-outline-variant/30 bg-surface-container-low p-5">
              <h2 className="font-headline text-lg text-on-surface">
                Quick start
              </h2>
              <p className="mt-1 text-xs text-on-surface-variant">
                Pick a typical layout and we&apos;ll add the rooms for you. Tap a
                room afterwards to fill in dimensions.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {(Object.keys(TEMPLATES) as Array<keyof typeof TEMPLATES>).map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => applyTemplate(key)}
                    className="rounded-full border border-primary/50 px-4 py-1.5 text-[11px] font-bold uppercase tracking-widest text-primary hover:bg-primary hover:text-on-primary"
                  >
                    {TEMPLATES[key].name}
                  </button>
                ))}
              </div>
            </section>

            <div className="rounded-xl border-2 border-primary/40 bg-inverse-surface p-6 text-on-primary shadow-lg md:p-8">
              <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="font-label text-[10px] font-bold uppercase tracking-[0.25em] text-primary">
                    Auto-scan
                  </p>
                  <h2 className="font-headline mt-1 text-xl text-[#f7f5ef] md:text-2xl">
                    Scan your room with the camera
                  </h2>
                  <p className="mt-2 max-w-xl text-sm text-white/65">
                    Full-screen HUD with LiDAR/RoomPlan placeholder, corner marking, or
                    360° video + mock AI processing. With several rooms, you&apos;ll
                    pick which one to update; a single room opens the scan right away.
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

            {rooms.map((room, ri) => (
              <section
                key={room.id}
                className="rounded-xl border border-outline-variant/20 bg-surface-container-low p-6 md:p-8"
              >
                <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <h2 className="font-headline text-xl text-on-surface">
                      Room {ri + 1}
                    </h2>
                    {/* Multi-storey selector — small inline dropdown so
                        the customer can flag which storey this room is
                        on. Stored as `placement.floor` (integer). */}
                    <label className="inline-flex items-center gap-2 text-[11px] text-on-surface-variant">
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
                        className="rounded border border-outline-variant/40 bg-surface-container-lowest px-2 py-1 text-sm text-on-surface"
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
                    <button
                      type="button"
                      onClick={() => setScanRoomId(room.id)}
                      className="rounded-lg border border-primary bg-primary/10 px-4 py-2 text-xs font-bold uppercase tracking-widest text-primary transition-colors hover:bg-primary hover:text-on-primary"
                    >
                      Auto-Scan this room
                    </button>
                    {/* Reorder + duplicate cluster. The duplicate helper
                        deep-clones the room (new IDs throughout) and the
                        arrows nudge it up or down in the list. */}
                    <button
                      type="button"
                      onClick={() => moveRoom(room.id, -1)}
                      disabled={ri === 0}
                      aria-label="Move room up"
                      className="rounded border border-outline-variant/40 px-2 py-1 text-xs text-on-surface hover:border-primary disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => moveRoom(room.id, 1)}
                      disabled={ri === rooms.length - 1}
                      aria-label="Move room down"
                      className="rounded border border-outline-variant/40 px-2 py-1 text-xs text-on-surface hover:border-primary disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      onClick={() => duplicateRoom(room.id)}
                      className="rounded border border-outline-variant/40 px-2 py-1 text-xs font-bold uppercase tracking-widest text-on-surface hover:border-primary"
                    >
                      Duplicate
                    </button>
                    {rooms.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeRoom(room.id)}
                        className="text-xs font-bold uppercase tracking-widest text-error hover:underline"
                      >
                        Remove room
                      </button>
                    )}
                  </div>
                </div>

                <div className="mb-6">
                  <label className="font-label mb-2 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                    Room name *
                  </label>
                  <input
                    value={room.name}
                    onChange={(e) =>
                      setRoom(room.id, { name: e.target.value })
                    }
                    placeholder="e.g. Kitchen, Master bedroom"
                    className="w-full max-w-md rounded border border-outline-variant/30 bg-surface-container-lowest px-4 py-3 text-sm outline-none ring-primary/40 focus:ring-2"
                  />
                  {issueFor(`room-${ri}-name`) && (
                    <p className="mt-1 text-xs text-error">
                      {issueFor(`room-${ri}-name`)}
                    </p>
                  )}
                </div>

                {/* Room shape selector. Most rooms are rectangular —
                    we surface that as the default and only ask for
                    the notch dimensions when the customer flips to
                    L-shape. Custom polygon is a power-user option. */}
                <div className="mb-6">
                  <h3 className="font-label mb-2 text-xs font-bold uppercase tracking-widest text-primary">
                    Room shape
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {(["rectangle", "l-shape", "custom"] as const).map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setRoom(room.id, { shape: s })}
                        className={`rounded-full px-4 py-1.5 text-[11px] font-bold uppercase tracking-widest transition ${
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
                  {room.shape === "l-shape" && (
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <label className="text-xs text-on-surface-variant">
                        Notch width (m)
                        <input
                          inputMode="decimal"
                          value={room.notchWidthM ?? ""}
                          onChange={(e) =>
                            setRoom(room.id, { notchWidthM: e.target.value })
                          }
                          placeholder="0.00"
                          className="mt-1 w-full rounded border border-outline-variant/30 bg-surface px-3 py-2 text-sm"
                        />
                      </label>
                      <label className="text-xs text-on-surface-variant">
                        Notch length (m)
                        <input
                          inputMode="decimal"
                          value={room.notchLengthM ?? ""}
                          onChange={(e) =>
                            setRoom(room.id, { notchLengthM: e.target.value })
                          }
                          placeholder="0.00"
                          className="mt-1 w-full rounded border border-outline-variant/30 bg-surface px-3 py-2 text-sm"
                        />
                      </label>
                      <p className="sm:col-span-2 text-[11px] text-on-surface-variant">
                        Imagine the room as a rectangle with a rectangular bite cut
                        out of one corner. Width × length here is the size of that bite.
                      </p>
                    </div>
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
                    <h3 className="font-label text-xs font-bold uppercase tracking-widest text-primary">
                      Wall lengths (FR-01 / irregular FR-02)
                    </h3>
                    <button
                      type="button"
                      onClick={() => addWall(room.id)}
                      className="text-xs font-bold uppercase tracking-widest text-primary hover:underline"
                    >
                      + Add wall segment
                    </button>
                  </div>
                  <div className="space-y-3">
                    {room.walls.map((w, wi) => (
                      <div
                        key={w.id}
                        className="flex flex-col gap-2 rounded-lg bg-surface-container-lowest p-4 sm:flex-row sm:items-end"
                      >
                        <div className="min-w-0 flex-1">
                          <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                            Label
                          </label>
                          <input
                            value={w.label}
                            onChange={(e) => {
                              const walls = room.walls.map((x) =>
                                x.id === w.id
                                  ? { ...x, label: e.target.value }
                                  : x,
                              );
                              setRoom(room.id, { walls });
                            }}
                            className="w-full rounded border border-outline-variant/30 bg-surface px-3 py-2 text-sm"
                          />
                        </div>
                        <div className="w-full sm:w-40">
                          <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
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
                            className="w-full rounded border border-outline-variant/30 bg-surface px-3 py-2 text-sm"
                          />
                          {issueFor(`room-${ri}-wall-${wi}`) && (
                            <p className="mt-1 text-xs text-error">
                              {issueFor(`room-${ri}-wall-${wi}`)}
                            </p>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setPhotoTargetWall({ roomId: room.id, wallId: w.id });
                            fileInputRef.current?.click();
                          }}
                          className="material-symbols-outlined shrink-0 rounded p-2 text-on-surface-variant hover:bg-surface-container-low hover:text-primary"
                          aria-label="Add photo of this wall"
                          title="Add photo of this wall"
                        >
                          add_a_photo
                        </button>
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
                                className="relative h-16 w-16 overflow-hidden rounded border border-outline-variant/30"
                              >
                                <img
                                  src={p.uri}
                                  alt={p.name}
                                  className="h-full w-full object-cover"
                                />
                                <button
                                  type="button"
                                  onClick={() => removePhotoFromWall(room.id, w.id, p.id)}
                                  className="absolute right-0.5 top-0.5 rounded bg-inverse-surface/80 px-1 text-[10px] text-surface"
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

                <div className="mb-8">
                  <label className="font-label mb-2 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                    Ceiling height (m) *
                  </label>
                  <input
                    inputMode="decimal"
                    value={room.ceilingHeightM}
                    onChange={(e) =>
                      setRoom(room.id, { ceilingHeightM: e.target.value })
                    }
                    placeholder="e.g. 2.45"
                    className="w-full max-w-xs rounded border border-outline-variant/30 bg-surface-container-lowest px-4 py-3 text-sm outline-none ring-primary/40 focus:ring-2"
                  />
                  {issueFor(`room-${ri}-ceiling`) && (
                    <p className="mt-1 text-xs text-error">
                      {issueFor(`room-${ri}-ceiling`)}
                    </p>
                  )}
                </div>

                <div className="mb-8 grid gap-8 md:grid-cols-2">
                  <div>
                    <div className="mb-3 flex items-center justify-between">
                      <h3 className="font-label text-xs font-bold uppercase tracking-widest text-primary">
                        Doors
                      </h3>
                      <button
                        type="button"
                        onClick={() => addOpening(room.id, "doors")}
                        className="text-xs font-bold uppercase tracking-widest text-primary hover:underline"
                      >
                        + Add door
                      </button>
                    </div>
                    {room.doors.length === 0 && (
                      <p className="text-xs text-on-surface-variant">
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
                            <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
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
                              className="w-full rounded border border-outline-variant/30 bg-surface px-3 py-2 text-sm"
                            />
                            {issueFor(`room-${ri}-door-${di}`) && (
                              <p className="mt-1 text-xs text-error">
                                {issueFor(`room-${ri}-door-${di}`)}
                              </p>
                            )}
                          </div>
                          <div className="flex-1">
                            <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
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
                              className="w-full rounded border border-outline-variant/30 bg-surface px-3 py-2 text-sm"
                            >
                              {room.walls.map((w, i) => (
                                <option key={w.id} value={i}>
                                  Wall {i + 1}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="flex-1">
                            <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                              Offset (m)
                            </label>
                            <input
                              inputMode="decimal"
                              value={d.positionM ?? ""}
                              onChange={(e) => {
                                const doors = room.doors.map((x) =>
                                  x.id === d.id ? { ...x, positionM: e.target.value } : x,
                                );
                                setRoom(room.id, { doors });
                              }}
                              placeholder="from wall start"
                              className="w-full rounded border border-outline-variant/30 bg-surface px-3 py-2 text-sm"
                            />
                          </div>
                          <div className="flex-[2]">
                            <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
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
                              className="w-full rounded border border-outline-variant/30 bg-surface px-3 py-2 text-sm"
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
                      <h3 className="font-label text-xs font-bold uppercase tracking-widest text-primary">
                        Windows
                      </h3>
                      <button
                        type="button"
                        onClick={() => addOpening(room.id, "windows")}
                        className="text-xs font-bold uppercase tracking-widest text-primary hover:underline"
                      >
                        + Add window
                      </button>
                    </div>
                    {room.windows.length === 0 && (
                      <p className="text-xs text-on-surface-variant">
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
                            <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
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
                              className="w-full rounded border border-outline-variant/30 bg-surface px-3 py-2 text-sm"
                            />
                            {issueFor(`room-${ri}-window-${wi}`) && (
                              <p className="mt-1 text-xs text-error">
                                {issueFor(`room-${ri}-window-${wi}`)}
                              </p>
                            )}
                          </div>
                          <div className="flex-1">
                            <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
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
                              className="w-full rounded border border-outline-variant/30 bg-surface px-3 py-2 text-sm"
                            >
                              {room.walls.map((wallSeg, i) => (
                                <option key={wallSeg.id} value={i}>
                                  Wall {i + 1}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="flex-1">
                            <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                              Offset (m)
                            </label>
                            <input
                              inputMode="decimal"
                              value={w.positionM ?? ""}
                              onChange={(e) => {
                                const windows = room.windows.map((x) =>
                                  x.id === w.id ? { ...x, positionM: e.target.value } : x,
                                );
                                setRoom(room.id, { windows });
                              }}
                              placeholder="from wall start"
                              className="w-full rounded border border-outline-variant/30 bg-surface px-3 py-2 text-sm"
                            />
                          </div>
                          <div className="flex-[2]">
                            <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
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
                              className="w-full rounded border border-outline-variant/30 bg-surface px-3 py-2 text-sm"
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

                <div className="mb-6">
                  <label className="font-label mb-2 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                    Irregular room (FR-02) — describe bays, angles, L-shape
                  </label>
                  <textarea
                    value={room.irregularNotes}
                    onChange={(e) =>
                      setRoom(room.id, { irregularNotes: e.target.value })
                    }
                    rows={3}
                    placeholder="e.g. Fifth wall 1.2 m at 135° to wall 4; bay 0.9 m deep…"
                    className="w-full rounded border border-outline-variant/30 bg-surface-container-lowest px-4 py-3 text-sm outline-none ring-primary/40 focus:ring-2"
                  />
                </div>

                <div className="mb-6">
                  <label className="font-label mb-2 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                    Notes for this room (FR-04)
                  </label>
                  <textarea
                    value={room.notes}
                    onChange={(e) => setRoom(room.id, { notes: e.target.value })}
                    rows={3}
                    placeholder="Anything else the designer should know…"
                    className="w-full rounded border border-outline-variant/30 bg-surface-container-lowest px-4 py-3 text-sm outline-none ring-primary/40 focus:ring-2"
                  />
                </div>

                <div>
                  <label className="font-label mb-2 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                    Photos * — corners, openings, overall context
                  </label>
                  <p className="mb-3 text-xs text-on-surface-variant">
                    Required: at least one reference photo per room so the architect can audit the measurements against what's actually there (radiators, columns, molding, etc.).
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setPhotoTargetRoomId(room.id);
                      fileInputRef.current?.click();
                    }}
                    className="mb-4 inline-flex items-center gap-2 rounded border border-primary px-4 py-2 text-xs font-bold uppercase tracking-widest text-primary transition-colors hover:bg-primary hover:text-on-primary"
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: "16px" }} aria-hidden>add_a_photo</span>
                    Take photo or upload
                  </button>
                  {issueFor(`room-${ri}-photos`) && (
                    <p className="mb-3 text-xs text-error">
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
                          className="absolute right-1 top-1 rounded bg-inverse-surface/80 px-1 text-[10px] text-surface"
                        >
                          ✕
                        </button>
                        <p className="truncate p-1 text-[9px] text-on-surface-variant">
                          {p.name}
                        </p>
                      </div>
                    ))}
                  </div>
                  <div className="mt-4 border-t border-outline-variant/20 pt-4">
                    <label className="font-label mb-1 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                      Voice memo (optional)
                    </label>
                    <p className="mb-1 text-xs text-on-surface-variant">
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
              </section>
            ))}

            <button
              type="button"
              onClick={addRoom}
              className="w-full rounded-xl border border-dashed border-outline py-4 text-sm font-bold uppercase tracking-widest text-primary transition-colors hover:bg-surface-container-low"
            >
              + Add another room (FR-06)
            </button>

            {issues.some((i) => i.path === "rooms") && (
              <p className="text-sm text-error">{issueFor("rooms")}</p>
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
                <p className="rounded-lg bg-surface p-3 text-xs text-on-surface-variant">
                  Add a second room above, then come back here to link them.
                </p>
              )}

              {rooms.length >= 2 && (
                <div className="space-y-3">
                  {connections.length === 0 && (
                    <p className="text-xs text-on-surface-variant">
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
                          <span className="block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                            Room A
                          </span>
                          <select
                            value={c.roomAId}
                            onChange={(e) =>
                              updateConnection(c.id, { roomAId: e.target.value })
                            }
                            className="mt-1 w-full rounded border border-outline bg-surface px-2 py-2 text-sm text-on-surface"
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
                          <span className="block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                            Connection
                          </span>
                          <select
                            value={c.kind}
                            onChange={(e) =>
                              updateConnection(c.id, {
                                kind: e.target.value as ConnectionKind,
                              })
                            }
                            className="mt-1 w-full rounded border border-outline bg-surface px-2 py-2 text-sm text-on-surface"
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
                              className="mt-2 w-full rounded border border-outline bg-surface px-2 py-2 text-sm text-on-surface"
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
                            <span className="block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                              Room B
                            </span>
                            <select
                              value={c.roomBId}
                              onChange={(e) =>
                                updateConnection(c.id, { roomBId: e.target.value })
                              }
                              className="mt-1 w-full rounded border border-outline bg-surface px-2 py-2 text-sm text-on-surface"
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
                            <span className="block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
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
                              className="mt-1 w-full rounded border border-outline bg-surface px-2 py-2 text-sm text-on-surface"
                            />
                          </label>
                        )}

                        <div className="flex items-end justify-end md:col-span-1">
                          <button
                            type="button"
                            onClick={() => removeConnection(c.id)}
                            aria-label={`Remove connection ${idx + 1}`}
                            className="rounded border border-outline px-3 py-2 text-xs font-bold uppercase tracking-widest text-on-surface-variant hover:bg-surface-container-low"
                          >
                            ✕
                          </button>
                        </div>

                        <label className="md:col-span-12">
                          <span className="block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                            Notes (optional)
                          </span>
                          <input
                            type="text"
                            value={c.notes}
                            onChange={(e) =>
                              updateConnection(c.id, { notes: e.target.value })
                            }
                            placeholder="e.g. door is double, opens into kitchen"
                            className="mt-1 w-full rounded border border-outline bg-surface px-2 py-2 text-sm text-on-surface"
                          />
                        </label>
                      </div>
                    );
                  })}

                  <button
                    type="button"
                    onClick={addConnection}
                    className="w-full rounded border border-dashed border-outline py-3 text-xs font-bold uppercase tracking-widest text-primary transition-colors hover:bg-surface-container-low"
                  >
                    + Add connection
                  </button>
                </div>
              )}
            </section>

            <div className="flex flex-wrap items-center justify-between gap-4">
              <button
                type="button"
                onClick={() => setStep("project")}
                className="inline-flex h-12 w-12 items-center justify-center rounded-full border-2 border-outline bg-surface-container-low text-on-surface shadow-md transition-all hover:bg-surface-container active:scale-[0.94]"
                aria-label="Back to project details"
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
          <section className="space-y-6 rounded-xl bg-surface-container-low p-6 md:p-8">
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
                    <p className="font-label text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                      {side === "front" && "Front (street side)"}
                      {side === "back" && "Back (garden side)"}
                      {side === "left" && "Left (looking at the front)"}
                      {side === "right" && "Right (looking at the front)"}
                    </p>
                    <p className="mt-1 text-xs text-on-surface-variant">
                      {exteriorPhotos[side].length} photo
                      {exteriorPhotos[side].length === 1 ? "" : "s"}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setExteriorTargetSide(side);
                      fileInputRef.current?.click();
                    }}
                    className="rounded border border-primary px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-primary hover:bg-primary hover:text-on-primary"
                  >
                    + Add photo
                  </button>
                </div>
                {exteriorPhotos[side].length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {exteriorPhotos[side].map((p) => (
                      <div
                        key={p.id}
                        className="relative h-16 w-16 overflow-hidden rounded border border-outline-variant/30"
                      >
                        <img
                          src={p.uri}
                          alt={p.name}
                          className="h-full w-full object-cover"
                        />
                        <button
                          type="button"
                          onClick={() => removeExteriorPhoto(side, p.id)}
                          className="absolute right-0.5 top-0.5 rounded bg-inverse-surface/80 px-1 text-[10px] text-surface"
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
                className="rounded-full border-2 border-outline-variant/40 px-5 py-2 text-xs font-bold uppercase tracking-widest text-on-surface"
              >
                ← Back
              </button>
              <button
                type="button"
                onClick={() => setStep("proposal")}
                className="rounded-full bg-primary px-7 py-2 text-xs font-bold uppercase tracking-widest text-on-primary"
              >
                Proposal →
              </button>
            </div>
          </section>
        )}

        {step === "proposal" && (
          <section className="space-y-6 rounded-xl bg-surface-container-low p-6 md:p-8">
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
              <label className="font-label mb-2 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                Description
              </label>
              <textarea
                value={proposalDescription}
                onChange={(e) => setProposalDescription(e.target.value)}
                rows={6}
                placeholder="e.g. Rear single-storey extension off the kitchen, open onto the garden, room for a 6-seat dining table…"
                className="w-full rounded border border-outline-variant/30 bg-surface-container-lowest px-4 py-3 text-sm outline-none ring-primary/40 focus:ring-2"
              />
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between">
                <label className="font-label block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                  Sketches / inspiration
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setProposalSketchTarget(true);
                    fileInputRef.current?.click();
                  }}
                  className="rounded border border-primary px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-primary hover:bg-primary hover:text-on-primary"
                >
                  + Add image
                </button>
              </div>
              {proposalSketches.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {proposalSketches.map((p) => (
                    <div
                      key={p.id}
                      className="relative h-20 w-20 overflow-hidden rounded border border-outline-variant/30"
                    >
                      <img src={p.uri} alt={p.name} className="h-full w-full object-cover" />
                      <button
                        type="button"
                        onClick={() => removeProposalSketch(p.id)}
                        className="absolute right-0.5 top-0.5 rounded bg-inverse-surface/80 px-1 text-[10px] text-surface"
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
                className="rounded-full border-2 border-outline-variant/40 px-5 py-2 text-xs font-bold uppercase tracking-widest text-on-surface"
              >
                ← Back
              </button>
              <button
                type="button"
                onClick={() => setStep("plan")}
                className="rounded-full bg-primary px-7 py-2 text-xs font-bold uppercase tracking-widest text-on-primary"
              >
                Floor plan →
              </button>
            </div>
          </section>
        )}

        {step === "plan" && (
          <div className="space-y-8">
            <section className="rounded-xl bg-surface-container-low p-6 md:p-8">
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
            <p className="text-xs text-on-surface-variant">
              The floor plan is optional — an empty layout still submits,
              but the architect will have to infer the arrangement from
              your room connections.
            </p>
          </div>
        )}

        {step === "review" && (
          <div className="space-y-10">
            <section className="rounded-xl bg-surface-container-low p-6 md:p-8">
              <h2 className="font-headline mb-2 text-2xl text-on-surface">
                Submission summary
              </h2>
              <p className="mb-6 text-sm text-on-surface-variant">
                {customerName} · {email} · {projectName}
              </p>
              <div className="space-y-8">
                {rooms.map((room, ri) => (
                  <div key={room.id}>
                    <h3 className="font-headline mb-4 text-lg text-primary">
                      {room.name}
                    </h3>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      {room.walls.map((w) => {
                        const m = parseMeters(w.lengthM);
                        const dual = formatLengthDual(m, unit);
                        return (
                          <div
                            key={w.id}
                            className="flex items-center justify-between rounded-lg bg-surface-container-lowest p-4 editorial-shadow"
                          >
                            <div>
                              <p className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">
                                {w.label}
                              </p>
                              <p className="font-headline text-2xl text-on-surface">
                                {dual.primary}
                              </p>
                              <p className="text-xs text-on-surface-variant">
                                {dual.secondary}
                              </p>
                            </div>
                            <span className="text-[10px] font-bold text-emerald-700">
                              OK
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
                              <p className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">
                                Ceiling height
                              </p>
                              <p className="font-headline text-2xl text-on-surface">
                                {dual.primary}
                              </p>
                              <p className="text-xs text-on-surface-variant">
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
            </section>

            {submitStatus === "success" ? (
              <div role="status" aria-live="polite" className="rounded border border-primary/40 bg-primary/10 p-6">
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
                      <span className="font-label text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                        Submission ID
                      </span>{" "}
                      <span className="font-mono text-base text-primary">{lastSubmissionId}</span>
                    </p>
                    <p className="mt-1 text-xs text-on-surface-variant">
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
                    className="rounded border border-outline px-6 py-3 text-sm font-bold uppercase tracking-widest disabled:opacity-50"
                  >
                    Edit measurements
                  </button>
                  <button
                    type="button"
                    onClick={() => setStep("plan")}
                    disabled={submitStatus === "submitting"}
                    className="rounded border border-outline px-6 py-3 text-sm font-bold uppercase tracking-widest disabled:opacity-50"
                  >
                    Edit floor plan
                  </button>
                  <button
                    type="button"
                    onClick={downloadJson}
                    disabled={submitStatus === "submitting"}
                    className="inline-flex items-center gap-2 rounded bg-inverse-surface px-6 py-3 text-sm font-bold uppercase tracking-widest text-surface hover:opacity-90 disabled:opacity-50"
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: "18px" }} aria-hidden>download</span>
                    Download JSON (backup)
                  </button>
                  <button
                    type="button"
                    onClick={submitToBackend}
                    disabled={submitStatus === "submitting"}
                    className="inline-flex items-center gap-2 rounded bg-primary px-6 py-3 text-sm font-bold uppercase tracking-widest text-on-primary hover:bg-surface-tint disabled:opacity-60"
                  >
                    {submitStatus === "submitting"
                      ? "Sending…"
                      : (
                        <>
                          <span className="material-symbols-outlined" style={{ fontSize: "18px" }} aria-hidden>send</span>
                          Send to TM Designs
                        </>
                      )}
                  </button>
                </div>
                {submitStatus === "error" && submitError && (
                  <div role="alert" aria-live="assertive" className="mt-2 rounded border border-error/40 bg-error/10 p-4">
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
                <p className="text-xs text-on-surface-variant">
                  Photo binaries are not uploaded yet — the JSON backup includes
                  filenames only. Attach images manually if your project needs
                  them.
                </p>
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
