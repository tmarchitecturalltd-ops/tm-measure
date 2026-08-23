#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// Bridges the @objc Swift class RoomPlanPlugin to Capacitor's runtime
// plugin registry. The first arg must match the @objc(RoomPlanPlugin)
// Swift attribute; the second must match the JS-side
//   registerPlugin<RoomPlanPlugin>("RoomPlan", …)
// call in src/index.ts.
// Every method callable from JS must be listed here. A method that
// exists in Swift but is missing from this macro is simply not there as
// far as the bridge is concerned — the call rejects with "not
// implemented", which reads like a platform problem rather than a
// registration one.
CAP_PLUGIN(RoomPlanPlugin, "RoomPlan",
    CAP_PLUGIN_METHOD(isSupported,    CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(startScan,      CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(startHouseScan, CAPPluginReturnPromise);
)
