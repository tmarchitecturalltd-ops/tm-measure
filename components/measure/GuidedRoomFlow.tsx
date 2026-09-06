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

import { useMemo, useRef, useState } from "react";
import type { Opening, RoomDraft, RoomShape } from "@tm-designs/measure-core";
import { validateRoom } from "@tm-designs/measure-core";
import WallPositionPicker from "@/components/measure/WallPositionPicker";
import VoiceRecorder from "@/components/measure/VoiceRecorder";
import LengthHint from "@/components/measure/LengthHint";
import CustomShapeEditor from "@/components/measure/CustomShapeEditor";
import GuidedScreen, { type MenuSection } from "@/components/measure/GuidedScreen";

/**
 * The rooms a UK house actually has, in roughly the order they get
 * surveyed. Nine is the limit: a wall of chips is as much work to read
 * as the keyboard was to use, and the tenth room is the one that needs
 * typing anyway.
 */
const ROOM_NAMES = [
  "Kitchen",
  "Living room",
  "Dining room",
  "Hallway",
  "Bedroom",
  "Master bedroom",
  "Bathroom",
  "En suite",
  "Utility",
  // Demo only. Harry asked for it as a joke for a walkthrough, and it
  // is one chip in a list a customer sees on every room they name --
  // so it comes out before anything goes to the App Store, where a
  // reviewer would find it long before a homeowner did.
  "Sex dungeon",
] as const;

/**
 * The next free name in a series — "Bedroom", then "Bedroom 2".
 *
 * A house has three bedrooms and two bathrooms, so a fixed list gets
 * you one of each and leaves the rest to the keyboard. Worse, without
 * numbering the customer names two rooms "Bedroom" and the plan comes
 * back with two identical labels and no way to tell which is which —
 * which is a drawing Charlie has to ring someone about.
 *
 * The first one is unnumbered, because "Kitchen 1" in a house with one
 * kitchen reads as a mistake.
 */
