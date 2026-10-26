"use client";

/**
 * components/measure/ScanResultFilter.tsx
 *
 * What the sensor found, before anyone is asked to name it.
 *
 * A whole-property scan used to drop the customer straight into
 * "What's this room called?" for Room 1 of 6, with no idea what the
 * six were. RoomPlan captures whatever it sees, so some of those six
 * are places nobody walked into -- a hallway through an open door, a
 * cupboard, half the room next door. Removing one meant paging to it
 * and finding Delete in a menu, which you would only do if you already
 * knew it was there.
 *
 * So: one screen, a row per capture, tick what to keep. Strays are
 * pre-unticked rather than deleted, because a cupboard somebody is
 * genuinely surveying is one tap away.
 *
 * Each row draws the room's own outline. Two numbers tell you a room
 * is 4.2 by 3.1; the shape tells you which room it is, and whether the
 * scan picked up the chimney breast -- which until now could only be
 * checked by opening the DXF on a computer.
 */

import { useState } from "react";
import {
  looksLikeMergedCapture,
  looksLikeStrayCapture,
  outlineThumbnail,
  outlineAreaM2,
  roomFootprint,
  type RoomDraft,
  type RoomStairs,
} from "@tm-designs/measure-core";
import GuidedScreen from "@/components/measure/GuidedScreen";

type Props = {
  rooms: RoomDraft[];
  /**
   * Staircases the sensor found, by room id, awaiting a yes or no.
   *
   * RoomPlan measures a flight better than anybody dragging one
   * onto a plan. The objection to using it was never the
   * measurement: it was that a staircase nobody had vouched for
   * would appear on a drawing a builder prices from, with nothing
   * saying it was the app's idea. Asking here settles that while
   * the customer is still standing in the house.
   */
  stairsProposals?: Record<string, RoomStairs[]>;
  /** Keep these rooms, and these staircases, and drop the rest. */
  onConfirm: (keepIds: string[], keepStairIds: string[]) => void;
  onBack: () => void;
};

