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

import AppHome from "@/components/app/AppHome";
import InternalHome from "@/components/InternalHome";

const IS_CAPACITOR = process.env.CAPACITOR === "1";

export default function Home() {
  if (IS_CAPACITOR) {
    return <AppHome />;
  }
  return <InternalHome />;
}
