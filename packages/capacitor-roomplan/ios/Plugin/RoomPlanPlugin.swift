import Foundation
import Capacitor

/**
 * RoomPlanPlugin — thin Capacitor-facing class.
 *
 * All the real work — presenting RoomCaptureView, handling delegate
 * callbacks, converting CapturedRoom into a JS-serialisable dict — is
 * in `RoomCaptureRunner`. That class is @available(iOS 16.0, *), so
 * this plugin class can't import RoomPlan directly at file scope;
 * instead we hop behind an `if #available` block and use `AnyObject`
 * for the ivar retain.
 *
 * Threading: all UI work is bounced to the main queue. The plugin
 * method bodies themselves run on Capacitor's plugin dispatch queue.
 */
@objc(RoomPlanPlugin)
public class RoomPlanPlugin: CAPPlugin {

    /** Retains the runner for the duration of a scan session. */
    private var runner: AnyObject?

    @objc public func isSupported(_ call: CAPPluginCall) {
        if #available(iOS 16.0, *) {
            if RoomCaptureRunner.isSupportedOnThisDevice() {
                call.resolve(["supported": true])
            } else {
                call.resolve([
                    "supported": false,
                    "reason":
                        "This iPhone or iPad does not have a LiDAR sensor. RoomPlan runs on iPhone 12 Pro and newer Pro models, and on iPad Pro (2020 or later)."
                ])
            }
        } else {
            call.resolve([
                "supported": false,
                "reason": "RoomPlan requires iOS 16 or newer. Please update in Settings → General → Software Update."
            ])
        }
    }

    @objc public func startScan(_ call: CAPPluginCall) {
        guard #available(iOS 16.0, *) else {
            call.reject("RoomPlan requires iOS 16 or newer.")
            return
        }
        guard RoomCaptureRunner.isSupportedOnThisDevice() else {
            call.reject("This device does not support RoomPlan (no LiDAR sensor).")
            return
        }

        let title = call.getString("title") ?? "Scan this room"
        let unit = call.getString("unit") ?? "m"

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            guard let host = self.bridge?.viewController else {
                call.reject("No view controller available to present RoomPlan.")
                return
            }
            let r = RoomCaptureRunner(title: title, unit: unit) { [weak self] result in
                // Release the runner once we've handed the result to JS.
                self?.runner = nil
                switch result {
                case .success(let payload):
                    call.resolve(payload)
                case .failure(let err):
                    call.reject(err.localizedDescription)
                }
            }
            self.runner = r
            r.present(from: host)
        }
    }

    /**
     * Scan a whole property: several rooms merged into one plan.
     *
     * Separate from startScan rather than a flag on it, because the
     * requirements genuinely differ — this needs iOS 17 for
     * StructureBuilder, where a single-room scan runs on 16 — and a
     * caller that cannot do one may still be able to do the other.
     */
    @objc public func startHouseScan(_ call: CAPPluginCall) {
        guard #available(iOS 17.0, *) else {
            call.reject(
                "Scanning a whole property needs iOS 17 or newer. "
                + "You can still scan rooms one at a time."
            )
            return
        }
        guard HouseCaptureRunner.isSupportedOnThisDevice() else {
            call.reject("This device does not support RoomPlan (no LiDAR sensor).")
            return
        }

        let unit = call.getString("unit") ?? "m"

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            guard let host = self.bridge?.viewController else {
                call.reject("No view controller available to present RoomPlan.")
                return
            }
            let r = HouseCaptureRunner(unit: unit) { [weak self] result in
                self?.runner = nil
                switch result {
                case .success(let payload):
                    call.resolve(payload)
                case .failure(let err):
                    call.reject(err.localizedDescription)
                }
            }
            self.runner = r
            r.present(from: host)
        }
    }

    /*
     * ── ARKit floor tracing ──────────────────────────────────────
     *
     * Lives in the RoomPlan plugin despite not being RoomPlan, and
     * that is a deliberate trade rather than an oversight. A second
     * Capacitor plugin means a second podspec, a second package, and
     * another thing for the iOS build to get wrong — for two methods
     * that serve the same screen as the three above and are chosen
     * between at the same moment. The class name is now a little
     * wrong; the alternative was more moving parts in a pipeline we
     * cannot compile locally.
     */

    /**
     * Can this device trace a floor with ARKit?
     *
     * A much lower bar than RoomPlan: world tracking runs on anything
     * with an A9 or better, so in practice every iPhone still in use.
     * Worth asking separately all the same — ARKit is unavailable in
     * the simulator, and a device can have the chip and still refuse
     * if the camera is held by something else.
     */
    @objc public func isArTraceSupported(_ call: CAPPluginCall) {
        if #available(iOS 13.0, *), ARFloorTraceRunner.isSupportedOnThisDevice() {
            call.resolve(["supported": true])
        } else {
            call.resolve([
                "supported": false,
                "reason":
                    "This device cannot run ARKit world tracking, so it cannot measure without a tape."
            ])
        }
    }

    /**
     * Trace a room's outline by tapping its corners, to real scale.
     *
     * The point of this method is what it does *not* ask for: no
     * ceiling height, no reference object, no tape. ARKit supplies
     * the scale from the device's own motion.
     */
    @objc public func startArFloorTrace(_ call: CAPPluginCall) {
        guard #available(iOS 13.0, *), ARFloorTraceRunner.isSupportedOnThisDevice() else {
            call.reject("This device cannot run ARKit world tracking.")
            return
        }

        let title = call.getString("title") ?? "Trace this room"

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            guard let host = self.bridge?.viewController else {
                call.reject("No view controller available to present the camera.")
                return
            }
            let r = ARFloorTraceRunner(title: title) { [weak self] result in
                self?.runner = nil
                switch result {
                case .success(let payload):
                    call.resolve(payload)
                case .failure(let err):
                    call.reject(err.localizedDescription)
                }
            }
            self.runner = r
            r.present(from: host)
        }
    }
}
