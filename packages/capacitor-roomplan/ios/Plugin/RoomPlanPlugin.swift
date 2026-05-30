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
}
