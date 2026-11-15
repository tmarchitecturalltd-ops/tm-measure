/**
 * app/page.tsx — root route.
 *
 * Renders two completely different home screens depending on how the
 * project was built:
 *
 *   • Web (`next build`)            → marketing landing for tmdesignsltd.com
 *   • Capacitor (`CAPACITOR=1 …`)   → AppHome — the in-app start screen
 *
 * Using a build-time env var (rather than a runtime detection) keeps
 * the static export tidy: only the relevant component is bundled, so
 * the website never ships the AppHome code and the iOS/Android shell
 * never ships the marketing components. The unused branch tree-shakes
 * because the conditional resolves to a constant at build time.
 */

import Link from "next/link";
import AppHome from "@/components/app/AppHome";
import Hero from "@/components/Hero";
import Navbar from "@/components/Navbar";
import Process from "@/components/Process";

const IS_CAPACITOR = process.env.CAPACITOR === "1";

export default function Home() {
  if (IS_CAPACITOR) {
    return <AppHome />;
  }
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Hero />

        {/* ── Where the work actually happens ──────────────────────
            This page is the dev-time web face of the app repo --
            the live site is served elsewhere, and the iOS build
            shows AppHome here instead. So what it is for, in
            practice, is getting to the tools, and it had no links
            to any of them: finding the proposal screen meant
            remembering the URL.

            Pricing used to sit here. It is the public site's job,
            it was out of date, and by the time anyone is on this
            page the customer has already bought. */}
        <section className="mx-auto max-w-5xl px-4 py-16 md:px-6">
          <p className="font-label text-xs font-bold uppercase tracking-[0.2em] text-primary">
            Internal
          </p>
          <h2 className="font-headline mt-2 text-2xl text-on-surface">
            TM Measure tools
          </h2>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                href: "/measure",
                title: "Survey",
                body: "The customer's measuring flow. Scan or type a room, then send it.",
              },
              {
                href: "/architect",
                title: "Submissions",
                body: "Every survey that has come in. Open one to check it and approve.",
              },
              {
                href: "/architect/proposal",
                title: "Proposal tool",
                body: "Draw a rear extension on a survey. Rules, loads and a DXF.",
              },
              {
                href: "/status",
                title: "Status",
                body: "What a customer sees when they look up their submission.",
              },
            ].map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="tm-lift rounded-2xl border border-outline-variant/40 bg-surface-container-low p-5"
              >
                <p className="font-headline text-lg text-on-surface">
                  {l.title}
                </p>
                <p className="mt-1 text-sm text-on-surface-variant">{l.body}</p>
                <p className="mt-3 text-sm font-bold text-primary">Open →</p>
              </Link>
            ))}
          </div>
        </section>

        <Process />
        {/* Testimonials removed. The quotes were written, not
            received, and each carried a name, a star rating and
            "Google Review · TM Architectural Designs LTD · 1 month
            ago" under it. That is not a placeholder; it is a
            fabricated testimonial attributed to a real person who
            does not exist, on a page that also linked to the real
            Google listing.

            The component is still in the repo. Feed it real
            reviews, with real names and fixed dates, and put it
            back. */}
      </main>
    </>
  );
}
