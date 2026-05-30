"use client";

/**
 * app/status/page.tsx
 *
 * Customer-facing "Where's my quote?" lookup. The customer enters the
 * submission ID we email back to them plus the email they used. We
 * call the Apps Script `?action=status&id=…&email=…` endpoint which
 * gates the response on both fields matching.
 *
 * No localStorage, no auth, no PII echoed back beyond the project
 * name the customer already knows.
 */

import Link from "next/link";
import { useState } from "react";

type StatusResp = {
  submissionId: string;
  projectName: string;
  submittedAt: string | null;
  approvedAt: string | null;
  state: "pending" | "approved";
};

export default function StatusPage() {
  const [id, setId] = useState("");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<StatusResp | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const endpoint = process.env.NEXT_PUBLIC_MEASURE_SUBMIT_URL;
      if (!endpoint) {
        throw new Error("Submission endpoint not configured.");
      }
      const qs = new URLSearchParams({
        action: "status",
        id: id.trim(),
        email: email.trim(),
      });
      const r = await fetch(`${endpoint}?${qs.toString()}`);
      const data: { ok?: boolean; error?: string; status?: StatusResp } = await r.json();
      if (data.ok === false) throw new Error(data.error || "Lookup failed.");
      if (!data.status) throw new Error("No status returned.");
      setResult(data.status);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-surface pb-24 pt-10">
      <header className="mx-auto mb-6 max-w-2xl px-4 md:px-6">
        <Link
          href="/"
          className="material-symbols-outlined inline-flex items-center text-primary"
          aria-label="Back to home"
        >
          arrow_back
        </Link>
        <p className="font-label mt-3 text-[10px] font-bold uppercase tracking-[0.3em] text-primary">
          Project status
        </p>
        <h1 className="font-headline mt-1 text-3xl text-on-surface md:text-4xl">
          Where&apos;s my quote?
        </h1>
        <p className="mt-2 text-sm text-on-surface-variant">
          Enter your submission ID (we email it back to you after you tap Send) and the email address you submitted with.
        </p>
      </header>

      <main className="mx-auto max-w-2xl space-y-6 px-4 md:px-6">
        <form
          onSubmit={submit}
          className="space-y-4 rounded-xl border border-outline-variant/30 bg-surface-container-low p-5"
        >
          <div>
            <label
              htmlFor="status-id"
              className="font-label mb-2 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant"
            >
              Submission ID
            </label>
            <input
              id="status-id"
              required
              value={id}
              onChange={(e) => setId(e.target.value.toUpperCase())}
              placeholder="e.g. A1B2C3D4"
              className="w-full rounded border border-outline-variant/30 bg-surface-container-lowest px-4 py-2 text-sm outline-none ring-primary/40 focus:ring-2"
              autoCapitalize="characters"
              spellCheck={false}
            />
          </div>
          <div>
            <label
              htmlFor="status-email"
              className="font-label mb-2 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant"
            >
              Email used
            </label>
            <input
              id="status-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded border border-outline-variant/30 bg-surface-container-lowest px-4 py-2 text-sm outline-none ring-primary/40 focus:ring-2"
              autoComplete="email"
            />
          </div>
          <button
            type="submit"
            disabled={loading || !id || !email}
            className="rounded-full bg-primary px-5 py-2 text-xs font-bold uppercase tracking-widest text-on-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Checking…" : "Check status"}
          </button>
        </form>

        {error && (
          <p
            role="alert"
            className="rounded-md bg-error/10 px-4 py-3 text-sm text-error"
          >
            {error}
          </p>
        )}

        {result && (
          <section
            aria-live="polite"
            className="rounded-xl border-2 border-primary/40 bg-inverse-surface p-6 text-on-primary shadow-lg"
          >
            <p className="font-label text-[10px] font-bold uppercase tracking-[0.25em] text-primary">
              {result.state === "approved" ? "Approved" : "Pending review"}
            </p>
            <h2 className="font-headline mt-1 text-2xl text-[#f7f5ef]">
              {result.projectName || "(unnamed project)"}
            </h2>
            <dl className="mt-4 space-y-1.5 text-sm text-white/75">
              <div className="flex justify-between">
                <dt className="font-mono text-[11px] uppercase tracking-widest text-white/45">
                  Submission ID
                </dt>
                <dd className="font-mono">{result.submissionId}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="font-mono text-[11px] uppercase tracking-widest text-white/45">
                  Submitted
                </dt>
                <dd>
                  {result.submittedAt
                    ? new Date(result.submittedAt).toLocaleString("en-GB", {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })
                    : "—"}
                </dd>
              </div>
              {result.approvedAt && (
                <div className="flex justify-between">
                  <dt className="font-mono text-[11px] uppercase tracking-widest text-white/45">
                    Approved
                  </dt>
                  <dd>
                    {new Date(result.approvedAt).toLocaleString("en-GB", {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </dd>
                </div>
              )}
            </dl>
            <p className="mt-4 text-xs text-white/55">
              {result.state === "approved"
                ? "Your measurements have been verified — your designer is preparing the quote now."
                : "We have your submission. The architect typically reviews within two working days."}
            </p>
          </section>
        )}
      </main>
    </div>
  );
}
