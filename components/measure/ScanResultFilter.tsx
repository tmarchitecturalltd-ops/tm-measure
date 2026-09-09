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
  looksLikeStrayCapture,
  outlineThumbnail,
  type RoomDraft,
} from "@tm-designs/measure-core";
import GuidedScreen from "@/components/measure/GuidedScreen";

type Props = {
  rooms: RoomDraft[];
  /** Keep these, drop the rest. */
  onConfirm: (keepIds: string[]) => void;
  onBack: () => void;
};

export default function ScanResultFilter({ rooms, onConfirm, onBack }: Props) {
  const [dropped, setDropped] = useState<Set<string>>(
    () =>
      new Set(
        rooms
          .filter((r) => {
            const w = Number.parseFloat(r.walls[0]?.lengthM ?? "") || 0;
            const l = Number.parseFloat(r.walls[1]?.lengthM ?? "") || 0;
            return looksLikeStrayCapture(w, l);
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
      onNext={() => onConfirm(keeping.map((r) => r.id))}
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
        Untick anything that isn&apos;t a room — a scan often catches a
        doorway or the room next door in passing.
      </p>

      <ul className="overflow-hidden rounded-2xl border border-outline-variant/40">
        {rooms.map((r, i) => {
          const kept = !dropped.has(r.id);
          const w = Number.parseFloat(r.walls[0]?.lengthM ?? "") || 0;
          const l = Number.parseFloat(r.walls[1]?.lengthM ?? "") || 0;
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
                  <span className="mt-0.5 block text-sm text-on-surface-variant">
                    {w.toFixed(2)} × {l.toFixed(2)} m
                    {thumb ? " · shape captured" : ""}
                  </span>
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
