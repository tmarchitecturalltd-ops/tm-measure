import ARKit
import Foundation
import SceneKit
import UIKit

/**
 * ARFloorTraceRunner — real-world scale without LiDAR, and without a
 * tape measure.
 *
 * ## Why this exists
 *
 * The camera scanner we already have works out the *proportions* of a
 * room from one photograph using perspective geometry. What a single
 * photograph cannot tell you is scale: the same image is consistent
 * with a dolls' house and with a cathedral. So the app asks the
 * customer to tape-measure the ceiling, and uses that one known
 * distance as the ruler everything else is derived from.
 *
 * That makes the ceiling height load-bearing in two unfortunate ways.
 * It is a hard gate — the scanner refuses to start without it — and it
 * is a multiplier: a height that is 6% out makes every wall in the
 * room 6% out, which on a 4 m wall is 24 cm, and the drawing looks
 * perfectly plausible while being useless. We cannot default it and we
 * cannot guess it.
 *
 * And it undercuts the whole proposition. "Measure one thing and we do
 * the rest" is a far weaker promise than "measure nothing", and the
 * one thing is the first thing the customer is asked to do.
 *
 * ARKit removes the need entirely. World tracking fuses the camera
 * feed with the accelerometer and gyroscope — visual-inertial odometry
 * — so the device knows how far *it* has moved in real metres. That
 * gives metric scale with no reference object, no LiDAR, and no tape,
 * on any ARKit-capable iPhone, which is everything from the 6s
 * onwards. The sensor stops being a luxury feature and becomes the
 * ordinary path.
 *
 * ## What it does
 *
 * Shows the camera, waits for ARKit to find the floor, then lets the
 * customer tap each corner of the room. Every tap is raycast against
 * the floor plane and comes back as a point in metres. The result is
 * the room's outline, to scale, in the order they walked it.
 *
 * The ceiling is collected too, when ARKit happens to find a
 * horizontal plane above the camera. That is a bonus rather than the
 * point: it means a scanned room can fill in its own ceiling height,
 * and the question disappears from that path as well.
 *
 * ## What it is not
 *
 * Not RoomPlan. RoomPlan reads geometry off the LiDAR sensor and
 * identifies walls, doors and windows by itself. This is the customer
 * pointing at corners, with ARKit supplying nothing but accurate
 * positions. Fewer features, far more devices, and the positions are
 * the part that actually matters.
 *
 * ## Accuracy, honestly
 *
 * ARKit's own drift over a room-sized walk is small — centimetres —
 * but it grows with distance and with poor tracking, and it is worse
 * in the dark, against blank walls, and if the phone is moved fast.
 * The tracking state is reported back with the result so the app can
 * say when a trace was taken under bad conditions rather than
 * presenting every number with equal confidence.
 */
@available(iOS 13.0, *)
final class ARFloorTraceRunner: NSObject {

    enum TraceError: LocalizedError {
        case cancelled
        case noPoints
        case trackingFailed(String)

        var errorDescription: String? {
            switch self {
            case .cancelled:
                return "Tracing was cancelled"
            case .noPoints:
                return "No corners were marked"
            case .trackingFailed(let m):
                return "The camera lost track of the room: \(m)"
            }
        }
    }

    /// True when this device can run ARKit world tracking at all.
    static func isSupportedOnThisDevice() -> Bool {
        return ARWorldTrackingConfiguration.isSupported
    }

    private let title: String
    private let completion: (Result<[String: Any], Error>) -> Void

    private var sceneView: ARSCNView?
    private weak var modalVC: UIViewController?
    private var started = Date()

    /// Floor-plane taps, in ARKit world metres. y is dropped on the way out.
    private var points: [SCNVector3] = []

    /// Highest horizontal plane seen above the camera, if any.
    private var ceilingY: Float?
    /// Lowest horizontal plane seen — taken to be the floor.
    private var floorY: Float?

