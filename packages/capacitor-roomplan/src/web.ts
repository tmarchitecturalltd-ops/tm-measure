import { WebPlugin } from "@capacitor/core";

import type {
  ArFloorTraceOptions,
  ArFloorTraceResult,
  ArHeightMeasureResult,
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

  /*
   * ARKit floor tracing is native too, for now.
   *
   * WebXR can do world tracking in a browser, and one day this could
   * be a real implementation rather than a refusal — which would
   * matter, because it would put scale-without-a-tape into the
   * desktop preview where it can actually be iterated on. Not today:
   * WebXR's immersive-ar mode is Android Chrome only, so it would
   * cover neither the iOS app nor the laptop we develop against.
   */
  async isArTraceSupported(): Promise<{ supported: boolean; reason?: string }> {
    return {
      supported: false,
      reason: "Tracing a room with the camera only works inside the app.",
    };
  }

  async startArFloorTrace(
    _options?: ArFloorTraceOptions,
  ): Promise<ArFloorTraceResult> {
    throw this.unimplemented(
      "Tracing a room with the camera only works inside the app.",
    );
  }

  async startArHeightMeasure(
    _options?: ArFloorTraceOptions,
  ): Promise<ArHeightMeasureResult> {
    throw this.unimplemented(
      "Measuring a ceiling with the camera only works inside the app.",
    );
  }
}
