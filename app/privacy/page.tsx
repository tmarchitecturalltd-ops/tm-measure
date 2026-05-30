/**
 * app/privacy/page.tsx
 *
 * Public privacy policy page. Required for App Store + Play Store
 * submission — Apple specifically asks for a publicly hosted URL
 * before the listing can go live.
 *
 * Source of truth is `store-assets/privacy-policy.md`. We read it
 * synchronously at build time inside this server component, parse it
 * via the tiny `renderMarkdown` helper, and emit a fully-styled
 * static HTML page. No runtime fetch, no client JS — works fine with
 * Capacitor's `next export` static build.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import Link from "next/link";
import { renderMarkdown } from "@/lib/renderMarkdown";

export const metadata = {
  title: "Privacy Policy — TM Measure",
  description:
    "How TM Architectural Designs Ltd. handles your data when you use the TM Measure app.",
};

export default function PrivacyPage() {
  // process.cwd() is the App root when next build runs.
  const source = readFileSync(
    join(process.cwd(), "store-assets", "privacy-policy.md"),
    "utf8",
  );

  return (
    <div className="min-h-screen bg-surface pb-24 pt-10">
      <header className="mx-auto mb-6 max-w-3xl px-4 md:px-6">
        <Link
          href="/"
          className="material-symbols-outlined inline-flex items-center text-primary"
          aria-label="Back to home"
        >
          arrow_back
        </Link>
        <p className="font-label mt-3 text-[10px] font-bold uppercase tracking-[0.3em] text-primary">
          Legal
        </p>
      </header>
      <main className="mx-auto max-w-3xl px-4 md:px-6">
        <article className="rounded-xl bg-surface-container-low p-6 md:p-10">
          {renderMarkdown(source)}
        </article>
      </main>
    </div>
  );
}