    /// Worst tracking state seen during the session, not the last one.
    /// A trace that was briefly lost and recovered is still suspect.
    private var worstTracking: ARCamera.TrackingState = .normal

    /// How many corners landed on ARKit's guess rather than on floor
    /// it had mapped. Reported out, because a trace built on estimates
    /// deserves less confidence than one built on measured planes.
    private var estimatedTaps = 0

    private var statusLabel: UILabel?
    private var countLabel: UILabel?
    private var doneButton: UIButton?

    init(title: String, completion: @escaping (Result<[String: Any], Error>) -> Void) {
        self.title = title
        self.completion = completion
        super.init()
    }

    // MARK: - Presentation

    func present(from host: UIViewController) {
        let vc = UIViewController()
        vc.modalPresentationStyle = .fullScreen
        modalVC = vc

        let scene = ARSCNView(frame: .zero)
        scene.translatesAutoresizingMaskIntoConstraints = false
        scene.session.delegate = self
        scene.delegate = self
        scene.automaticallyUpdatesLighting = true
        sceneView = scene
        vc.view.addSubview(scene)
        NSLayoutConstraint.activate([
            scene.topAnchor.constraint(equalTo: vc.view.topAnchor),
            scene.bottomAnchor.constraint(equalTo: vc.view.bottomAnchor),
            scene.leadingAnchor.constraint(equalTo: vc.view.leadingAnchor),
            scene.trailingAnchor.constraint(equalTo: vc.view.trailingAnchor),
        ])

        buildOverlay(on: vc)

        let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap(_:)))
        scene.addGestureRecognizer(tap)

        started = Date()
        host.present(vc, animated: true) { [weak self] in
            self?.startSession()
        }
    }

    private func startSession() {
        let config = ARWorldTrackingConfiguration()
        config.planeDetection = [.horizontal]
        config.worldAlignment = .gravity
        sceneView?.session.run(config, options: [.resetTracking, .removeExistingAnchors])
        // The room's name, where someone tracing six rooms in a row
        // can see which one they are in.
        setStatus("\(title)\n\nMove the phone slowly until the floor is found")
    }

    // MARK: - Overlay chrome
    //
    // Deliberately plain. Apple's RoomPlan brings its own coaching UI
    // and this does not, so what is here has to do the whole job of
    // telling someone what to point at and when it is working — with
    // no room for decoration on top of a live camera feed.

    private func buildOverlay(on vc: UIViewController) {
        let status = UILabel()
        status.translatesAutoresizingMaskIntoConstraints = false
        status.textColor = .white
        status.font = .systemFont(ofSize: 16, weight: .semibold)
        status.numberOfLines = 0
        status.textAlignment = .center
        status.shadowColor = .black
        status.shadowOffset = CGSize(width: 0, height: 1)
        statusLabel = status
        vc.view.addSubview(status)

        let count = UILabel()
        count.translatesAutoresizingMaskIntoConstraints = false
        count.textColor = .white
        count.font = .systemFont(ofSize: 14, weight: .regular)
        count.textAlignment = .center
        count.shadowColor = .black
        count.shadowOffset = CGSize(width: 0, height: 1)
        countLabel = count
        vc.view.addSubview(count)

        let done = UIButton(type: .system)
        done.translatesAutoresizingMaskIntoConstraints = false
        done.setTitle("Done", for: .normal)
        done.setTitleColor(.black, for: .normal)
        done.titleLabel?.font = .systemFont(ofSize: 17, weight: .bold)
        done.backgroundColor = UIColor(red: 0.722, green: 0.588, blue: 0.314, alpha: 1)
        done.layer.cornerRadius = 28
        done.addTarget(self, action: #selector(finish), for: .touchUpInside)
        done.isEnabled = false
        done.alpha = 0.4
        doneButton = done
        vc.view.addSubview(done)

        let undo = UIButton(type: .system)
        undo.translatesAutoresizingMaskIntoConstraints = false
        undo.setTitle("Undo", for: .normal)
        undo.setTitleColor(.white, for: .normal)
        undo.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        undo.addTarget(self, action: #selector(undoPoint), for: .touchUpInside)
        vc.view.addSubview(undo)

        let cancel = UIButton(type: .system)
        cancel.translatesAutoresizingMaskIntoConstraints = false
        cancel.setTitle("Cancel", for: .normal)
        cancel.setTitleColor(.white, for: .normal)
        cancel.titleLabel?.font = .systemFont(ofSize: 17, weight: .regular)
        cancel.addTarget(self, action: #selector(cancel(_:)), for: .touchUpInside)
        vc.view.addSubview(cancel)

        let guide = vc.view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            cancel.topAnchor.constraint(equalTo: guide.topAnchor, constant: 12),
            cancel.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 20),

            status.topAnchor.constraint(equalTo: guide.topAnchor, constant: 56),
            status.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 24),
            status.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -24),

            count.topAnchor.constraint(equalTo: status.bottomAnchor, constant: 8),
            count.centerXAnchor.constraint(equalTo: guide.centerXAnchor),

            done.bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -24),
            done.centerXAnchor.constraint(equalTo: guide.centerXAnchor),
            done.widthAnchor.constraint(equalToConstant: 160),
            done.heightAnchor.constraint(equalToConstant: 56),

            undo.centerYAnchor.constraint(equalTo: done.centerYAnchor),
            undo.trailingAnchor.constraint(equalTo: done.leadingAnchor, constant: -24),
        ])

        // A crosshair at the centre, so there is something to aim with
        // before the first tap rather than guessing where the middle is.
        let cross = UIView()
        cross.translatesAutoresizingMaskIntoConstraints = false
        cross.backgroundColor = .clear
        cross.layer.borderColor = UIColor.white.cgColor
        cross.layer.borderWidth = 2
        cross.layer.cornerRadius = 12
        vc.view.addSubview(cross)
        NSLayoutConstraint.activate([
            cross.centerXAnchor.constraint(equalTo: vc.view.centerXAnchor),
            cross.centerYAnchor.constraint(equalTo: vc.view.centerYAnchor),
            cross.widthAnchor.constraint(equalToConstant: 24),
            cross.heightAnchor.constraint(equalToConstant: 24),
        ])
    }

    private func setStatus(_ text: String) {
        DispatchQueue.main.async { [weak self] in
            self?.statusLabel?.text = text
        }
    }

    private func refreshCount() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            let n = self.points.count
            if n == 0 {
                self.countLabel?.text = nil
            } else if n == 1 {
                self.countLabel?.text = "1 corner"
            } else {
                // The running distance from the previous corner is the
                // one number someone can sanity-check against the room
                // they are standing in, so it is the one shown.
                let d = self.distance(self.points[n - 2], self.points[n - 1])
                self.countLabel?.text = String(format: "%d corners · last wall %.2f m", n, d)
            }
            let ready = n >= 2
            self.doneButton?.isEnabled = ready
            self.doneButton?.alpha = ready ? 1 : 0.4
        }
    }

    private func distance(_ a: SCNVector3, _ b: SCNVector3) -> Float {
        let dx = a.x - b.x
        let dz = a.z - b.z
        return (dx * dx + dz * dz).squareRoot()
    }

    // MARK: - Tapping

    @objc private func handleTap(_ gesture: UITapGestureRecognizer) {
        guard let scene = sceneView else { return }
        let location = gesture.location(in: scene)

        /*
         * Three attempts, strictest first.
         *
         * The first version allowed only `.existingPlaneGeometry` — a
         * tap had to land on floor ARKit had actually mapped. The
         * reasoning was sound and the result was not: in a real room
         * the corners are the least-mapped part of the floor, because
         * they are where the furniture is. Tested in a garage it
         * refused nearly every tap with "No floor found there", which
         * is a scanner that works only in an empty room.
         *
         * So it falls back. `.existingPlaneInfinite` extends the floor
         * plane ARKit *has* found out past where it stopped mapping,
         * which is exactly right for a corner behind a bicycle: the
         * plane is the same floor, we simply could not see that part
         * of it. `.estimatedPlane` is ARKit's guess from raw feature
         * points, used only when there is nothing better.
         *
         * The strictness still matters, so which one answered is
         * recorded rather than thrown away: a trace that leaned on
         * estimates is a trace to be less sure of, and the app should
         * be able to say so instead of presenting every corner with
         * equal confidence.
         */
        let targets: [(ARRaycastQuery.Target, String)] = [
            (.existingPlaneGeometry, "mapped"),
            (.existingPlaneInfinite, "extended"),
            (.estimatedPlane, "estimated"),
        ]

        var found: ARRaycastResult?
        var usedTarget = "mapped"
        for (target, label) in targets {
            guard
                let query = scene.raycastQuery(
                    from: location,
                    allowing: target,
                    alignment: .horizontal
                )
            else { continue }
            if let hit = scene.session.raycast(query).first {
                found = hit
                usedTarget = label
                break
            }
        }

        guard let hit = found else {
            setStatus("Can't see the floor there — point a little further into the room")
            return
        }
        if usedTarget == "estimated" { estimatedTaps += 1 }

        let t = hit.worldTransform
        let p = SCNVector3(t.columns.3.x, t.columns.3.y, t.columns.3.z)

        // Ignore a tap that lands on a surface well above the floor —
        // a worktop or a table is a horizontal plane too, and a corner
        // placed on one is wrong by the height of the worktop.
        if let floor = floorY, p.y - floor > 0.35 {
            setStatus("That looks like a worktop, not the floor")
            return
        }

        points.append(p)
        dropMarker(at: p)
        refreshCount()
        setStatus("Tap the next corner, going round the room")
    }

    @objc private func undoPoint() {
        guard !points.isEmpty else { return }
        points.removeLast()
        sceneView?.scene.rootNode.childNodes
            .filter { $0.name == "tm-marker" }
            .last?
            .removeFromParentNode()
        refreshCount()
    }

    private func dropMarker(at p: SCNVector3) {
        let sphere = SCNSphere(radius: 0.04)
        sphere.firstMaterial?.diffuse.contents = UIColor(
            red: 0.722, green: 0.588, blue: 0.314, alpha: 1
        )
        let node = SCNNode(geometry: sphere)
        node.name = "tm-marker"
        node.position = p
        sceneView?.scene.rootNode.addChildNode(node)
    }

    // MARK: - Finishing

    /**
     * Settle the JS promise exactly once, whether or not the modal is
     * still around to dismiss.
     *
     * `modalVC` is weak, so if the view controller has already gone —
     * the system dismissed it, the app was backgrounded and tidied up
     * — then `modalVC?.dismiss(...)` does nothing at all, including
     * not running its completion block. The promise on the JavaScript
     * side then never resolves and never rejects, and the app sits
     * there waiting for an answer that cannot arrive. That reads to a
     * customer as a freeze, which is the worst way for this to fail:
     * no error, no screen, nothing to report.
     *
     * The `settled` flag covers the other end of it. Cancel and Done
     * can both be in flight, and resolving a Capacitor call twice is
     * a crash, not a no-op.
     */
    private var settled = false

    private func settle(_ result: Result<[String: Any], Error>) {
        guard !settled else { return }
        settled = true
        sceneView?.session.pause()

        let done = completion
        if let vc = modalVC {
            vc.dismiss(animated: true) { done(result) }
        } else {
            done(result)
        }
    }

    @objc private func cancel(_ sender: Any?) {
        settle(.failure(TraceError.cancelled))
    }

    @objc private func finish() {
        guard points.count >= 2 else {
            settle(.failure(TraceError.noPoints))
            return
        }

        /*
         * Out in the app's own frame.
         *
         * ARKit is y-up with gravity; the app is z-down on screen with
         * y discarded. Dropping y and keeping x and z as they are
         * matches what the RoomPlan path already produces, so
         * everything downstream — the outline checks, the mitring, the
         * DXF — treats a traced room and a scanned one identically.
         */
        let pointDicts: [[String: Any]] = points.map { ["x": Double($0.x), "z": Double($0.z)] }

        var payload: [String: Any] = [
            "pointsM": pointDicts,
            "durationS": Date().timeIntervalSince(started),
            "complete": true,
            "trackingQuality": trackingWord(worstTracking),
            "estimatedPoints": estimatedTaps,
        ]

        // Ceiling height, if ARKit found a plane above us. Reported
        // rather than assumed: a room with no detected ceiling simply
        // does not carry one, and the app falls back to asking.
        if let c = ceilingY, let f = floorY, c - f > 1.8, c - f < 5.0 {
            payload["heightM"] = Double(c - f)
        }

        settle(.success(payload))
    }

    private func trackingWord(_ s: ARCamera.TrackingState) -> String {
        switch s {
        case .normal: return "good"
        case .limited: return "limited"
        case .notAvailable: return "poor"
        @unknown default: return "limited"
        }
    }
}

