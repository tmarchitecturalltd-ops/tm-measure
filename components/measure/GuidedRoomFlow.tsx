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

import { useMemo, useState } from "react";
import type { Opening, RoomDraft, RoomShape } from "@tm-designs/measure-core";
import WallPositionPicker from "@/components/measure/WallPositionPicker";
import VoiceRecorder from "@/components/measure/VoiceRecorder";
import LengthHint from "@/components/measure/LengthHint";

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
    if (step === "walls" && !room.walls.some((w) => w.lengthM.trim())) {
      return "Enter at least one wall length.";
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
    <section className="tm-lift rounded-2xl border border-outline-variant/30 bg-surface-container-low p-5 md:p-7">
      {/* Where am I, and how much is left. A guided flow without a
          visible end is just an interrogation. */}
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-label text-sm font-bold uppercase tracking-widest text-primary">
          Room {roomIndex + 1} of {totalRooms} · step {stepIndex + 1} of{" "}
          {steps.length}
        </p>
        <button
          type="button"
          onClick={onExitGuided}
          className="text-sm font-bold uppercase tracking-widest text-on-surface-variant hover:text-primary"
        >
          Show all at once
        </button>
      </div>
      <div className="mb-5 h-1.5 w-full overflow-hidden rounded-full bg-outline-variant/30">
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${((stepIndex + 1) / steps.length) * 100}%` }}
        />
      </div>

      <h2 className="font-headline mb-4 text-2xl text-on-surface">
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

      <div className="mt-6 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
          disabled={stepIndex === 0}
          className="rounded-full border border-outline px-5 py-2.5 text-sm font-bold uppercase tracking-widest disabled:opacity-40"
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
          className="rounded-full bg-primary px-7 py-2.5 text-sm font-bold uppercase tracking-widest text-on-primary disabled:opacity-40"
        >
          {isLast ? "Finish this room" : "Next"}
        </button>
      </div>
    </section>
  );
}
