/**
 * Room connectivity graph — add to packages/measure-core/src/connectivity.ts.
 * Re-export from index.ts:
 *   export * from "./connectivity";
 *
 * Why this exists
 * ──────────────────────────────────────────────────────────────────────
 * Individual room dimensions alone aren't enough to design an extension.
 * The architect also needs to know HOW the rooms fit together — which
 * rooms share a doorway, which share a wall, which are open-plan, etc.
 * Without that graph, laying out the ground floor plan is guesswork.
 *
 * The customer-facing form captures the minimum useful relationship:
 *   "Room A and Room B are connected by a door / opening / shared wall."
 * More precise wall-offset data can be added later, but this gets us to
 * a real adjacency graph immediately.
 */

/**
 * The kind of link between two rooms.
 *   door         — there is a doorway (typically with a door leaf)
 *   opening      — cased opening / archway (no door leaf)
 *   shared-wall  — rooms share an internal wall but no opening
 *   stairs       — vertical link between floors (staircase or ladder)
 *   external     — the wall in question is an external wall (no neighbour)
 */
export type ConnectionKind =
  | "door"
  | "opening"
  | "shared-wall"
  | "stairs"
  | "external";

/**
 * Sub-type of stairs — captured separately because the architect
 * needs to know the geometry to draft the stair pitch correctly.
 *   straight        — single straight flight, no turn
 *   winder-l        — L-shaped winder turn (90°)
 *   winder-single   — single winder step at the turn
 */
export type StairsShape = "straight" | "winder-l" | "winder-single";

/**
 * A connection link between two rooms.
 *
 * If `kind === "external"`, `roomBId` is unset — the "other side" is
 * outside the house. This lets the customer flag which of a room's
 * walls touch fresh air (useful for the architect to know which walls
 * can carry windows or be demolished for an extension).
 */
export type RoomConnection = {
  id: string;
  roomAId: string;
  /** Wall index in Room A's walls array (0–3). Optional, for future precision. */
  wallAIndex?: number;
  roomBId?: string;
  wallBIndex?: number;
  kind: ConnectionKind;
  /** Stair shape, only meaningful when kind === "stairs". */
  stairsShape?: StairsShape;
  /** Door/opening width in metres, if applicable. */
  widthM?: number;
  /** Free-text notes. */
  notes?: string;
};

/** Form-friendly connection row — string fields so the UI can bind directly. */
export type RoomConnectionDraft = {
  id: string;
  roomAId: string;
  roomBId: string; // empty string means "external"
  kind: ConnectionKind;
  /** Stair shape — only used when kind === "stairs". */
  stairsShape?: StairsShape;
  widthM: string;
  notes: string;
};

/** Build a blank draft row — for "Add connection" buttons. */
export function makeRoomConnectionDraft(): RoomConnectionDraft {
  return {
    id: typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    roomAId: "",
    roomBId: "",
    kind: "door",
    widthM: "",
    notes: "",
  };
}

/**
 * Convert form drafts to normalised payload connections.
 * - Drops any drafts with missing roomAId
 * - Drops self-loops (roomA == roomB)
 * - Collapses rows that are genuinely identical, including the
 *   A↔B / B↔A restatement of the same link
 *
 * De-duplication deliberately keys on the whole row, not just the pair
 * of rooms. Keying on the pair alone discarded real information:
 *
 *   - Two rooms can connect more than once — a door *and* a wide
 *     opening, or a door *and* stairs. Only the first survived.
 *   - External walls were keyed on the room alone, so a room could
 *     record just one. A corner room has two, and the second was
 *     dropped — exactly the detail an architect needs when judging
 *     where an extension can go.
 *
 * Two rows that differ in any respect are two different facts about
 * the building, so both are kept.
 */
export function normalizeConnections(
  drafts: RoomConnectionDraft[],
): RoomConnection[] {
  const seen = new Set<string>();
  const out: RoomConnection[] = [];
  for (const d of drafts) {
    if (!d.roomAId) continue;
    if (d.kind !== "external" && !d.roomBId) continue;
    if (d.roomAId === d.roomBId) continue;
    const widthM = d.widthM.trim() ? Number(d.widthM) : undefined;
    const width = d.widthM.trim();
    const notes = d.notes.trim();
    const shape = d.kind === "stairs" ? (d.stairsShape ?? "") : "";
    const where =
      d.kind === "external"
        ? `ext:${d.roomAId}`
        : canonicalPairKey(d.roomAId, d.roomBId);
    const key = [where, d.kind, shape, width, notes].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: d.id,
      roomAId: d.roomAId,
      roomBId: d.kind === "external" ? undefined : d.roomBId || undefined,
      kind: d.kind,
      stairsShape: d.kind === "stairs" ? d.stairsShape : undefined,
      widthM: Number.isFinite(widthM) ? widthM : undefined,
      notes: d.notes.trim() ? d.notes.trim() : undefined,
    });
  }
  return out;
}

function canonicalPairKey(a: string, b: string): string {
  return a < b ? `${a}__${b}` : `${b}__${a}`;
}

/** Human-readable summary used in email/sheet cells. */
export function describeConnection(
  c: RoomConnection,
  roomNameById: (id: string) => string,
): string {
  const aName = roomNameById(c.roomAId);
  if (c.kind === "external") {
    return `${aName} → external wall${c.notes ? ` (${c.notes})` : ""}`;
  }
  const bName = c.roomBId ? roomNameById(c.roomBId) : "?";
  const verb =
    c.kind === "door"
      ? "door"
      : c.kind === "opening"
        ? "opening"
        : c.kind === "stairs"
          ? "stairs"
          : "shared wall";
  const width = c.widthM ? ` ${c.widthM.toFixed(2)} m wide` : "";
  const notes = c.notes ? ` · ${c.notes}` : "";
  return `${aName} ↔ ${bName} (${verb}${width})${notes}`;
}