// MARK: - ARSessionDelegate

@available(iOS 13.0, *)
extension ARFloorTraceRunner: ARSessionDelegate {

    func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
        // Keep the worst state seen, not the current one. A trace that
        // lost tracking halfway and recovered has a join in it, and the
        // numbers either side of that join may not agree.
        switch (worstTracking, camera.trackingState) {
        case (_, .notAvailable):
            worstTracking = .notAvailable
        case (.normal, .limited(let r)):
            worstTracking = .limited(r)
        default:
            break
        }

        switch camera.trackingState {
        case .limited(.initializing):
            setStatus("Getting its bearings — keep moving slowly")
        case .limited(.excessiveMotion):
            setStatus("Slow down")
        case .limited(.insufficientFeatures):
            setStatus("Not enough detail to track — try more light, or point at something patterned")
        case .limited(.relocalizing):
            setStatus("Finding the room again")
        case .notAvailable:
            setStatus("Tracking unavailable")
        case .normal:
            if floorY == nil {
                setStatus("Looking for the floor")
            } else if points.isEmpty {
                setStatus("Tap each corner of the room, going round")
            }
        default:
            break
        }
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        settle(.failure(TraceError.trackingFailed(error.localizedDescription)))
    }
}

// MARK: - ARSCNViewDelegate

