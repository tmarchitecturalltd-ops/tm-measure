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

import AppHome from "@/components/app/AppHome";
import Hero from "@/components/Hero";
import Navbar from "@/components/Navbar";
import Pricing from "@/components/Pricing";
import Process from "@/components/Process";
import ReviewCarousel from "@/components/ReviewCarousel";

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
        <Pricing />
        <Process />
        <ReviewCarousel />
      </main>
    </>
  );
}
