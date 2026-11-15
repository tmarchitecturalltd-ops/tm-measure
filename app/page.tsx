/**
 * app/page.tsx — root route.
 *
 * Two completely different screens, chosen at build time:
 *
 *   • Capacitor (`CAPACITOR=1 …`)  → AppHome, the customer's start
 *                                     screen inside the app
 *   • Anywhere else                → the internal console
 *
 * A build-time env var rather than runtime detection, so only the
 * relevant component is bundled: the hosted site never ships
 * AppHome, and the phone never ships the console.
 */

import Link from "next/link";
import AppHome from "@/components/app/AppHome";

const IS_CAPACITOR = process.env.CAPACITOR === "1";

/**
 * The root, which is two different things.
 *
 *   • Capacitor build  → AppHome, the customer's start screen
 *   • Anywhere else    → this: the internal console
 *
 * It used to be the marketing landing page, and that was wrong in
 * both directions. The live site is served from elsewhere, so this
 * copy was never seen by a customer; and now that the tools are
 * hosted behind a login, the first thing Charlie meets is a hero
 * reading "Extension Plans in 2 Weeks — No Site Visit" with a
 * Start Project button, on a page only he and Harry can reach.
 * Half a sales site and half a toolbox, as described.
 *
 * So the marketing components are gone from here. They are still in
 * the repo if the public site is ever rebuilt from it.
 */
const TOOLS = [
  {
    href: "/architect",
    title: "Submissions",
    body: "Every survey that has come in. Open one to check the measurements, the photos and the plan, then approve it.",
  },
  {
    href: "/architect/proposal",
    title: "Proposal tool",
    body: "Draw a rear extension onto a survey. Permitted development checks, the load take-down, and a DXF with plan and elevations.",
  },
  {
    href: "/measure",
    title: "Survey flow",
    body: "The measuring flow as the customer sees it in the app. Useful for checking a change before it ships.",
  },
  {
    href: "/status",
    title: "Status lookup",
    body: "What a customer sees when they check on a submission with their ID and email.",
  },
];

export default function Home() {
  if (IS_CAPACITOR) {
    return <AppHome />;
  }
  return (
    <main className="mx-auto max-w-4xl px-6 py-16">
      <p className="font-label text-xs font-bold uppercase tracking-[0.25em] text-primary">
        TM Measure
      </p>
      <h1 className="font-headline mt-2 text-3xl text-on-surface md:text-4xl">
        Internal tools
      </h1>
      <p className="mt-3 max-w-2xl text-base text-on-surface-variant">
        Everything here is behind the login. Surveys come in from the app;
        the proposal tool draws the work onto them.
      </p>

      <div className="mt-10 grid gap-4 sm:grid-cols-2">
        {TOOLS.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className="tm-lift rounded-2xl border border-outline-variant/40 bg-surface-container-low p-6"
          >
            <p className="font-headline text-xl text-on-surface">{t.title}</p>
            <p className="mt-2 text-sm leading-relaxed text-on-surface-variant">
              {t.body}
            </p>
            <p className="mt-4 text-sm font-bold text-primary">Open &rarr;</p>
          </Link>
        ))}
      </div>

      <p className="mt-12 text-xs text-on-surface-variant">
        The public site is tmdesignsltd.com and is served separately. This
        one is not for customers.
      </p>
    </main>
  );
}
