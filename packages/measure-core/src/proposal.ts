/**
 * Proposed work: the rules, and the envelope they allow.
 *
 * ── What this is for ───────────────────────────────────────────────
 *
 * Charlie draws the same single-storey rear extension many times a
 * year. The parts that repeat exactly are the permitted development
 * arithmetic, the envelope projected off the rear wall, and several
 * hundred words of Building Regulations notes. None of those is
 * design; all of them take time and all of them are easy to get
 * subtly wrong at eleven at night.
 *
 * So this works out what the rules allow and where the envelope
 * goes. It does not decide where the kitchen is, whether the light
 * works, or whether the thing will be approved. Those are the job.
 *
 * ── The three states ───────────────────────────────────────────────
 *
 * Every check returns `pass`, `breach` or `unverified`, and there is
 * deliberately no fourth. A rule that cannot be tested — because
 * nobody entered the garden depth, or because the house is listed
 * and the question does not apply — says so by name. The failure
 * this is written against is a report that reads as compliant
 * because a field was blank.
 */

/** How the house is attached. Decides the projection allowance. */
export type HouseForm =
  | "detached"
  | "semi"
  | "mid-terrace"
  | "end-terrace"
  | "bungalow"
  | "flat"
  | "maisonette";

export type ExistingExtension =
  | "none"
  | "single-storey-rear"
  | "side-return"
  | "wraparound"
  | "two-storey-rear"
  | "conservatory";

export type Designation =
  | "conservation-area"
  | "listed"
  | "article-4"
  | "national-park"
  | "aonb"
  | "green-belt"
  | "pd-removed-by-condition";

export type HouseLog = {
  form: HouseForm;
  /** Era label, for the notes and the drawing title only. */
  era?: string;
  bedrooms?: number;
  /** What is already built, cumulative under PD. See the rear rule. */
  existing: ExistingExtension[];
  /** Depth of any existing rear extension, metres. */
  existingRearDepthM?: number;
  designations: Designation[];
  /** Rear wall to the rear boundary, metres. */
  rearBoundaryM?: number;
  /** Nearest flank wall to that side boundary, metres. */
  sideBoundaryM?: number;
  /** Whole plot, for the 50% rule. Optional, and its absence shows. */
  plotAreaM2?: number;
  /** Footprint of the house as built, for the same rule. */
  existingFootprintM2?: number;
};

export type RoofForm = "flat" | "flat-lantern" | "mono-pitch" | "gable" | "hipped";

export type Brief = {
  depthM: number;
  /** Across the back: the whole wall, or part of it. */
  width: "full" | "part";
  widthM?: number;
  roof: RoofForm;
  /** Height to the top of the roof, metres above the existing floor. */
  heightM: number;
  eavesHeightM: number;
  rearGlazing: "bifold" | "sliding" | "french" | "picture-window";
  rearGlazingWidthM?: number;
  rooflights?: number;
  notes?: string;
};

export type CheckState = "pass" | "breach" | "unverified";

export type Check = {
  id: string;
  rule: string;
  state: CheckState;
  /** What it was tested against, or what is missing. */
  detail: string;
};

/**
 * Permitted development limits for a single-storey rear extension,
 * England, Class A. Metres.
 *
 * The larger figures are the prior approval route -- still permitted
 * development, but only after the neighbour consultation scheme, so
 * they are reported as a separate outcome rather than as a pass.
 */
export const PD = {
  rearDepthAttached: 3,
  rearDepthDetached: 4,
  rearDepthAttachedLarger: 6,
  rearDepthDetachedLarger: 8,
  maxHeight: 4,
  maxEaves: 3,
  maxEavesNearBoundary: 3,
  boundaryProximity: 2,
  maxCurtilageCovered: 0.5,
};

function detachedLike(form: HouseForm): boolean {
  return form === "detached" || form === "bungalow";
}

/**
 * Does the house have permitted development rights at all?
 *
 * Returned as its own check because when the answer is no, every
 * other check below is beside the point -- and reporting "depth
 * passes" on a listed building would be worse than reporting
 * nothing.
 */
export function pdRightsCheck(log: HouseLog): Check {
  if (log.form === "flat" || log.form === "maisonette") {
    return {
      id: "pd-rights",
      rule: "Permitted development rights",
      state: "breach",
      detail:
        "Flats and maisonettes have no permitted development rights. " +
        "A full planning application is required.",
    };
  }
  const blocking: Designation[] = [
    "listed",
    "article-4",
    "pd-removed-by-condition",
  ];
  const hit = log.designations.filter((d) => blocking.includes(d));
  if (hit.length) {
    return {
      id: "pd-rights",
      rule: "Permitted development rights",
      state: "breach",
      detail:
        "Rights are removed or restricted: " +
        hit.join(", ") +
        ". A full application is required, and listed building consent " +
        "where applicable.",
    };
  }
  const caution: Designation[] = [
    "conservation-area",
    "national-park",
    "aonb",
    "green-belt",
  ];
  const soft = log.designations.filter((d) => caution.includes(d));
  if (soft.length) {
    return {
      id: "pd-rights",
      rule: "Permitted development rights",
      state: "unverified",
      detail:
        "Designated land (" +
        soft.join(", ") +
        "). Rear extensions can still be permitted development, but side " +
        "extensions and cladding are not, and the larger-extension route " +
        "is unavailable. Confirm against the local authority.",
    };
  }
  return {
    id: "pd-rights",
    rule: "Permitted development rights",
    state: "pass",
    detail: "No designation recorded that removes rights.",
  };
}

