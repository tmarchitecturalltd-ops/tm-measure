"use client";

/**
 * components/measure/GuidedProjectFlow.tsx
 *
 * The project details step, one question at a time.
 *
 * The same four-plus fields as before, in the same order, on the same
 * screen furniture as the room flow — because two screens in one app
 * that ask questions in visibly different ways is worse than either
 * style on its own. Nothing new is collected here.
 *
 * Ceiling height gets its own screen despite being optional. It is the
 * one number on this step that a customer might have to go and check,
 * and burying it beside the project name is how it ended up guessed.
 * Skipping it is one tap.
 */

import { useState } from "react";
import type { UnitPreference } from "@tm-designs/measure-core";
import type { ProjectType } from "@/lib/recentSubmissions";
import GuidedScreen, {
  type MenuSection,
} from "@/components/measure/GuidedScreen";
import LengthHint from "@/components/measure/LengthHint";

type StepId = "name" | "email" | "project" | "type" | "ceiling" | "unit";

const LABELS: Record<StepId, string> = {
  name: "What's your name?",
  email: "What's your email?",
  project: "What shall we call this project?",
  type: "What are you planning?",
  ceiling: "How high are the ceilings?",
  unit: "Metres or feet?",
};

/**
 * Three, down from six.
 *
 * The answer changes nothing in the app — it is one word in the email
 * and one column in the sheet — so every extra option is friction
 * bought with no return. Six choices at the point of highest drop-off,
 * before the customer has invested anything, to tell us something we
 * could ask when we reply.
 *
 * These three cover most of the work. New build, renovation and garage
 * conversions fall into "Something else", where the project name and
 * the photos say more than a category ever would. `ProjectType` still
 * carries all six so older drafts and existing submissions keep their
 * labels.
 */
const TYPES: { value: ProjectType; label: string; hint: string }[] = [
  { value: "extension", label: "Extension", hint: "Adding on to the house" },
  { value: "loft", label: "Loft conversion", hint: "Using the roof space" },
  { value: "other", label: "Something else", hint: "Tell us when we reply" },
];

type Props = {
  customerName: string;
  onCustomerName: (v: string) => void;
  email: string;
  onEmail: (v: string) => void;
  projectName: string;
  onProjectName: (v: string) => void;
  projectType: ProjectType | null;
  onProjectType: (v: ProjectType) => void;
  defaultCeilingHeightM: string;
  onDefaultCeilingHeightM: (v: string) => void;
  unit: UnitPreference;
  onUnit: (v: UnitPreference) => void;
  unitLocked: boolean;
  /** Runs the same validation the one-page version ran. */
  onDone: () => void;
  /**
   * Kept for the validation path, which still drops to the one-page
   * view to point at a problem this flow cannot show. It is no longer
   * offered as a choice.
   */
  onExitGuided: () => void;
  issueFor: (path: string) => string | undefined;
  /**
   * Where Back goes from the first question.
   *
   * Disabling it there is correct in that there is no previous
   * question, and wrong in every other sense: a greyed-out button in
   * the corner of the first screen someone sees reads as broken.
   */
  onBackFromFirst?: () => void;
};

