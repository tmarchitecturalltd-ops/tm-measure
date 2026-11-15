/**
 * What is sitting on the beam.
 *
 * ── The division of labour ─────────────────────────────────────────
 *
 * Charlie already has software that sizes a steel beam to Eurocode
 * and prints utilisation ratios. Rebuilding that would be a great
 * deal of work to arrive where he already is, and it would move the
 * liability for a section size onto a program nobody has signed for.
 *
 * What that software asks for, and what nobody enjoys working out,
 * is the load. A rear extension beam carries some combination of
 * roof, floor, wall and the reaction from another beam, each over a
 * tributary width that depends on which way the joists run. It is
 * half an hour of arithmetic, it is error-prone in the way that
 * arithmetic at eleven at night is error-prone, and all of the
 * numbers it needs are already on the drawing.
 *
 * So this works out the loads. The steel is sized elsewhere, by the
 * tool that does it properly, and signed by the person who is
 * responsible for it.
 *
 * ── What the numbers are ───────────────────────────────────────────
 *
 * Characteristic loads to BS EN 1991-1-1 and its UK National Annex.
 * Permanent actions are the self-weight of the construction;
 * variable actions are imposed and snow. The design value at the
 * ultimate limit state is the usual 1.35 Gk + 1.5 Qk.
 *
 * Every self-weight figure below is a *typical* construction. They
 * are the ones that recur on Charlie's drawings, they are stated
 * rather than hidden, and every one can be overridden. A beam whose
 * load was computed from an assumed build-up is a beam whose load
 * is an assumption -- which is why the output names each figure it
 * used.
 */

/** Permanent actions, kN/m² on plan unless stated. */
export const SELF_WEIGHT = {
  /** Warm flat roof: joists, deck, insulation, three-layer felt, board. */
  flatRoof: 0.6,
  /** Tiled pitched roof including ceiling, measured on plan. */
  pitchedRoofTiled: 1.0,
  /** Slated pitched roof including ceiling, on plan. */
  pitchedRoofSlate: 0.85,
  /** Domestic timber floor: joists, boards, ceiling. */
  timberFloor: 0.5,
  /** Lightweight partition allowance, UK NA to BS EN 1991-1-1. */
  partitionAllowance: 0.5,
  /** Walls, kN/m² of wall area. */
  wall: {
    /** 100 brick + 100 lightweight block, insulated, plastered. */
    cavity: 4.0,
    /** 215 solid brick, plastered one side. */
    solidBrick215: 4.6,
    /** 100 dense block, plastered. */
    block100: 2.4,
    /** Timber stud, plasterboard both sides. */
    timberStud: 0.5,
  },
} as const;

/** Variable actions, kN/m². */
export const IMPOSED = {
  /** Category A domestic floor, UK NA. */
  domesticFloor: 1.5,
  /** Flat roof, no access except for maintenance and repair. */
  roofMaintenance: 0.6,
  /**
   * Snow, ground load. Varies by location and altitude -- 0.6 is a
   * fair figure for most of lowland England and is wrong for a site
   * at height, which is why it is an input rather than a constant
   * the caller cannot see.
   */
  snowTypical: 0.6,
} as const;

export const PARTIAL = { permanent: 1.35, variable: 1.5 } as const;

export type Supported =
  | {
      kind: "flat-roof";
      /** Clear span of the joists bearing on this beam, metres. */
      spanM: number;
      /** Both sides, when the beam is in the middle of the roof. */
      bothSides?: boolean;
      snowKNm2?: number;
      selfWeightKNm2?: number;
    }
  | {
      kind: "pitched-roof";
      spanM: number;
      bothSides?: boolean;
      covering?: "tile" | "slate";
      snowKNm2?: number;
      selfWeightKNm2?: number;
    }
  | {
      kind: "floor";
      spanM: number;
      bothSides?: boolean;
      /** Lightweight partitions on the floor above. */
      partitions?: boolean;
      selfWeightKNm2?: number;
      imposedKNm2?: number;
    }
  | {
      kind: "wall";
      heightM: number;
      construction?: keyof typeof SELF_WEIGHT.wall;
      /** Proportion of the wall that is window or door. 0 to 0.9. */
      openingsFraction?: number;
      selfWeightKNm2?: number;
    }
  | {
      kind: "point";
      label: string;
      /** Characteristic values in kN, as reactions from another beam. */
      gkKN: number;
      qkKN: number;
      /** Metres from the left-hand bearing. */
      atM: number;
    };

export type LoadLine = {
  description: string;
  /** kN/m for distributed, kN for point. */
  gk: number;
  qk: number;
  point: boolean;
};

