/**
 * The standard notes, as data.
 *
 * ── Why these are here ─────────────────────────────────────────────
 *
 * Every one of Charlie's drawings carries several hundred words of
 * the same Building Regulations notes: Part H for the drainage, Part
 * G for the hot water, Part F for the ventilation, Part Q for the
 * windows, plus strapping, lintels, trickle vents and lead flashing.
 * They are retyped or copied drawing to drawing, which is how a
 * clause ends up on a job it does not apply to, and how one drawing
 * ends up with last year's wording.
 *
 * Held here they are written once, reviewed once, and selected by
 * what the job actually contains.
 *
 * ── What these are not ─────────────────────────────────────────────
 *
 * They are standard clauses, not a specification. Nothing here is
 * calculated: no joist sizes, no steel sections, no spans. Those
 * come from Charlie's structural calculations and are pasted onto
 * the drawing as they are now. A note that looks like a calculation
 * is the one thing that must never appear in this file.
 *
 * Wording follows the current Approved Documents. When a document is
 * revised these need revising with it -- which is the argument for
 * them being in one file rather than in forty drawings.
 */

export type NoteGroup = {
  id: string;
  heading: string;
  /** Shown only when the job has this. See selectNotes. */
  appliesWhen?: (job: NoteContext) => boolean;
  lines: string[];
};

export type NoteContext = {
  hasNewDrainage: boolean;
  hasNewBathroom: boolean;
  hasNewKitchen: boolean;
  hasNewWindows: boolean;
  hasFlatRoof: boolean;
  hasPitchedRoof: boolean;
  hasSteel: boolean;
  hasRooflights: boolean;
  isExtension: boolean;
  isLoft: boolean;
};

