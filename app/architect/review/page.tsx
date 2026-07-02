"use client";

/**
 * app/architect/review/page.tsx
 *
 * Architect Verification Console — single-submission detail view.
 *
 * URL: /architect/review?id=XXXXXXXX
 *
 * Reads the submission via Apps Script `?action=detail&id=…`, renders
 * measurements + photo filenames + connections + floor plan summary
 * side-by-side, and provides:
 *   • Approve → stamps the sheet via `?action=approve` and downloads
 *     the raw JSON payload for CAD/BIM import.
 *   • Download JSON → just the export (no approve).
 *
 * Static-export-safe via query string instead of dynamic route segment.
 */

import Link from "next/link";
import PhotoAnnotator from "@/components/PhotoAnnotator";
import { useCallback, useEffect, useMemo, useState } from "react";

const ENDPOINT_KEY = "tm.architect.endpoint";
const SECRET_KEY = "tm.architect.secret";

type Wall = { id?: string; label?: string; lengthM?: number | string };
type Opening = { id?: string; widthM?: number | string; note?: string };
type Photo = { id?: string; name?: string; uri?: string; driveUrl?: string };
type VoiceMemo = {
  id?: string;
  name?: string;
  driveUrl?: string;
  durationMs?: number;
  type?: string;
};
type Placement = {
  floor?: number;
  rotationDeg?: number;
  positionM?: { x?: number; z?: number };
};
type Room = {
  id?: string;
  name?: string;
  walls?: Wall[];
  ceilingHeightM?: number | string;
  doors?: Opening[];
  windows?: Opening[];
  irregularShapeNotes?: string;
  notes?: string;
  photos?: Photo[];
  voiceMemos?: VoiceMemo[];
  placement?: Placement;
};
type Connection = {
  id?: string;
  roomAId?: string;
  roomAName?: string;
  roomBId?: string;
  roomBName?: string;
  kind?: string;
  widthM?: number;
  notes?: string;
};
type ExteriorBlock = {
  bySide?: Record<"front" | "back" | "left" | "right", Photo[]>;
};
type ProposalBlock = {
  description?: string;
  sketches?: Photo[];
};
type ReviewStatus = "pending" | "in-review" | "approved" | "rejected";

type Submission = {
  submissionId?: string;
  customerName?: string;
  email?: string;
  projectName?: string;
  unitPreference?: string;
  submittedAt?: string;
  approvedAt?: string | null;
  rooms?: Room[];
  connections?: Connection[];
  exterior?: ExteriorBlock;
  proposal?: ProposalBlock;
  status?: ReviewStatus;
  internalNote?: string;
};

function fmtMeters(v: unknown): string {
  const n = Number(v);
  if (!isFinite(n)) return "—";
  return `${n.toFixed(2)} m`;
}

function fmtImperial(v: unknown): string {
  const n = Number(v);
  if (!isFinite(n)) return "";
  const inches = n * 39.3700787;
  const ft = Math.floor(inches / 12);
  const inch = Math.round(inches - ft * 12);
  if (inch === 12) return `${ft + 1}' 0"`;
  return `${ft}' ${inch}"`;
}

function fmtDual(v: unknown): string {
  const m = fmtMeters(v);
  if (m === "—") return "—";
  return `${m} · ${fmtImperial(v)}`;
}

