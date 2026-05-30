"use client";

import { useCallback, useState } from "react";

const STEP_DETAILS: Record<string, string> = {
  "01":
    "Fill in our simple online form with your project details. We'll send you a measuring kit with a laser measurer — no site visit needed, anywhere in the UK.",
  "02":
    "Take photos and measurements using our kit. Our team creates accurate architectural drawings and structural calculations tailored to your project requirements.",
  "03":
    "You review the draft drawings and request any amendments. We'll refine until you're completely happy — all included in your fixed price.",
  "04":
    "Receive your completed plans within 2 weeks, ready for planning submission or building control approval. 98% of our plans are approved first time.",
};

const STEPS = [
  {
    id: "01" as const,
    title: "Send Details",
    body:
      "Fill in our simple online form with your project details. We'll send you a measuring kit with a laser measurer — no site visit needed, anywhere in the UK.",
  },
  {
    id: "02" as const,
    title: "You Measure, We Draw",
    body:
      "Take photos and measurements using our kit. Our team creates accurate architectural drawings and structural calculations tailored to your project.",
  },
  {
    id: "03" as const,
    title: "Review & Revise",
    body:
      "Review your draft drawings 100% online. Request any amendments until you're completely happy — all included in your fixed price.",
  },
  {
    id: "04" as const,
    title: "Submit & Build",
    body:
      "Receive your completed plans within 2 weeks, ready for planning submission or building control approval. 98% of our plans are approved first time.",
  },
];

export default function Process() {
  const [openId, setOpenId] = useState<string | null>(null);

  const toggleStep = useCallback((stepId: string) => {
    if (typeof window !== "undefined" && window.innerWidth >= 768) return;
    setOpenId((cur) => (cur === stepId ? null : stepId));
  }, []);

  return (
    <section id="process" className="bg-surface py-20">
      <div className="mx-auto max-w-[1920px] px-4 md:px-8">
        <div className="mb-10 md:mb-16">
          <span className="font-label mb-4 block text-xs font-bold uppercase tracking-[0.3em] text-primary">
            THE PROCESS
          </span>
          <h2 className="font-headline text-3xl text-on-surface md:text-5xl">
            Four Steps to Planning-Ready Drawings
          </h2>
        </div>

        <div className="grid grid-cols-4 gap-2 md:gap-8" id="steps-grid">
          {STEPS.map((step) => {
            const expanded = openId === step.id;
            return (
              <div
                key={step.id}
                role="button"
                tabIndex={0}
                onClick={() => toggleStep(step.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggleStep(step.id);
                  }
                }}
                className={`step-card flex select-none flex-col rounded-lg bg-surface-container-low p-3 transition-shadow hover:shadow-md md:p-8 ${
                  expanded ? "ring-2 ring-primary" : ""
                }`}
              >
                <div className="flex items-start justify-between">
                  <span className="font-headline mb-2 block text-xl text-primary/30 md:mb-6 md:text-4xl">
                    {step.id}
                  </span>
                  <span className="material-symbols-outlined step-icon mt-0.5 text-sm text-primary/40 md:hidden">
                    {expanded ? "expand_less" : "expand_more"}
                  </span>
                </div>
                <h3 className="font-headline mb-1 text-xs leading-tight md:mb-4 md:text-xl">
                  {step.title}
                </h3>
                <p className="mt-2 hidden text-sm leading-relaxed text-on-surface-variant md:block">
                  {step.body}
                </p>
              </div>
            );
          })}
        </div>

        {openId ? (
          <div className="mt-3 rounded-lg border border-primary/20 bg-primary/5 p-4 md:hidden">
            <p className="text-sm leading-relaxed text-on-surface-variant">
              {STEP_DETAILS[openId]}
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