/**
 * Depth, including anything already built.
 *
 * The allowance is for the whole rear projection, not for this
 * extension on its own, and that is the error this check exists to
 * catch: a house with a 3 m extension already on it has no rear
 * allowance left, and a drawing that claims otherwise is found out
 * at the council rather than at the desk.
 */
export function depthCheck(log: HouseLog, brief: Brief): Check {
  const limit = detachedLike(log.form)
    ? PD.rearDepthDetached
    : PD.rearDepthAttached;
  const larger = detachedLike(log.form)
    ? PD.rearDepthDetachedLarger
    : PD.rearDepthAttachedLarger;

  const built = log.existing.some((e) =>
    ["single-storey-rear", "wraparound", "two-storey-rear"].includes(e),
  );
  if (built && log.existingRearDepthM === undefined) {
    return {
      id: "depth",
      rule: "Rear projection depth",
      state: "unverified",
      detail:
        "The house already has a rear extension and its depth was not " +
        "recorded. The allowance is cumulative, so the total cannot be " +
        "tested. Enter the existing depth.",
    };
  }

  const total = brief.depthM + (log.existingRearDepthM ?? 0);
  const cumulative =
    log.existingRearDepthM && log.existingRearDepthM > 0
      ? ` (${brief.depthM} m new plus ${log.existingRearDepthM} m existing)`
      : "";

  if (total <= limit) {
    return {
      id: "depth",
      rule: "Rear projection depth",
      state: "pass",
      detail:
        `${total.toFixed(2)} m total against a ${limit} m limit for a ` +
        `${log.form} house${cumulative}.`,
    };
  }
  if (total <= larger) {
    return {
      id: "depth",
      rule: "Rear projection depth",
      state: "breach",
      detail:
        `${total.toFixed(2)} m exceeds the ${limit} m limit but is within ` +
        `the ${larger} m larger-extension allowance. Permitted development ` +
        "via prior approval and the neighbour consultation scheme, which " +
        "takes 42 days and is not available on designated land.",
    };
  }
  return {
    id: "depth",
    rule: "Rear projection depth",
    state: "breach",
    detail:
      `${total.toFixed(2)} m exceeds even the ${larger} m larger-extension ` +
      "allowance. A full planning application is required.",
  };
}

/** Overall height and eaves, including the boundary case. */
export function heightChecks(log: HouseLog, brief: Brief): Check[] {
  const out: Check[] = [];

  out.push(
    brief.heightM <= PD.maxHeight
      ? {
          id: "height",
          rule: "Overall height",
          state: "pass",
          detail: `${brief.heightM.toFixed(2)} m against a ${PD.maxHeight} m limit.`,
        }
      : {
          id: "height",
          rule: "Overall height",
          state: "breach",
          detail:
            `${brief.heightM.toFixed(2)} m exceeds the ${PD.maxHeight} m ` +
            "limit for a single-storey rear extension.",
        },
  );

  out.push(
    brief.eavesHeightM <= PD.maxEaves
      ? {
          id: "eaves",
          rule: "Eaves height",
          state: "pass",
          detail: `${brief.eavesHeightM.toFixed(2)} m against a ${PD.maxEaves} m limit.`,
        }
      : {
          id: "eaves",
          rule: "Eaves height",
          state: "breach",
          detail: `${brief.eavesHeightM.toFixed(2)} m exceeds the ${PD.maxEaves} m limit.`,
        },
  );

  /*
   * The boundary case.
   *
   * Within 2 m of a boundary the eaves may not exceed 3 m -- the same
   * figure as the general limit, which makes it look redundant and is
   * exactly why it gets missed: on a sloping site or with a raised
   * floor the eaves creep over 3 m, and next to a boundary that is
   * the rule that bites.
   */
  if (log.sideBoundaryM === undefined) {
    out.push({
      id: "eaves-boundary",
      rule: "Eaves height within 2 m of a boundary",
      state: "unverified",
      detail:
        "Distance to the side boundary was not recorded, so this rule " +
        "cannot be tested. Enter the flank wall to boundary distance.",
    });
  } else if (log.sideBoundaryM < PD.boundaryProximity) {
    out.push(
      brief.eavesHeightM <= PD.maxEavesNearBoundary
        ? {
            id: "eaves-boundary",
            rule: "Eaves height within 2 m of a boundary",
            state: "pass",
            detail:
              `${log.sideBoundaryM.toFixed(2)} m from the boundary, eaves ` +
              `${brief.eavesHeightM.toFixed(2)} m against a ${PD.maxEavesNearBoundary} m limit.`,
          }
        : {
            id: "eaves-boundary",
            rule: "Eaves height within 2 m of a boundary",
            state: "breach",
            detail:
              `${log.sideBoundaryM.toFixed(2)} m from the boundary, so the ` +
              `eaves may not exceed ${PD.maxEavesNearBoundary} m. ` +
              `${brief.eavesHeightM.toFixed(2)} m proposed.`,
          },
    );
  } else {
    out.push({
      id: "eaves-boundary",
      rule: "Eaves height within 2 m of a boundary",
      state: "pass",
      detail:
        `${log.sideBoundaryM.toFixed(2)} m from the boundary, so the 2 m ` +
        "rule does not apply.",
    });
  }

  return out;
}

