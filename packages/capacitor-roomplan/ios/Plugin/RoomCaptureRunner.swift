import Foundation
import UIKit
import simd

#if canImport(RoomPlan)
import RoomPlan

/**
 * RoomCaptureRunner — owns one RoomPlan scan session end to end.
 *
 * Lifecycle:
 *   1. `present(from:)`         → builds a CaptureModalViewController
 *                                 hosting a RoomCaptureView, shows it
 *                                 full-screen, runs the capture session.
 *   2. User walks the room.     RoomCaptureView drives the coaching
 *                                 overlay — arrows, the progress toast,
 *                                 the live geometry. It does NOT provide
 *                                 a Done button; Apple's own sample app
 *                                 adds one. This file must too, and for
 *                                 a long time did not, which left the
 *                                 customer on the camera screen with
 *                                 only Cancel and no way to keep a scan.
 *   3. User taps our "Done".    Framework calls:
 *         captureView(shouldPresent:error:) → return true
 *         captureView(didPresent:error:)    → we serialise and dismiss.
 *   4. Completion closure fires with the JS-serialisable dict.
 *
 * On cancel the modal's cancel button calls `dismiss(payload:.failure)`.
 */
@available(iOS 16.0, *)
class RoomCaptureRunner: NSObject, RoomCaptureViewDelegate {

    enum RoomPlanError: LocalizedError {
        case cancelled
        case captureFailed(String)

        var errorDescription: String? {
            switch self {
            case .cancelled: return "Scan cancelled"
            case .captureFailed(let m): return m
            }
        }
    }

    /// Public guard used by the plugin's isSupported() before we even
    /// instantiate a runner — avoids importing RoomPlan symbols from
    /// the plugin class itself.
    static func isSupportedOnThisDevice() -> Bool {
        return RoomCaptureSession.isSupported
    }

    private let title: String
    private let unit: String
    private let completion: (Result<[String: Any], Error>) -> Void
    private var startedAt: Date = Date()

    private weak var hostVC: UIViewController?
    private var modalVC: CaptureModalViewController?

    /// Set when the customer chose Cancel, so the scan that stopping the
    /// session produces is discarded rather than processed and returned.
    private var isCancelling = false

    /// The completion closure must fire exactly once.
    ///
    /// Stopping the session is asynchronous, so a cancel and a delayed
    /// didPresent could both reach `dismiss`, resolving the same
    /// Capacitor call twice — which surfaces in JS as a scan that
    /// "succeeded" immediately after the user cancelled it.
    private var hasCompleted = false

    init(
        title: String,
        unit: String,
        completion: @escaping (Result<[String: Any], Error>) -> Void
    ) {
        self.title = title
        self.unit = unit
        self.completion = completion
        super.init()
    }

    // Required by NSCoding conformance that RoomCaptureViewDelegate pulls in
    // under the iOS 26 SDK. This runner is only ever created programmatically,
    // so decoding is unsupported.
    required init?(coder: NSCoder) {
        return nil
    }

    func encode(with coder: NSCoder) {
        // No encodable state; runner is created programmatically only.
    }

    // MARK: - Present / dismiss

    func present(from host: UIViewController) {
        self.hostVC = host
        let modal = CaptureModalViewController(delegate: self, title: title)
        modal.modalPresentationStyle = .fullScreen
        self.modalVC = modal
        host.present(modal, animated: true)
        startedAt = Date()
    }

    /// Both success and cancel/error routes funnel through here so the
    /// completion closure always fires exactly once.
    func dismiss(payload: Result<[String: Any], Error>) {
        guard !hasCompleted else { return }
        hasCompleted = true
        let closure = self.completion
        let finalPayload = payload
        guard let modal = modalVC else {
            // Defensive — modal already gone, just resolve.
            closure(finalPayload)
            return
        }
        modal.dismiss(animated: true) { [weak self] in
            self?.modalVC = nil
            closure(finalPayload)
        }
    }

    // Called by the modal's Cancel button.
    func userCancelled() {
        isCancelling = true
        dismiss(payload: .failure(RoomPlanError.cancelled))
    }

    // MARK: - RoomCaptureViewDelegate