export const NOTE_GROUPS: NoteGroup[] = [
  {
    id: "general",
    heading: "General",
    lines: [
      "All work to comply with the current Building Regulations and " +
        "relevant British Standards.",
      "All dimensions to be checked on site before any work begins or " +
        "materials are ordered. Do not scale from this drawing.",
      "Although every effort has been made to ensure the accuracy of " +
        "these plans, the measurements are not guaranteed. One should " +
        "retake measurements again. The plans have been drawn as per " +
        "what was visible upon a site visit. The integrity of load " +
        "bearings should be checked.",
      "Any discrepancy between this drawing and the structural " +
        "engineer's calculations is to be reported before work proceeds.",
    ],
  },
  {
    id: "part-a",
    heading: "Part A — Structure",
    appliesWhen: (j) => j.hasSteel || j.isExtension,
    lines: [
      "All structural steelwork to the structural engineer's " +
        "calculations and details. Sections shown on this drawing are " +
        "indicative only until those calculations are issued.",
      "Steel beams to be supported on padstones or piers of Class B " +
        "engineering brick as specified by the engineer.",
      "Returns should be greater than 600 mm for buttressing. Walls to " +
        "be strapped to the steels.",
      "Lateral restraint straps at least 1.2 m long to be fixed between " +
        "roof members running parallel to walls at no greater than 2.0 m " +
        "centres. Noggins to be placed between the roof members at " +
        "lateral restraint strap locations; straps to be fixed across at " +
        "least three joists or rafters.",
      "Wall plates to be strapped down with steel restraint straps at " +
        "least 1.2 m long at no more than 2.0 m centres.",
      "Cavity wall lintels to all new openings, with a minimum 150 mm " +
        "end bearing each side.",
    ],
  },
  {
    id: "part-c",
    heading: "Part C — Damp and ground conditions",
    appliesWhen: (j) => j.isExtension,
    lines: [
      "DPC to be a minimum 150 mm above finished external ground level " +
        "and lapped with the DPM.",
      "DPM beneath the floor slab to be lapped and sealed to the DPC at " +
        "all perimeters.",
      "Cavity trays and weep holes over all openings and at all " +
        "abutments.",
      "Foundations to be taken down to a depth agreed with Building " +
        "Control on site, and to the engineer's design where adjacent " +
        "to drains or trees.",
    ],
  },
  {
    id: "part-f",
    heading: "Part F — Ventilation",
    appliesWhen: (j) => j.hasNewWindows || j.hasNewBathroom || j.hasNewKitchen,
    lines: [
      "Background ventilation to provide a minimum of 8,000 mm² " +
        "equivalent area to habitable rooms and 4,000 mm² to wet rooms, " +
        "via trickle vents in the new windows and doors.",
      "Intermittent extract rates: 30 l/s to kitchens over a hob, or " +
        "60 l/s elsewhere in a kitchen; 15 l/s to bathrooms, utility " +
        "rooms and ensuites.",
      "Extract fans serving rooms without an openable window to be " +
        "wired in tandem with the lighting circuit and provided with a " +
        "minimum 15 minute overrun timer.",
      "To provide adequate makeup air, internal doors to wet rooms to " +
        "have a minimum 10 mm undercut above the finished floor level.",
    ],
  },
  {
    id: "part-g",
    heading: "Part G — Sanitation and hot water safety",
    appliesWhen: (j) => j.hasNewBathroom || j.hasNewKitchen,
    lines: [
      "Hot water supply to new washbasins and showers to be limited to " +
        "a maximum of 48°C by thermostatic mixing valves complying with " +
        "BS EN 1111 or BS EN 1287, to prevent scalding.",
      "In accordance with Regulation 36, potential water consumption " +
        "must not exceed 125 litres per person per day. Fittings to be " +
        "low-flow: dual flush WCs at 6/4 or 4/2.6 litres, showers at a " +
        "maximum 10 l/min, washbasin taps at a maximum 5 l/min.",
      "All hot and cold distribution pipework to be insulated within " +
        "floor voids and service ducts in accordance with the Domestic " +
        "Building Services Compliance Guide.",
    ],
  },
  {
    id: "part-h",
    heading: "Part H — Drainage and waste disposal",
    appliesWhen: (j) => j.hasNewDrainage || j.hasNewBathroom || j.hasNewKitchen,
    lines: [
      "Soil and vent pipe: new WCs to connect via a minimum 100 mm " +
        "internal diameter soil pipe laid at a minimum gradient of " +
        "1:40, to the existing SVP or a new internal stub stack with an " +
        "air admittance valve complying with BS EN 12380.",
      "Waste pipe sizes and gradients: WCs 100 mm, maximum run 6.0 m. " +
        "Showers and basins 40/50 mm laid at a minimum gradient of " +
        "1:30, maximum 3.0 m for 40 mm and 4.0 m for 50 mm unvented.",
      "All appliances to be fitted with 75 mm deep seal anti-siphonage " +
        "traps.",
      "Underground pipes to be bedded on pea shingle surrounding the " +
        "pipe, laid at between 1:80 and 1:40, with correct bedding " +
        "100 mm below the pipe in accordance with Approved Document H " +
        "H1 2.4 and BS EN 1610 Annex B Table B15.",
      "Where a new waste run passes beneath a new wall, a concrete " +
        "lintel is to be provided over.",
      "All new drainage to be air-tested in accordance with BS EN 12056 " +
        "to the satisfaction of the Building Control Officer before " +
        "covering over.",
      "Rainwater to be taken to a soakaway a minimum of 5 m from the " +
        "building, or connected to the existing surface water system " +
        "where one is available.",
    ],
  },
  {
    id: "part-j",
    heading: "Part J — Combustion appliances",
    appliesWhen: (j) => j.isExtension,
    lines: [
      "Where an existing flue or chimney is affected by the works, it " +
        "is to be checked and, where retained, swept and tested before " +
        "the work is completed.",
      "Chimneys should be checked for additional loadings.",
    ],
  },
  {
    id: "part-l",
    heading: "Part L — Conservation of fuel and power",
    lines: [
      "New windows and doors to achieve a maximum U-value of 1.4 W/m²K.",
      "New rooflights to achieve a maximum U-value of 2.2 W/m²K.",
      "New external walls to achieve a maximum U-value of 0.18 W/m²K.",
      "New flat roofs to achieve a maximum U-value of 0.15 W/m²K, " +
        "pitched roofs 0.15 W/m²K at ceiling level.",
      "New ground floors to achieve a maximum U-value of 0.18 W/m²K.",
      "All new fixed lighting to be low energy.",
    ],
  },
  {
    id: "part-q",
    heading: "Part Q — Security",
    appliesWhen: (j) => j.hasNewWindows,
    lines: [
      "New windows and doors to comply with Approved Document Q and to " +
        "be certified to PAS 24:2016 where they are easily accessible.",
      "Trickle vents to windows and doors to provide 10,000 mm² " +
        "ventilation and are not to compromise the Part Q rating.",
    ],
  },
  {
    id: "part-b",
    heading: "Part B — Fire safety",
    lines: [
      "Mains-powered interlinked smoke alarms to BS 5839-6 at least " +
        "Grade D2 Category LD3, with a heat alarm to the kitchen.",
      "Where any new waste or soil pipe penetrates a fire-separating " +
        "floor, ceiling or wall, it is to be fully sealed with a " +
        "proprietary intumescent fire collar or fire-stopping wrap " +
        "tested to BS 476-20 to maintain structural fire integrity.",
      "Escape windows to habitable rooms to have a minimum clear " +
        "openable area of 0.33 m², a minimum 450 mm clear height and " +
        "width, and a cill no more than 1100 mm above floor level.",
    ],
  },
  {
    id: "flat-roof",
    heading: "Flat roof construction",
    appliesWhen: (j) => j.hasFlatRoof,
    lines: [
      "Warm roof construction: insulation laid over the deck, with the " +
        "vapour control layer beneath it.",
      "Flat roof to be covered with a triple layer felt system or " +
        "single ply membrane to the manufacturer's details, laid to a " +
        "minimum fall of 1:80.",
      "Code 4 lead flashing where the new roof meets the existing " +
        "wall, dressed a minimum 150 mm up and chased into the " +
        "brickwork.",
      "Firrings to be laid to achieve the fall; no ponding permitted.",
    ],
  },
  {
    id: "pitched-roof",
    heading: "Pitched roof construction",
    appliesWhen: (j) => j.hasPitchedRoof,
    lines: [
      "Cold roof: a minimum 50 mm continuous air gap above the " +
        "insulation and beneath the underside of the felt, with 5 mm " +
        "continuous ridge ventilation.",
      "Roof covering to match the existing as closely as possible in " +
        "colour, size and texture.",
      "Code 4 lead flashing or similar at the junction between the new " +
        "roof and the original house, and to all abutments.",
    ],
  },
  {
    id: "rooflights",
    heading: "Rooflights",
    appliesWhen: (j) => j.hasRooflights,
    lines: [
      "Rooflights to be double glazed and fitted with double trimmers " +
        "to the structural engineer's details.",
      "Code 4 lead flashing to the surrounds of all rooflights and to " +
        "all joints between the rooflight and the roof covering.",
    ],
  },
  {
    id: "radiators",
    heading: "Heating",
    appliesWhen: (j) => j.isExtension,
    lines: [
      "TRVs to be fitted to all radiators.",
      "Any radiator removed or relocated to be allowed for in the " +
        "heating system balance.",
    ],
  },
];

/**
 * The notes this job needs, and only those.
 *
 * A clause on a drawing it does not apply to is not harmless. It
 * gets read, priced, and occasionally built -- and it teaches whoever
 * reads the next drawing that the notes are boilerplate to be
 * skipped, which is the worse outcome.
 */
export function selectNotes(job: NoteContext): NoteGroup[] {
  return NOTE_GROUPS.filter((g) => !g.appliesWhen || g.appliesWhen(job));
}

/** A plain-text block, for the drawing or the email. */
export function notesAsText(groups: NoteGroup[]): string {
  return groups
    .map((g) => g.heading + "\n" + g.lines.map((l) => "  " + l).join("\n"))
    .join("\n\n");
}
