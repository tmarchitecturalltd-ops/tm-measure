#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// Bridges the @objc Swift class RoomPlanPlugin to Capacitor's runtime
// plugin registry. The first arg must match the @objc(RoomPlanPlugin)
// Swift attribute; the second must match the JS-side
//   registerPlugin<RoomPlanPlugin>("RoomPlan", …)
// call in src/index.ts.
CAP_PLUGIN(RoomPlanPlugin, "RoomPlan",
    CAP_PLUGIN_METHOD(isSupported, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(startScan,   CAPPluginReturnPromise);
)