export type LoadTakeDown = {
  lines: LoadLine[];
  /** Characteristic distributed loads, kN/m. */
  gkPerM: number;
  qkPerM: number;
  /** Design distributed load at ULS, kN/m. */
  udlULS: number;
  /** Point loads, characteristic and design. */
  points: { label: string; gkKN: number; qkKN: number; ulsKN: number; atM: number }[];
  /** Reactions at each bearing, kN. */
  reactions: { leftULS: number; rightULS: number; leftSLS: number; rightSLS: number };
  /** Every assumption, in the order it was applied. */
  assumptions: string[];
};

/**
 * Tributary width.
 *
 * A beam carries half of what spans onto it from each side -- the
 * other half goes to the wall at the far end. A beam in the middle
 * of a roof gets half from both sides; one at the edge gets half
 * from one. Getting this wrong by a factor of two is the single
 * commonest error in a hand take-down, which is the argument for
 * not doing it by hand.
 */
function tributary(spanM: number, bothSides?: boolean): number {
  return bothSides ? spanM : spanM / 2;
}

/**
 * The loads on one beam, characteristic and design.
 *
 * `spanM` is the beam's own clear span, used only for the
 * reactions.
 */
export function takeDown(
  spanM: number,
  supported: Supported[],
  opts: { beamSelfWeightKNm?: number } = {},
): LoadTakeDown {
  const lines: LoadLine[] = [];
  const assumptions: string[] = [];
  const points: LoadTakeDown["points"] = [];

  /*
   * The beam's own weight.
   *
   * Small -- a 203 UB is about 0.25 kN/m -- and routinely left out
   * of a hand take-down, which is fine until it is not. Included by
   * default at a figure that suits the sections these spans
   * produce, and overridable once the real section is known.
   */
  const ownWeight = opts.beamSelfWeightKNm ?? 0.3;
  lines.push({
    description: `Beam self-weight (assumed ${ownWeight.toFixed(2)} kN/m until the section is known)`,
    gk: ownWeight,
    qk: 0,
    point: false,
  });

  for (const s of supported) {
    switch (s.kind) {
      case "flat-roof": {
        const w = tributary(s.spanM, s.bothSides);
        const sw = s.selfWeightKNm2 ?? SELF_WEIGHT.flatRoof;
        const snow = s.snowKNm2 ?? IMPOSED.snowTypical;
        const imposed = Math.max(snow, IMPOSED.roofMaintenance);
        lines.push({
          description:
            `Flat roof, ${s.spanM.toFixed(2)} m span ${s.bothSides ? "both sides" : "one side"} ` +
            `(${w.toFixed(2)} m load width)`,
          gk: sw * w,
          qk: imposed * w,
          point: false,
        });
        assumptions.push(
          `Flat roof self-weight ${sw} kN/m²; imposed ${imposed} kN/m² ` +
            `(the greater of snow ${snow} and maintenance ${IMPOSED.roofMaintenance}).`,
        );
        break;
      }
      case "pitched-roof": {
        const w = tributary(s.spanM, s.bothSides);
        const sw =
          s.selfWeightKNm2 ??
          (s.covering === "slate"
            ? SELF_WEIGHT.pitchedRoofSlate
            : SELF_WEIGHT.pitchedRoofTiled);
        const snow = s.snowKNm2 ?? IMPOSED.snowTypical;
        const imposed = Math.max(snow, IMPOSED.roofMaintenance);
        lines.push({
          description:
            `Pitched roof (${s.covering ?? "tile"}), ${s.spanM.toFixed(2)} m span ` +
            `${s.bothSides ? "both sides" : "one side"} (${w.toFixed(2)} m load width)`,
          gk: sw * w,
          qk: imposed * w,
          point: false,
        });
        assumptions.push(
          `Pitched roof self-weight ${sw} kN/m² measured on plan, including ceiling.`,
        );
        break;
      }
      case "floor": {
        const w = tributary(s.spanM, s.bothSides);
        const sw = s.selfWeightKNm2 ?? SELF_WEIGHT.timberFloor;
        const partition = s.partitions ? SELF_WEIGHT.partitionAllowance : 0;
        const imposed = s.imposedKNm2 ?? IMPOSED.domesticFloor;
        lines.push({
          description:
            `Floor over, ${s.spanM.toFixed(2)} m span ${s.bothSides ? "both sides" : "one side"} ` +
            `(${w.toFixed(2)} m load width)` +
            (s.partitions ? ", including partition allowance" : ""),
          gk: (sw + partition) * w,
          qk: imposed * w,
          point: false,
        });
        assumptions.push(
          `Floor self-weight ${sw} kN/m²` +
            (s.partitions
              ? ` plus ${SELF_WEIGHT.partitionAllowance} kN/m² for lightweight partitions`
              : "") +
            `; imposed ${imposed} kN/m² (Category A domestic).`,
        );
        break;
      }
      case "wall": {
        const sw = s.selfWeightKNm2 ?? SELF_WEIGHT.wall[s.construction ?? "cavity"];
        const solid = 1 - Math.min(Math.max(s.openingsFraction ?? 0, 0), 0.9);
        lines.push({
          description:
            `Wall over, ${s.heightM.toFixed(2)} m high` +
            (solid < 1 ? `, ${Math.round((1 - solid) * 100)}% openings` : ""),
          gk: sw * s.heightM * solid,
          qk: 0,
          point: false,
        });
        assumptions.push(
          `Wall self-weight ${sw} kN/m² of wall area (${s.construction ?? "cavity"}).`,
        );
        break;
      }
      case "point": {
        const uls =
          PARTIAL.permanent * s.gkKN + PARTIAL.variable * s.qkKN;
        points.push({
          label: s.label,
          gkKN: s.gkKN,
          qkKN: s.qkKN,
          ulsKN: uls,
          atM: s.atM,
        });
        lines.push({
          description: `${s.label} at ${s.atM.toFixed(2)} m from the left bearing`,
          gk: s.gkKN,
          qk: s.qkKN,
          point: true,
        });
        break;
      }
    }
  }

  const gkPerM = lines.filter((l) => !l.point).reduce((s, l) => s + l.gk, 0);
  const qkPerM = lines.filter((l) => !l.point).reduce((s, l) => s + l.qk, 0);
  const udlULS = PARTIAL.permanent * gkPerM + PARTIAL.variable * qkPerM;

  /*
   * Reactions.
   *
   * Simply supported, which is what a beam over an opening is. A
   * point load divides between the bearings in proportion to how
   * far it sits from each -- a continuous beam, or one with a
   * cantilever, is a different calculation and this does not
   * pretend to do it.
   */
  let leftULS = (udlULS * spanM) / 2;
  let rightULS = (udlULS * spanM) / 2;
  let leftSLS = ((gkPerM + qkPerM) * spanM) / 2;
  let rightSLS = ((gkPerM + qkPerM) * spanM) / 2;
  for (const p of points) {
    const fromRight = spanM > 0 ? (spanM - p.atM) / spanM : 0.5;
    const fromLeft = 1 - fromRight;
    leftULS += p.ulsKN * fromRight;
    rightULS += p.ulsKN * fromLeft;
    const sls = p.gkKN + p.qkKN;
    leftSLS += sls * fromRight;
    rightSLS += sls * fromLeft;
  }

  assumptions.push(
    `Design values at ULS: ${PARTIAL.permanent} × permanent + ${PARTIAL.variable} × variable.`,
    "Simply supported, uniformly distributed unless a point load is listed.",
    "Characteristic loads only. The section is sized, and this take-down checked, by the structural engineer.",
  );

  return {
    lines,
    gkPerM: Number(gkPerM.toFixed(3)),
    qkPerM: Number(qkPerM.toFixed(3)),
    udlULS: Number(udlULS.toFixed(3)),
    points,
    reactions: {
      leftULS: Number(leftULS.toFixed(2)),
      rightULS: Number(rightULS.toFixed(2)),
      leftSLS: Number(leftSLS.toFixed(2)),
      rightSLS: Number(rightSLS.toFixed(2)),
    },
    assumptions,
  };
}