export default function GuidedProjectFlow({
  customerName,
  onCustomerName,
  email,
  onEmail,
  projectName,
  onProjectName,
  projectType,
  onProjectType,
  defaultCeilingHeightM,
  onDefaultCeilingHeightM,
  unit,
  onUnit,
  unitLocked,
  onDone,
  issueFor,
  onBackFromFirst,
}: Props) {
  const steps: StepId[] = ["name", "email", "project", "type", "ceiling", "unit"];
  const [stepIndex, setStepIndex] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const step = steps[stepIndex];
  const isLast = stepIndex === steps.length - 1;

  const input =
    "w-full rounded-lg border border-outline-variant/40 bg-surface-container-lowest px-4 py-3 text-base outline-none ring-primary/30 focus:border-primary/70 focus:ring-2";

  /**
   * Only the three things a submission is useless without.
   *
   * Project type, ceiling height and units all have sensible defaults
   * or can be worked out later; blocking on them would be stopping
   * someone from starting over a detail we can ask about afterwards.
   */
  /**
   * Nothing here blocks.
   *
   * Name, email and project name are all genuinely required, but they
   * are required by the *submission*, not by walking round a house. A
   * customer standing in a doorway who cannot remember which email
   * they used should be able to get on with measuring and come back to
   * it — the survey is the hard part, and stopping them at the front
   * door over a field they can fill in later loses the whole thing.
   *
   * submitToBackend enforces all three before anything is sent, and
   * sends the customer back here with the reason. That is the right
   * place for it: at the point where the information is actually
   * needed, rather than the point where it is most annoying to ask.
   *
   * Email format is still checked as you type, because a typo caught
   * now is caught by the person who knows the answer.
   */
  const blocked = (): string | null => {
    if (
      step === "email" &&
      email.trim() &&
      // Deliberately loose. Rejecting an unusual but valid address is a
      // worse failure than accepting a typo we can follow up on.
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
    ) {
      return "That doesn't look like an email address.";
    }
    return null;
  };
  const block = blocked();

  const menuSections: MenuSection[] = [
    {
      heading: "Jump to a question",
      items: steps.map((sid, i) => ({
        label: LABELS[sid],
        onClick: () => setStepIndex(i),
        active: i === stepIndex,
      })),
    },
  ];

  return (
    <GuidedScreen
      eyebrow="Project details"
      title={LABELS[step]}
      progress={(stepIndex + 1) / steps.length}
      menuOpen={menuOpen}
      onMenuOpenChange={setMenuOpen}
      menuSections={menuSections}
      scrollKey={stepIndex}
      onBack={() =>
        stepIndex === 0 ? onBackFromFirst?.() : setStepIndex((i) => i - 1)
      }
      backDisabled={stepIndex === 0 && !onBackFromFirst}
      onNext={() => {
        if (block) return;
        if (isLast) onDone();
        else setStepIndex((i) => i + 1);
      }}
      nextDisabled={!!block}
      nextLabel={
        isLast
          ? "Start measuring"
          : (step === "name" && !customerName.trim()) ||
              (step === "email" && !email.trim()) ||
              (step === "project" && !projectName.trim()) ||
              (step === "type" && !projectType)
            ? "Skip for now"
            : "Next"
      }
      blockMessage={block}
    >
      {step === "name" && (
        <div>
          <input
            value={customerName}
            onChange={(e) => onCustomerName(e.target.value)}
            placeholder="e.g. Harry McCulloch"
            autoComplete="name"
            className={input}
          />
          {issueFor("name") && (
            <p data-error-anchor className="mt-2 text-sm text-error">
              {issueFor("name")}
            </p>
          )}
        </div>
      )}

      {step === "email" && (
        <div>
          <input
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            value={email}
            onChange={(e) => onEmail(e.target.value)}
            placeholder="you@example.com"
            className={input}
          />
          <p className="mt-2 text-sm text-on-surface-variant">
            We&apos;ll send your quote and drawings here. Nothing else.
          </p>
          {issueFor("email") && (
            <p data-error-anchor className="mt-2 text-sm text-error">
              {issueFor("email")}
            </p>
          )}
        </div>
      )}

      {step === "project" && (
        <div>
          <input
            value={projectName}
            onChange={(e) => onProjectName(e.target.value)}
            placeholder="e.g. Rear extension — 12 Smith Street"
            className={input}
          />
          <p className="mt-2 text-sm text-on-surface-variant">
            The address is a good one to use.
          </p>
          {issueFor("project") && (
            <p data-error-anchor className="mt-2 text-sm text-error">
              {issueFor("project")}
            </p>
          )}
        </div>
      )}

      {step === "type" && (
        <div className="grid gap-2">
          {TYPES.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => onProjectType(t.value)}
              className={`w-full justify-start rounded-xl border px-5 py-4 text-left ${
                projectType === t.value
                  ? "border-primary bg-primary/10"
                  : "border-outline-variant/40"
              }`}
            >
              <span className="block">
                <span className="block text-base font-bold text-on-surface">
                  {t.label}
                </span>
                <span className="mt-0.5 block text-sm text-on-surface-variant">
                  {t.hint}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}

      {step === "ceiling" && (
        <div>
          <input
            inputMode="decimal"
            value={defaultCeilingHeightM}
            onChange={(e) => onDefaultCeilingHeightM(e.target.value)}
            placeholder="2.40"
            className={input}
          />
          <LengthHint value={defaultCeilingHeightM} kind="ceiling" />
          <p className="mt-2 text-sm text-on-surface-variant">
            Metres, floor to ceiling. Most UK homes are around 2.4. Every room
            starts from this, and you can change any that differ. Skip it if
            you&apos;d rather measure as you go.
          </p>
        </div>
      )}

      {step === "unit" && (
        <div>
          <div className="grid gap-2">
            {(["metric", "imperial"] as const).map((u) => (
              <button
                key={u}
                type="button"
                onClick={() => !unitLocked && onUnit(u)}
                disabled={unitLocked}
                aria-pressed={unit === u}
                className={`w-full justify-start rounded-xl border px-5 py-4 text-left disabled:opacity-60 ${
                  unit === u
                    ? "border-primary bg-primary/10"
                    : "border-outline-variant/40"
                }`}
              >
                <span className="block">
                  <span className="block text-base font-bold text-on-surface">
                    {u === "metric" ? "Metres" : "Feet and inches"}
                  </span>
                  <span className="mt-0.5 block text-sm text-on-surface-variant">
                    {u === "metric"
                      ? "What most tape measures show first"
                      : "Shown alongside metres either way"}
                  </span>
                </span>
              </button>
            ))}
          </div>
          <p className="mt-3 text-sm text-on-surface-variant">
            {unitLocked
              ? "Locked for this project so measurements can't get mixed up part way through."
              : "This locks once you start measuring, so a survey can't end up half in each. Everything is stored in metres and the review step shows both."}
          </p>
        </div>
      )}
    </GuidedScreen>
  );
}
