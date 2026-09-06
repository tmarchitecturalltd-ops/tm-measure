"use client";

/**
 * components/measure/GuidedExtrasFlow.tsx
 *
 * The exterior photos and the proposal, one question at a time.
 *
 * These were the last two steps still laid out as long cards: four
 * photo slots on one page, then a description and a sketch uploader on
 * another. Everything before them asks one thing per screen, and a
 * survey that changes its manner two thirds of the way through reads
 * as two applications stitched together.
 *
 * Six screens now — one per side of the house, then the description,
 * then the sketches. Every one of them is skippable, because all of
 * this is genuinely optional: a customer who cannot get round the back
 * of their own house should not be stopped here.
 */

import { useState } from "react";
import type { RoomDraft, RoomPhoto, RoomStairs } from "@tm-designs/measure-core";
import GuidedScreen, {
  type MenuSection,
} from "@/components/measure/GuidedScreen";

import type { ExteriorSide } from "@tm-designs/measure-core";

type Side = ExteriorSide;
type StepId = Side | "stairs" | "description" | "sketches";

/**
 * Services and roof sit after the four elevations.
 *
 * They are the two things a survey is most often missing when it comes
 * back, and neither is something a customer would think to photograph
 * unprompted — a boiler is furniture to the person who lives with it.
 * Asked plainly, at the point they are already walking round with the
 * camera open, they cost a tap each and save a second visit.
 */
const STEPS: StepId[] = [
  "stairs",
  "front",
  "back",
  "left",
  "right",
  "services",
  "roof",
  "description",
  "sketches",
];

const LABELS: Record<StepId, string> = {
  stairs: "Are there any stairs?",
  front: "A photo of the front",
  back: "A photo of the back",
  left: "A photo of the left side",
  right: "A photo of the right side",
  services: "The boiler and the fuse box",
  roof: "The roof and the gutters",
  description: "What are you hoping to build?",
  sketches: "Any sketches or inspiration?",
};

const HINTS: Record<StepId, string> = {
  stairs:
    "One entry per flight — the main staircase, plus any others. Say which room you'd be standing in at the bottom.",
  front: "The street side. Stand back far enough to get the whole house in.",
  back: "The garden side, if you can get to it.",
  left: "Looking at the front of the house, the side on your left.",
  right: "Looking at the front of the house, the side on your right.",
  // Named the way a homeowner would say it. "Consumer unit" is the
  // correct term and almost nobody outside the trade uses it, so it
  // goes in brackets rather than in the question.
  services:
    "Where the boiler is, and the fuse box (consumer unit) — usually a grey box with switches. It tells us what can move and what can't.",
  roof:
    "From the ground is fine. The gutters, and the roof if you can see it. Worth photographing anything already sagging or patched.",
  description:
    "A few sentences is plenty. What you want, roughly where, and anything that matters to you.",
  sketches:
    "Anything you've been collecting — a rough drawing, photos of houses you like, screenshots.",
};

type Props = {
  photosBySide: Record<Side, RoomPhoto[]>;
  onAddSidePhotos: (side: Side, files: FileList | null) => void;
  onRemoveSidePhoto: (side: Side, id: string) => void;
  description: string;
  onDescription: (v: string) => void;
  sketches: RoomPhoto[];
  onAddSketches: (files: FileList | null) => void;
  onRemoveSketch: (id: string) => void;
  /**
   * Every room, so a flight can be attached to the one it starts in.
   *
   * The stairs data still lives on a room — the plan draws it against
   * that room's walls, so it has nowhere else to live — but the
   * question is asked once here rather than once per room.
   */
  rooms: RoomDraft[];
  onAddStairs: (roomId: string) => void;
  onSetStairs: (
    roomId: string,
    stairsId: string,
    patch: Partial<RoomStairs>,
  ) => void;
  onRemoveStairs: (roomId: string, stairsId: string) => void;
  /** Back out to the rooms step. */
  onBackToRooms: () => void;
  /** Finished — on to the floor plan. */
  onDone: () => void;
};

