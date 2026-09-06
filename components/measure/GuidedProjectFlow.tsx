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
 * Four questions: who you are, how to reach you, what to call the job,
 * and what you are building. Ceiling height moved to the floor plan and
 * the units question was dropped -- see the note above StepId.
 */

import { useState } from "react";
import type { ProjectType } from "@/lib/recentSubmissions";
import GuidedScreen, {
  type MenuSection,
} from "@/components/measure/GuidedScreen";

/*
 * No units question, and no ceiling question.
 *
 * Units: the app is metric. Every tape sold in the UK reads metric
 * first, the drawings are produced in millimetres, and the answer was
 * "metres" on effectively every submission -- so it was a screen that
 * asked a question with one right answer and offered a way to get it
 * wrong. Imperial is still shown alongside on the review screen, where
 * it helps someone sense-check a number they measured in feet.
 *
 * Ceiling height: it moved to the floor plan, where the floors are.
 * One number for the whole property was wrong in most houses -- a
 * Victorian ground floor and its bedrooms are rarely the same height,
 * and the loft never is -- and asking before the customer has told us
 * what floors exist meant asking in the one place the answer could not
 * be qualified.
 */
type StepId = "name" | "email" | "project" | "type";

const LABELS: Record<StepId, string> = {
  name: "What's your name?",
  email: "What's your email?",
  project: "What shall we call this project?",
  type: "What are you planning?",
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
  onDone,
  issueFor,
  onBackFromFirst,
}: Props) {
  const steps: StepId[] = ["name", "email", "project", "type"];
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
              (step === "project" && !projectName.trim())
            ? "Skip"
            : "Next"
      }
      blockMessage={block}
    >
      {step === "name" && (
        <div>
          <input
            value={customerName}
            onChange={(e) => onCustomerName(e.target.value)}
            placeholder="e.g. Sarah Whitfield"
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

    </GuidedScreen>
  );
}
