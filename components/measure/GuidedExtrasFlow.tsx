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
 * Seven screens now — one per side of the house, then manholes, then
 * the description and the sketches. Every one of them is skippable, because all of
 * this is genuinely optional: a customer who cannot get round the back
 * of their own house should not be stopped here.
 */

import { useState } from "react";
import type { RoomPhoto } from "@tm-designs/measure-core";
import GuidedScreen, {
  type MenuSection,
} from "@/components/measure/GuidedScreen";

import type { ExteriorSide } from "@tm-designs/measure-core";

type Side = ExteriorSide;
/*
 * No stairs step.
 *
 * Stairs are placed on the floor plan instead, where the customer can
 * see the rooms they run between and drag a flight to where it really
 * is -- including into a hall or a landing that belongs to no room,
 * which this step could not express at all. Asking here produced a
 * form with a width, a tread count and a room name, and no way to say
 * the one thing that matters about a staircase, which is where it is.
 */
type StepId = Side | "description" | "sketches";

/**
 * Manholes sit after the four elevations.
 *
 * Drains are the thing a survey is most often missing when it comes
 * back, and not something a customer would photograph unprompted — a
 * cover is part of the path to the person who walks over it every
 * day. Asked plainly, while they are already outside with the camera
 * open, it costs a tap and saves a second visit.
 *
 * A roof-and-gutters step sat here too. It was cut: the elevations
 * already show the roof from the ground, which is all a photograph
 * taken by someone standing in their own garden can show, so it was
 * one more screen to skip for a picture we already had.
 */
const STEPS: StepId[] = [
  "front",
  "back",
  "left",
  "right",
  "services",
  "description",
  "sketches",
];

const LABELS: Record<StepId, string> = {
  front: "A photo of the front",
  back: "A photo of the back",
  left: "A photo of the left side",
  right: "A photo of the right side",
  services: "Any manhole covers",
  description: "What are you hoping to build?",
  sketches: "Any sketches or inspiration?",
};

const HINTS: Record<StepId, string> = {
  front: "The street side. Stand back far enough to get the whole house in.",
  back: "The garden side, if you can get to it.",
  left: "Looking at the front of the house, the side on your left.",
  right: "Looking at the front of the house, the side on your right.",
  // Drains decide where an extension can go, and a manhole in the
  // wrong place is one of the few things that can stop a design after
  // it has been drawn. Photographed from above, with the surroundings
  // in shot, so the run between covers can be read off the picture.
  services:
    "The round or square metal covers in a path or the garden. Take two: one straight down over the cover, and one from further back showing the path with the cover in it and the back of the house behind — so we can see where it sits in relation to the house.",
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
  onBackToRooms,
  onDone,
}: Props) {
  const [stepIndex, setStepIndex] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const step = STEPS[stepIndex];
  const isLast = stepIndex === STEPS.length - 1;
  const isSide = step !== "description" && step !== "sketches";

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
        step === "services"
          ? "Drains"
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
