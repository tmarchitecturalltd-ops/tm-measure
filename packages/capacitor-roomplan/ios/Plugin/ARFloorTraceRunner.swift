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

    /**
     * What this session is for.
     *
     * Two jobs, one ARKit setup. Tracing a floor and measuring a
     * height need the same session, the same plane detection, the
     * same readiness rules and the same raycast fallback — they
     * differ only in what the taps mean and when Done lights up.
     * Splitting them into two classes would mean maintaining that
     * machinery twice and discovering, a year from now, that only
     * one copy got a fix.
     */
    enum Mode {
        /// Tap each corner; returns the room's outline.
        case floor
        /// Tap floor then ceiling; returns the height between them.
        case height
    }

    private let mode: Mode
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

    /// Tracking right now. Starts limited, because it always does —
    /// assuming normal before ARKit has said so is what let the first
    /// test record four corners of nothing.
    private var currentTracking: ARCamera.TrackingState = .limited(.initializing)

    /// How many corners landed on ARKit's guess rather than on floor
    /// it had mapped. Reported out, because a trace built on estimates
    /// deserves less confidence than one built on measured planes.
    private var estimatedTaps = 0

    private var crosshair: UIView?
    private var readySpinner: UIActivityIndicatorView?
    private var statusLabel: UILabel?
    private var countLabel: UILabel?
    private var doneButton: UIButton?

    init(
        mode: Mode = .floor,
        title: String,
        completion: @escaping (Result<[String: Any], Error>) -> Void
    ) {
        self.mode = mode
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
        // Vertical planes as well, for the height mode. A wall is the
        // easiest thing in a room for ARKit to lock onto — skirting,
        // sockets, picture edges — where a plain ceiling is the
        // hardest, so a tap near the wall-to-ceiling junction has
        // something to land on even when the ceiling itself offers
        // nothing. Harmless in floor mode: the raycasts there ask for
        // horizontal alignment and never see them.
        config.planeDetection = [.horizontal, .vertical]
        config.worldAlignment = .gravity
        sceneView?.session.run(config, options: [.resetTracking, .removeExistingAnchors])
        // The room's name, where someone doing six rooms in a row can
        // see which one they are in.
        // Say how long, and say what it is doing. "Please wait" with
        // no end in sight is why people tap at a camera feed that is
        // not ready yet.
        setStatus(
            "\(title)\n\nGetting ready — hold the phone up and move it slowly "
                + "around the room. This takes a few seconds."
        )
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

        /*
         * A spinner, because "wait" has to look like waiting.
         *
         * ARKit needs several seconds of movement before it can place
         * anything, and during that time the screen is a live camera
         * feed that looks completely ready. The only sign otherwise
         * was a line of text, which people read once and then ignore
         * while they tap at a scene that appears to be working. A
         * spinner is the one piece of UI everybody already reads as
         * "not yet", without reading anything.
         */
        let spinner = UIActivityIndicatorView(style: .large)
        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.color = .white
        spinner.hidesWhenStopped = true
        spinner.startAnimating()
        readySpinner = spinner
        vc.view.addSubview(spinner)

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

        /*
         * How many corners? — a stepper, floor mode only.
         *
         * Sits above the buttons rather than on a screen of its own.
         * A question asked before the camera opens is a question
         * answered before you can see the room; here it can be
         * adjusted at the moment you notice the alcove.
         */
        let cornerRow = UIStackView()
        cornerRow.translatesAutoresizingMaskIntoConstraints = false
        cornerRow.axis = .horizontal
        cornerRow.alignment = .center
        cornerRow.spacing = 14
        cornerRow.isHidden = mode == .height

        let fewer = UIButton(type: .system)
        fewer.setTitle("−", for: .normal)
        fewer.titleLabel?.font = .systemFont(ofSize: 26, weight: .medium)
        fewer.setTitleColor(.white, for: .normal)
        fewer.addTarget(self, action: #selector(fewerCorners), for: .touchUpInside)
        fewer.widthAnchor.constraint(equalToConstant: 44).isActive = true
        fewer.heightAnchor.constraint(equalToConstant: 44).isActive = true

        let cornerLabel = UILabel()
        cornerLabel.textColor = .white
        cornerLabel.font = .systemFont(ofSize: 15, weight: .semibold)
        cornerLabel.textAlignment = .center
        cornerLabel.shadowColor = .black
        cornerLabel.shadowOffset = CGSize(width: 0, height: 1)
        cornerCountLabel = cornerLabel

        let more = UIButton(type: .system)
        more.setTitle("+", for: .normal)
        more.titleLabel?.font = .systemFont(ofSize: 26, weight: .medium)
        more.setTitleColor(.white, for: .normal)
        more.addTarget(self, action: #selector(moreCorners), for: .touchUpInside)
        more.widthAnchor.constraint(equalToConstant: 44).isActive = true
        more.heightAnchor.constraint(equalToConstant: 44).isActive = true

        cornerRow.addArrangedSubview(fewer)
        cornerRow.addArrangedSubview(cornerLabel)
        cornerRow.addArrangedSubview(more)
        vc.view.addSubview(cornerRow)

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

            spinner.topAnchor.constraint(equalTo: count.bottomAnchor, constant: 20),
            spinner.centerXAnchor.constraint(equalTo: guide.centerXAnchor),

            cornerRow.bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -96),
            cornerRow.centerXAnchor.constraint(equalTo: guide.centerXAnchor),

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
        cross.layer.borderColor = UIColor.white.withAlphaComponent(0.5).cgColor
        cross.layer.borderWidth = 2
        cross.layer.cornerRadius = 12
        crosshair = cross
        vc.view.addSubview(cross)
        NSLayoutConstraint.activate([
            cross.centerXAnchor.constraint(equalTo: vc.view.centerXAnchor),
            cross.centerYAnchor.constraint(equalTo: vc.view.centerYAnchor),
            cross.widthAnchor.constraint(equalToConstant: 24),
            cross.heightAnchor.constraint(equalToConstant: 24),
        ])
    }

    /**
     * Show whether a tap would be accepted, before one is tried.
     *
     * The guard in handleTap is correct and invisible: someone who
     * taps too early gets told off for doing something the screen
     * never suggested was unavailable. The crosshair turns gold when
     * both conditions hold, so readiness is something you can see
     * rather than something you discover.
     */
    private func refreshReadiness() {
        let ready: Bool
        if case .normal = currentTracking, floorY != nil {
            ready = true
        } else {
            ready = false
        }
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.crosshair?.layer.borderColor =
                (ready
                    ? UIColor(red: 0.722, green: 0.588, blue: 0.314, alpha: 1)
                    : UIColor.white.withAlphaComponent(0.5)).cgColor
            self.crosshair?.layer.borderWidth = ready ? 3 : 2
            if ready {
                self.readySpinner?.stopAnimating()
            } else {
                self.readySpinner?.startAnimating()
            }

            // Say it once, at the moment it becomes true, rather than
            // overwriting whatever the last tap said.
            if ready && !self.announcedReady {
                self.announcedReady = true
                self.setStatus(
                    self.mode == .height
                        ? "Ready. Tap where the wall meets the floor."
                        : "Ready. Tap each corner once, going round — aim where two walls "
                            + "meet the floor, not the furniture in front of it. Don't tap "
                            + "the first corner again at the end; the room closes itself."
                )
            }
        }
    }

    /// "Ready" is announced once. Repeating it over a later
    /// instruction would be the app talking over itself.
    private var announcedReady = false

    /**
     * How many corners this room is expected to have.
     *
     * Four by default, because almost every room has four, and the
     * customer can change it before they start.
     *
     * This is a guide, not a rule. Knowing the target is what lets
     * the screen say "corner 3 of 4" instead of "3 corners", and
     * "that's all four — press Done" instead of leaving someone to
     * work out for themselves whether they have been all the way
     * round. Without it the only signal that a trace was complete
     * was the person's own memory of which corner they started at,
     * which is exactly the thing that made them tap the first corner
     * twice and put a zero-length wall in the drawing.
     *
     * Going over is allowed and only remarked on. Somebody who said
     * four and finds a fifth corner has discovered an alcove, which
     * is the single most valuable thing a survey can record — being
     * told "no" at that moment would lose it.
     */
    private var expectedCorners = 4
    private var cornerCountLabel: UILabel?

    private func setStatus(_ text: String) {
        DispatchQueue.main.async { [weak self] in
            self?.statusLabel?.text = text
        }
    }

    private func refreshCount() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            let n = self.points.count
            if self.mode == .height {
                // The number being measured, shown as it is measured.
                // Nobody can check a height they cannot see.
                if n >= 2 {
                    let h = abs(self.points[n - 1].y - self.points[n - 2].y)
                    self.countLabel?.text = String(format: "%.2f m", h)
                } else {
                    self.countLabel?.text = n == 1 ? "floor marked" : nil
                }
                let ready = n >= 2
                self.doneButton?.isEnabled = ready
                self.doneButton?.alpha = ready ? 1 : 0.4
                return
            }
            // "Corners: 4" before you start, "3 of 4" once you have.
            self.cornerCountLabel?.text =
                n == 0
                    ? "Corners: \(self.expectedCorners)"
                    : "\(n) of \(self.expectedCorners)"

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

            /*
             * Done lights up once the room could be a room, and is
             * called out once it matches what was asked for.
             *
             * Three points is the fewest that enclose anything, so
             * that is when the button becomes usable. But "usable"
             * and "finished" are different, and the gap between them
             * is where people tapped the first corner a second time
             * looking for a signal that they had gone all the way
             * round. On the last expected corner the button says so.
             */
            let usable = n >= 3
            self.doneButton?.isEnabled = usable
            self.doneButton?.alpha = usable ? 1 : 0.4
            let complete = n >= self.expectedCorners
            self.doneButton?.setTitle(complete ? "Done ✓" : "Done", for: .normal)
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

        /*
         * Nothing is recorded until ARKit is actually ready.
         *
         * The first field test produced a four-corner kitchen with
         * walls of 0.65, 0.43, 0.42 and 0.32 m, and reported tracking
         * as "limited". Those two facts are the same fact. While
         * world tracking is still initialising, ARKit has not yet
         * resolved the scale of anything, and the positions it hands
         * back are provisional — they tend to sit close together near
         * the origin. Tapping during that window produces a room the
         * size of a shoebox, with no error and no warning, because
         * every individual step worked exactly as written.
         *
         * That is the worst failure available to a measuring tool:
         * confident, specific, and wrong. A refused tap is a nuisance
         * for a second; a plausible wrong number can reach a drawing.
         *
         * So both conditions have to hold — tracking normal, and a
         * floor plane actually found — and until they do the tap is
         * turned away with the reason. The customer is standing in
         * the room and can fix it by moving the phone about for a few
         * more seconds, which is all ARKit is asking for.
         */
        guard case .normal = currentTracking else {
            setStatus("Not ready yet — keep moving the phone slowly until this message clears")
            return
        }
        // Floor mode needs a floor to measure against. Height mode
        // does not: it is the distance between two taps, and nothing
        // about that needs ARKit to have decided which surface is the
        // ground.
        if mode == .floor, floorY == nil {
            setStatus("Still looking for the floor — point at it and move slowly")
            return
        }

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

        // Height mode accepts any surface. It uses only the vertical
        // component of the hit, so whether the tap landed on the
        // ceiling, the top of the wall, or the coving between them
        // makes no practical difference — they are all at ceiling
        // height. Insisting on horizontal there would reject the
        // easiest thing in the room to aim at.
        let alignment: ARRaycastQuery.TargetAlignment =
            mode == .height ? .any : .horizontal

        var found: ARRaycastResult?
        var usedTarget = "mapped"
        for (target, label) in targets {
            guard
                let query = scene.raycastQuery(
                    from: location,
                    allowing: target,
                    alignment: alignment
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

        if mode == .floor {
            // Ignore a tap that lands on a surface well above the
            // floor — a worktop or a table is a horizontal plane too,
            // and a corner placed on one is wrong by the height of
            // the worktop.
            if let floor = floorY, p.y - floor > 0.35 {
                setStatus("That looks like a worktop, not the floor")
                return
            }
            /*
             * Refuse a corner on top of the last one.
             *
             * Two things produce a duplicate. A double tap, and —
             * more often — someone closing the loop by tapping the
             * first corner again at the end, which is the intuitive
             * thing to do and which nothing on screen discourages.
             * Either way it puts a zero-length wall in the drawing,
             * and a zero-length wall is a thing a draughtsman has to
             * stop and ask about.
             *
             * The outline closes itself, so tapping back at the start
             * means finished. Said out loud, because otherwise the
             * tap simply appears not to have registered.
             */
            if let last = points.last, distance(last, p) < 0.15 {
                setStatus("That's the same corner — tap the next one along")
                return
            }
            if points.count >= 3, let first = points.first, distance(first, p) < 0.4 {
                setStatus("Back at the start — the room closes itself, so press Done")
                return
            }

            points.append(p)
            dropMarker(at: p)
            refreshCount()
            /*
             * Three messages, and which one you get is the point.
             *
             * Repeating the furniture reminder rather than saying it
             * once: that mistake is made on the fourth corner as
             * easily as the first, and by then any opening
             * instruction is long gone.
             *
             * The completion message is the one that earns its
             * place. Without it, the only way to know you had been
             * all the way round was to remember where you started —
             * and the thing people did instead was tap the first
             * corner again to see if something happened.
             */
            let n = points.count
            if n >= expectedCorners {
                setStatus(
                    "That's all \(expectedCorners) corners — press Done. "
                        + "Found another one? Tap it, the count will follow."
                )
            } else if n >= 2 {
                setStatus(
                    "Corner \(n) of \(expectedCorners). Next one round — aim where the walls meet the floor."
                )
            } else {
                setStatus(
                    "Good. Next corner, going round the same way — aim where the walls meet the floor, not the furniture."
                )
            }
            return
        }

        /*
         * Height mode: two taps, and only the second one can be wrong
         * in a way that matters.
         *
         * Keeping just the last two means a mis-tap is corrected by
         * tapping again rather than by finding Undo — which is the
         * natural thing to do when you can see the marker landed in
         * the wrong place, and the thing people do regardless of what
         * the buttons say.
         */
        points.append(p)
        if points.count > 2 { points.removeFirst(points.count - 2) }
        dropMarker(at: p)
        refreshCount()
        setStatus(
            points.count < 2
                ? "Now tap where that same wall meets the ceiling"
                : "Tap again to adjust, or press Done"
        )
    }

    /*
     * Three is the fewest a room can have; twelve is more corners
     * than anyone will tap before giving up and ringing us, and the
     * upper bound exists only to stop the counter being nonsense.
     * Never below the number already placed — the label would then
     * be counting down past zero.
     */
    @objc private func fewerCorners() {
        expectedCorners = max(3, max(points.count, expectedCorners - 1))
        refreshCount()
    }

    @objc private func moreCorners() {
        expectedCorners = min(12, expectedCorners + 1)
        refreshCount()
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

        if mode == .height {
            let h = abs(points[points.count - 1].y - points[points.count - 2].y)
            /*
             * Refuse a figure that cannot be a ceiling.
             *
             * Two taps on the same surface give nearly zero; a tap
             * that fell through to a wildly estimated plane can give
             * ten metres. Neither is a room, and either would be
             * believed — this number goes on a drawing and nothing
             * downstream has any way to tell it is nonsense. The
             * bounds are generous: 1.8 m is lower than any habitable
             * room and 4.5 m higher than almost any house, so a real
             * measurement will never be turned away.
             */
            guard h >= 1.8, h <= 4.5 else {
                setStatus(
                    String(
                        format:
                            "That came out at %.2f m, which isn't a ceiling. Tap the floor, then the ceiling above it.",
                        h
                    )
                )
                points.removeAll()
                sceneView?.scene.rootNode.childNodes
                    .filter { $0.name == "tm-marker" }
                    .forEach { $0.removeFromParentNode() }
                refreshCount()
                return
            }
            settle(
                .success([
                    "heightM": Double(h),
                    "durationS": Date().timeIntervalSince(started),
                    "complete": true,
                    "trackingQuality": trackingWord(worstTracking),
                    "estimatedPoints": estimatedTaps,
                ])
            )
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
        currentTracking = camera.trackingState
        refreshReadiness()

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
            setStatus("Getting ready — keep moving the phone slowly. A few more seconds.")
        case .limited(.excessiveMotion):
            setStatus("Too fast — move the phone more slowly")
        case .limited(.insufficientFeatures):
            setStatus(
                "Not enough detail to track. Turn a light on, or point at a "
                    + "patterned surface for a moment."
            )
        case .limited(.relocalizing):
            setStatus("Lost the room for a second — hold still while it finds it again")
        case .notAvailable:
            setStatus("Tracking unavailable")
        case .normal:
            if floorY == nil && mode == .floor {
                setStatus("Nearly — point the phone down at the floor and move slowly")
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
            refreshReadiness()
        }
        if ceilingY == nil || y > ceilingY! {
            ceilingY = y
        }
    }
}