    /// Returning true lets Apple's pipeline process raw scan data into
    /// a CapturedRoom. Returning false would require us to call
    /// `processWithConfiguration` ourselves — more code, zero benefit.
    func captureView(shouldPresent roomDataForProcessing: CapturedRoomData, error: Error?) -> Bool {
        // Cancelling stops the session too, and a stopped session hands
        // its data here regardless of why it stopped. Processing it
        // would turn "Cancel" into "save this room", which is the
        // opposite of what was asked for.
        if isCancelling { return false }
        if let error = error {
            dismiss(payload: .failure(RoomPlanError.captureFailed(error.localizedDescription)))
            return false
        }
        return true
    }

    func captureView(didPresent processedResult: CapturedRoom, error: Error?) {
        if isCancelling { return }
        if let error = error {
            dismiss(payload: .failure(RoomPlanError.captureFailed(error.localizedDescription)))
            return
        }
        let elapsed = Date().timeIntervalSince(startedAt)
        let payload = CaptureSerializer.serialize(captured: processedResult, durationS: elapsed)
        dismiss(payload: .success(payload))
    }
}

// MARK: - Modal host view controller

@available(iOS 16.0, *)
private class CaptureModalViewController: UIViewController {

    /// Weak to avoid a retain cycle: the runner owns us (modalVC) and
    /// we point back at the runner as our delegate.
    private weak var delegateRunner: RoomCaptureRunner?
    private let titleText: String
    private var captureView: RoomCaptureView?
    private var hasStartedSession: Bool = false
    private var doneButton: UIButton?
    private var cancelButton: UIButton?
    private var statusLabel: UILabel?
    /// True once Done has been pressed, so the session is not stopped a
    /// second time by viewWillDisappear while it is already processing.
    private var isFinishing: Bool = false