export default function GuidedExtrasFlow({
  photosBySide,
  onAddSidePhotos,
  onRemoveSidePhoto,
  description,
  onDescription,
  sketches,
  onAddSketches,
  onRemoveSketch,
  rooms,
  onAddStairs,
  onSetStairs,
  onRemoveStairs,
  onBackToRooms,
  onDone,
}: Props) {
  const [stepIndex, setStepIndex] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  /** Which room the next flight gets attached to. */
  const [addToRoomId, setAddToRoomId] = useState<string | null>(null);
  const step = STEPS[stepIndex];
  const isLast = stepIndex === STEPS.length - 1;
  const isSide =
    step !== "description" && step !== "sketches" && step !== "stairs";

  /** Every flight in the house, flattened, with the room it sits in. */
  const flights = rooms.flatMap((r) =>
    (r.stairs ?? []).map((s) => ({ room: r, stairs: s })),
  );

  const field =
    "w-full rounded-lg border border-outline-variant/40 bg-surface-container-lowest px-3 py-2 text-base outline-none ring-primary/30 focus:border-primary/70 focus:ring-2";

  const menuSections: MenuSection[] = [
    {
      heading: "Jump to",
      items: STEPS.map((s, i) => ({
        label: LABELS[s],
        onClick: () => setStepIndex(i),
        active: i === stepIndex,
      })),
    },
    { items: [{ label: "Back to the rooms", onClick: onBackToRooms }] },
  ];

  const thumbs = (
    photos: RoomPhoto[],
    remove: (id: string) => void,
  ) =>
    photos.length > 0 && (
      <div className="mt-4 flex flex-wrap gap-2">
        {photos.map((p) => (
          <div
            key={p.id}
            className="relative h-24 w-24 overflow-hidden rounded-xl border border-outline-variant/30"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={p.uri} alt={p.name} className="h-full w-full object-cover" />
            <button
              type="button"
              onClick={() => remove(p.id)}
              aria-label={`Remove ${p.name}`}
              className="absolute right-1 top-1 rounded-full bg-inverse-surface/85 px-2 text-sm text-surface"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    );

  const addButton = (
    label: string,
    onFiles: (files: FileList | null) => void,
  ) => (
    // A label rather than a button, because a file input cannot be
    // opened programmatically on iOS without the tap landing on the
    // input itself. Styled to match the primary action, and sized to
    // the same 56px as the bottom bar.
    <label
      style={{ minHeight: 56 }}
      className="flex w-full cursor-pointer items-center justify-center rounded-2xl border-2 border-primary px-6 text-sm font-bold uppercase tracking-widest text-primary"
    >
      {label}
      <input
        type="file"
        accept="image/*,image/jpeg,image/png,image/heic,image/heif,image/webp"
        multiple
        className="sr-only"
        onChange={(e) => {
          onFiles(e.target.files);
          // Cleared so choosing the same file twice still fires.
          e.target.value = "";
        }}
      />
    </label>
  );

  return (
    <GuidedScreen
      eyebrow={
        step === "stairs"
          ? "The house as a whole"
          : step === "services" || step === "roof"
          ? // Not "Outside the house": a boiler is usually in a kitchen
            // cupboard, and telling someone to go outside to photograph
            // it is how the step gets skipped.
            "A few details"
          : isSide
            ? "Outside the house"
            : "Your project"
      }
      title={LABELS[step]}
      progress={(stepIndex + 1) / STEPS.length}
      menuOpen={menuOpen}
      onMenuOpenChange={setMenuOpen}
      menuSections={menuSections}
      scrollKey={stepIndex}
      onBack={() =>
        stepIndex === 0 ? onBackToRooms() : setStepIndex((i) => i - 1)
      }
      onNext={() => {
        if (isLast) onDone();
        else setStepIndex((i) => i + 1);
      }}
      // Nothing here is required, so Next never blocks and its label
      // says so when there is nothing to move on from.
      nextLabel={
        isLast
          ? "Done"
          : step === "stairs"
            ? flights.length
              ? "Next"
              : "Skip"
            : isSide && photosBySide[step as Side].length === 0
              ? "Skip"
              : "Next"
      }
    >
      <p className="mb-4 text-base leading-relaxed text-on-surface-variant">
        {HINTS[step]}
      </p>

      {isSide && (
        <div>
          {addButton(
            photosBySide[step as Side].length ? "Add another photo" : "Take or choose a photo",
            (files) => onAddSidePhotos(step as Side, files),
          )}
          {thumbs(photosBySide[step as Side], (id) =>
            onRemoveSidePhoto(step as Side, id),
          )}
        </div>
      )}

      {step === "stairs" && (
        <div className="space-y-4">
          {flights.length === 0 && (
            <p className="text-sm text-on-surface-variant">
              Nothing added yet. A bungalow or a single-storey flat won&apos;t
              have any — skip straight past.
            </p>
          )}

          {flights.map(({ room, stairs: s }) => (
            <div
              key={s.id}
              className="rounded-xl border border-outline-variant/30 bg-surface-container-lowest p-4"
            >
              {/* The room is shown, not editable.
                  A dropdown here would have to move the flight, and a
                  move is a remove-and-add: the id and the wall the
                  flight runs along belong to the room it was created
                  in, so there is nothing to carry the width and the
                  tread count across on. The customer would change the
                  room and watch their numbers empty themselves. It is
                  chosen when the flight is added, and getting it wrong
                  costs one Remove. */}
              <p className="text-sm font-bold uppercase tracking-widest text-primary">
                Starts in {room.name?.trim() || "an unnamed room"}
              </p>

              <div className="mt-3 flex flex-wrap items-end gap-3">
                <div className="min-w-[7rem] flex-1">
                  <label className="mb-1 block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                    Width (m)
                  </label>
                  <input
                    inputMode="decimal"
                    value={s.widthM}
                    onChange={(e) =>
                      onSetStairs(room.id, s.id, { widthM: e.target.value })
                    }
                    placeholder="0.90"
                    className={field}
                  />
                </div>
                <div className="min-w-[7rem] flex-1">
                  <label className="mb-1 block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                    Going
                  </label>
                  <select
                    value={s.direction}
                    onChange={(e) =>
                      onSetStairs(room.id, s.id, {
                        direction: e.target.value as "up" | "down",
                      })
                    }
                    className={field}
                  >
                    <option value="up">Up from there</option>
                    <option value="down">Down from there</option>
                  </select>
                </div>
              </div>

              <div className="mt-3">
                <label className="mb-1 block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                  Steps, if you counted them
                </label>
                <input
                  inputMode="numeric"
                  value={s.treads ?? ""}
                  onChange={(e) =>
                    onSetStairs(room.id, s.id, { treads: e.target.value })
                  }
                  placeholder="13"
                  className={field}
                />
                <p className="mt-1 text-sm text-on-surface-variant">
                  Leave it blank and we&apos;ll assume 13, which is the usual
                  number.
                </p>
              </div>

              <button
                type="button"
                onClick={() => onRemoveStairs(room.id, s.id)}
                style={{ minHeight: 44 }}
                className="mt-3 text-sm font-bold uppercase tracking-widest text-on-surface-variant"
              >
                Remove this flight
              </button>
            </div>
          ))}

          {rooms.length > 0 && (
            <div className="rounded-xl border border-outline-variant/30 p-4">
              <label className="mb-1 block text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                Which room do the stairs start in?
              </label>
              <select
                value={addToRoomId ?? rooms[0].id}
                onChange={(e) => setAddToRoomId(e.target.value)}
                className={field}
              >
                {rooms.map((r, i) => (
                  <option key={r.id} value={r.id}>
                    {r.name?.trim() || `Room ${i + 1}`}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => onAddStairs(addToRoomId ?? rooms[0].id)}
                style={{ minHeight: 56 }}
                className="mt-3 w-full rounded-2xl border-2 border-primary px-6 text-sm font-bold uppercase tracking-widest text-primary"
              >
                {flights.length ? "Add another flight" : "Add these stairs"}
              </button>
            </div>
          )}
        </div>
      )}

      {step === "description" && (
        <textarea
          value={description}
          onChange={(e) => onDescription(e.target.value)}
          rows={7}
          placeholder="e.g. We'd like a single-storey extension across the back, opening onto the garden, with the kitchen moved into it."
          className="w-full rounded-xl border border-outline-variant/40 bg-surface-container-lowest px-4 py-3 text-base outline-none ring-primary/30 focus:border-primary/70 focus:ring-2"
        />
      )}

      {step === "sketches" && (
        <div>
          {addButton(
            sketches.length ? "Add another" : "Choose images",
            onAddSketches,
          )}
          {thumbs(sketches, onRemoveSketch)}
        </div>
      )}
    </GuidedScreen>
  );
}
