import { registerPlugin } from "@capacitor/core";

import type { RoomPlanPlugin } from "./definitions";

/**
 * Registered Capacitor plugin instance. On iOS the name "RoomPlan"
 * is matched against the `@objc(RoomPlanPlugin)` Swift class via the
 * CAP_PLUGIN("RoomPlan", …) macro in RoomPlanPlugin.m.
 *
 * `web: () => import("./web")` keeps the heavy no-op web fallback
 * out of the main bundle until it's actually needed (e.g. on desktop
 * during `npm run dev`).
 */
const RoomPlan = registerPlugin<RoomPlanPlugin>("RoomPlan", {
  web: () => import("./web").then((m) => new m.RoomPlanWeb()),
});

export * from "./definitions";
export { RoomPlan };
