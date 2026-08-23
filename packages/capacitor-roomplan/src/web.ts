import { WebPlugin } from "@capacitor/core";

import type {
  RoomPlanPlugin,
  RoomPlanScanOptions,
  RoomPlanScanResult,
} from "./definitions";

/**
 * Web (desktop browser) and Android fallback for RoomPlan.
 *
 * Apple RoomPlan is iOS-only, so this implementation simply reports
 * unsupported for both public methods. The UI is expected to honour
 * `isSupported().supported === false` and route the user to the
 * corner-tap path instead.
 */
export class RoomPlanWeb extends WebPlugin implements RoomPlanPlugin {
  async isSupported(): Promise<{ supported: boolean; reason?: string }> {
    return {
      supported: false,
      reason:
        "Apple RoomPlan only runs inside the native iOS app on a LiDAR-equipped iPhone / iPad Pro.",
    };
  }

  async startScan(_options?: RoomPlanScanOptions): Promise<RoomPlanScanResult> {
    throw this.unimplemented(
      "RoomPlan is only available on iOS 16+ devices with a LiDAR sensor.",
    );
  }

  async startHouseScan(
    _options?: RoomPlanScanOptions,
  ): Promise<RoomPlanScanResult> {
    throw this.unimplemented(
      "Whole-property scanning is only available on iOS 17+ devices with a LiDAR sensor.",
    );
  }
}
