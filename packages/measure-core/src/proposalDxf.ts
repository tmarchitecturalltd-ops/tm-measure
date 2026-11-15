/**
 * The proposal, as a DXF Charlie can open and work in.
 *
 * Existing survey on its own layers in black, new work in red on
 * `TM-PROP-*` — which is the convention his drawings already use, so
 * the file arrives looking like the ones he produces rather than
 * like something that has to be translated first.
 *
 * Millimetres, and the app's screen-down z negated into CAD's y-up.
 * Both are load-bearing and both fail silently; see dxfPlan.ts,
 * which made the same two decisions for the same reasons.
 *
 * What is on the sheet and what is not:
 *
 *   drawn      the existing footprint, the new envelope, the
 *              knock-through, the glazing, the beam position and
 *              its span
 *   written    the compliance report, the standard notes, the beam
 *              schedule with the section left blank
 *   absent     anything sized by calculation
 */

import type { Pt } from "./splitRooms.ts";
import {
  roomOutlineM,
  squareRoomsForDrawing,
  squareToSheet,
  type PlanRoomInput,
} from "./dxfPlan.ts";
import type { ProposedExtension, ProposedBeam } from "./proposalPlan.ts";
import { beamScheduleLine } from "./proposalPlan.ts";
import type { ComplianceReport } from "./proposal.ts";
import { takeDownAsText, type LoadTakeDown } from "./loads.ts";
import type { NoteGroup } from "./proposalNotes.ts";

export const PROP_LAYER = {
  existing: "TM-EXIST",
  existingText: "TM-EXIST-TEXT",
  walls: "TM-PROP-WALLS",
  openings: "TM-PROP-OPENINGS",
  beams: "TM-PROP-BEAMS",
  dims: "TM-PROP-DIMS",
  notes: "TM-PROP-NOTES",
  compliance: "TM-PROP-COMPLIANCE",
} as const;

function pair(code: number, value: string | number): string {
  return code + "\n" + value;
}

const toMm = (p: Pt) => ({ x: p.x * 1000, y: -p.z * 1000 });

function line(layer: string, a: Pt, b: Pt): string {
  const A = toMm(a);
  const B = toMm(b);
  return [
    pair(0, "LINE"),
    pair(8, layer),
    pair(10, A.x.toFixed(2)),
    pair(20, A.y.toFixed(2)),
    pair(30, "0.0"),
    pair(11, B.x.toFixed(2)),
    pair(21, B.y.toFixed(2)),
    pair(31, "0.0"),
  ].join("\n");
}

function text(
  layer: string,
  at: Pt,
  heightMm: number,
  value: string,
): string {
  const P = toMm(at);
  return [
    pair(0, "TEXT"),
    pair(8, layer),
    pair(10, P.x.toFixed(2)),
    pair(20, P.y.toFixed(2)),
    pair(30, "0.0"),
    pair(40, heightMm.toFixed(2)),
    // DXF has no newline inside a TEXT entity, so every line is its
    // own entity and the caller steps the y. A \n written here would
    // reach CAD as a literal backslash-n, which is the kind of fault
    // that survives to a printed drawing.
    pair(1, value.replace(/\n/g, " ")),
  ].join("\n");
}

function polyline(layer: string, poly: Pt[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < poly.length; i += 1) {
    out.push(line(layer, poly[i], poly[(i + 1) % poly.length]));
  }
  return out;
}

export type ProposalDxfInput = {
  entries: PlanRoomInput[];
  extension: ProposedExtension;
  beams: ProposedBeam[];
  /** Load take-down per beam ref, when one has been worked out. */
  loads?: Record<string, LoadTakeDown>;
  report: ComplianceReport;
  notes: NoteGroup[];
  projectName?: string;
  /** Era, form, bedrooms — printed on the sheet as context. */
  subtitle?: string;
};

