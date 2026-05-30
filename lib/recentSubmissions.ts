/**
 * lib/recentSubmissions.ts
 *
 * Tiny localStorage-backed log of measurement submissions, used by the
 * app home screen to show "Recent submissions". The full submission
 * payload still goes to the Apps Script backend; this is only a local
 * convenience cache so the customer can see what they've sent.
 *
 * Design notes
 * ──────────────────────────────────────────────────────────────────
 * • localStorage works in Capacitor's WKWebView/WebView, so no extra
 *   plugin is needed. If we ever migrate to @capacitor/preferences for
 *   parity with native, only this module needs to change.
 * • All getters are SSR-safe: they no-op on the server (where
 *   `window` is undefined). The home page is a server component, but
 *   the section that consumes this is a client component, so reads
 *   happen in the browser.
 * • Cap the log at MAX_ENTRIES so we never grow unbounded.
 * • Versioned key so we can migrate the schema later without users'
 *   old entries crashing the parse step.
 */
"use client";

const STORAGE_KEY = "tm-measure:recent-submissions:v1";
const MAX_ENTRIES = 20;

/**
 * Project type a user can pick from the home tile grid. Kept narrow
 * so the email subject line and the home tile labels stay aligned.
 */
export type ProjectType =
  | "extension"
  | "loft"
  | "newbuild"
  | "renovation"
  | "garage"
  | "other";

export type RecentSubmission = {
  id: string;
  projectName: string;
  projectType: ProjectType | null;
  submittedAt: string;
  roomCount: number;
  /** Optional Apps Script-issued submission id ("AB12CD34"). */
  remoteId?: string;
};

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

/** Read the log. Returns [] on the server or when storage is empty/corrupt. */
export function getRecentSubmissions(): RecentSubmission[] {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive: drop entries that don't look like our shape so a
    // hand-edited localStorage can't crash the home page render.
    return parsed.filter(
      (e) =>
        e &&
        typeof e.id === "string" &&
        typeof e.projectName === "string" &&
        typeof e.submittedAt === "string",
    );
  } catch {
    return [];
  }
}

/** Append a submission to the log; trims to MAX_ENTRIES, newest first. */
export function recordSubmission(entry: RecentSubmission): void {
  if (!isBrowser()) return;
  try {
    const current = getRecentSubmissions();
    const next = [entry, ...current.filter((e) => e.id !== entry.id)].slice(
      0,
      MAX_ENTRIES,
    );
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore quota / privacy-mode errors — the log is a convenience,
    // not a source of truth.
  }
}

/** Wipe the log — exposed for a future "Clear history" affordance. */
export function clearRecentSubmissions(): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* noop */
  }
}

/** Human label for a ProjectType, used in tiles and subjects. */
export function projectTypeLabel(t: ProjectType | null | undefined): string {
  switch (t) {
    case "extension":
      return "Extension";
    case "loft":
      return "Loft conversion";
    case "newbuild":
      return "New build";
    case "renovation":
      return "Renovation";
    case "garage":
      return "Garage conversion";
    case "other":
      return "Other";
    default:
      return "Project";
  }
}
