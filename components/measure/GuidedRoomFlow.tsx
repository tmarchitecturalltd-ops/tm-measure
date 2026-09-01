"use client";

/**
 * components/measure/GuidedRoomFlow.tsx
 *
 * One question at a time, for one room.
 *
 * The all-at-once room card asks for everything on a single page: name,
 * shape, six wall lengths, ceiling, doors, windows, stairs, photos,
 * voice notes. That is efficient for someone who already knows what all
 * of it means and overwhelming for a homeowner standing in their
 * kitchen holding a tape measure. Reported as "a lot of information for
 * a non-techy customer to engage with and complete", which is a fair
 * description of a screen with thirty inputs on it.
 *
 * This asks one thing per screen with a progress bar. Nothing new is
 * collected and nothing is collected differently — the same fields in
 * the same order, shown one at a time.
 *
 * The all-at-once view is still there behind "Show all at once". Some
 * people genuinely prefer it, and more importantly a guided step that
 * goes wrong must never be the only way through: a customer part-way
 * round a house cannot be left with no route forward.
 */

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Opening, RoomDraft, RoomShape } from "@tm-designs/measure-core";
import WallPositionPicker from "@/components/measure/WallPositionPicker";
import VoiceRecorder from "@/components/measure/VoiceRecorder";
import LengthHint from "@/components/measure/LengthHint";
import CustomShapeEditor from "@/components/measure/CustomShapeEditor";

type StepId =
  | "name"
  | "shape"
  | "walls"
  | "ceiling"
  | "doors"
  | "windows"
  | "stairs"
  | "photos";

type Props = {
  room: RoomDraft;
  roomIndex: number;
  totalRooms: number;
  onPatch: (patch: Partial<RoomDraft>) => void;
  onSetShape: (shape: RoomShape) => void;
  onAddOpening: (kind: "doors" | "windows") => void;
  onRemoveOpening: (kind: "doors" | "windows", id: string) => void;
  onAddStairs: () => void;
  onRemoveStairs: (id: string) => void;
  onSetStairs: (id: string, patch: Partial<NonNullable<RoomDraft["stairs"]>[number]>) => void;
  onPhotos: (files: FileList | null) => void;
  onDone: () => void;
  onExitGuided: () => void;
  issueFor: (suffix: string) => string | undefined;
  /** Open the LiDAR scanner for this room. Absent where unsupported. */
  onScanRoom?: () => void;
  /** Open the whole-property scanner. Absent where unsupported. */
  onScanHouse?: () => void;
  /** Jump straight to another room. */
  onGoToRoom?: (index: number) => void;
  /** Room names, for the jump list in the menu. */
  roomNames?: string[];
};

const LABELS: Record<StepId, string> = {
  name: "What's this room called?",
  shape: "What shape is it?",
  walls: "How long are the walls?",
  ceiling: "How high is the ceiling?",
  doors: "Any doors?",
  windows: "Any windows?",
  stairs: "Any stairs in this room?",
  photos: "A photo of the room",
};