export default function ArchitectReviewPage() {
  const [endpoint, setEndpoint] = useState("");
  const [secret, setSecret] = useState("");
  const [submissionId, setSubmissionId] = useState<string | null>(null);
  const [submission, setSubmission] = useState<Submission | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  /** Currently-open annotation target: the Drive URL of the photo
   *  being drawn on plus a friendly name for the saved copy. */
  const [annotating, setAnnotating] = useState<
    | { url: string; name: string; appendTo: (driveUrl: string) => void }
    | null
  >(null);

  // Pull endpoint + ID on mount (static-export-safe — runtime only).
  useEffect(() => {
    if (typeof window === "undefined") return;
    setEndpoint(window.localStorage.getItem(ENDPOINT_KEY) ?? "");
    setSecret(window.localStorage.getItem(SECRET_KEY) ?? "");
    const id = new URLSearchParams(window.location.search).get("id");
    setSubmissionId(id);
  }, []);

  const fetchDetail = useCallback(async (url: string, sec: string, id: string) => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(url, {
        method: "POST",
        mode: "cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: "detail", id, ...(sec ? { secret: sec } : {}) }),
      });
      if (!r.ok) throw new Error(`Server responded ${r.status}`);
      const data: { ok?: boolean; error?: string; submission?: Submission } = await r.json();
      if (data.ok === false) throw new Error(data.error || "Endpoint returned an error.");
      setSubmission(data.submission ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (endpoint && submissionId) void fetchDetail(endpoint, secret, submissionId);
  }, [endpoint, secret, submissionId, fetchDetail]);

  const downloadJson = useCallback(() => {
    if (!submission) return;
    const blob = new Blob([JSON.stringify(submission, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `tm-submission-${submission.submissionId || "export"}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [submission]);

  const updateStatus = useCallback(
    async (next: ReviewStatus, note?: string) => {
      if (!submission?.submissionId || !endpoint) return;
      try {
        const r = await fetch(endpoint, {
          method: "POST",
          mode: "cors",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({
            action: "set_status",
            id: submission.submissionId,
            status: next,
            note: note ?? submission.internalNote ?? "",
            secret,
          }),
        });
        if (!r.ok) throw new Error(`Server responded ${r.status}`);
        const data: { ok?: boolean; error?: string } = await r.json();
        if (data.ok === false) throw new Error(data.error || "Status update failed.");
        setSubmission({
          ...submission,
          status: next,
          internalNote: note ?? submission.internalNote,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [submission, endpoint, secret],
  );

  const approve = useCallback(async () => {
    if (!submission?.submissionId || !endpoint) return;
    setApproving(true);
    setError(null);
    try {
      // Mutating action over POST so the admin secret stays out of
      // URL query strings (referrer headers, server logs, browser
      // history). text/plain keeps it CORS-simple for Apps Script.
      const r = await fetch(endpoint, {
        method: "POST",
        mode: "cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
          action: "approve",
          id: submission.submissionId,
          secret,
        }),
      });
      if (!r.ok) throw new Error(`Server responded ${r.status}`);
      const data: { ok?: boolean; error?: string; approvedAt?: string } = await r.json();
      if (data.ok === false) throw new Error(data.error || "Approval failed.");
      setSubmission({ ...submission, approvedAt: data.approvedAt ?? new Date().toISOString() });
      // Auto-export the JSON so the architect always walks away with the
      // file even if the approve call was the only reason they came here.
      downloadJson();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApproving(false);
    }
  }, [submission, endpoint, secret, downloadJson]);

  const totalArea = useMemo(() => {
    if (!submission?.rooms) return 0;
    return submission.rooms.reduce((sum, r) => {
      const w = Number(r.walls?.[0]?.lengthM);
      const l = Number(r.walls?.[1]?.lengthM);
      if (!isFinite(w) || !isFinite(l)) return sum;
      return sum + w * l;
    }, 0);
  }, [submission]);

  return (
    <div className="min-h-screen bg-surface pb-24 pt-10">
      <header className="mx-auto mb-6 max-w-5xl px-4 md:px-6">
        <Link
          href="/architect"
          className="material-symbols-outlined inline-flex items-center text-primary"
          aria-label="Back to console"
        >
          arrow_back
        </Link>
        <p className="font-label mt-3 text-[10px] font-bold uppercase tracking-[0.3em] text-primary">
          Verification
        </p>
        <h1 className="font-headline mt-1 text-3xl text-on-surface md:text-4xl">
          {submission?.projectName || (loading ? "Loading…" : "Submission")}
        </h1>
        {submission && (
          <p className="mt-1 text-sm text-on-surface-variant">
            {submission.customerName} · {submission.email} · ID {submission.submissionId}
          </p>
        )}
      </header>

      <main className="mx-auto max-w-5xl space-y-6 px-4 md:px-6">
        {error && (
          <p className="rounded-md bg-error/10 px-4 py-3 text-sm text-error">{error}</p>
        )}

        {!endpoint && (
          <p className="rounded-md bg-surface-container-high px-4 py-6 text-sm text-on-surface-variant">
            Set the Apps Script endpoint on the <Link className="text-primary underline" href="/architect">console home</Link> first.
          </p>
        )}

        {submission && (
          <>
            {/* Approve bar */}
            <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border-2 border-primary/40 bg-inverse-surface p-5 text-[#f7f5ef] shadow-lg">
              <div>
                <p className="font-label text-[10px] font-bold uppercase tracking-[0.25em] text-primary">
                  Status
                </p>
                <p className="mt-1 text-lg font-semibold">
                  {submission.approvedAt
                    ? `Approved ${new Date(submission.approvedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}`
                    : "Awaiting verification"}
                </p>
                <p className="mt-1 text-xs text-white/65">
                  {submission.rooms?.length ?? 0} rooms · ≈ {totalArea.toFixed(1)} m² total floor area
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={downloadJson}
                  className="rounded-full border border-primary px-5 py-2 text-xs font-bold uppercase tracking-widest text-primary"
                >
                  Download JSON
                </button>
                <button
                  type="button"
                  onClick={() => {
                    // Lean on the browser's native PDF print path —
                    // the print stylesheet in globals.css strips the
                    // app shell and forces page breaks per section.
                    if (typeof window !== "undefined") window.print();
                  }}
                  className="rounded-full border border-primary px-5 py-2 text-xs font-bold uppercase tracking-widest text-primary"
                >
                  Download PDF
                </button>
                <button
                  type="button"
                  onClick={approve}
                  disabled={approving || !!submission.approvedAt}
                  className="rounded-full bg-primary px-5 py-2 text-xs font-bold uppercase tracking-widest text-on-primary disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {approving
                    ? "Approving…"
                    : submission.approvedAt
                      ? "Approved"
                      : "Approve & export"}
                </button>
              </div>
            </section>

            {/* Workflow status + internal notes */}
            <section className="rounded-xl border border-outline-variant/20 bg-surface-container-low p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="font-headline text-xl text-on-surface">Workflow</h2>
                <div className="flex flex-wrap gap-2">
                  {(["pending", "in-review", "approved", "rejected"] as const).map((s) => {
                    const active = (submission.status ?? "pending") === s;
                    return (
                      <button
                        key={s}
                        type="button"
                        onClick={() => void updateStatus(s)}
                        className={`rounded-full px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest transition ${
                          active
                            ? "bg-primary text-on-primary shadow-sm"
                            : "bg-surface-container-high text-on-surface"
                        }`}
                      >
                        {s.replace("-", " ")}
                      </button>
                    );
                  })}
                </div>
              </div>
              <label
                htmlFor="internal-note"
                className="font-label mt-4 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant"
              >
                Internal note (visible to architect only)
              </label>
              <textarea
                id="internal-note"
                rows={3}
                value={submission.internalNote ?? ""}
                onChange={(e) =>
                  setSubmission({ ...submission, internalNote: e.target.value })
                }
                onBlur={() =>
                  void updateStatus(
                    submission.status ?? "pending",
                    submission.internalNote ?? "",
                  )
                }
                placeholder="Notes only visible to the TM team — pricing assumptions, follow-ups, anything off-the-record."
                className="mt-1 w-full rounded border border-outline-variant/30 bg-surface-container-lowest px-4 py-2 text-sm outline-none ring-primary/40 focus:ring-2"
              />
            </section>

            {/* Rooms */}
            <section className="space-y-4">
              <h2 className="font-headline text-xl text-on-surface">Rooms</h2>
              {(submission.rooms ?? []).map((r, ri) => (
                <article
                  key={r.id ?? ri}
                  className="rounded-xl border border-outline-variant/20 bg-surface-container-low p-5"
                >
                  <h3 className="font-headline text-lg text-on-surface">
                    {r.name || `Room ${ri + 1}`}
                  </h3>

                  <div className="mt-3 grid gap-4 md:grid-cols-2">
                    <div>
                      <p className="font-label text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                        Walls
                      </p>
                      <ul className="mt-1 space-y-1 text-sm text-on-surface">
                        {(r.walls ?? []).map((w, i) => (
                          <li key={w.id ?? i} className="flex justify-between gap-3">
                            <span>{w.label || `Wall ${i + 1}`}</span>
                            <span className="font-mono">{fmtDual(w.lengthM)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <p className="font-label text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                        Vertical / openings
                      </p>
                      <ul className="mt-1 space-y-1 text-sm text-on-surface">
                        <li className="flex justify-between gap-3">
                          <span>Ceiling height</span>
                          <span className="font-mono">{fmtDual(r.ceilingHeightM)}</span>
                        </li>
                        {(r.doors ?? []).map((d, i) => (
                          <li key={d.id ?? i} className="flex justify-between gap-3">
                            <span>Door {d.note ? `(${d.note})` : ""}</span>
                            <span className="font-mono">{fmtDual(d.widthM)}</span>
                          </li>
                        ))}
                        {(r.windows ?? []).map((w, i) => (
                          <li key={w.id ?? i} className="flex justify-between gap-3">
                            <span>Window {w.note ? `(${w.note})` : ""}</span>
                            <span className="font-mono">{fmtDual(w.widthM)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>

                  {(r.notes || r.irregularShapeNotes) && (
                    <div className="mt-4 rounded-md border-l-2 border-primary bg-surface-container-lowest p-3 text-sm text-on-surface">
                      {[r.irregularShapeNotes, r.notes].filter(Boolean).join("\n\n")}
                    </div>
                  )}

                  {r.photos && r.photos.length > 0 && (
                    <div className="mt-4">
                      <p className="font-label mb-1 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                        Reference photos ({r.photos.length})
                      </p>
                      <ul className="flex flex-wrap gap-2">
                        {r.photos.map((p, i) =>
                          p.driveUrl ? (
                            <li key={p.id ?? i} className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-1 text-xs text-primary">
                              <a
                                href={p.driveUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1"
                              >
                                <span className="material-symbols-outlined" style={{ fontSize: "14px" }} aria-hidden>open_in_new</span>
                                {p.name || `photo-${i + 1}`}
                              </a>
                              <button
                                type="button"
                                onClick={() => {
                                  const captured = p;
                                  setAnnotating({
                                    url: captured.driveUrl ?? "",
                                    name: captured.name || `photo-${i + 1}`,
                                    appendTo: () => {/* no-op for room photos */},
                                  });
                                }}
                                title="Annotate"
                                className="ml-1 rounded px-1.5 text-[10px] font-bold uppercase tracking-widest text-primary hover:bg-primary/15"
                              >
                                ✎
                              </button>
                            </li>
                          ) : (
                            <li
                              key={p.id ?? i}
                              className="rounded-md bg-surface-container-high px-3 py-1 text-xs text-on-surface"
                            >
                              {p.name || `photo-${i + 1}`}
                            </li>
                          ),
                        )}
                      </ul>
                      <p className="mt-2 text-[11px] text-on-surface-variant">
                        Photos with the open-in-new icon are hosted on the project Drive folder; older submissions list filenames only.
                      </p>
                    </div>
                  )}
                  {r.voiceMemos && r.voiceMemos.length > 0 && (
                    <div className="mt-4">
                      <p className="font-label mb-1 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                        Voice memos ({r.voiceMemos.length})
                      </p>
                      <ul className="space-y-2">
                        {r.voiceMemos.map((m, i) =>
                          m.driveUrl ? (
                            <li
                              key={m.id ?? i}
                              className="flex flex-wrap items-center gap-3 rounded-md border border-outline-variant/30 bg-surface-container-lowest p-2 text-xs"
                            >
                              <span aria-hidden>🎙</span>
                              <a
                                href={m.driveUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-primary underline"
                              >
                                {m.name || `voice-${i + 1}`}
                              </a>
                              {typeof m.durationMs === "number" && (
                                <span className="text-on-surface-variant">
                                  {(m.durationMs / 1000).toFixed(1)}s
                                </span>
                              )}
                            </li>
                          ) : (
                            <li key={m.id ?? i} className="text-xs text-on-surface">
                              {m.name || `voice-${i + 1}`}
                            </li>
                          ),
                        )}
                      </ul>
                    </div>
                  )}
                </article>
              ))}
            </section>

            {/* Exterior 2×2 grid */}
            {submission.exterior?.bySide && (
              <section className="pdf-page-break rounded-xl border border-outline-variant/20 bg-surface-container-low p-5">
                <h2 className="font-headline text-xl text-on-surface">Exterior</h2>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {(["front", "back", "left", "right"] as const).map((side) => {
                    const photos = submission.exterior?.bySide?.[side] ?? [];
                    return (
                      <div
                        key={side}
                        className="rounded-md border border-outline-variant/30 bg-surface-container-lowest p-3"
                      >
                        <p className="font-label text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                          {side === "front" && "Front (street)"}
                          {side === "back" && "Back (garden)"}
                          {side === "left" && "Left"}
                          {side === "right" && "Right"}
                        </p>
                        {photos.length === 0 ? (
                          <p className="mt-1 text-xs italic text-on-surface-variant">
                            No photo.
                          </p>
                        ) : (
                          <ul className="mt-1 space-y-1">
                            {photos.map((p, i) =>
                              p.driveUrl ? (
                                <li key={p.id ?? i} className="flex items-center gap-2">
                                  <a
                                    href={p.driveUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-xs text-primary underline"
                                  >
                                    {p.name || `photo-${i + 1}`}
                                  </a>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setAnnotating({
                                        url: p.driveUrl ?? "",
                                        name: `exterior-${side}-${p.name || i + 1}`,
                                        appendTo: () => {/* no-op */},
                                      })
                                    }
                                    title="Annotate"
                                    className="rounded px-1.5 text-[10px] font-bold uppercase tracking-widest text-primary hover:bg-primary/15"
                                  >
                                    ✎
                                  </button>
                                </li>
                              ) : (
                                <li key={p.id ?? i} className="text-xs text-on-surface">
                                  {p.name || `photo-${i + 1}`}
                                </li>
                              ),
                            )}
                          </ul>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Proposal description + sketches */}
            {submission.proposal &&
              ((submission.proposal.description?.trim() ?? "") !== "" ||
                (submission.proposal.sketches?.length ?? 0) > 0) && (
                <section className="pdf-page-break rounded-xl border border-outline-variant/20 bg-surface-container-low p-5">
                  <h2 className="font-headline text-xl text-on-surface">Proposal</h2>
                  {submission.proposal.description && (
                    <p className="mt-3 whitespace-pre-wrap rounded-md border-l-2 border-primary bg-surface-container-lowest p-3 text-sm text-on-surface">
                      {submission.proposal.description}
                    </p>
                  )}
                  {submission.proposal.sketches &&
                    submission.proposal.sketches.length > 0 && (
                      <div className="mt-4">
                        <p className="font-label mb-1 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                          Sketches ({submission.proposal.sketches.length})
                        </p>
                        <ul className="flex flex-wrap gap-2">
                          {submission.proposal.sketches.map((p, i) =>
                            p.driveUrl ? (
                              <li key={p.id ?? i} className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-1 text-xs text-primary">
                                <a
                                  href={p.driveUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1"
                                >
                                  {p.name || `sketch-${i + 1}`}
                                </a>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setAnnotating({
                                      url: p.driveUrl ?? "",
                                      name: `proposal-${p.name || `sketch-${i + 1}`}`,
                                      appendTo: () => {/* no-op */},
                                    })
                                  }
                                  title="Annotate"
                                  className="rounded px-1.5 text-[10px] font-bold uppercase tracking-widest text-primary hover:bg-primary/15"
                                >
                                  ✎
                                </button>
                              </li>
                            ) : (
                              <li
                                key={p.id ?? i}
                                className="rounded-md bg-surface-container-high px-3 py-1 text-xs text-on-surface"
                              >
                                {p.name || `sketch-${i + 1}`}
                              </li>
                            ),
                          )}
                        </ul>
                      </div>
                    )}
                </section>
              )}

            {/* Connections */}
            {submission.connections && submission.connections.length > 0 && (
              <section className="pdf-page-break rounded-xl border border-outline-variant/20 bg-surface-container-low p-5">
                <h2 className="font-headline text-xl text-on-surface">Room connections</h2>
                <ul className="mt-3 space-y-2 text-sm text-on-surface">
                  {submission.connections.map((c, i) => (
                    <li key={c.id ?? i}>
                      <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-primary">
                        {c.kind ?? "wall"}
                      </span>{" "}
                      {c.roomAName ?? "(room)"}
                      {c.kind !== "external" && c.roomBName ? ` ↔ ${c.roomBName}` : ""}
                      {typeof c.widthM === "number" && isFinite(c.widthM)
                        ? ` · ${c.widthM.toFixed(2)} m`
                        : ""}
                      {c.notes ? ` · ${c.notes}` : ""}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </main>
      {annotating && (
        <PhotoAnnotator
          open
          imageUrl={annotating.url}
          suggestedName={annotating.name}
          endpoint={endpoint}
          secret={secret}
          submissionId={submission?.submissionId ?? submissionId ?? ""}
          onClose={() => setAnnotating(null)}
          onSaved={(driveUrl) => annotating.appendTo(driveUrl)}
        />
      )}
    </div>
  );
}
