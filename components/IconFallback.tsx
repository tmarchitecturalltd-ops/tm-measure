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
};

const REPLACED_ATTR = "data-icon-replaced";

function replaceAll(root: ParentNode) {
  const nodes = root.querySelectorAll<HTMLElement>(".material-symbols-outlined");
  nodes.forEach((el) => {
    if (el.getAttribute(REPLACED_ATTR)) return;
    const key = (el.textContent ?? "").trim();
    const glyph = ICON_MAP[key];
    if (!glyph) return;
    el.textContent = glyph;
    // Drop the icon-font family so the emoji renders in the OS font
    // (Apple Color Emoji on iOS, Noto Color Emoji on Android, etc.).
    el.style.fontFamily = "inherit";
    el.setAttribute(REPLACED_ATTR, "1");
  });
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
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return null;
}