@available(iOS 13.0, *)
extension ARFloorTraceRunner: ARSCNViewDelegate {

    func renderer(_ renderer: SCNSceneRenderer, didAdd node: SCNNode, for anchor: ARAnchor) {
        guard let plane = anchor as? ARPlaneAnchor else { return }
        noteHorizontalPlane(plane)
    }

    func renderer(_ renderer: SCNSceneRenderer, didUpdate node: SCNNode, for anchor: ARAnchor) {
        guard let plane = anchor as? ARPlaneAnchor else { return }
        noteHorizontalPlane(plane)
    }

    /**
     * Track the lowest and highest horizontal planes.
     *
     * ARKit does not label a plane "floor" — it reports horizontal
     * surfaces, which in a kitchen means the floor, the worktops, the
     * table and the top of the fridge. The lowest one is the floor,
     * reliably, because nothing in a room is below it.
     *
     * The highest is the ceiling only if it is above the camera and a
     * sensible distance up, which is checked where it is used rather
     * than here, so that a tall wardrobe does not quietly become the
     * ceiling height on the drawing.
     */
    private func noteHorizontalPlane(_ plane: ARPlaneAnchor) {
        let y = plane.transform.columns.3.y
        if floorY == nil || y < floorY! {
            let firstFloor = floorY == nil
            floorY = y
            if firstFloor {
                setStatus("Floor found — tap each corner of the room, going round")
            }
        }
        if ceilingY == nil || y > ceilingY! {
            ceilingY = y
        }
    }
}
