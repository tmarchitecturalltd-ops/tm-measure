"use client";

/**
 * app/architect/proposal/page.tsx
 *
 * The proposal tool. Charlie's screen, not a customer's.
 *
 * Loads a submission the customer already sent, takes the log and
 * the brief, and produces a DXF: the existing survey in black, the
 * proposed extension in red, the permitted development report, the
 * beam schedule and the standard notes.
 *
 * ── What it does not do ────────────────────────────────────────────
 *
 * It does not decide where the kitchen goes, size a steel, or say
 * whether the application will be approved. The drawing it makes is
 * a first draft of the geometry and the paperwork around it; the
 * design is Charlie's and so is the responsibility for it.
 *
 * ── Why the plot fields are required ───────────────────────────────
 *
 * Two of the permitted development rules cannot be tested without
 * them, and the rules engine refuses to call a scheme permitted
 * development while anything is untested. That is deliberate: a
 * report that reads as compliant because a field was blank is found
 * out at the council rather than at the desk. So the fields are on
 * the form, and leaving them empty produces an honest "not
 * determined" rather than a quiet pass.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  assessRearExtension,
  rearWall,
  buildRearExtension,
  beamsForExtension,
  selectNotes,
  buildProposalDxf,
  type HouseForm,
  type ExistingExtension,
  type Designation,
  type RoofForm,
  type Brief,
  type HouseLog,
} from "@tm-designs/measure-core";
import type { RoomDraft } from "@tm-designs/measure-core";

const ENDPOINT_KEY = "tm.architect.endpoint";
const SECRET_KEY = "tm.architect.secret";

type Placement = {
  floor?: number;
  rotationDeg?: number;
  positionM?: { x?: number; z?: number };
};
type SubRoom = {
  id?: string;
  name?: string;
  ceilingHeightM?: number | string;
  shape?: string;
  floorPolygonM?: { x: number; z: number }[];
  walls?: { lengthM?: number | string }[];
  placement?: Placement;
};
type Submission = {
  submissionId?: string;
  customerName?: string;
  projectName?: string;
  rooms?: SubRoom[];
};

const FORMS: { value: HouseForm; label: string }[] = [
  { value: "detached", label: "Detached" },
  { value: "semi", label: "Semi-detached" },
  { value: "mid-terrace", label: "Mid-terrace" },
  { value: "end-terrace", label: "End-terrace" },
  { value: "bungalow", label: "Bungalow" },
  { value: "flat", label: "Flat" },
  { value: "maisonette", label: "Maisonette" },
];

const ERAS = [
  "Pre-1850",
  "1850–1900 Victorian",
  "1900–1918 Edwardian",
  "1919–1939",
  "1945–1965",
  "1965–1980",
  "1980–2000",
  "2000–2010",
  "Post-2010",
];

const EXISTING: { value: ExistingExtension; label: string }[] = [
  { value: "single-storey-rear", label: "Single-storey rear" },
  { value: "side-return", label: "Side return" },
  { value: "wraparound", label: "Wraparound" },
  { value: "two-storey-rear", label: "Two-storey rear" },
  { value: "conservatory", label: "Conservatory" },
];

const DESIGNATIONS: { value: Designation; label: string }[] = [
  { value: "conservation-area", label: "Conservation area" },
  { value: "listed", label: "Listed" },
  { value: "article-4", label: "Article 4" },
  { value: "national-park", label: "National park" },
  { value: "aonb", label: "AONB" },
  { value: "green-belt", label: "Green belt" },
  { value: "pd-removed-by-condition", label: "PD removed by condition" },
];

const ROOFS: { value: RoofForm; label: string }[] = [
  { value: "flat", label: "Flat" },
  { value: "flat-lantern", label: "Flat with lantern" },
  { value: "mono-pitch", label: "Mono-pitch" },
  { value: "gable", label: "Gable" },
  { value: "hipped", label: "Hipped" },
];

const FACES = ["north", "south", "east", "west"] as const;

const label = "mb-1 block text-xs font-bold uppercase tracking-widest text-on-surface-variant";
const field = "w-full rounded-lg border border-outline-variant/50 bg-white px-3 py-2 text-base";
const card = "rounded-2xl border border-outline-variant/40 bg-surface-container-low p-4";

export default function ProposalPage() {
  const [endpoint, setEndpoint] = useState("");
  const [secret, setSecret] = useState("");
  const [id, setId] = useState("");
  const [submission, setSubmission] = useState<Submission | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // The log
  const [form, setForm] = useState<HouseForm>("semi");
  const [era, setEra] = useState("1919–1939");
  const [bedrooms, setBedrooms] = useState("3");
  const [existing, setExisting] = useState<ExistingExtension[]>([]);
  const [existingRearDepth, setExistingRearDepth] = useState("");
  const [designations, setDesignations] = useState<Designation[]>([]);
  const [rearBoundary, setRearBoundary] = useState("");
  const [sideBoundary, setSideBoundary] = useState("");
  const [plotArea, setPlotArea] = useState("");
  const [footprint, setFootprint] = useState("");

  // The brief
  const [face, setFace] = useState<(typeof FACES)[number]>("south");
  const [depth, setDepth] = useState("3");
  const [widthMode, setWidthMode] = useState<"full" | "part">("full");
  const [widthM, setWidthM] = useState("4");
  const [roof, setRoof] = useState<RoofForm>("flat");
  const [height, setHeight] = useState("3.1");
  const [eaves, setEaves] = useState("2.85");
  const [glazing, setGlazing] = useState<Brief["rearGlazing"]>("bifold");
  const [glazingWidth, setGlazingWidth] = useState("");
  const [rooflights, setRooflights] = useState("0");
  const [newKitchen, setNewKitchen] = useState(true);
  const [newBathroom, setNewBathroom] = useState(false);
  const [briefNotes, setBriefNotes] = useState("");

  useEffect(() => {
    setEndpoint(window.localStorage.getItem(ENDPOINT_KEY) ?? "");
    setSecret(window.localStorage.getItem(SECRET_KEY) ?? "");
  }, []);

  const load = useCallback(async () => {
    if (!endpoint || !id.trim()) return;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        body: JSON.stringify({ action: "detail", id: id.trim(), secret }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "Could not load it.");
      setSubmission(json.submission as Submission);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
      setSubmission(null);
    } finally {
      setLoading(false);
    }
  }, [endpoint, secret, id]);

  /**
   * The survey, in the shape the geometry wants.
   *
   * Only rooms with a position are usable: a room nobody placed has
   * no relationship to the rear wall, and guessing one would move
   * the extension.
   */
  const entries = useMemo(() => {
    const rooms = submission?.rooms ?? [];
    return rooms
      .map((r) => {
        const p = r.placement;
        if (!p?.positionM || typeof p.positionM.x !== "number") return null;
        const draft = {
          id: r.id ?? "",
          name: r.name ?? "Room",
          walls: (r.walls ?? []).map((w, i) => ({
            id: `${r.id}-w${i}`,
            label: `Wall ${i + 1}`,
            lengthM: String(w.lengthM ?? ""),
          })),
          ceilingHeightM: String(r.ceilingHeightM ?? ""),
          doors: [],
          windows: [],
          irregularNotes: "",
          notes: "",
          photos: [],
          shape: r.shape === "custom" ? "custom" : "rectangle",
          floorPolygonM: r.floorPolygonM,
        } as unknown as RoomDraft;
        return {
          room: draft,
          anchor: { x: p.positionM.x, z: p.positionM.z ?? 0 },
          rotationDeg: (p.rotationDeg ?? 0) as never,
          floor: p.floor ?? 0,
        };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);
  }, [submission]);

  const num = (s: string) => {
    const n = Number.parseFloat(s);
    return Number.isFinite(n) ? n : undefined;
  };

  const result = useMemo(() => {
    if (!entries.length) return null;
    const wall = rearWall(entries, face);
    if (!wall) return null;

    const brief: Brief = {
      depthM: num(depth) ?? 3,
      width: widthMode,
      widthM: widthMode === "part" ? num(widthM) : undefined,
      roof,
      heightM: num(height) ?? 3,
      eavesHeightM: num(eaves) ?? 2.8,
      rearGlazing: glazing,
      rearGlazingWidthM: num(glazingWidth),
      rooflights: num(rooflights),
      notes: briefNotes || undefined,
    };
    const ext = buildRearExtension(wall, brief);
    const beams = beamsForExtension(ext);

    const log: HouseLog = {
      form,
      era,
      bedrooms: num(bedrooms),
      existing,
      existingRearDepthM: num(existingRearDepth),
      designations,
      rearBoundaryM: num(rearBoundary),
      sideBoundaryM: num(sideBoundary),
      plotAreaM2: num(plotArea),
      existingFootprintM2: num(footprint),
    };
    const report = assessRearExtension(log, { ...brief, widthM: ext.widthM });
    const notes = selectNotes({
      hasNewDrainage: newKitchen || newBathroom,
      hasNewBathroom: newBathroom,
      hasNewKitchen: newKitchen,
      hasNewWindows: true,
      hasFlatRoof: roof === "flat" || roof === "flat-lantern",
      hasPitchedRoof: roof !== "flat" && roof !== "flat-lantern",
      hasSteel: true,
      hasRooflights: (num(rooflights) ?? 0) > 0 || roof === "flat-lantern",
      isExtension: true,
      isLoft: false,
    });
    return { wall, ext, beams, report, notes, brief, log };
  }, [
    entries, face, depth, widthMode, widthM, roof, height, eaves, glazing,
    glazingWidth, rooflights, briefNotes, form, era, bedrooms, existing,
    existingRearDepth, designations, rearBoundary, sideBoundary, plotArea,
    footprint, newKitchen, newBathroom,
  ]);

  const download = useCallback(() => {
    if (!result) return;
    const dxf = buildProposalDxf({
      entries,
      extension: result.ext,
      beams: result.beams,
      report: result.report,
      notes: result.notes,
      projectName:
        (submission?.projectName || "Proposed work") +
        (submission?.customerName ? " — " + submission.customerName : ""),
      subtitle: `${era} ${FORMS.find((f) => f.value === form)?.label} · ${bedrooms} bed · ${ROOFS.find((r) => r.value === roof)?.label.toLowerCase()} roof`,
    });
    const blob = new Blob([dxf], { type: "application/dxf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download =
      (submission?.submissionId || "proposal") + "-proposed.dxf";
    a.click();
    URL.revokeObjectURL(url);
  }, [result, entries, submission, era, form, bedrooms, roof]);

  const toggle = <T,>(list: T[], v: T, set: (x: T[]) => void) =>
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  return (
    <main className="mx-auto max-w-6xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-headline text-2xl text-on-surface">
          Proposal — single-storey rear extension
        </h1>
        <Link href="/architect" className="text-sm font-bold text-primary underline">
          Back to submissions
        </Link>
      </div>

      <div className={card + " mb-5"}>
        <label className={label}>Submission ID</label>
        <div className="flex gap-2">
          <input
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="8428779A"
            className={field}
          />
          <button
            type="button"
            onClick={() => void load()}
            className="shrink-0 rounded-lg bg-primary px-5 font-bold text-on-primary"
          >
            {loading ? "Loading…" : "Load survey"}
          </button>
        </div>
        {loadError && <p className="mt-2 text-sm text-error">{loadError}</p>}
        {submission && (
          <p className="mt-2 text-sm text-on-surface-variant">
            {submission.projectName} — {submission.customerName} ·{" "}
            {entries.length} room{entries.length === 1 ? "" : "s"} positioned
            {entries.length === 0 &&
              " · nothing placed on the plan, so there is no rear wall to build off"}
          </p>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* ── The log ───────────────────────────────────────────── */}
        <section className={card}>
          <h2 className="font-headline mb-3 text-lg">The house</h2>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={label}>Form</label>
              <select value={form} onChange={(e) => setForm(e.target.value as HouseForm)} className={field}>
                {FORMS.map((f) => (
                  <option key={f.value} value={f.value}>{f.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={label}>Era</label>
              <select value={era} onChange={(e) => setEra(e.target.value)} className={field}>
                {ERAS.map((e) => <option key={e}>{e}</option>)}
              </select>
            </div>
            <div>
              <label className={label}>Bedrooms</label>
              <input value={bedrooms} onChange={(e) => setBedrooms(e.target.value)} inputMode="numeric" className={field} />
            </div>
            <div>
              <label className={label}>Garden side</label>
              <select value={face} onChange={(e) => setFace(e.target.value as typeof face)} className={field}>
                {FACES.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
          </div>

          <p className={label + " mt-4"}>Already extended</p>
          <div className="flex flex-wrap gap-2">
            {EXISTING.map((x) => (
              <button
                key={x.value}
                type="button"
                onClick={() => toggle(existing, x.value, setExisting)}
                className={`rounded-full border px-3 py-1.5 text-sm font-semibold ${
                  existing.includes(x.value)
                    ? "border-primary bg-primary/10 text-on-surface"
                    : "border-outline-variant/50 text-on-surface-variant"
                }`}
              >
                {x.label}
              </button>
            ))}
          </div>
          {existing.length > 0 && (
            <div className="mt-3">
              <label className={label}>Existing rear projection (m)</label>
              <input value={existingRearDepth} onChange={(e) => setExistingRearDepth(e.target.value)} inputMode="decimal" className={field} />
              <p className="mt-1 text-xs text-on-surface-variant">
                The allowance is cumulative. Without this the depth check
                cannot be completed.
              </p>
            </div>
          )}

          <p className={label + " mt-4"}>Designations</p>
          <div className="flex flex-wrap gap-2">
            {DESIGNATIONS.map((d) => (
              <button
                key={d.value}
                type="button"
                onClick={() => toggle(designations, d.value, setDesignations)}
                className={`rounded-full border px-3 py-1.5 text-sm font-semibold ${
                  designations.includes(d.value)
                    ? "border-error bg-error/10 text-on-surface"
                    : "border-outline-variant/50 text-on-surface-variant"
                }`}
              >
                {d.label}
              </button>
            ))}
          </div>

          <p className={label + " mt-4"}>The plot</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={label}>Rear wall to rear boundary (m)</label>
              <input value={rearBoundary} onChange={(e) => setRearBoundary(e.target.value)} inputMode="decimal" className={field} />
            </div>
            <div>
              <label className={label}>Flank to side boundary (m)</label>
              <input value={sideBoundary} onChange={(e) => setSideBoundary(e.target.value)} inputMode="decimal" className={field} />
            </div>
            <div>
              <label className={label}>Plot area (m²)</label>
              <input value={plotArea} onChange={(e) => setPlotArea(e.target.value)} inputMode="decimal" className={field} />
            </div>
            <div>
              <label className={label}>Existing footprint (m²)</label>
              <input value={footprint} onChange={(e) => setFootprint(e.target.value)} inputMode="decimal" className={field} />
            </div>
          </div>
          <p className="mt-2 text-xs text-on-surface-variant">
            All four are needed before the scheme can be called permitted
            development. Leave one out and the report says which rule it
            could not test, rather than passing it quietly.
          </p>
        </section>

        {/* ── The brief ─────────────────────────────────────────── */}
        <section className={card}>
          <h2 className="font-headline mb-3 text-lg">What they want</h2>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={label}>Depth (m)</label>
              <input value={depth} onChange={(e) => setDepth(e.target.value)} inputMode="decimal" className={field} />
            </div>
            <div>
              <label className={label}>Width</label>
              <select value={widthMode} onChange={(e) => setWidthMode(e.target.value as "full" | "part")} className={field}>
                <option value="full">Full width of the house</option>
                <option value="part">Part width</option>
              </select>
            </div>
            {widthMode === "part" && (
              <div>
                <label className={label}>Width (m)</label>
                <input value={widthM} onChange={(e) => setWidthM(e.target.value)} inputMode="decimal" className={field} />
              </div>
            )}
            <div>
              <label className={label}>Roof</label>
              <select value={roof} onChange={(e) => setRoof(e.target.value as RoofForm)} className={field}>
                {ROOFS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
            <div>
              <label className={label}>Overall height (m)</label>
              <input value={height} onChange={(e) => setHeight(e.target.value)} inputMode="decimal" className={field} />
            </div>
            <div>
              <label className={label}>Eaves height (m)</label>
              <input value={eaves} onChange={(e) => setEaves(e.target.value)} inputMode="decimal" className={field} />
            </div>
            <div>
              <label className={label}>Rear glazing</label>
              <select value={glazing} onChange={(e) => setGlazing(e.target.value as Brief["rearGlazing"])} className={field}>
                <option value="bifold">Bi-fold doors</option>
                <option value="sliding">Sliding doors</option>
                <option value="french">French doors</option>
                <option value="picture-window">Picture window</option>
              </select>
            </div>
            <div>
              <label className={label}>Glazing width (m, optional)</label>
              <input value={glazingWidth} onChange={(e) => setGlazingWidth(e.target.value)} inputMode="decimal" className={field} />
            </div>
            <div>
              <label className={label}>Rooflights</label>
              <input value={rooflights} onChange={(e) => setRooflights(e.target.value)} inputMode="numeric" className={field} />
            </div>
          </div>

          <div className="mt-3 flex gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={newKitchen} onChange={(e) => setNewKitchen(e.target.checked)} />
              New kitchen
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={newBathroom} onChange={(e) => setNewBathroom(e.target.checked)} />
              New WC or bathroom
            </label>
          </div>

          <div className="mt-3">
            <label className={label}>Notes (carried onto the drawing)</label>
            <textarea value={briefNotes} onChange={(e) => setBriefNotes(e.target.value)} rows={3} className={field} />
          </div>
        </section>
      </div>

      {/* ── The report ──────────────────────────────────────────── */}
      {result && (
        <section className={card + " mt-5"}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-headline text-lg">
              {result.ext.widthM.toFixed(2)} × {result.ext.depthM.toFixed(2)} m
              {" "}· {result.ext.footprintM2.toFixed(1)} m²
            </h2>
            <button
              type="button"
              onClick={download}
              className="rounded-lg bg-primary px-5 py-2.5 font-bold text-on-primary"
            >
              Download DXF
            </button>
          </div>

          <p
            className={`mb-3 rounded-lg px-3 py-2 text-sm font-semibold ${
              result.report.route === "permitted-development"
                ? "bg-primary/10 text-on-surface"
                : result.report.route === "unknown"
                  ? "bg-amber-100 text-amber-900"
                  : "bg-error/10 text-error"
            }`}
          >
            {result.report.route === "permitted-development"
              ? "Permitted development — all rules tested and passed"
              : result.report.route === "prior-approval"
                ? "Prior approval — larger extension, 42 day neighbour consultation"
                : result.report.route === "full-application"
                  ? "Full planning application required"
                  : "Not determined — a rule could not be tested"}
          </p>

          <ul className="space-y-1.5">
            {result.report.checks.map((c) => (
              <li key={c.id} className="flex gap-3 text-sm">
                <span
                  className={`mt-0.5 w-24 shrink-0 text-xs font-bold uppercase tracking-wider ${
                    c.state === "pass"
                      ? "text-primary"
                      : c.state === "breach"
                        ? "text-error"
                        : "text-amber-700"
                  }`}
                >
                  {c.state}
                </span>
                <span>
                  <strong className="text-on-surface">{c.rule}.</strong>{" "}
                  <span className="text-on-surface-variant">{c.detail}</span>
                </span>
              </li>
            ))}
          </ul>

          {result.beams.length > 0 && (
            <div className="mt-4 border-t border-outline-variant/40 pt-3">
              <p className={label}>Beams</p>
              {result.beams.map((b) => (
                <p key={b.ref} className="text-sm text-on-surface-variant">
                  <strong className="text-on-surface">{b.ref}</strong> —{" "}
                  {b.spanM.toFixed(2)} m clear span, {b.bearingMm} mm bearing
                  each end. Section to be confirmed by calculation.
                </p>
              ))}
            </div>
          )}

          <p className="mt-4 text-xs text-on-surface-variant">
            {result.notes.length} note groups will be written onto the
            drawing. Nothing on it is sized by calculation.
          </p>
        </section>
      )}
    </main>
  );
}