    init(delegate: RoomCaptureRunner, title: String) {
        self.delegateRunner = delegate
        self.titleText = title
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        // RoomCaptureView covers the full screen. Apple renders the
        // coaching UI on top — arrows, the progress toast, the live
        // geometry — but NOT a Done button. That is the app's job, and
        // its absence here is why a scan could never be completed.
        let cv = RoomCaptureView(frame: view.bounds)
        cv.translatesAutoresizingMaskIntoConstraints = false
        cv.delegate = delegateRunner
        view.addSubview(cv)
        self.captureView = cv

        NSLayoutConstraint.activate([
            cv.topAnchor.constraint(equalTo: view.topAnchor),
            cv.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            cv.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            cv.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])

        // Cancel pill (top-left)
        let cancel = UIButton(type: .system)
        cancel.setTitle("Cancel", for: .normal)
        cancel.setTitleColor(.white, for: .normal)
        cancel.titleLabel?.font = .systemFont(ofSize: 15, weight: .semibold)
        cancel.backgroundColor = UIColor(white: 0.0, alpha: 0.55)
        cancel.layer.cornerRadius = 18
        cancel.layer.cornerCurve = .continuous
        cancel.contentEdgeInsets = UIEdgeInsets(top: 8, left: 16, bottom: 8, right: 16)
        cancel.translatesAutoresizingMaskIntoConstraints = false
        cancel.addTarget(self, action: #selector(onCancel), for: .touchUpInside)
        view.addSubview(cancel)
        NSLayoutConstraint.activate([
            cancel.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
            cancel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
        ])

        // Title label (centred, matches cancel pill's y)
        let label = UILabel()
        label.text = titleText
        label.textColor = .white
        label.font = .systemFont(ofSize: 15, weight: .semibold)
        label.shadowColor = UIColor(white: 0.0, alpha: 0.7)
        label.shadowOffset = CGSize(width: 0, height: 1)
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: cancel.centerYAnchor),
        ])
        self.cancelButton = cancel

        // Done (bottom centre).
        //
        // The one control the whole feature depends on, and it was
        // missing: RoomCaptureView does not supply it, so the session
        // could only ever be stopped by Cancel, which throws the scan
        // away. The customer was left walking round a room with no way
        // to say "that's the room done".
        //
        // Bottom centre and large, because it is pressed one-handed
        // while holding a phone up at arm's length.
        let done = UIButton(type: .system)
        done.setTitle("Done", for: .normal)
        done.setTitleColor(.black, for: .normal)
        done.titleLabel?.font = .systemFont(ofSize: 18, weight: .bold)
        done.backgroundColor = .white
        done.layer.cornerRadius = 28
        done.layer.cornerCurve = .continuous
        done.translatesAutoresizingMaskIntoConstraints = false
        done.addTarget(self, action: #selector(onDone), for: .touchUpInside)
        view.addSubview(done)
        NSLayoutConstraint.activate([
            done.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            done.bottomAnchor.constraint(
                equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -28),
            done.widthAnchor.constraint(greaterThanOrEqualToConstant: 200),
            done.heightAnchor.constraint(equalToConstant: 56),
        ])
        self.doneButton = done

        // Processing takes a few seconds and Apple shows nothing during
        // it. Without a word here the app looks frozen at exactly the
        // moment the customer is waiting to find out whether their walk
        // round the room counted.
        let status = UILabel()
        status.text = ""
        status.textColor = .white
        status.font = .systemFont(ofSize: 15, weight: .semibold)
        status.textAlignment = .center
        status.numberOfLines = 2
        status.shadowColor = UIColor(white: 0.0, alpha: 0.7)
        status.shadowOffset = CGSize(width: 0, height: 1)
        status.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(status)
        NSLayoutConstraint.activate([
            status.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            status.bottomAnchor.constraint(equalTo: done.topAnchor, constant: -14),
            status.leadingAnchor.constraint(
                greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
        ])
        self.statusLabel = status
    }

    @objc private func onDone() {
        guard !isFinishing else { return }
        isFinishing = true
        // Both controls off: a second tap while Apple is processing
        // stops a session that has already stopped, and Cancel here
        // would race the result that is on its way.
        doneButton?.isEnabled = false
        doneButton?.alpha = 0.5
        doneButton?.setTitle("Finishing…", for: .normal)
        cancelButton?.isEnabled = false
        cancelButton?.alpha = 0.5
        statusLabel?.text = "Working out the measurements…"
        captureView?.captureSession.stop()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // Guard: avoid double-start if the view re-appears (e.g. after
        // backgrounding). The session handles re-runs idempotently, but
        // starting twice back-to-back can log harmless warnings.
        guard !hasStartedSession else { return }
        hasStartedSession = true
        let cfg = RoomCaptureSession.Configuration()
        captureView?.captureSession.run(configuration: cfg)
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        // Not while finishing. Done has already stopped the session and
        // is waiting on didPresent; stopping again mid-dismissal was
        // producing a second delegate callback, and with it a second
        // resolution of the same Capacitor call.
        guard !isFinishing else { return }
        captureView?.captureSession.stop()
    }

    @objc private func onCancel() {
        delegateRunner?.userCancelled()
    }
}

// MARK: - CapturedRoom → JS dict

/// Stateless container for the CapturedRoom → `[String: Any]`
/// conversion. Kept separate from the runner to make the geometry
/// code reviewable in isolation.
@available(iOS 16.0, *)
enum CaptureSerializer {

    static func serialize(captured: CapturedRoom, durationS: TimeInterval) -> [String: Any] {
        let wallDicts = captured.walls.map { wallToDict($0) }
        let doorDicts = captured.doors.map { openingToDict($0, walls: captured.walls) }
        let windowDicts = captured.windows.map { openingToDict($0, walls: captured.walls) }
        let openingDicts = captured.openings.map { openingToDict($0, walls: captured.walls) }

        // Floor area + bounding box from the floor polygon if one exists;
        // fall back to the wall endpoints otherwise.
        //
        // IMPORTANT: we use an *oriented* bounding box aligned with the
        // longest wall, not an axis-aligned one. RoomPlan world axes track
        // the device's initial orientation, so a 4 × 3 m room scanned at
        // 45° to world X gave an AABB of ~5 × 5 m — that was the LiDAR-
        // off-by-25% bug field-testers reported.
        let floorPoly: [(Double, Double)]
        if #available(iOS 17.0, *) {
            floorPoly = captured.floors.flatMap { floor in
                floor.polygonCorners.map { (Double($0.x), Double($0.z)) }
            }
        } else {
            // `floors`/`polygonCorners` are iOS 17+. On iOS 16 fall back to
            // the wall-endpoint bounding box computed below.
            floorPoly = []
        }
        let fallbackPts: [(Double, Double)] = captured.walls.flatMap { w in
            wallEndpoints(for: w)
        }
        // Principal axis = direction of the longest wall, projected to XZ.
        // For walls of equal length this is stable because Swift `max(by:)`
        // returns the first match on a tie.
        let principalAxis: (Double, Double)? = captured.walls
            .max(by: { Double($0.dimensions.x) < Double($1.dimensions.x) })
            .map { localXAxisXZ($0.transform) }
        let (widthM, lengthM, areaM2, rectangular) = boundingMetrics(
            primary: floorPoly,
            fallback: fallbackPts,
            axis: principalAxis
        )