/** Does the extension fit in the garden at all, and the 50% rule. */
export function plotChecks(log: HouseLog, brief: Brief): Check[] {
  const out: Check[] = [];

  if (log.rearBoundaryM === undefined) {
    out.push({
      id: "garden",
      rule: "Space to the rear boundary",
      state: "unverified",
      detail:
        "Distance to the rear boundary was not recorded. Enter it to " +
        "confirm the extension fits and to see what garden is left.",
    });
  } else {
    const left = log.rearBoundaryM - brief.depthM;
    out.push(
      left > 0
        ? {
            id: "garden",
            rule: "Space to the rear boundary",
            state: left >= 3 ? "pass" : "breach",
            detail:
              `${left.toFixed(2)} m of garden remains. ` +
              (left >= 3
                ? "No rule sets a minimum, but under 3 m is usually resisted."
                : "Under 3 m. Not a permitted development rule, but councils " +
                  "commonly resist it and it is worth raising with the client."),
          }
        : {
            id: "garden",
            rule: "Space to the rear boundary",
            state: "breach",
            detail:
              `The extension is ${brief.depthM.toFixed(2)} m deep and the ` +
              `boundary is ${log.rearBoundaryM.toFixed(2)} m away. It does ` +
              "not fit.",
          },
    );
  }

  if (log.plotAreaM2 === undefined || log.existingFootprintM2 === undefined) {
    out.push({
      id: "curtilage",
      rule: "50% of the curtilage",
      state: "unverified",
      detail:
        "Plot area or existing footprint was not recorded, so the 50% " +
        "rule cannot be tested. Outbuildings and previous extensions all " +
        "count toward it.",
    });
  } else {
    const added = brief.depthM * (brief.widthM ?? 0);
    const covered = (log.existingFootprintM2 + added) / log.plotAreaM2;
    out.push(
      covered <= PD.maxCurtilageCovered
        ? {
            id: "curtilage",
            rule: "50% of the curtilage",
            state: "pass",
            detail: `${(covered * 100).toFixed(0)}% covered after the work.`,
          }
        : {
            id: "curtilage",
            rule: "50% of the curtilage",
            state: "breach",
            detail:
              `${(covered * 100).toFixed(0)}% of the curtilage would be ` +
              "covered. The limit is 50%.",
          },
    );
  }

  return out;
}

export type ComplianceReport = {
  checks: Check[];
  /** The worst state present, which is what the drawing is headed with. */
  overall: CheckState;
  route: "permitted-development" | "prior-approval" | "full-application" | "unknown";
};

/**
 * Every check, and what route the work is on.
 *
 * `unknown` when anything is unverified, never an optimistic guess:
 * the report exists so that Charlie knows what he still has to
 * check, and a route stated confidently from incomplete inputs
 * would be the one thing worse than no report.
 */
export function assessRearExtension(
  log: HouseLog,
  brief: Brief,
): ComplianceReport {
  const checks: Check[] = [
    pdRightsCheck(log),
    depthCheck(log, brief),
    ...heightChecks(log, brief),
    ...plotChecks(log, brief),
  ];

  const anyBreach = checks.some((c) => c.state === "breach");
  const anyUnverified = checks.some((c) => c.state === "unverified");
  const overall: CheckState = anyBreach
    ? "breach"
    : anyUnverified
      ? "unverified"
      : "pass";

  let route: ComplianceReport["route"] = "unknown";
  if (!anyUnverified) {
    if (!anyBreach) {
      route = "permitted-development";
    } else {
      const depth = checks.find((c) => c.id === "depth");
      const onlyDepthAndLarger =
        checks.filter((c) => c.state === "breach").length === 1 &&
        depth?.state === "breach" &&
        depth.detail.includes("larger-extension allowance. Permitted");
      route = onlyDepthAndLarger ? "prior-approval" : "full-application";
    }
  }

  return { checks, overall, route };
}
