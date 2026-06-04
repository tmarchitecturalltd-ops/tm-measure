"use client";

/**
 * app/architect/page.tsx
 *
 * Architect Verification Console — list view.
 *
 * Fetches submissions from the Google Apps Script `?action=list`
 * endpoint and renders them as a sortable card list. The Apps Script
 * URL is stored in localStorage so Harry only enters it once per
 * device. No auth — keep the URL private.
 *
 * Static-export-safe (no dynamic params, no server side data).
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

type SubmissionSummary = {
  id: string;
  submittedAt: string | null;
  customerName: string;
  email: string;
  projectName: string;
  roomCount: number;
  approvedAt: string | null;
  status?: "pending" | "in-review" | "approved" | "rejected";
  internalNote?: string;
};

const ENDPOINT_KEY = "tm.architect.endpoint";
const SECRET_KEY = "tm.architect.secret";

/**
 * Allow only Google Apps Script web-app URLs. Anything else would be
 * either a typo or an attempted phishing redirect (since the Apps
 * Script endpoint is the only thing this console is designed to talk
 * to). We accept .../macros/s/<id>/exec and .../macros/u/<n>/s/<id>/exec.
 */
function isValidAppsScriptUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return false;
    if (u.hostname !== "script.google.com") return false;
    return /\/macros\/(?:u\/\d+\/)?s\/[A-Za-z0-9_-]+\/exec\/?$/.test(u.pathname);
  } catch {
    return false;
  }
}