export default function GuidedRoomFlow({
  room,
  roomIndex,
  totalRooms,
  onPatch,
  onSetShape,
  onAddOpening,
  onRemoveOpening,
  onAddStairs,
  onRemoveStairs,
  onSetStairs,
  onPhotos,
  onDone,
  onExitGuided,
  issueFor,
  onScanRoom,
  onScanHouse,
  onGoToRoom,
  roomNames = [],
}: Props) {
  const steps: StepId[] = useMemo(
    () => [
      "name",
      "shape",
      "walls",
      "ceiling",
      "doors",
      "windows",
      "stairs",
      "photos",
    ],
    [],
  );
  const [stepIndex, setStepIndex] = useState(0);
  /**
   * Typing lengths or tracing the outline. Starts on whichever the room
   * already looks like, so returning to a drawn room does not silently
   * present the typing view over a polygon the customer made.
   */
  const [wallMode, setWallMode] = useState<"type" | "draw">(
    room.floorPolygonM?.length ? "draw" : "type",
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  /*
   * Freeze the page behind.
   *
   * This is a full-screen takeover, and without locking the body the
   * page underneath still scrolls when a drag starts on a non-
   * scrollable part of the question -- so the customer returns from
   * guided mode to find the form somewhere they did not leave it.
   */
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Reset the scroll on every step. Without it, moving from a long step
  // to a short one leaves the new question scrolled out of view — the
  // exact problem this layout exists to fix.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [stepIndex, roomIndex]);
  const step = steps[stepIndex];
  const isLast = stepIndex === steps.length - 1;

  const input =
    "w-full rounded-lg border border-outline-variant/40 bg-surface-container-lowest px-4 py-3 text-base outline-none ring-primary/30 focus:border-primary/70 focus:ring-2";

  /**
   * Whether the customer may continue.
   *
   * Deliberately permissive. Only the two things the survey is useless
   * without are required — a name to refer to the room by, and at least
   * one wall length. Everything else can be left, because a guided flow
   * that refuses to advance is worse than one that collects less: the
   * person is standing in a room and cannot always answer in the order
   * we ask.
   */
  const blocked = (): string | null => {
    if (step === "name" && !room.name.trim()) {
      return "Give the room a name so we know which one it is.";
    }
    if (
      step === "walls" &&
      !room.walls.some((w) => w.lengthM.trim()) &&
      // A closed outline is a complete answer to "how long are the
      // walls" — every length is implied by the polygon. Demanding a
      // typed number on top would make drawing extra work rather than
      // an alternative to it.
      (room.floorPolygonM?.length ?? 0) < 3
    ) {
      return "Enter at least one wall length, or draw the shape.";
    }
    return null;
  };
  const block = blocked();

  const openingStep = (kind: "doors" | "windows") => {
    const list = kind === "doors" ? room.doors : room.windows;
    const noun = kind === "doors" ? "door" : "window";
    return (
      <div className="space-y-4">
        {list.length === 0 && (
          <p className="text-sm text-on-surface-variant">
            None added. If this room has no {noun}s, just carry on.
          </p>
        )}
        {list.map((o: Opening) => (
          <div
            key={o.id}
            className="rounded-lg border border-outline-variant/30 bg-surface-container-lowest p-4"
          >
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[7rem] flex-1">
                <label className="mb-1 block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                  Width (m)
                </label>
                <input
                  inputMode="decimal"
                  value={o.widthM}
                  onChange={(e) =>
                    onPatch({
                      [kind]: list.map((x) =>
                        x.id === o.id ? { ...x, widthM: e.target.value } : x,
                      ),
                    } as Partial<RoomDraft>)
                  }
                  placeholder={kind === "doors" ? "0.80" : "1.20"}
                  className={input}
                />
                <LengthHint value={o.widthM} kind="opening" />
              </div>
              <div className="min-w-[7rem] flex-1">
                <label className="mb-1 block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                  On which wall
                </label>
                <select
                  value={o.wallIndex ?? 0}
                  onChange={(e) =>
                    onPatch({
                      [kind]: list.map((x) =>
                        x.id === o.id
                          ? { ...x, wallIndex: parseInt(e.target.value, 10) }
                          : x,
                      ),
                    } as Partial<RoomDraft>)
                  }
                  className={input}
                >
                  {room.walls.map((w, i) => (
                    <option key={w.id} value={i}>
                      {w.label || `Wall ${i + 1}`}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onClick={() => onRemoveOpening(kind, o.id)}
                aria-label={`Remove ${noun}`}
                className="material-symbols-outlined rounded p-2 text-on-surface-variant hover:text-error"
              >
                close
              </button>
            </div>
            <div className="mt-3">
              <WallPositionPicker
                label="Where on that wall?"
                wallLengthM={Number.parseFloat(
                  room.walls[o.wallIndex ?? 0]?.lengthM ?? "",
                )}
                openingWidthM={Number.parseFloat(
                  o.widthM || (kind === "doors" ? "0.8" : "1.2"),
                )}
                positionM={o.positionM ? Number.parseFloat(o.positionM) : null}
                approx={o.positionApprox === true}
                startCornerLabel={
                  room.walls[
                    ((o.wallIndex ?? 0) - 1 + room.walls.length) %
                      room.walls.length
                  ]?.label
                }
                endCornerLabel={
                  room.walls[((o.wallIndex ?? 0) + 1) % room.walls.length]?.label
                }
                onChange={(positionM, approx) =>
                  onPatch({
                    [kind]: list.map((x) =>
                      x.id === o.id
                        ? {
                            ...x,
                            positionM: String(positionM),
                            positionApprox: approx,
                          }
                        : x,
                    ),
                  } as Partial<RoomDraft>)
                }
              />
            </div>
          </div>
        ))}
        <button
          type="button"
          onClick={() => onAddOpening(kind)}
          className="rounded-full border border-primary px-5 py-2 text-sm font-bold uppercase tracking-widest text-primary"
        >
          + Add {noun}
        </button>
      </div>
    );
  };

  return (
    /*
     * The question owns the screen.
     *
     * Previously this was a card sitting below the app header, the
     * progress pills, the intro paragraph and the room pager — so on a
     * phone the actual question was below the fold and every step began
     * by scrolling down to find out what was being asked. A one-
     * question-at-a-time flow whose question you have to go looking for
     * is not really one question at a time.
     *
     * So: fixed to the viewport, everything else gone. Two controls in
     * the corners — a way home on the left, everything else behind a
     * menu on the right — and the question centred between them with
     * its answer and the Next button directly underneath.
     *
     * min-h-0 + overflow-y-auto on the middle band is what keeps the
     * corners and the Next button pinned while a long step (six walls,
     * several windows) scrolls internally.
     */
    <div className="fixed inset-0 z-[45] flex flex-col" style={{ backgroundColor: "#fcf9f5" }}>
      {/* ── Corners ─────────────────────────────────────────────── */}
      <div
        className="flex shrink-0 items-center justify-between px-3 py-2"
        style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
      >
        <Link
          href="/"
          aria-label="Back to the home screen"
          className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-sm font-bold text-on-surface-variant hover:text-primary"
        >
          <span className="material-symbols-outlined" style={{ fontSize: "20px" }} aria-hidden>
            home
          </span>
          Self measure
        </Link>

        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="Menu"
          aria-expanded={menuOpen}
          className="rounded-full px-3 py-2 text-on-surface-variant hover:text-primary"
        >
          <span className="material-symbols-outlined" style={{ fontSize: "26px" }} aria-hidden>
            menu
          </span>
        </button>
      </div>

      {/* Progress. Kept — a guided flow with no visible end is just an
          interrogation — but reduced to a hairline so it frames the
          question rather than competing with it. */}
      <div className="h-1 shrink-0 bg-outline-variant/25">
        <div
          className="h-full bg-primary transition-all"
          style={{ width: `${((stepIndex + 1) / steps.length) * 100}%` }}
        />
      </div>

      {/* ── Menu ────────────────────────────────────────────────── */}
      {menuOpen && (
        <>
          {/* Tap-anywhere-else to close. A menu on a phone that can only
              be dismissed by finding its own button again is a trap. */}
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setMenuOpen(false)}
            className="fixed inset-0 z-40 bg-black/20"
          />
          <div className="absolute right-3 top-14 z-50 w-72 overflow-hidden rounded-2xl border border-outline-variant/40 bg-surface-container-lowest shadow-2xl">
            {onScanRoom && (
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onScanRoom();
                }}
                className="w-full justify-start px-5 py-3 text-left text-base font-semibold text-on-surface"
              >
                Measure this room automatically
              </button>
            )}
            {onScanHouse && (
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onScanHouse();
                }}
                className="w-full justify-start px-5 py-3 text-left text-base font-semibold text-on-surface"
              >
                Scan the whole property
              </button>
            )}

            <div className="border-t border-outline-variant/30 px-5 pb-1 pt-3 text-sm font-bold uppercase tracking-widest text-on-surface-variant">
              Jump to a step
            </div>
            {steps.map((sid, i) => (
              <button
                key={sid}
                type="button"
                onClick={() => {
                  setStepIndex(i);
                  setMenuOpen(false);
                }}
                className={`w-full justify-start px-5 py-2.5 text-left text-base ${
                  i === stepIndex
                    ? "font-bold text-primary"
                    : "text-on-surface"
                }`}
              >
                {LABELS[sid]}
              </button>
            ))}

            {roomNames.length > 1 && onGoToRoom && (
              <>
                <div className="border-t border-outline-variant/30 px-5 pb-1 pt-3 text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                  Jump to a room
                </div>
                {roomNames.map((n, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => {
                      onGoToRoom(i);
                      setStepIndex(0);
                      setMenuOpen(false);
                    }}
                    className={`w-full justify-start px-5 py-2.5 text-left text-base ${
                      i === roomIndex ? "font-bold text-primary" : "text-on-surface"
                    }`}
                  >
                    {i + 1}. {n.trim() || "Unnamed room"}
                  </button>
                ))}
              </>
            )}

            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                onExitGuided();
              }}
              className="w-full justify-start border-t border-outline-variant/30 px-5 py-3 text-left text-base font-semibold text-on-surface-variant"
            >
              Show everything on one page
            </button>
          </div>
        </>
      )}

      {/* ── The question ────────────────────────────────────────── */}
      <div
        ref={scrollRef}
        className="flex min-h-0 flex-1 flex-col justify-center overflow-y-auto px-5 py-4"
      >
        <div className="mx-auto w-full max-w-xl">
          <p className="font-label mb-2 text-sm font-bold uppercase tracking-widest text-primary">
            Room {roomIndex + 1} of {totalRooms}
          </p>
          <h2 className="font-headline mb-5 text-3xl leading-tight text-on-surface">
            {LABELS[step]}
          </h2>

      {step === "name" && (
        <div>
          <input
            value={room.name}
            onChange={(e) => onPatch({ name: e.target.value })}
            placeholder="e.g. Kitchen"
            className={input}
            autoFocus
          />
          <p className="mt-2 text-sm text-on-surface-variant">
            Whatever you call it at home is fine.
          </p>
        </div>
      )}

      {step === "shape" && (
        <div className="flex flex-wrap gap-2">
          {(["rectangle", "l-shape", "custom"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onSetShape(s)}
              className={`rounded-xl border px-5 py-4 text-left ${
                (room.shape ?? "rectangle") === s
                  ? "border-primary bg-primary/10"
                  : "border-outline-variant/40"
              }`}
            >
              <span className="block text-sm font-bold text-on-surface">
                {s === "rectangle"
                  ? "Four straight walls"
                  : s === "l-shape"
                    ? "L-shaped"
                    : "Something else"}
              </span>
              <span className="mt-0.5 block text-sm text-on-surface-variant">
                {s === "rectangle"
                  ? "The usual — a simple box"
                  : s === "l-shape"
                    ? "Six walls, with a corner taken out"
                    : "Draw the outline yourself"}
              </span>
            </button>
          ))}
        </div>
      )}

      {step === "walls" && (
        <div className="space-y-3">
          {/* Type or draw.
              Typing six numbers describes a shape the customer can see
              and we cannot, and for anything other than a plain
              rectangle it is the harder of the two — you have to hold
              the room in your head while entering it a side at a time.
              Tracing the outline is often quicker and it is the only
              way to record a bay, a chimney breast, or a corner cut
              off at an angle. Both write to the same room, so nobody
              has to choose correctly at the start. */}
          <div
            role="radiogroup"
            aria-label="How would you like to enter this room?"
            className="flex gap-2"
          >
            {(["type", "draw"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={wallMode === m}
                onClick={() => {
                  setWallMode(m);
                  // Drawing produces a polygon, which is only honoured
                  // on a custom-shaped room; without this the traced
                  // outline is recorded and then ignored downstream.
                  if (m === "draw" && (room.shape ?? "rectangle") !== "custom") {
                    onSetShape("custom");
                  }
                }}
                className={`flex-1 rounded-xl border px-4 py-3 text-sm font-bold ${
                  wallMode === m
                    ? "border-primary bg-primary/10 text-on-surface"
                    : "border-outline-variant/40 text-on-surface-variant"
                }`}
              >
                {m === "type" ? "Type the lengths" : "Draw the shape"}
              </button>
            ))}
          </div>

          {wallMode === "draw" && (
            <div className="rounded-xl border border-outline-variant/30 p-3">
              <p className="mb-2 text-sm text-on-surface-variant">
                Tap each corner in order, then close the shape. Drag any
                corner to nudge it.
              </p>
              <CustomShapeEditor room={room} onPatch={onPatch} />
            </div>
          )}

          {wallMode === "type" && (
          <>
          <p className="text-sm text-on-surface-variant">
            Work round the room in order. Skip any you can&apos;t reach — one
            is enough to carry on.
          </p>
          {room.walls.map((w, i) => (
            <div key={w.id}>
              <div className="flex items-center gap-3">
                <span className="w-20 shrink-0 text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                  {w.label || `Wall ${i + 1}`}
                </span>
                <input
                  inputMode="decimal"
                  value={w.lengthM}
                  onChange={(e) =>
                    onPatch({
                      walls: room.walls.map((x) =>
                        x.id === w.id ? { ...x, lengthM: e.target.value } : x,
                      ),
                    })
                  }
                  placeholder="0.00"
                  className={input}
                />
                <span className="text-sm text-on-surface-variant">m</span>
              </div>
              <div className="pl-[5.75rem]">
                <LengthHint value={w.lengthM} kind="wall" />
              </div>
            </div>
          ))}
          {issueFor("wall-0") && (
            <p className="text-sm text-error">{issueFor("wall-0")}</p>
          )}
          </>
          )}
        </div>
      )}

      {step === "ceiling" && (
        <div>
          <input
            inputMode="decimal"
            value={room.ceilingHeightM}
            onChange={(e) => onPatch({ ceilingHeightM: e.target.value })}
            placeholder="2.40"
            className={input}
          />
          <LengthHint value={room.ceilingHeightM} kind="ceiling" />
          <p className="mt-2 text-sm text-on-surface-variant">
            Metres, floor to ceiling. Most UK homes are around 2.4.
          </p>
        </div>
      )}

      {step === "doors" && openingStep("doors")}
      {step === "windows" && openingStep("windows")}

      {step === "stairs" && (
        <div className="space-y-4">
          {(room.stairs ?? []).length === 0 && (
            <p className="text-sm text-on-surface-variant">
              Only if a flight starts, ends or passes through this room.
              Otherwise carry on.
            </p>
          )}
          {(room.stairs ?? []).map((s) => (
            <div
              key={s.id}
              className="rounded-lg border border-outline-variant/30 bg-surface-container-lowest p-4"
            >
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-[7rem] flex-1">
                  <label className="mb-1 block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                    Width (m)
                  </label>
                  <input
                    inputMode="decimal"
                    value={s.widthM}
                    onChange={(e) =>
                      onSetStairs(s.id, { widthM: e.target.value })
                    }
                    placeholder="0.90"
                    className={input}
                  />
                </div>
                <div className="min-w-[7rem] flex-1">
                  <label className="mb-1 block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                    Going
                  </label>
                  <select
                    value={s.direction}
                    onChange={(e) =>
                      onSetStairs(s.id, {
                        direction: e.target.value as "up" | "down",
                      })
                    }
                    className={input}
                  >
                    <option value="up">Up from here</option>
                    <option value="down">Down from here</option>
                  </select>
                </div>
                <button
                  type="button"
                  onClick={() => onRemoveStairs(s.id)}
                  aria-label="Remove stairs"
                  className="material-symbols-outlined rounded p-2 text-on-surface-variant hover:text-error"
                >
                  close
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={onAddStairs}
            className="rounded-full border border-primary px-5 py-2 text-sm font-bold uppercase tracking-widest text-primary"
          >
            + Add stairs
          </button>
        </div>
      )}

      {step === "photos" && (
        <div className="space-y-4">
          <p className="text-sm text-on-surface-variant">
            At least one, so the architect can see what the measurements
            can&apos;t show — a chimney breast, a radiator, the state of the
            room.
          </p>
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-full bg-primary px-6 py-3 text-sm font-bold uppercase tracking-widest text-on-primary">
            <span
              className="material-symbols-outlined"
              style={{ fontSize: "18px" }}
              aria-hidden
            >
              photo_camera
            </span>
            {room.photos.length ? "Add another photo" : "Take or choose a photo"}
            <input
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                onPhotos(e.target.files);
                e.currentTarget.value = "";
              }}
            />
          </label>
          {room.photos.length > 0 && (
            <p className="text-sm text-on-surface-variant">
              {room.photos.length} photo
              {room.photos.length === 1 ? "" : "s"} added.
            </p>
          )}

          <div className="border-t border-outline-variant/20 pt-4">
            <label className="mb-1 block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
              Anything else? (optional)
            </label>
            <p className="mb-2 text-sm text-on-surface-variant">
              Faster to say than type — awkward corners, sloping ceilings,
              anything odd.
            </p>
            <VoiceRecorder
              memos={room.voiceMemos ?? []}
              onChange={(next) => onPatch({ voiceMemos: next })}
            />
          </div>
        </div>
      )}

          {block && (
            <p className="mt-4 rounded-md bg-amber-100/60 px-3 py-2 text-sm text-amber-900">
              {block}
            </p>
          )}

          {/* Directly under the question, not pinned to the bottom of
              the screen. On a step with one input there would be a
              stretch of empty space between the answer and the button,
              and the customer has to look away from what they just
              typed to find what to press. */}
          <div className="mt-7 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
              disabled={stepIndex === 0}
              className="rounded-full border border-outline px-6 py-3 text-sm font-bold uppercase tracking-widest disabled:opacity-40"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => {
                if (block) return;
                if (isLast) onDone();
                else setStepIndex((i) => i + 1);
              }}
              disabled={!!block}
              className="rounded-full bg-primary px-8 py-3 text-sm font-bold uppercase tracking-widest text-on-primary disabled:opacity-40"
            >
              {isLast
                ? roomIndex + 1 < totalRooms
                  ? "Next room"
                  : "Finish"
                : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