        // Tallest wall is a decent heightM estimate — RoomPlan often
        // gives all walls the same height but occasionally reports
        // stepped ceilings.
        let heightM = captured.walls.map { Double($0.dimensions.y) }.max() ?? 2.4

        let roomDict: [String: Any] = [
            "id": UUID().uuidString,
            "widthM": widthM,
            "lengthM": lengthM,
            "heightM": heightM,
            "floorAreaM2": areaM2,
            "rectangular": rectangular,
            "walls": wallDicts,
            "doors": doorDicts,
            "windows": windowDicts,
            "openings": openingDicts,
        ]
        return [
            "rooms": [roomDict],
            "durationS": durationS,
            "complete": true,
        ]
    }

    // MARK: - Per-surface helpers

    private static func wallToDict(_ w: CapturedRoom.Surface) -> [String: Any] {
        let length = Double(w.dimensions.x)
        let height = Double(w.dimensions.y)
        let thickness = Double(w.dimensions.z)
        let mid = midpointXZ(w.transform)
        let dir = localXAxisXZ(w.transform)
        let half = length / 2.0
        let start = (mid.0 - dir.0 * half, mid.1 - dir.1 * half)
        let end = (mid.0 + dir.0 * half, mid.1 + dir.1 * half)
        return [
            "id": w.identifier.uuidString,
            "midpoint": ["x": mid.0, "z": mid.1],
            "start": ["x": start.0, "z": start.1],
            "end": ["x": end.0, "z": end.1],
            "lengthM": length,
            "heightM": height,
            "thicknessM": thickness,
        ]
    }

    private static func wallEndpoints(for w: CapturedRoom.Surface) -> [(Double, Double)] {
        let length = Double(w.dimensions.x)
        let mid = midpointXZ(w.transform)
        let dir = localXAxisXZ(w.transform)
        let half = length / 2.0
        return [
            (mid.0 - dir.0 * half, mid.1 - dir.1 * half),
            (mid.0 + dir.0 * half, mid.1 + dir.1 * half),
        ]
    }

    private static func openingToDict(
        _ o: CapturedRoom.Surface,
        walls: [CapturedRoom.Surface]
    ) -> [String: Any] {
        let width = Double(o.dimensions.x)
        let height = Double(o.dimensions.y)
        let oMid = midpointXZ(o.transform)

        // Match to nearest wall by distance from opening midpoint to wall
        // midpoint. Fine for well-separated walls; RoomPlan already
        // snaps openings to their parent wall axis, so ambiguity is rare.
        var parentId: String? = nil
        var offset: Double? = nil
        var minDist = Double.greatestFiniteMagnitude
        for w in walls {
            let wMid = midpointXZ(w.transform)
            let dx = oMid.0 - wMid.0
            let dz = oMid.1 - wMid.1
            let d = (dx * dx + dz * dz).squareRoot()
            if d < minDist {
                minDist = d
                parentId = w.identifier.uuidString

                // Project onto wall axis to get distance from wall start.
                let wLen = Double(w.dimensions.x)
                let dir = localXAxisXZ(w.transform)
                let half = wLen / 2.0
                let startX = wMid.0 - dir.0 * half
                let startZ = wMid.1 - dir.1 * half
                let relX = oMid.0 - startX
                let relZ = oMid.1 - startZ
                // dir is unit length (rotation matrix column) → dot product
                // is the signed offset along the wall from start → end.
                offset = relX * dir.0 + relZ * dir.1
            }
        }

        var out: [String: Any] = [
            "id": o.identifier.uuidString,
            "widthM": width,
            "heightM": height,
        ]
        if let p = parentId { out["parentWallId"] = p }
        if let off = offset, off.isFinite { out["offsetFromWallStartM"] = off }
        return out
    }

    // MARK: - Geometry primitives

    /// Pulls the translation column out of a 4x4 transform, keeping XZ.
    private static func midpointXZ(_ m: simd_float4x4) -> (Double, Double) {
        return (Double(m.columns.3.x), Double(m.columns.3.z))
    }

    /// The local +X axis of a RoomPlan Surface (expressed in world
    /// coordinates) is the along-wall direction. Column 0 of the 4x4
    /// is that axis; we project to XZ and keep it (already unit length).
    private static func localXAxisXZ(_ m: simd_float4x4) -> (Double, Double) {
        return (Double(m.columns.0.x), Double(m.columns.0.z))
    }

    /// Oriented bounding box + shoelace area + rectangularity test.
    ///
    /// Projects the floor polygon onto a `principal` axis (the
    /// direction of the room's longest wall) and its perpendicular,
    /// then measures the extent along each. The result hugs the room
    /// no matter how the device was held at the start of the scan.
    /// If no axis is supplied, falls back to the world-axis AABB —
    /// behaviour identical to the pre-fix version.
    private static func boundingMetrics(
        primary: [(Double, Double)],
        fallback: [(Double, Double)],
        axis: (Double, Double)? = nil
    ) -> (width: Double, length: Double, area: Double, rectangular: Bool) {
        let pts = primary.count >= 3 ? primary : fallback
        guard pts.count >= 3 else { return (0, 0, 0, false) }

        // Normalise the principal axis. If it ends up degenerate (length
        // zero, e.g. wall transform missing), fall back to world X.
        var ux = 1.0, uz = 0.0
        if let a = axis {
            let mag = (a.0 * a.0 + a.1 * a.1).squareRoot()
            if mag > 1e-6 {
                ux = a.0 / mag
                uz = a.1 / mag
            }
        }
        // Perpendicular axis (rotated 90° in the XZ plane).
        let px = -uz
        let pz = ux

        var minU = Double.greatestFiniteMagnitude
        var maxU = -Double.greatestFiniteMagnitude
        var minP = Double.greatestFiniteMagnitude
        var maxP = -Double.greatestFiniteMagnitude
        for p in pts {
            let u = p.0 * ux + p.1 * uz
            let v = p.0 * px + p.1 * pz
            if u < minU { minU = u }
            if u > maxU { maxU = u }
            if v < minP { minP = v }
            if v > maxP { maxP = v }
        }
        let extentU = maxU - minU
        let extentV = maxP - minP
        // Width ≥ length per the ScanDimensions convention.
        let width = max(extentU, extentV)
        let length = min(extentU, extentV)

        // Shoelace only meaningful for ordered polygons (floor polygon)
        // — the fallback point cloud has no ordering, so report
        // OBB area there and flag rectangular = true.
        if primary.count >= 3 {
            var s = 0.0
            for i in 0..<primary.count {
                let (x1, z1) = primary[i]
                let (x2, z2) = primary[(i + 1) % primary.count]
                s += x1 * z2 - x2 * z1
            }
            let area = abs(s) / 2.0
            let obbArea = extentU * extentV
            let rectangular = obbArea > 0 ? (area / obbArea) > 0.90 : false
            return (width, length, area, rectangular)
        } else {
            let area = extentU * extentV
            return (width, length, area, true)
        }
    }

    // MARK: - Whole-house structure

    /**
     * Serialise a merged CapturedStructure: several rooms, one frame.
     *
     * The single-room serialiser deliberately reports an ORIENTED
     * bounding box, because a room scanned at 45° to the world axes
     * would otherwise measure 25% too large. That is right for a room
     * on its own and wrong for a house: rooms have to keep their real
     * positions and angles relative to each other, or the plan is a pile
     * of rectangles rather than a building.
     *
     * So each room additionally carries `originM` (its footprint corner
     * in the shared frame) and `rotationDeg` (the bearing of its longest
     * wall). Together those place the room on the plan, which is what
     * makes a floor plan possible without asking the customer to drag
     * rooms around a grid.
     */
    @available(iOS 17.0, *)
    static func serializeStructure(
        structure: CapturedStructure,
        roomNames: [String],
        durationS: TimeInterval
    ) -> [String: Any] {
        var roomDicts: [[String: Any]] = []

        for (index, room) in structure.rooms.enumerated() {
            let wallDicts = room.walls.map { wallToDict($0) }
            let doorDicts = room.doors.map { openingToDict($0, walls: room.walls) }
            let windowDicts = room.windows.map { openingToDict($0, walls: room.walls) }
            let openingDicts = room.openings.map { openingToDict($0, walls: room.walls) }

            let floorPoly: [(Double, Double)] = room.floors.flatMap { floor in
                floor.polygonCorners.map { (Double($0.x), Double($0.z)) }
            }
            let fallbackPts: [(Double, Double)] = room.walls.flatMap { wallEndpoints(for: $0) }
            let pts = floorPoly.count >= 3 ? floorPoly : fallbackPts

            let principalAxis: (Double, Double)? = room.walls
                .max(by: { Double($0.dimensions.x) < Double($1.dimensions.x) })
                .map { localXAxisXZ($0.transform) }

            let (widthM, lengthM, areaM2, rectangular) = boundingMetrics(
                primary: floorPoly,
                fallback: fallbackPts,
                axis: principalAxis
            )

            // Axis-aligned corner in the SHARED frame. This is the room's
            // position on the plan; the oriented box above is its size.
            let minX = pts.map { $0.0 }.min() ?? 0
            let minZ = pts.map { $0.1 }.min() ?? 0

            // Bearing of the longest wall, measured clockwise from +X to
            // match the app's screen-down z convention.
            var rotationDeg = 0.0
            if let axis = principalAxis {
                rotationDeg = atan2(axis.1, axis.0) * 180.0 / Double.pi
                if rotationDeg < 0 { rotationDeg += 360 }
            }

            let heightM = room.walls.map { Double($0.dimensions.y) }.max() ?? 2.4
            let name = index < roomNames.count ? roomNames[index] : "Room \(index + 1)"

            // The true outline, in the shared frame.
            //
            // This was computed and then used only to derive a width and
            // a length, so an L-shaped room reached the drawing as a
            // rectangle with six wall lengths listed against it —
            // wrong in a way that looks finished. Capturing the shape of
            // an awkward room is the main thing a scan can do that a
            // tape and a form cannot, and it was being discarded one
            // step before anyone could use it.
            let polygonDicts: [[String: Any]] = pts.map { ["x": $0.0, "z": $0.1] }

            roomDicts.append([
                "id": UUID().uuidString,
                "name": name,
                "widthM": widthM,
                "lengthM": lengthM,
                "heightM": heightM,
                "floorAreaM2": areaM2,
                "rectangular": rectangular,
                "originM": ["x": minX, "z": minZ],
                "rotationDeg": rotationDeg,
                "floorPolygonM": polygonDicts,
                "walls": wallDicts,
                "doors": doorDicts,
                "windows": windowDicts,
                "openings": openingDicts,
            ])
        }

        return [
            "rooms": roomDicts,
            "durationS": durationS,
            "complete": true,
            "merged": true,
        ]
    }
}

#else
// ── RoomPlan framework not available in this SDK ────────────────────
// Shouldn't happen with modern Xcode (15+), but keeps the file
// compilable against older toolchains and unit-test targets that
// might not link RoomPlan.

@available(iOS 16.0, *)
class RoomCaptureRunner: NSObject {
    enum RoomPlanError: LocalizedError {
        case cancelled
        case captureFailed(String)
        case unsupported

        var errorDescription: String? {
            switch self {
            case .cancelled: return "Scan cancelled"
            case .captureFailed(let m): return m
            case .unsupported: return "RoomPlan framework is not linked in this build."
            }
        }
    }
    static func isSupportedOnThisDevice() -> Bool { return false }

    init(
        title: String,
        unit: String,
        completion: @escaping (Result<[String: Any], Error>) -> Void
    ) {
        super.init()
        // Fire the failure asynchronously to match the real runner's
        // "may resolve after present()" contract.
        DispatchQueue.main.async { completion(.failure(RoomPlanError.unsupported)) }
    }
    func present(from host: UIViewController) {}
    func dismiss(payload: Result<[String: Any], Error>) {}
    func userCancelled() {}
}
#endif