export default function ArchitectListPage() {
  const [endpoint, setEndpoint] = useState("");
  const [endpointInput, setEndpointInput] = useState("");
  const [secret, setSecret] = useState("");
  const [secretInput, setSecretInput] = useState("");
  const [submissions, setSubmissions] = useState<SubmissionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<"all" | "pending" | "approved">("all");

  useEffect(() => {
    if (typeof window === "undefined") return;
    setEndpoint(window.localStorage.getItem(ENDPOINT_KEY) ?? "");
    setEndpointInput(window.localStorage.getItem(ENDPOINT_KEY) ?? "");
    setSecret(window.localStorage.getItem(SECRET_KEY) ?? "");
    setSecretInput(window.localStorage.getItem(SECRET_KEY) ?? "");
  }, []);

  const fetchList = useCallback(async (url: string, sec: string) => {
    if (!url) return;
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ action: "list" });
      if (sec) qs.set("secret", sec);
      const r = await fetch(`${url}?${qs.toString()}`, { method: "GET" });
      if (!r.ok) throw new Error(`Server responded ${r.status}`);
      const data: { ok?: boolean; error?: string; submissions?: SubmissionSummary[] } = await r.json();
      if (data.ok === false) throw new Error(data.error || "Endpoint returned an error.");
      setSubmissions(data.submissions ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (endpoint) void fetchList(endpoint, secret);
  }, [endpoint, secret, fetchList]);

  const saveEndpoint = () => {
    const cleaned = endpointInput.trim();
    if (cleaned && !isValidAppsScriptUrl(cleaned)) {
      setError("Endpoint must be a Google Apps Script /exec URL (script.google.com).");
      return;
    }
    setError(null);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(ENDPOINT_KEY, cleaned);
      window.localStorage.setItem(SECRET_KEY, secretInput.trim());
    }
    setEndpoint(cleaned);
    setSecret(secretInput.trim());
  };

  const forgetEndpoint = () => {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(ENDPOINT_KEY);
      window.localStorage.removeItem(SECRET_KEY);
    }
    setEndpoint("");
    setEndpointInput("");
    setSecret("");
    setSecretInput("");
    setSubmissions(null);
  };

  const filtered = useMemo(() => {
    if (!submissions) return [];
    if (filter === "pending") {
      return submissions.filter((s) => (s.status ?? "pending") === "pending");
    }
    if (filter === "approved") {
      return submissions.filter((s) => (s.status ?? "pending") === "approved" || !!s.approvedAt);
    }
    return submissions;
  }, [submissions, filter]);

  return (
    <div className="min-h-screen bg-surface pb-24 pt-10">
      <header className="mx-auto mb-8 max-w-5xl px-4 md:px-6">
        <p className="font-label text-[10px] font-bold uppercase tracking-[0.3em] text-primary">
          TM Measure
        </p>
        <h1 className="font-headline mt-2 text-3xl text-on-surface md:text-4xl">
          Architect Verification Console
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-on-surface-variant">
          Review every customer submission. Open one to inspect measurements, photos and the floor plan, then approve to lock it for export.
        </p>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 px-4 md:px-6">
        {/* Endpoint configuration */}
        <section className="rounded-xl border border-outline-variant/30 bg-surface-container-low p-5">
          <label className="font-label mb-2 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
            Apps Script endpoint
          </label>
          <input
            value={endpointInput}
            onChange={(e) => setEndpointInput(e.target.value)}
            placeholder="https://script.google.com/macros/s/…/exec"
            className="w-full rounded border border-outline-variant/30 bg-surface-container-lowest px-4 py-2 text-sm outline-none ring-primary/40 focus:ring-2"
          />
          <label className="font-label mb-2 mt-4 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
            Admin secret
          </label>
          <input
            type="password"
            value={secretInput}
            onChange={(e) => setSecretInput(e.target.value)}
            placeholder="Set in Apps Script → Project Settings → Script Properties"
            className="w-full rounded border border-outline-variant/30 bg-surface-container-lowest px-4 py-2 text-sm outline-none ring-primary/40 focus:ring-2"
            autoComplete="off"
          />
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={saveEndpoint}
              className="rounded-full bg-primary px-5 py-2 text-xs font-bold uppercase tracking-widest text-on-primary"
            >
              Save & load
            </button>
            {endpoint && (
              <button
                type="button"
                onClick={forgetEndpoint}
                className="rounded-full border border-outline-variant/40 px-5 py-2 text-xs font-bold uppercase tracking-widest text-on-surface"
              >
                Forget on this device
              </button>
            )}
          </div>
          {endpoint && (
            <p className="mt-3 text-xs text-on-surface-variant">
              Stored locally — only visible on this device. Use Forget when handing the laptop back.
            </p>
          )}
        </section>

        {/* Status + filters */}
        <section className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-2">
            {(["all", "pending", "approved"] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setFilter(k)}
                className={`rounded-full px-4 py-1.5 text-[11px] font-bold uppercase tracking-widest transition ${
                  filter === k
                    ? "bg-primary text-on-primary"
                    : "bg-surface-container-high text-on-surface"
                }`}
              >
                {k}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => endpoint && void fetchList(endpoint, secret)}
            disabled={!endpoint || loading}
            className="rounded-full border border-primary px-4 py-1.5 text-[11px] font-bold uppercase tracking-widest text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </section>

        {error && (
          <p className="rounded-md bg-error/10 px-4 py-3 text-sm text-error">
            {error}
          </p>
        )}

        {/* List */}
        {!endpoint && !error && (
          <p className="rounded-md bg-surface-container-high px-4 py-6 text-center text-sm text-on-surface-variant">
            Paste the Apps Script `/exec` URL above to load submissions.
          </p>
        )}

        {endpoint && submissions && submissions.length === 0 && !error && (
          <p className="rounded-md bg-surface-container-high px-4 py-6 text-center text-sm text-on-surface-variant">
            No submissions yet.
          </p>
        )}

        <ul className="space-y-3">
          {filtered.map((s) => (
            <li key={s.id}>
              <Link
                href={`/architect/review?id=${encodeURIComponent(s.id)}`}
                className="block rounded-xl border border-outline-variant/20 bg-surface-container-low p-5 transition hover:border-primary hover:shadow-md"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-headline text-lg text-on-surface">
                      {s.projectName || "(unnamed project)"}
                    </p>
                    <p className="mt-1 text-sm text-on-surface-variant">
                      {s.customerName || "—"} · {s.email || "—"}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-label text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                      {s.submittedAt ? new Date(s.submittedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "—"}
                    </p>
                    <p className="mt-1 text-xs text-on-surface-variant">
                      {s.roomCount} room{s.roomCount === 1 ? "" : "s"} · ID {s.id}
                    </p>
                    {(() => {
                      const status = s.status ?? (s.approvedAt ? "approved" : "pending");
                      const tones: Record<string, string> = {
                        approved: "bg-primary/15 text-primary",
                        "in-review": "bg-amber-200/30 text-amber-700",
                        rejected: "bg-error/15 text-error",
                        pending: "bg-surface-container-high text-on-surface-variant",
                      };
                      return (
                        <span className={`mt-2 inline-block rounded-full px-3 py-0.5 text-[10px] font-bold uppercase tracking-widest ${tones[status] ?? tones.pending}`}>
                          {status.replace("-", " ")}
                        </span>
                      );
                    })()}
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