/** The take-down as lines for a drawing or a schedule. */
export function takeDownAsText(ref: string, spanM: number, t: LoadTakeDown): string[] {
  const out: string[] = [];
  out.push(`${ref} — load take-down — ${spanM.toFixed(2)} m clear span`);
  for (const l of t.lines) {
    out.push(
      `   ${l.description}: Gk ${l.gk.toFixed(2)} ${l.point ? "kN" : "kN/m"}` +
        (l.qk ? `, Qk ${l.qk.toFixed(2)} ${l.point ? "kN" : "kN/m"}` : ""),
    );
  }
  out.push(
    `   Totals: Gk ${t.gkPerM.toFixed(2)} kN/m, Qk ${t.qkPerM.toFixed(2)} kN/m` +
      ` → design UDL ${t.udlULS.toFixed(2)} kN/m at ULS`,
  );
  for (const p of t.points) {
    out.push(
      `   ${p.label}: Gk ${p.gkKN.toFixed(2)} kN, Qk ${p.qkKN.toFixed(2)} kN` +
        ` → ${p.ulsKN.toFixed(2)} kN at ULS, ${p.atM.toFixed(2)} m from the left bearing`,
    );
  }
  out.push(
    `   Reactions at ULS: ${t.reactions.leftULS.toFixed(2)} kN left, ` +
      `${t.reactions.rightULS.toFixed(2)} kN right`,
  );
  out.push("   Assumptions:");
  for (const a of t.assumptions) out.push(`     ${a}`);
  return out;
}