export function buildProposalDxf(input: ProposalDxfInput): string {
  const prepared = squareToSheet(
    squareRoomsForDrawing(input.entries.filter((e) => e.anchor)),
  );

  const out: string[] = [];
  out.push(pair(0, "SECTION"), pair(2, "HEADER"));
  out.push(pair(9, "$INSUNITS"), pair(70, 4)); // millimetres
  out.push(pair(0, "ENDSEC"));

  const layers: [string, number][] = [
    [PROP_LAYER.existing, 7],
    [PROP_LAYER.existingText, 8],
    [PROP_LAYER.walls, 1],
    [PROP_LAYER.openings, 1],
    [PROP_LAYER.beams, 1],
    [PROP_LAYER.dims, 1],
    [PROP_LAYER.notes, 7],
    [PROP_LAYER.compliance, 7],
  ];
  out.push(pair(0, "SECTION"), pair(2, "TABLES"));
  out.push(pair(0, "TABLE"), pair(2, "LAYER"), pair(70, layers.length));
  for (const [name, colour] of layers) {
    out.push(
      pair(0, "LAYER"),
      pair(2, name),
      pair(70, 0),
      pair(62, colour),
      pair(6, "CONTINUOUS"),
    );
  }
  out.push(pair(0, "ENDTAB"), pair(0, "ENDSEC"));

  out.push(pair(0, "SECTION"), pair(2, "ENTITIES"));

  // ── Existing ────────────────────────────────────────────────────
  for (const e of prepared) {
    const poly = roomOutlineM(e);
    if (poly.length < 3) continue;
    out.push(...polyline(PROP_LAYER.existing, poly));
    const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length;
    const cz = poly.reduce((s, p) => s + p.z, 0) / poly.length;
    out.push(
      text(
        PROP_LAYER.existingText,
        { x: cx - 0.6, z: cz },
        200,
        e.room.name?.trim() || "Room",
      ),
    );
  }

  // ── Proposed ────────────────────────────────────────────────────
  const ext = input.extension;
  out.push(...polyline(PROP_LAYER.walls, ext.outline));

  /*
   * The knock-through, dashed in the drawing's sense: drawn as the
   * line it is and left on its own layer, so Charlie can switch it
   * to a dashed linetype in one action. R12 linetypes are declared
   * per-file and a file that declares one CAD does not have is a
   * file that will not open, which is a poor trade for a dash.
   */
  if (ext.knockThrough) {
    out.push(
      line(PROP_LAYER.walls, ext.knockThrough.a, ext.knockThrough.b),
    );
  }

  for (const o of ext.openings) {
    out.push(line(PROP_LAYER.openings, o.a, o.b));
    const mid = { x: (o.a.x + o.b.x) / 2, z: (o.a.z + o.b.z) / 2 };
    out.push(
      text(
        PROP_LAYER.openings,
        { x: mid.x - 1.2, z: mid.z + 0.45 },
        150,
        `${o.label} ${o.widthM.toFixed(2)} m`,
      ),
    );
  }

  for (const b of input.beams) {
    out.push(line(PROP_LAYER.beams, b.a, b.b));
    const mid = { x: (b.a.x + b.b.x) / 2, z: (b.a.z + b.b.z) / 2 };
    out.push(
      text(
        PROP_LAYER.beams,
        { x: mid.x - 0.3, z: mid.z - 0.3 },
        200,
        b.ref,
      ),
    );
  }

  // Overall size of the new work, written across it.
  const cx = ext.outline.reduce((s, p) => s + p.x, 0) / ext.outline.length;
  const cz = ext.outline.reduce((s, p) => s + p.z, 0) / ext.outline.length;
  out.push(
    text(
      PROP_LAYER.dims,
      { x: cx - 1.6, z: cz },
      250,
      `PROPOSED ${ext.widthM.toFixed(2)} x ${ext.depthM.toFixed(2)} m  (${ext.footprintM2.toFixed(1)} m2)`,
    ),
  );

  // ── Written blocks, down the right-hand side ────────────────────
  const right = Math.max(...prepared.flatMap((e) => roomOutlineM(e)).map((p) => p.x), ...ext.outline.map((p) => p.x)) + 2;
  const top = Math.min(...prepared.flatMap((e) => roomOutlineM(e)).map((p) => p.z), ...ext.outline.map((p) => p.z));
  let y = top;
  const put = (layer: string, s: string, size = 120) => {
    out.push(text(layer, { x: right, z: y }, size, s));
    y += size / 1000 + 0.12;
  };

  put(PROP_LAYER.compliance, (input.projectName || "Proposed work").toUpperCase(), 260);
  if (input.subtitle) put(PROP_LAYER.compliance, input.subtitle, 150);
  y += 0.25;

  put(PROP_LAYER.compliance, "PLANNING ROUTE: " + routeLabel(input.report), 200);
  y += 0.15;
  for (const c of input.report.checks) {
    put(
      PROP_LAYER.compliance,
      `[${c.state.toUpperCase()}] ${c.rule}: ${c.detail}`,
    );
  }
  y += 0.4;

  if (input.beams.length) {
    put(PROP_LAYER.beams, "BEAM SCHEDULE", 200);
    for (const b of input.beams) {
      put(PROP_LAYER.beams, beamScheduleLine(b));
      put(PROP_LAYER.beams, "   carries: " + b.supports);
      /*
       * The take-down under the beam it belongs to.
       *
       * This is what the engineer's software asks for, so it goes
       * on the drawing rather than in a separate note nobody
       * carries to the desk with them. It states its own
       * assumptions, because a load computed from an assumed
       * build-up is an assumption.
       */
      const t = input.loads?.[b.ref];
      if (t) {
        for (const l of takeDownAsText(b.ref, b.spanM, t).slice(1)) {
          put(PROP_LAYER.beams, l);
        }
      }
    }
    put(
      PROP_LAYER.beams,
      "   Sections to the structural engineer's calculations. " +
        "No section on this drawing has been calculated.",
    );
    y += 0.4;
  }

  for (const g of input.notes) {
    put(PROP_LAYER.notes, g.heading.toUpperCase(), 170);
    for (const l of g.lines) put(PROP_LAYER.notes, "  " + l);
    y += 0.2;
  }

  out.push(pair(0, "ENDSEC"), pair(0, "EOF"));
  return out.join("\n") + "\n";
}

function routeLabel(r: ComplianceReport): string {
  switch (r.route) {
    case "permitted-development":
      return "PERMITTED DEVELOPMENT — all rules tested and passed";
    case "prior-approval":
      return "PRIOR APPROVAL — larger extension, neighbour consultation (42 days)";
    case "full-application":
      return "FULL PLANNING APPLICATION REQUIRED";
    default:
      return "NOT DETERMINED — one or more rules could not be tested, see below";
  }
}
