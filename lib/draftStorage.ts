/**
 * lib/draftStorage.ts
 *
 * Auto-saving project draft for MeasureIntakeForm. Survives accidental
 * tab closes, Capacitor app backgrounding, and "swipe-up" gestures. The
 * draft is keyed by a single slot per device — only one in-flight
 * project at a time, which matches the form's single-project UX.
 *
 * Design notes
 * ──────────────────────────────────────────────────────────────────
 * • Photos can't be JSON-serialised — they're Blob URLs that die when
 *   the document unloads. The draft persists everything *except*
 *   the photos array, so the user knows to re-take photos on resume.
 * • Saves are debounced (300 ms) to keep typing snappy.
 * • Schema is versioned so future changes don't crash old drafts —
 *   anything with a mismatched version is silently dropped on load.
 * • Cleared on successful submit so the next session starts fresh.
 */
"use client";

const STORAGE_KEY = "tm-measure:project-draft:v1";

export type ProjectDraftSnapshot = {
  version: 1;
  savedAt: string; // ISO timestamp
  step: "project" | "rooms" | "plan" | "review";
  customerName: string;
  email: string;
  projectName: string;
  projectType: string | null;
  unit: "metric" | "imperial";
  unitLocked: boolean;
  rooms: Array<Record<string, unknown>>;
  connections: Array<Record<string, unknown>>;
  placements: Record<string, unknown>;
};

/**
 * Save the draft. Drops the photos array from each room before
 * stringifying — blob URLs would resolve to dead handles on resume.
 */
export function saveDraft(snapshot: Omit<ProjectDraftSnapshot, "version" | "savedAt">): void {
  if (typeof window === "undefined") return;
  try {
    const payload: ProjectDraftSnapshot = {
      ...snapshot,
      rooms: snapshot.rooms.map((r) => {
        const { photos: _photos, ...rest } = r as { photos?: unknown };
        return { ...rest, photos: [] };
      }),
      version: 1,
      savedAt: new Date().toISOString(),
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* quota exceeded, private mode, etc. — silently drop */
  }
}

/** Load the draft if one exists and matches schema version. */
export function loadDraft(): ProjectDraftSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ProjectDraftSnapshot;
    if (parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Clear the draft. Called on successful submit. */
export function clearDraft(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* noop */
  }
}

/**
 * Debounce helper — used by the form to batch rapid keystrokes into
 * one save. Not a hook on purpose: the form holds the timer ref so
 * the debounce span survives re-renders.
 */
export function makeDebouncedSaver<T extends ProjectDraftSnapshot>(
  delayMs = 300,
): {
  schedule: (snapshot: Omit<T, "version" | "savedAt">) => void;
  flush: () => void;
  cancel: () => void;
} {
  let pending: Omit<T, "version" | "savedAt"> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => {
    if (pending) saveDraft(pending);
    pending = null;
    timer = null;
  };
  return {
    schedule(snapshot) {
      pending = snapshot;
      if (timer) clearTimeout(timer);
      timer = setTimeout(fire, delayMs);
    },
    flush() {
      if (timer) clearTimeout(timer);
      fire();
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}
