"use client";

/**
 * components/IconFallback.tsx
 *
 * Runtime DOM scanner that replaces every `.material-symbols-outlined`
 * span's text ("arrow_forward", "photo_camera", …) with an OS-native
 * emoji or unicode glyph. We do this because the Google-hosted
 * Material Symbols font wasn't reaching Capacitor WKWebView reliably,
 * leaving customers staring at raw glyph names where icons should be.
 *
 * Emojis are baked into every iOS / Android / desktop browser, need
 * no network round-trip, and look fine inline. Where a clean line-art
 * character exists in plain Unicode (←, →, ✕, ▾), we prefer that
 * over a colour emoji so the icon doesn't clash with the brand's
 * cream / gold palette.
 *
 * Mounted once in `app/layout.tsx`; a MutationObserver re-runs the
 * pass whenever React adds new nodes so dynamically rendered icons
 * (modals, popovers, scan HUD) also get translated.
 */

import { useEffect } from "react";

const ICON_MAP: Record<string, string> = {
  // Navigation arrows — keep minimal so they look like buttons
  arrow_back: "←",
  arrow_forward: "→",
  arrow_back_ios_new: "‹",
  arrow_forward_ios: "›",
  chevron_left: "‹",
  chevron_right: "›",
  expand_more: "▾",
  expand_less: "▴",
  close: "✕",

  // Photo / camera
  photo_camera: "📷",
  add_a_photo: "📸",

  // Form / status
  fact_check: "✅",
  fact_check_outlined: "📋",
  checklist: "📝",
  shield: "🛡️",
  open_in_new: "↗",
  send: "✉️",
  fullscreen: "⛶",
  center_focus_strong: "🎯",
  restart_alt: "↻",
  mail: "✉",
  home: "⌂",
  settings: "⚙",
  delete: "🗑",
  edit: "✎",
  arrow_drop_down: "▾",
  arrow_drop_up: "▴",
  refresh: "↻",
  download: "⬇",
  upload: "⬆",

  // Capture / media
  mic: "🎙",
  mic_off: "🔇",
  stop: "■",
  stop_circle: "⏹",
  view_in_ar: "🧊",
  edit_note: "✎",
  schedule: "🕐",
  star: "★",
  play_arrow: "▶",
  pause: "⏸",
  image: "🖼",
  photo_library: "🖼",
  collections: "🖼",
  attach_file: "📎",
  videocam: "🎥",

  // Measurement / editing
  straighten: "📏",
  square_foot: "📐",
  architecture: "📐",
  crop_free: "⛶",
  zoom_in: "＋",
  zoom_out: "－",
  undo: "↶",
  redo: "↷",
  add: "＋",
  remove: "－",
  check: "✓",
  check_circle: "✅",
  error: "⚠",
  warning: "⚠",
  info: "ℹ",
  help: "?",
  visibility: "👁",
  location_on: "📍",
  calendar_month: "📅",
  description: "📄",
  save: "💾",
  share: "↗",
  more_vert: "⋮",
  menu: "☰",
  search: "🔍",
};

/** Glyph used when a name isn't in the map — guarantees a customer
 *  never sees a raw string like "center_focus__strong" on screen. */
const FALLBACK_GLYPH = "•";

/** Material names arrive with stray separators or casing in a few
 *  places (e.g. "center_focus__strong", "Photo Camera"). Normalise to
 *  lower snake_case with single underscores before the lookup. */
function normaliseKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
}

const REPLACED_ATTR = "data-icon-replaced";

function replaceEl(el: HTMLElement) {
  const raw = (el.textContent ?? "").trim();
  if (!raw) return;
  // Already a glyph (no letters/underscores) — nothing to swap.
  if (!/^[a-z][a-z0-9_\s-]*$/i.test(raw)) return;
  const glyph = ICON_MAP[normaliseKey(raw)] ?? FALLBACK_GLYPH;
  if (el.textContent === glyph) return;
  el.textContent = glyph;
  // Drop the icon-font family so the emoji renders in the OS font
  // (Apple Color Emoji on iOS, Noto Color Emoji on Android, etc.).
  el.style.fontFamily = "inherit";
  el.setAttribute(REPLACED_ATTR, "1");
}

function replaceAll(root: ParentNode) {
  if (root instanceof HTMLElement && root.matches(".material-symbols-outlined")) {
    replaceEl(root);
  }
  root
    .querySelectorAll<HTMLElement>(".material-symbols-outlined")
    .forEach(replaceEl);
}

export default function IconFallback() {
  useEffect(() => {
    if (typeof document === "undefined") return;
    replaceAll(document);
    const observer = new MutationObserver((mutations) => {
      // Optimisation: only walk added subtrees, not the whole document
      // again. Saves work on big pages with frequent React updates.
      for (const m of mutations) {
        m.addedNodes.forEach((n) => {
          if (n.nodeType === 1) replaceAll(n as Element);
        });
        // React often reuses a single icon span and swaps only its text
        // (e.g. the tutorial overlay stepping through its steps). That
        // fires characterData, not childList, so handle it explicitly —
        // otherwise every step after the first shows the raw glyph name.
        if (m.type === "characterData" && m.target.parentElement) {
          const parent = m.target.parentElement;
          if (parent.classList.contains("material-symbols-outlined")) {
            replaceEl(parent);
          }
        }
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => observer.disconnect();
  }, []);
  return null;
}