export default function ScanResultFilter({
  rooms,
  stairsProposals,
  onConfirm,
  onBack,
}: Props) {
  /*
   * Staircases start ticked.
   *
   * Opposite to stray rooms, which start unticked, and for the
   * opposite reason. A stray is something the sensor caught by
   * accident and nobody wants; a staircase it has measured is
   * something somebody does want, and only low-confidence
   * detections get this far. The question being asked is "is this
   * right?", not "would you like one?", so the answer it offers
   * is the sensor's and the customer overrules it.
   */
  const [droppedStairs, setDroppedStairs] = useState<Set<string>>(
    () => new Set(),
  );
  const [dropped, setDropped] = useState<Set<string>>(
    () =>
      new Set(
        rooms
          .filter((r) => {
            const { widthM, lengthM } = roomFootprint(r);
            return looksLikeStrayCapture(widthM, lengthM);
          })
          .map((r) => r.id),
      ),
  );

  const keeping = rooms.filter((r) => !dropped.has(r.id));

  return (
    <GuidedScreen
      eyebrow="From the scan"
      title={`We found ${rooms.length} room${rooms.length === 1 ? "" : "s"}`}
      progress={0.45}
      menuOpen={false}
      onMenuOpenChange={() => {}}
      menuSections={[]}
      scrollKey="scan-filter"
      onBack={onBack}
      onNext={() =>
        onConfirm(
          keeping.map((r) => r.id),
          Object.values(stairsProposals ?? {})
            .flat()
            .filter((st) => !droppedStairs.has(st.id))
            .map((st) => st.id),
        )
      }
      nextLabel={
        keeping.length === rooms.length
          ? "Keep all"
          : `Keep these ${keeping.length}`
      }
      nextDisabled={keeping.length === 0}
      blockMessage={
        keeping.length === 0 ? "Keep at least one room to carry on." : null
      }
    >
      <p className="mb-3 text-base leading-relaxed text-on-surface-variant">
        Untick anything that isn&apos;t a room. A scan often catches a
        doorway or the room next door in passing.
      </p>

      {/* One room is an answer, not a fault.
          This was an amber warning saying "Only one room came back" and
          telling the customer to go back and scan again. Nothing was
          actually blocking them -- one room has always been enough to
          carry on with -- but a yellow box that opens by contradicting
          what you just did reads as a refusal, and it was taken as one:
          reported as the app making you record at least two rooms.
          Plenty of jobs are one room. Somebody scanning a single
          kitchen for a rear extension has done exactly the right
          thing and should not be told off for it. So: no amber, no
          "only", and the possibility that it stopped early offered
          second, as a thing they might want rather than a thing they
          got wrong. */}
      {rooms.length === 1 && (
        <p className="mb-3 text-sm text-on-surface-variant">
          One room is fine if that&apos;s the job. If you meant to scan
          more, go back and walk through each room, pressing Done only
          at the very end.
        </p>
      )}

      <ul className="overflow-hidden rounded-2xl border border-outline-variant/40">
        {rooms.map((r, i) => {
          const kept = !dropped.has(r.id);
          /*
           * The footprint, not walls[0] by walls[1].
           *
           * A scanned room's walls arrive in the sensor's order, so
           * those two are whichever it fitted first. The capture that
           * made this matter was three rooms taken as one: its
           * envelope was 9.81 by 6.97 m, but the first two walls it
           * returned were short ones, so every test on this screen
           * was asked about a small room and sensibly said nothing.
           * `roomFootprint` is the same fix already made in
           * floorplan.ts, and the same reason.
           */
          const { widthM: w, lengthM: l } = roomFootprint(r);
          const thumb = outlineThumbnail(r.floorPolygonM, 44, 4);
          return (
            <li key={r.id}>
              <button
                type="button"
                onClick={() =>
                  setDropped((prev) => {
                    const next = new Set(prev);
                    if (next.has(r.id)) next.delete(r.id);
                    else next.add(r.id);
                    return next;
                  })
                }
                style={{ minHeight: 64 }}
                className={`flex w-full items-center gap-3 px-3 text-left ${
                  i > 0 ? "border-t border-outline-variant/25" : ""
                } ${kept ? "" : "opacity-45"}`}
              >
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-2 ${
                    kept
                      ? "border-primary bg-primary text-on-primary"
                      : "border-outline-variant"
                  }`}
                  aria-hidden
                >
                  {kept && (
                    <span
                      className="material-symbols-outlined"
                      style={{ fontSize: "16px" }}
                    >
                      check
                    </span>
                  )}
                </span>

                {/* The shape, at a glance. A room with no usable
                    outline gets a plain rectangle, which is honest:
                    that is exactly what the drawing will contain. */}
                <span
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-surface-container-low"
                  aria-hidden
                >
                  <svg width={44} height={44} viewBox="0 0 44 44">
                    {thumb ? (
                      <path
                        d={thumb.path}
                        fill="rgba(184,150,80,0.18)"
                        stroke="#b89650"
                        strokeWidth={1.5}
                        strokeLinejoin="round"
                      />
                    ) : (
                      <rect
                        x={8}
                        y={12}
                        width={28}
                        height={20}
                        fill="rgba(184,150,80,0.18)"
                        stroke="#b89650"
                        strokeWidth={1.5}
                      />
                    )}
                  </svg>
                </span>

                <span className="min-w-0 flex-1">
                  <span className="block truncate font-headline text-base text-on-surface">
                    {r.name?.trim() || `Room ${i + 1}`}
                  </span>
                  {/* Say why a room is a rectangle.
                      Three rounds of "it is still coming back square"
                      cost a day between us, because the only visible
                      symptom was the same whatever the cause: no
                      polygon sent, too few corners, or one rejected as
                      unusable all look identical on the plan. The row
                      now says which, so the next report names the
                      stage rather than the symptom. */}
                  <span className="mt-0.5 block text-sm text-on-surface-variant">
                    {w.toFixed(2)} × {l.toFixed(2)} m
                    {thumb
                      ? ` · ${r.floorPolygonM!.length} corners`
                      : (r.scanCornerCount ?? 0) === 0
                        ? " · no outline from the sensor"
                        : (r.scanCornerCount ?? 0) < 5
                          ? ` · ${r.scanCornerCount} corners, so a rectangle`
                          : ` · ${r.scanCornerCount} corners, outline not usable`}
                  </span>

                  {/* Probably more than one room.
                      The sensor decides for itself where one room
                      ends, and through a wide opening it often
                      decides it doesn't — so a whole ground floor
                      comes back as one 8 x 7 m "room" with five doors
                      in it, reaches CAD as a single rectangle the
                      size of a house, and nobody notices until
                      somebody reads the dimensions and thinks they
                      look odd.
                      Said here because here is the only place it can
                      still be fixed, and only the customer can fix
                      it: they are in the house and can walk it again
                      room by room. Left ticked, because it is a guess
                      and a genuine open-plan extension trips it. */}
                  {/* The staircase, if the sensor found one here.
                      Inside the room's row because that is the room
                      it is in, and a separate list would ask the
                      customer to work out which. */}
                  {(stairsProposals?.[r.id] ?? []).map((st) => {
                    const kept = !droppedStairs.has(st.id);
                    return (
                      <span
                        key={st.id}
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation();
                          setDroppedStairs((prev) => {
                            const next = new Set(prev);
                            if (next.has(st.id)) next.delete(st.id);
                            else next.add(st.id);
                            return next;
                          });
                        }}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter" && e.key !== " ") return;
                          e.stopPropagation();
                          e.preventDefault();
                          setDroppedStairs((prev) => {
                            const next = new Set(prev);
                            if (next.has(st.id)) next.delete(st.id);
                            else next.add(st.id);
                            return next;
                          });
                        }}
                        style={{ minHeight: 44 }}
                        className={`mt-1 flex items-center gap-2 text-sm ${
                          kept ? "text-primary" : "text-on-surface-variant line-through"
                        }`}
                      >
                        <span
                          className="material-symbols-outlined"
                          style={{ fontSize: "18px" }}
                          aria-hidden
                        >
                          stairs
                        </span>
                        Staircase, {st.widthM} m wide.{" "}
                        {kept ? "Tap if there isn't one" : "Tap to put it back"}
                      </span>
                    );
                  })}

                  {looksLikeMergedCapture({
                    widthM: w,
                    lengthM: l,
                    floorAreaM2: outlineAreaM2(r.floorPolygonM),
                    // Hung doors only. A cased opening lives in the
                    // same list now, and counting them here would
                    // push ordinary open-plan rooms over the "this
                    // looks like more than one room" line -- a
                    // kitchen-diner has one doorway and no door in
                    // it, which is exactly the case this test is
                    // trying not to catch.
                    doorCount: (r.doors ?? []).filter((d) => !d.cased).length,
                    windowCount: r.windows?.length ?? 0,
                  }) && (
                    <span className="mt-1 block text-sm text-primary">
                      This looks like more than one room. If it is,
                      scan them separately
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {dropped.size > 0 && (
        <p className="mt-3 text-sm text-on-surface-variant">
          {dropped.size} won&apos;t be sent. Nothing is deleted until you
          carry on.
        </p>
      )}
    </GuidedScreen>
  );
}