function nextFreeName(base: string, taken: string[]): string {
  const used = new Set(taken.map((n) => n.trim().toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let i = 2; i < 50; i++) {
    const candidate = `${base} ${i}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return base;
}

type StepId =
  | "name"
  | "scan"
  | "measured"
  | "shape"
  | "walls"
  | "ceiling"
  | "doors"
  | "windows"
  | "photos";

type Props = {
  room: RoomDraft;
  roomIndex: number;
  totalRooms: number;
  onPatch: (patch: Partial<RoomDraft>) => void;
  onSetShape: (shape: RoomShape) => void;
  onAddOpening: (kind: "doors" | "windows") => void;
  onRemoveOpening: (kind: "doors" | "windows", id: string) => void;
  onPhotos: (files: FileList | null) => void;
  onDone: () => void;
  onExitGuided: () => void;
  issueFor: (suffix: string) => string | undefined;
  /** Open the scanner for this room. Absent when scanning is off. */
  onScanRoom?: () => void;
  /**
   * True when this phone measures with LiDAR rather than the camera.
   *
   * Only changes the wording. A phone without the sensor still has a
   * scanner — corner-tap, using the camera — and hiding it from those
   * customers left the app's headline feature visible to about a fifth
   * of them.
   */
  scanIsLidar?: boolean;
  /** Open the whole-property scanner. Absent where unsupported. */
  onScanHouse?: () => void;
  /** Jump straight to another room. */
  onGoToRoom?: (index: number) => void;
  /**
   * Add a room and move to it.
   *
   * There was no way to do this from the guided flow at all: finishing
   * the last room went straight to the exterior photos, so anyone who
   * had measured the kitchen and wanted the lounge next had to leave
   * the flow to find the button. A survey of a house that cannot add
   * the second room is not much of a survey.
   */
  onAddRoom?: () => void;
  /**
   * Delete this room and go back to the one before it.
   *
   * The way out of a room nobody wanted. A room added by mistake could
   * not be got rid of from inside the flow: the name question blocks
   * Next until it is answered, and Finish runs the same check, so an
   * empty extra room held the whole survey until it was given a name
   * it did not deserve. Offered only while the room is still blank —
   * once there are measurements in it, deleting is a decision for the
   * rooms list, where the undo lives.
   */
  onRemoveRoom?: () => void;
  /** Room names, for the jump list in the menu. */
  roomNames?: string[];
  /**
   * Where Back goes from the first question.
   *
   * It used to be disabled there, which is correct in the sense that
   * there is no previous question and wrong in every other sense: a
   * greyed-out button in the corner of the first screen of a flow reads
   * as broken, not as "nothing behind this". Reported as the back
   * buttons not working. Every screen now has somewhere to go back to.
   */
  onBackFromFirst?: () => void;
  /**
   * This phone has LiDAR, so scanning is the way rooms get measured
   * and the typed fields are not offered.
   */
  scanRequired?: boolean;
  /** Last scan attempt failed or was cancelled — see the escape hatch. */
  scanFailed?: boolean;
};

const LABELS: Record<StepId, string> = {
  name: "What's this room called?",
  scan: "Let's measure this room",
  measured: "Here's what the scan measured",
  shape: "What shape is it?",
  walls: "How long are the walls?",
  ceiling: "How high is the ceiling?",
  doors: "Any doors?",
  windows: "Any windows?",
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
  onPhotos,
  onDone,
  onExitGuided,
  issueFor,
  onScanRoom,
  scanIsLidar = false,
  onScanHouse,
  onGoToRoom,
  roomNames = [],
  onAddRoom,
  onRemoveRoom,
  onBackFromFirst,
  scanRequired = false,
  scanFailed = false,
}: Props) {
  /**
   * A scanned room is not asked to be measured again.
   *
   * The sensor has already produced the shape, every wall length, the
   * ceiling height, and the doors and windows. Walking the customer
   * through screens asking them to type those in is asking for work
   * the app has just done, and inviting a worse answer than the one it
   * already holds — a typed 3.5 replacing a measured 3.47.
   *
   * There was a screen after the scan listing every wall length, on
   * the reasoning that numbers you are never shown are barely better
   * than numbers you were asked to invent. Removed on review: it
   * arrived at the moment the customer had just been told the phone
   * had done the work, and asked them to read a table confirming it.
   * The figures are still on the review screen before anything is
   * sent, which is the point at which checking them is a decision
   * rather than an interruption.
   *
   * Stairs and photos stay: neither comes out of a scan.
   */
  const scanned = room.measuredByScan === true;

  /**
   * On a LiDAR phone, the sensor does the measuring.
   *
   * Typed lengths are not offered at all on these devices: the phone
   * can measure a room better than a person with a tape can, and
   * offering both invites the worse answer — someone types 3.5 where
   * the sensor would have said 3.47, and nobody downstream can tell
   * which they got.
   *
   * `manualEscape` is the exception, and it exists because a flow with
   * no way through is the failure this app keeps producing. A scan can
   * fail: a room too dark, too large, a sensor that will not settle. If
   * that happens the typed fields come back, because a customer stuck
   * in their own hallway with a button that will not work is worse than
   * a measurement we are less sure of.
   */
  const [manualEscape, setManualEscape] = useState(false);
  const mustScan = scanRequired && !scanned && !manualEscape;

  const steps: StepId[] = useMemo(
    () =>
      /*
       * No stairs step.
       *
       * A staircase is not a feature of a room. It arrives in one, ends
       * in another, and belongs to neither -- so asking "are there
       * stairs in this room?" once per room invites the same flight to
       * be entered twice, from the landing and from the hall, or missed
       * entirely because each end looked like the other end's job. It
       * is asked once now, at the whole-house stage, where the question
       * is which room each flight starts in. The data still hangs off a
       * room, because that is what the plan needs to draw against.
       */
      mustScan
        ? ["name", "scan"]
        : scanned
        ? ["name", "photos"]
        : [
            "name",
            "shape",
            "walls",
            "ceiling",
            "doors",
            "windows",
            "photos",
          ],
    [scanned, mustScan],
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
  /**
   * A problem found when Finish was pressed, rather than while typing.
   *
   * Finish used to run the whole-project validator and, if anything
   * failed, return without a word — so the button was simply dead. On a
   * drawn room it was dead permanently, because the validator wanted
   * typed wall lengths that drawing never produces. A button that does
   * nothing is the worst possible response: the customer cannot tell
   * whether the app is broken, slow, or waiting for something.
   */
  const [finishIssue, setFinishIssue] = useState<string | null>(null);

  /**
   * Nothing has been put in this room yet.
   *
   * Deliberately strict: any wall length, photo, memo, opening, traced
   * outline or scan counts as work, and work is not something to throw
   * away behind an underlined bit of text on the name screen.
   */
  const roomIsEmpty =
    !room.name.trim() &&
    !room.walls.some((w) => w.lengthM.trim()) &&
    (room.photos?.length ?? 0) === 0 &&
    (room.voiceMemos?.length ?? 0) === 0 &&
    (room.doors?.length ?? 0) === 0 &&
    (room.windows?.length ?? 0) === 0 &&
    (room.floorPolygonM?.length ?? 0) === 0 &&
    room.measuredByScan !== true;

  /**
   * The wall length boxes, so finishing one can move to the next.
   *
   * Entering six numbers is the longest single stretch of typing in
   * the survey, and having to put the phone down, tap the next box and
   * pick the keyboard back up between each one is where people lose
   * their place in the room. Enter — the "Go"/return key — advances;
   * the last box closes the keyboard rather than trapping the cursor.
   *
   * Note the iOS decimal keypad has no return key of its own. What it
   * does have, inside the app, is the WKWebView accessory bar with
   * up/down arrows, which walks these same inputs because they are
   * siblings in the document. This handler covers hardware keyboards
   * and Android; the arrows cover iPhone.
   */
  const wallInputs = useRef<(HTMLInputElement | null)[]>([]);


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
    if (step === "scan" && !scanned) {
      return "Scan the room to carry on — it only takes a minute.";
    }
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

  /** Which step a validation path belongs to, so we can go there. */
  const stepForPath = (path: string): StepId | null => {
    if (path.endsWith("-name")) return "name";
    if (/-wall-\d+$/.test(path)) return "walls";
    if (path.endsWith("-ceiling")) return "ceiling";
    if (/-door-\d+$/.test(path)) return "doors";
    if (/-window-\d+$/.test(path)) return "windows";
    if (path.endsWith("-photos")) return "photos";
    return null;
  };

  /**
   * Finish this room.
   *
   * Checks this room only, and on a failure takes the customer to the
   * question that needs answering rather than refusing at the door.
   * Photo issues are excluded to match the rest of the flow, which
   * treats a missing photo as a nudge and not a barrier.
   */
  const finishRoom = (andThen?: () => void) => {
    const issues = validateRoom(room, roomIndex).filter(
      (i) => !i.path.endsWith("-photos"),
    );
    /*
     * Only stop for something the customer can actually go and fix.
     *
     * Staying put and showing the message was the polite-looking
     * version of a dead end: a scanned room has no walls or ceiling
     * screen, so an issue on one of those fields named a box that
     * exists nowhere in the flow, and Finish did nothing on every
     * screen with no way to learn why. The specific case is fixed in
     * validateRoom, but the trap is structural — any future step list
     * that drops a screen would rebuild it — so the rule belongs here:
     * a fault the customer cannot reach is not a fault we may block
     * them with. Submission still checks the whole survey.
     */
    const reachable = issues.filter((i) => {
      const target = stepForPath(i.path);
      return target !== null && steps.includes(target);
    });
    if (reachable.length) {
      const first = reachable[0];
      setFinishIssue(first.message);
      setStepIndex(steps.indexOf(stepForPath(first.path)!));
      return;
    }
    setFinishIssue(null);
    (andThen ?? onDone)();
  };

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

  const menuSections: MenuSection[] = [
    ...(onScanRoom || onScanHouse
      ? [
          {
            items: [
              ...(onScanRoom
                ? [
                    {
                      label: scanIsLidar
                        ? "Measure this room with the sensor"
                        : "Measure this room with the camera",
                      onClick: onScanRoom,
                    },
                  ]
                : []),
              ...(onScanHouse
                ? [
                    {
                      label: "Scan the whole property",
                      onClick: onScanHouse,
                    },
                  ]
                : []),
            ],
          },
        ]
      : []),
    {
      heading: "Jump to a step",
      items: steps.map((sid, i) => ({
        label: LABELS[sid],
        onClick: () => setStepIndex(i),
        active: i === stepIndex,
      })),
    },
    ...(roomNames.length > 1 && onGoToRoom
      ? [
          {
            heading: "Jump to a room",
            items: roomNames.map((n, i) => ({
              label: `${i + 1}. ${n.trim() || "Unnamed room"}`,
              onClick: () => {
                onGoToRoom(i);
                setStepIndex(0);
              },
              active: i === roomIndex,
            })),
          },
        ]
      : []),
    {
      items: [
        ...(onAddRoom
          ? [{ label: "Add another room", onClick: () => finishRoom(onAddRoom) }]
          : []),
        {
          label: "Done with the rooms — carry on",
          onClick: () => finishRoom(),
        },
      ],
    },
  ];

  return (
    <GuidedScreen
      eyebrow={`Room ${roomIndex + 1} of ${totalRooms}`}
      title={LABELS[step]}
      progress={(stepIndex + 1) / steps.length}
      menuOpen={menuOpen}
      onMenuOpenChange={setMenuOpen}
      menuSections={menuSections}
      scrollKey={`${roomIndex}-${stepIndex}`}
      onBack={() =>
        stepIndex === 0
          ? onBackFromFirst?.()
          : setStepIndex((i) => i - 1)
      }
      backDisabled={stepIndex === 0 && !onBackFromFirst}
      onNext={() => {
        if (block) return;
        setFinishIssue(null);
        if (!isLast) {
          setStepIndex((i) => i + 1);
          return;
        }
        // Last question of the last room: finish the rooms and move on
        // to the whole-house stage.
        //
        // This used to add another room, on the reasoning that most
        // people have one more to do. The flaw is that it never
        // stopped: the only way out was "Done with the rooms" in the
        // Steps menu, so anyone who did not open that menu pressed
        // Next and got Room 2, then Room 3, with no visible end to the
        // survey. Adding a room is now the link above the bar, where
        // it is one tap and clearly a choice; the button under the
        // thumb moves forward.
        finishRoom();
      }}
      nextDisabled={!!block}
      nextLabel={
        isLast
          ? roomIndex + 1 < totalRooms
            ? "Next room"
            : "Done with the rooms"
          : "Next"
      }
      blockMessage={block ?? finishIssue}
    >

      {step === "name" && (
        <div>
          <input
            value={room.name}
            onChange={(e) => onPatch({ name: e.target.value })}
            placeholder="e.g. Kitchen"
            className={input}
            autoFocus
          />
          {/* Tap instead of type.
              Naming rooms is the one bit of typing that repeats — once
              per room, ten times in a house — and it is typing on a
              phone held in one hand while standing up. Nine names cover
              most of a survey. The field stays, because plenty of
              houses have a snug or a boot room and the app should not
              argue with what someone calls their own house. */}
          <div className="mt-3 flex flex-wrap gap-2">
            {ROOM_NAMES.map((base) => {
              // Names already used by the *other* rooms. This room's own
              // name is excluded, so a chip you have already picked
              // stays selected rather than offering to renumber itself.
              const others = roomNames.filter((_, i) => i !== roomIndex);
              const label = nextFreeName(base, others);
              return (
                <button
                  key={base}
                  type="button"
                  onClick={() => onPatch({ name: label })}
                  style={{ minHeight: 44 }}
                  className={`rounded-full border px-4 text-sm font-bold ${
                    room.name === label
                      ? "border-primary bg-primary/10 text-on-surface"
                      : "border-outline-variant/40 text-on-surface-variant"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <p className="mt-3 text-sm text-on-surface-variant">
            Whatever you call it at home is fine.
          </p>

          {/* The escape hatch for a room added by mistake.
              Only while it is empty — see onRemoveRoom. Plain text
              rather than a button, because it must be findable without
              competing with the answer. */}
          {onRemoveRoom && roomIsEmpty && totalRooms > 1 && (
            <button
              type="button"
              onClick={onRemoveRoom}
              style={{ minHeight: 44 }}
              className="mt-5 text-sm font-bold uppercase tracking-widest text-on-surface-variant underline"
            >
              I didn&apos;t mean to add this room
            </button>
          )}
        </div>
      )}

      {step === "scan" && (
        <div className="space-y-4">
          <p className="text-base leading-relaxed text-on-surface-variant">
            Your phone can measure this room itself — walls, ceiling, doors
            and windows — more precisely than a tape, and there&apos;s
            nothing to type afterwards.
          </p>
          <button
            type="button"
            onClick={onScanRoom}
            style={{ minHeight: 64 }}
            className="w-full rounded-2xl bg-primary px-6 text-base font-bold uppercase tracking-widest text-on-primary shadow-lg shadow-primary/25 active:scale-[0.98]"
          >
            Scan this room
          </button>
          {onScanHouse && (
            <button
              type="button"
              onClick={onScanHouse}
              style={{ minHeight: 56 }}
              className="w-full rounded-2xl border-2 border-outline px-6 text-sm font-bold uppercase tracking-widest text-on-surface"
            >
              Scan the whole property instead
            </button>
          )}
          <p className="text-sm text-on-surface-variant">
            Hold the phone up and walk slowly round the room, pointing it at
            each wall in turn. Tap Done when the whole room is covered.
          </p>

          {/* The way out.
              Only after a scan has actually failed or been cancelled —
              not offered up front, because given the choice people take
              the familiar option and type a worse number than the phone
              would have measured. But a room that will not scan has to
              have a route through it: too dark, too large, a sensor that
              will not settle. Being stuck in your own hallway with a
              button that does nothing is the failure this app has
              produced more than once. */}
          {scanFailed && !manualEscape && (
            <div className="rounded-xl border border-outline-variant/40 p-4">
              <p className="text-sm text-on-surface-variant">
                Scanning didn&apos;t work? You can measure this room by hand
                instead — a tape measure and the four wall lengths.
              </p>
              <button
                type="button"
                onClick={() => {
                  setManualEscape(true);
                  setStepIndex(1);
                }}
                className="mt-3 rounded-full border border-primary px-5 py-2 text-sm font-bold uppercase tracking-widest text-primary"
              >
                Enter the sizes by hand
              </button>
            </div>
          )}
        </div>
      )}

      {step === "measured" && (
        <div className="space-y-4">
          <p className="text-sm text-on-surface-variant">
            Nothing to type — the scan measured all of this. Have a quick
            look and carry on.
          </p>
          <dl className="divide-y divide-outline-variant/30 rounded-xl border border-outline-variant/30 bg-surface-container-lowest">
            {room.walls
              .filter((w) => w.lengthM.trim())
              .map((w, i) => (
                <div key={w.id} className="flex justify-between px-4 py-3">
                  <dt className="text-base text-on-surface-variant">
                    {w.label || `Wall ${i + 1}`}
                  </dt>
                  <dd className="text-base font-semibold text-on-surface">
                    {w.lengthM} m
                  </dd>
                </div>
              ))}
            {room.ceilingHeightM.trim() && (
              <div className="flex justify-between px-4 py-3">
                <dt className="text-base text-on-surface-variant">Ceiling</dt>
                <dd className="text-base font-semibold text-on-surface">
                  {room.ceilingHeightM} m
                </dd>
              </div>
            )}
            <div className="flex justify-between px-4 py-3">
              <dt className="text-base text-on-surface-variant">
                Doors and windows
              </dt>
              <dd className="text-base font-semibold text-on-surface">
                {room.doors.length} / {room.windows.length}
              </dd>
            </div>
            {(room.floorPolygonM?.length ?? 0) >= 3 && (
              <div className="flex justify-between px-4 py-3">
                <dt className="text-base text-on-surface-variant">Shape</dt>
                <dd className="text-base font-semibold text-on-surface">
                  {room.floorPolygonM!.length} corners
                </dd>
              </div>
            )}
          </dl>

          {/* An escape hatch, not an invitation.
              The sensor is more reliable than a person typing, so the
              default is to accept it. But a scan can get a room wrong,
              and a customer who can see it is wrong and has no way to
              say so will either submit something they know is false or
              give up. */}
          <button
            type="button"
            onClick={onExitGuided}
            className="w-full justify-start rounded-xl border border-outline-variant/40 px-5 py-3 text-left text-sm font-semibold text-on-surface-variant"
          >
            Something looks wrong — let me edit it
          </button>
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
              {/* One wrapper, two lines. Two sibling spans in a button
                  are at the mercy of whatever display the button has —
                  they were laid out in a row by a global rule and the
                  two lines ran together. A single block child cannot be
                  rearranged by its parent's flex direction. */}
              <span className="block">
                <span className="block text-base font-bold text-on-surface">
                  {s === "rectangle"
                    ? "Four straight walls"
                    : s === "l-shape"
                      ? "L-shaped"
                      : "Something else"}
                </span>
                <span className="mt-1 block text-sm text-on-surface-variant">
                  {s === "rectangle"
                    ? "The usual — a simple box"
                    : s === "l-shape"
                      ? "Six walls, with a corner taken out"
                      : "Draw the outline yourself"}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}

      {step === "walls" && (
        <div className="space-y-3">
          {/* Scanning offered here, not only in the menu.
              "Where is the auto scan option?" has now been asked three
              times, which is the answer: a feature reachable only from
              a hamburger is a feature most people never find. This is
              the screen where measuring is the question, so it belongs
              on it. */}
          {onScanRoom && (
            <button
              type="button"
              onClick={onScanRoom}
              style={{ minHeight: 56 }}
              className="mb-1 flex w-full items-center justify-center gap-2 rounded-2xl bg-primary px-5 text-sm font-bold uppercase tracking-widest text-on-primary"
            >
              <span
                className="material-symbols-outlined"
                style={{ fontSize: "20px" }}
                aria-hidden
              >
                {scanIsLidar ? "view_in_ar" : "photo_camera"}
              </span>
              {scanIsLidar ? "Measure with the sensor" : "Measure with the camera"}
            </button>
          )}
          {onScanRoom && (
            <p className="pb-1 text-center text-sm text-on-surface-variant">
              or enter the lengths yourself
            </p>
          )}

          {/* Type or draw.
              Typing six numbers describes a shape the customer can see
              and we cannot, and for anything other than a plain
              rectangle it is the harder of the two — you have to hold
              the room in your head while entering it a side at a time.
              Tracing the outline is often quicker and it is the only
              way to record a bay, a chimney breast, or a corner cut
              off at an angle. Both write to the same room, so nobody
              has to choose correctly at the start. */}
          {/* Hidden on scanned rooms. Neither option applies: the
              geometry is already captured, and offering to re-enter it
              only invites a worse answer over a better one. Scanned
              rooms do not reach this step at all now, but the guard
              stays so a future change to the step list cannot quietly
              reintroduce the choice. */}
          {!scanned && (
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
          )}

          {!scanned && wallMode === "draw" && (
            <div className="rounded-xl border border-outline-variant/30 p-3">
              <p className="mb-2 text-sm text-on-surface-variant">
                Tap each corner in order, then close the shape. Drag any
                corner to nudge it.
              </p>
              <CustomShapeEditor room={room} onPatch={onPatch} />
            </div>
          )}

          {(scanned || wallMode === "type") && (
          <>
          {/* Honest about what is needed.
              This used to say "one is enough to carry on", which was
              true of the Next button and not of the Finish button —
              the survey needs every wall of a typed room, so the
              customer was told one thing and stopped by another. */}
          <p className="text-sm text-on-surface-variant">
            Work round the room in order. You can move on with some blank
            and come back — we&apos;ll ask again before you finish the room.
          </p>
          {room.walls.map((w, i) => (
            <div key={w.id}>
              <div className="flex items-center gap-3">
                <span className="w-20 shrink-0 text-sm font-bold uppercase tracking-widest text-on-surface-variant">
                  {w.label || `Wall ${i + 1}`}
                </span>
                <input
                  ref={(el) => {
                    wallInputs.current[i] = el;
                  }}
                  inputMode="decimal"
                  enterKeyHint={
                    i < room.walls.length - 1 ? "next" : "done"
                  }
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    const next = wallInputs.current[i + 1];
                    if (next) {
                      next.focus();
                      next.select();
                    } else {
                      e.currentTarget.blur();
                    }
                  }}
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

      {step === "photos" && (
        <div className="space-y-4">
          <p className="text-base leading-relaxed text-on-surface-variant">
            One photo of the whole room is enough. It shows us things the
            measurements can&apos;t — radiators, alcoves, where the light
            comes from.
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

      {/* The other way out of the last room.
          Next now finishes the rooms, so adding one has to be visible
          on this screen or it goes back to living only in the Steps
          menu — which is how the survey ended up with no exit in the
          first place. A bordered button rather than a link: it is the
          less likely choice, not a footnote. */}
      {isLast && roomIndex + 1 >= totalRooms && onAddRoom && (
        <button
          type="button"
          onClick={() => finishRoom(onAddRoom)}
          style={{ minHeight: 56 }}
          className="mt-6 w-full rounded-full border-2 border-outline px-4 text-sm font-bold uppercase tracking-wide text-on-surface"
        >
          Add another room
        </button>
      )}

    </GuidedScreen>
  );
}
