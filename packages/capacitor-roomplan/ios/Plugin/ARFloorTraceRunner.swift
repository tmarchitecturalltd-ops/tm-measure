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

    /**
     * Marking the doors and windows, after the floor is traced.
     *
     * A phone without LiDAR has no depth mesh, and RoomPlan's
     * classifier is the thing that recognises an opening, so
     * nothing on this path can find a window by itself. It returned
     * corners and a ceiling height and that was all -- which is
     * most iPhones, since every non-Pro model is on this path.
     *
     * Detecting them from the camera was the obvious idea and the
     * wrong one. Vision will happily find bright rectangles on a
     * wall, and so will a mirror, a television, a picture and a
     * pair of curtains; a window that is not there, on a drawing
     * somebody prices glazing from, is worse than one that is
     * missing.
     *
     * So the customer points and the sensor measures. Two taps per
     * opening -- one bottom corner, then the other -- and the width
     * is the distance between them, which ARKit knows to the
     * centimetre. The position along the wall comes out of the same
     * two points. Nothing is typed and nothing is estimated; the
     * only thing being asked of the person is which rectangle on
     * the wall is a window, which they can see and the sensor
     * cannot.
     *
     * Done in the same session as the floor trace, deliberately.
     * Stopping and restarting would give the openings their own
     * world origin and leave them to be matched to the outline by
     * guesswork -- the same mistake that was dropping internal
     * walls out of whole-property scans.
     */
    enum OpeningKind: String {
        case door
        case window
        case opening
    }

    /// A finished opening: both bottom corners, in world metres.
    private struct MarkedOpening {
        let kind: OpeningKind
        let a: SCNVector3
        let b: SCNVector3
    }

    private var openings: [MarkedOpening] = []
    /// The first corner of the opening being marked, if one is part-done.
    private var pendingCorner: SCNVector3?
    private var openingKind: OpeningKind = .window
    /// True once the floor is finished and we are marking openings.
    private var markingOpenings = false

    /// Highest horizontal plane seen above the camera, if any.
    private var ceilingY: Float?
    /// Lowest horizontal plane seen — taken to be the floor.
    private var floorY: Float?

    /**
     * The walls, as lines on the floor.
     *
     * Each detected vertical plane reduced to the line it makes
     * when you look down on it: a point it passes through and the
     * direction it runs, both in metres on the horizontal.
     *
     * This is what makes a corner measurable rather than guessed.
     * See snapToCorner.
     */
    private var wallLines: [UUID: (p: SIMD2<Float>, d: SIMD2<Float>, half: Float)] = [:]
    /// Largest floor plane mapped so far, in square metres. See
    /// noteHorizontalPlane: this is what readiness waits on.
    private var floorAreaM2: Double = 0
    /// Enough mapped floor to trust a tap. About what you see
    /// walking into a small bedroom and turning round.
    /*
     * Down from 4.0, because the taps it was protecting are no
     * longer fragile.
     *
     * Four square metres was set when a tap was only ever a raycast
     * onto mapped floor, so the gate was the only thing standing
     * between a thin scrap of plane and a trace built on ARKit's
     * guesses. A corner now falls back to a wall crossing and then
     * to the floor plane itself, neither of which needs the floor
     * mapped at that spot, so most of what the gate was buying is
     * bought elsewhere.
     *
     * What is left is the wait, and the wait is the thing people
     * complain about: it was reported as taking some time to
     * calibrate before anything could be tapped. Two and a half
     * square metres is still a proper look at the floor -- a couple
     * of seconds of sweeping, not a scrap -- and it is reached
     * noticeably sooner.
     */
    private let minFloorAreaM2: Double = 2.5

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

    /// How many corners came from a wall intersection rather than
    /// from where the thumb landed. The higher this is, the less the
    /// drawing depends on anyone's aim. See snapToCorner.
    private var snappedTaps = 0

    private var crosshair: UIView?
    private var readySpinner: UIActivityIndicatorView?
    private var statusLabel: UILabel?
    private var countLabel: UILabel?
    /// The corner stepper, hidden once the floor is done.
    private var cornerStepper: UIStackView?
    /// Door / window / opening, shown in its place.
    private var kindPicker: UISegmentedControl?
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
        // Vertical planes earn their keep twice.
        //
        // In height mode a wall is the easiest thing in a room for
        // ARKit to lock onto — skirting, sockets, picture edges —
        // where a plain ceiling is the hardest, so a tap near the
        // wall-to-ceiling junction has something to land on even
        // when the ceiling itself offers nothing.
        //
        // In floor mode they are where the measurements now come
        // from: a corner is read as the place two walls cross, not
        // as the place a thumb landed. See snapToCorner.
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
        cornerStepper = cornerRow

        /*
         * Door, window or opening — the one thing the sensor cannot
         * work out for itself.
         *
         * Takes the stepper's place once the floor is traced, so
         * the two never compete for the same strip of screen. A
         * segmented control rather than three buttons because the
         * current choice has to be visible at a glance: every tap
         * for the next minute is labelled by it, and realising
         * afterwards that six windows went in as doors means doing
         * them all again.
         *
         * Window first and selected, because most rooms have more
         * windows than doors.
         */
        let kinds = UISegmentedControl(items: ["Door", "Window", "Opening"])
        kinds.translatesAutoresizingMaskIntoConstraints = false
        kinds.selectedSegmentIndex = 1
        kinds.selectedSegmentTintColor = UIColor(
            red: 0.722, green: 0.588, blue: 0.314, alpha: 1
        )
        kinds.backgroundColor = UIColor(white: 0, alpha: 0.5)
        kinds.setTitleTextAttributes([.foregroundColor: UIColor.white], for: .normal)
        kinds.setTitleTextAttributes([.foregroundColor: UIColor.black], for: .selected)
        kinds.addTarget(self, action: #selector(kindChanged(_:)), for: .valueChanged)
        kinds.isHidden = true
        vc.view.addSubview(kinds)
        kindPicker = kinds
        NSLayoutConstraint.activate([
            kinds.centerXAnchor.constraint(equalTo: cornerRow.centerXAnchor),
            kinds.centerYAnchor.constraint(equalTo: cornerRow.centerYAnchor),
            kinds.widthAnchor.constraint(equalToConstant: 280),
            kinds.heightAnchor.constraint(equalToConstant: 40),
        ])

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
        // Floor mode also waits on enough mapped floor; height mode
        // only needs tracking, since it measures between two taps
        // and has no floor to be wrong about.
        let ready: Bool
        if case .normal = currentTracking {
            ready =
                mode == .height
                || (floorY != nil && floorAreaM2 >= minFloorAreaM2)
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
            /*
             * "Next", not "Done", because it no longer finishes.
             *
             * This button now hands the floor trace over to marking
             * the doors and windows, and a button that says Done
             * and then shows you another screen is the app going
             * back on its word at the exact moment somebody thinks
             * they have finished.
             */
            self.doneButton?.setTitle(complete ? "Next ✓" : "Next", for: .normal)
        }
    }

    private func distance(_ a: SCNVector3, _ b: SCNVector3) -> Float {
        let dx = a.x - b.x
        let dz = a.z - b.z
        return (dx * dx + dz * dz).squareRoot()
    }

    // MARK: - Corners from walls

    /**
     * How far a tap may be moved onto a wall intersection.
     *
     * Wide enough to cover a thumb aimed into a shadowed corner from
     * three metres away, narrow enough that it cannot grab the wrong
     * corner: it is a rare room whose corners are less than 0.7 m
     * apart.
     */
    private let snapRadiusM: Float = 0.7

    /** Below this, two walls are parallel enough to be the same wall. */
    private let minCornerSine: Float = 0.5  // about 30 degrees

    /**
     * How near a tap has to land, on screen, to claim a corner whose
     * floor cannot be seen. About a thumb's width at 3x.
     */
    private let maxCornerTapDistancePx: CGFloat = 120

    /**
     * Move a tapped point onto the intersection of two walls.
     *
     * The measurement problem this exists to solve: three traces of
     * the same room came back with the long wall at 5.22, 5.80 and
     * 5.39 m. The room did not change. What changed was where a
     * thumb landed on a phone screen, pointed at a corner that was
     * four metres away and often behind a sofa. A tap is accurate to
     * roughly where you can see, and the drawing inherited that.
     *
     * But the corner is not really a point anyone needs to hit. It
     * is where two walls meet, and ARKit has already fitted both
     * walls across their whole visible length — tens of thousands of
     * depth samples each, averaged. Two long lines cross at one
     * place, and that place is known far better than any single
     * point on either of them.
     *
     * So the tap stops being the measurement and becomes the
     * question: *which* corner do you mean. The answer comes from
     * the walls. This is also why it degrades honestly — with only
     * one wall seen, or none, there is nothing to intersect and the
     * raw tap stands, exactly as before.
     *
     * Returns the snapped point, or nil to keep the tap.
     */
    /**
     * Every place two detected walls cross, on the floor.
     *
     * The room's corners, as the sensor understands them, with no
     * reference to where anyone has tapped.
     */
    private func cornerCandidates() -> [SIMD2<Float>] {
        guard wallLines.count >= 2 else { return [] }
        let walls = Array(wallLines.values)
        var out: [SIMD2<Float>] = []

        for i in 0..<walls.count {
            for j in (i + 1)..<walls.count {
                let a = walls[i]
                let b = walls[j]

                // Two lines cross once unless they are parallel. The
                // cross product is the sine of the angle between
                // them, both directions being unit length.
                let denom = a.d.x * b.d.y - a.d.y * b.d.x
                guard abs(denom) > minCornerSine else { continue }

                let delta = b.p - a.p
                let t = (delta.x * b.d.y - delta.y * b.d.x) / denom
                let x = a.p + a.d * t

                // Reject a crossing that is off the end of either
                // wall. Two walls on opposite sides of a hallway meet
                // somewhere out in the garden, and without this that
                // phantom is as eligible as a real corner.
                let overrunA = abs(t) - a.half
                let alongB = simd_dot(x - b.p, b.d)
                let overrunB = abs(alongB) - b.half
                guard overrunA < 1.0, overrunB < 1.0 else { continue }

                out.append(x)
            }
        }
        return out
    }

    private func snapToCorner(_ p: SCNVector3) -> SCNVector3? {
        let tap = SIMD2<Float>(p.x, p.z)
        var best: SIMD2<Float>?
        var bestDist = snapRadiusM

        for x in cornerCandidates() {
            let d = simd_length(x - tap)
            if d < bestDist {
                bestDist = d
                best = x
            }
        }

        guard let corner = best else { return nil }
        return SCNVector3(corner.x, p.y, corner.y)
    }

    /**
     * The corner being pointed at, when the floor under it cannot
     * be seen at all.
     *
     * The case this is for, reported from a hotel room: a bed
     * pushed into the corner. The floor there is not merely hidden,
     * it has never been mapped, so there is nothing to extend
     * underneath and every raycast comes back at mattress height.
     * The app then refused the tap — "sweep the phone over some
     * clear floor nearby" — and kept refusing, because no amount of
     * sweeping reveals floor that is under a bed. The corner was
     * untappable, and the trace went on without it, which is how a
     * six-corner room came back with a 6.91 m wall closing it.
     *
     * But the corner itself is in plain sight. Both walls run up
     * the picture above the headboard, and ARKit has already fitted
     * them. Only the floor is missing, and the floor height is a
     * number we already know.
     *
     * So this ignores depth entirely. Every wall crossing is
     * projected onto the screen and compared with the tap in
     * pixels, which is the one comparison that still works when
     * nothing along the ray is at the right distance. Pointing at
     * the corner is enough; what is piled in front of it does not
     * matter.
     *
     * Deliberately not used when the floor *is* visible — a reading
     * off the measured floor is better than one off two wall fits,
     * and this would quietly override it.
     */
    /**
     * Where the ray through the tap meets the floor, as a plane.
     *
     * The last resort, and the one that always has an answer.
     *
     * Everything above this asks ARKit what it can see: mapped floor
     * first, then the walls. Both can come up empty in the same
     * place at the same time — a corner with a bed in it, in a room
     * where only one wall has been fitted so far — and the tap was
     * then refused, with a message asking the customer to reveal
     * floor that is underneath a bed. Reported as having to tap a
     * clear corner first before the blocked one would work, which
     * is a real thing people found by trial and error and should
     * not have had to.
     *
     * But the floor is a plane, and its height is known. The bed
     * obstructs the *mesh*, not the plane — the floor does not stop
     * and start again on the other side of the furniture. So the ray
     * through the tap is intersected with that plane directly, which
     * is pure arithmetic and cannot fail for want of mapping.
     *
     * Last because it is the weakest of the three. It trusts the
     * aim, where a wall crossing does not, so it inherits whatever
     * error is in pointing at a corner four metres away. That is
     * still a measurement, and a measurement beats a refusal.
     */
    private func floorPlaneHit(_ location: CGPoint) -> SCNVector3? {
        guard let scene = sceneView, let floor = floorY else { return nil }

        let near = scene.unprojectPoint(
            SCNVector3(Float(location.x), Float(location.y), 0)
        )
        let far = scene.unprojectPoint(
            SCNVector3(Float(location.x), Float(location.y), 1)
        )
        let dy = far.y - near.y

        // Parallel to the floor: the ray is along the horizon and
        // never reaches it. Pointing at the wall, not the floor.
        guard abs(dy) > 1e-5 else { return nil }

        let t = (floor - near.y) / dy
        // Behind the camera, which is what a tap above the horizon
        // gives: the plane is met in the wrong direction.
        guard t > 0 else { return nil }

        let p = SCNVector3(
            near.x + (far.x - near.x) * t,
            floor,
            near.z + (far.z - near.z) * t
        )

        // A corner twenty metres away is the horizon, not a room.
        let cam = scene.pointOfView?.worldPosition ?? SCNVector3(0, 0, 0)
        let reach = distance(cam, p)
        guard reach < 15 else { return nil }

        return p
    }

    private func cornerAtScreenPoint(_ location: CGPoint) -> SCNVector3? {
        guard let scene = sceneView, let floor = floorY else { return nil }

        var best: SCNVector3?
        var bestPx = maxCornerTapDistancePx

        for c in cornerCandidates() {
            let world = SCNVector3(c.x, floor, c.y)
            let p = scene.projectPoint(world)
            // z outside 0...1 is behind the camera: the corner
            // behind you is not the one you are pointing at.
            guard p.z > 0, p.z < 1 else { continue }
            let dx = CGFloat(p.x) - location.x
            let dy = CGFloat(p.y) - location.y
            let px = (dx * dx + dy * dy).squareRoot()
            if px < bestPx {
                bestPx = px
                best = world
            }
        }
        return best
    }

    /**
     * Record a floor corner, wherever it came from.
     *
     * Shared by the two routes to a corner — a reading off the
     * mapped floor, and a wall crossing picked out of the picture
     * when there is no floor to read. Everything from here on is
     * the same either way, and the duplicate checks in particular
     * have to see both or a corner placed by one route could be
     * repeated by the other.
     */
    private func placeFloorCorner(_ p: SCNVector3, fromWalls: Bool) {
        /*
         * Refuse a corner on top of the last one.
         *
         * Two things produce a duplicate. A double tap, and — more
         * often — someone closing the loop by tapping the first
         * corner again at the end, which is the intuitive thing to
         * do and which nothing on screen discourages. Either way it
         * puts a zero-length wall in the drawing, and a zero-length
         * wall is a thing a draughtsman has to stop and ask about.
         *
         * The outline closes itself, so tapping back at the start
         * means finished. Said out loud, because otherwise the tap
         * simply appears not to have registered.
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
        if fromWalls { snappedTaps += 1 }
        dropMarker(at: p)
        refreshCount()

        /*
         * Three messages, and which one you get is the point.
         *
         * Repeating the furniture reminder rather than saying it
         * once: that mistake is made on the fourth corner as easily
         * as the first, and by then any opening instruction is long
         * gone.
         *
         * The completion message is the one that earns its place.
         * Without it, the only way to know you had been all the way
         * round was to remember where you started — and the thing
         * people did instead was tap the first corner again to see
         * if something happened.
         */
        let n = points.count
        if fromWalls {
            // Worth saying once per corner. Somebody who has just
            // been told twice that the floor cannot be found needs
            // to know the tap landed anyway, and why — otherwise
            // the sensible response is to move the bed.
            setStatus(
                "Got it from the walls, through the furniture. Corner \(n) of \(expectedCorners)."
            )
        } else if n >= expectedCorners {
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
    }

    // MARK: - Marking openings

    /**
     * A tap while marking doors and windows.
     *
     * Raycast against the walls rather than the floor: a window
     * sill is a metre up a vertical plane, and the floor-seeking
     * ladder that serves the corner trace would drag it down to
     * ground level.
     *
     * `.existingPlaneGeometry` first, so a tap only lands where
     * ARKit has actually fitted wall. The looser targets would
     * always return something -- an infinite plane extends a wall
     * across the whole room -- and a window measured against a
     * guess is a number with nothing behind it.
     */
    private func handleOpeningTap(_ location: CGPoint) {
        guard let scene = sceneView else { return }

        var hit: ARRaycastResult?
        for target in [
            ARRaycastQuery.Target.existingPlaneGeometry,
            .existingPlaneInfinite,
        ] {
            guard
                let q = scene.raycastQuery(
                    from: location,
                    allowing: target,
                    alignment: .vertical
                )
            else { continue }
            if let first = scene.session.raycast(q).first {
                hit = first
                break
            }
        }

        guard let found = hit else {
            setStatus(
                "Point at the wall around the opening for a moment, then tap its corner"
            )
            return
        }

        let t = found.worldTransform.columns.3
        let p = SCNVector3(t.x, t.y, t.z)

        guard let first = pendingCorner else {
            pendingCorner = p
            dropMarker(at: p, colour: .systemBlue)
            setStatus("Now the other bottom corner of the same \(openingKind.rawValue)")
            refreshOpeningCount()
            return
        }

        let w = distance(first, p)
        /*
         * Both taps on the same spot is a double tap, not an
         * opening. Three metres is wider than any domestic door or
         * window and usually means the second tap missed the wall
         * and landed on the one opposite.
         */
        if w < 0.15 {
            setStatus("That's the same corner — tap the other side of the opening")
            return
        }
        if w > 3.0 {
            setStatus(
                "That's \(String(format: "%.1f", w)) m apart, which is wider than an opening. Undo and try again"
            )
            return
        }

        openings.append(MarkedOpening(kind: openingKind, a: first, b: p))
        pendingCorner = nil
        dropMarker(at: p, colour: .systemBlue)
        setStatus(
            "\(openingKind.rawValue.capitalized) — \(String(format: "%.2f", w)) m. "
                + "Mark another, or press Done."
        )
        refreshOpeningCount()
    }

    private func refreshOpeningCount() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let n = self.openings.count
            let half = self.pendingCorner != nil
            self.countLabel?.text = half
                ? "\(n) marked · tap the other corner"
                : "\(n) marked"
            // Done is always available here: a room with no windows
            // is a real answer, and this step is an addition to a
            // trace that has already succeeded.
            self.doneButton?.setTitle("Done", for: .normal)
            self.doneButton?.isEnabled = true
            self.doneButton?.alpha = 1
        }
    }

    // MARK: - Tapping

    @objc private func handleTap(_ gesture: UITapGestureRecognizer) {
        guard let scene = sceneView else { return }

        // Marking doors and windows is a different question against
        // different surfaces, so it gets its own handler rather than
        // another branch inside the corner logic. See
        // handleOpeningTap.
        if markingOpenings {
            handleOpeningTap(gesture.location(in: scene))
            return
        }

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
        if mode == .floor, floorAreaM2 < minFloorAreaM2 {
            setStatus(
                "Nearly ready — walk the room slowly with the phone pointed at "
                    + "the floor. The more it sees, the more accurate the result."
            )
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

        /*
         * Take the hit nearest the floor, not the first one.
         *
         * `raycast` returns every surface along the ray, and `.first`
         * is the nearest to the camera — which in a bedroom is the
         * bed. Worse, `.existingPlaneInfinite` extends a detected
         * plane across the whole room, so the top of a bed becomes
         * an invisible sheet at mattress height covering the floor
         * beside it. Tapping the carpet in the gap between two beds
         * hit that sheet, came back half a metre up, and the
         * worktop guard then refused it: "that looks like a worktop,
         * not the floor", while the customer was pointing directly
         * at the floor.
         *
         * Sorting the candidates by how close they are to the known
         * floor fixes that, and it fixes the furniture problem in
         * the same move — the floor plane extended *under* a bed is
         * exactly what we want when the corner is behind one, and it
         * is now the result that wins rather than the one that gets
         * shadowed. Point at where the corner would be and the
         * reading comes from the floor, through the furniture.
         *
         * With no floor found yet, lowest wins: nothing in a room is
         * below the floor.
         */
        var candidates: [(ARRaycastResult, String)] = []
        for (target, label) in targets {
            guard
                let query = scene.raycastQuery(
                    from: location,
                    allowing: target,
                    alignment: alignment
                )
            else { continue }
            for hit in scene.session.raycast(query) {
                candidates.append((hit, label))
            }
            // Mapped geometry is trusted on its own; only reach for
            // the looser targets when it produced nothing at all.
            if !candidates.isEmpty { break }
        }

        var found: ARRaycastResult?
        var usedTarget = "mapped"
        if mode == .height {
            // Height mode wants whatever was aimed at, floor or
            // ceiling, so the nearest hit is the right one.
            found = candidates.first?.0
            usedTarget = candidates.first?.1 ?? "mapped"
        } else if let floor = floorY {
            let best = candidates.min {
                abs($0.0.worldTransform.columns.3.y - floor)
                    < abs($1.0.worldTransform.columns.3.y - floor)
            }
            found = best?.0
            usedTarget = best?.1 ?? "mapped"
        } else {
            let lowest = candidates.min {
                $0.0.worldTransform.columns.3.y < $1.0.worldTransform.columns.3.y
            }
            found = lowest?.0
            usedTarget = lowest?.1 ?? "mapped"
        }

        /*
         * Nothing along the ray. Before giving up, ask the walls.
         *
         * See cornerAtScreenPoint: a corner with a bed in it has no
         * floor to hit, and that is not a reason to refuse the tap.
         */
        if found == nil, mode == .floor {
            if let fromWalls = cornerAtScreenPoint(location) {
                placeFloorCorner(fromWalls, fromWalls: true)
                return
            }
            if let onPlane = floorPlaneHit(location) {
                placeFloorCorner(onPlane, fromWalls: false)
                return
            }
        }

        guard let hit = found else {
            setStatus("Can't see the floor there — point a little further into the room")
            return
        }
        if usedTarget == "estimated" { estimatedTaps += 1 }

        let t = hit.worldTransform
        // Not a constant: in floor mode the walls get a say in where
        // this ends up. See snapToCorner.
        var p = SCNVector3(t.columns.3.x, t.columns.3.y, t.columns.3.z)

        if mode == .floor {
            // Ignore a tap that lands on a surface well above the
            // floor — a worktop or a table is a horizontal plane too,
            // and a corner placed on one is wrong by the height of
            // the worktop.
            /*
             * A last resort, now that the nearest-to-floor hit wins.
             *
             * Reaching here means even the lowest surface along that
             * ray is half a metre up — so the floor genuinely has
             * not been mapped there and every candidate was
             * furniture. The old wording blamed the customer for
             * pointing at a worktop while they were pointing at
             * carpet; it now says what will actually help, which is
             * to let ARKit see some open floor first.
             */
            if let floor = floorY, p.y - floor > 0.35 {
                /*
                 * Everything along the ray is furniture. Ask the
                 * walls before refusing.
                 *
                 * This is the bed-in-the-corner case and it used to
                 * be a dead end: no sweeping reveals floor that is
                 * underneath a bed, so the message asking for some
                 * was advice that could not be taken. The corner
                 * overhead is visible the whole time.
                 */
                if let fromWalls = cornerAtScreenPoint(location) {
                    placeFloorCorner(fromWalls, fromWalls: true)
                } else if let onPlane = floorPlaneHit(location) {
                    // The floor does not stop under the bed. See
                    // floorPlaneHit.
                    placeFloorCorner(onPlane, fromWalls: false)
                } else {
                    setStatus(
                        "Can't find the floor there yet — sweep the phone over some "
                            + "clear floor nearby, then tap the corner again"
                    )
                }
                return
            }

            /*
             * Hand the corner over to the walls.
             *
             * Done before the duplicate and back-at-start checks,
             * so those compare the points that will actually be
             * drawn. Two taps a few centimetres apart that both
             * snap to the same corner are a duplicate, and should be
             * caught as one.
             */
            if let snapped = snapToCorner(p) {
                p = snapped
                snappedTaps += 1
            }
            placeFloorCorner(p, fromWalls: false)
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
        /*
         * Undo means the last thing you did, which is a different
         * thing in each phase -- and in the openings phase, a
         * half-marked opening and a finished one are different
         * again. Getting this wrong is how an undo button becomes
         * the control nobody trusts.
         */
        if markingOpenings {
            if pendingCorner != nil {
                pendingCorner = nil
                removeLastMarker()
                setStatus("Start that one again — tap one bottom corner")
            } else if !openings.isEmpty {
                openings.removeLast()
                removeLastMarker()
                removeLastMarker()
                setStatus("Removed. Tap one bottom corner of an opening")
            }
            refreshOpeningCount()
            return
        }

        guard !points.isEmpty else { return }
        points.removeLast()
        removeLastMarker()
        refreshCount()
    }

    private func removeLastMarker() {
        sceneView?.scene.rootNode.childNodes
            .filter { $0.name == "tm-marker" }
            .last?
            .removeFromParentNode()
    }

    /**
     * Switch the screen over to marking doors and windows.
     *
     * The corner stepper goes: it counts corners and there are no
     * more corners to count. A kind picker takes its place, because
     * a door, a window and a cased opening are drawn differently
     * and only the person in the room knows which is which.
     */
    private func beginMarkingOpenings() {
        markingOpenings = true
        cornerStepper?.isHidden = true
        kindPicker?.isHidden = false
        setStatus(
            "Now the doors and windows. Tap one bottom corner of an opening, "
                + "then the other — we'll measure the width. Press Done when there are none left."
        )
        refreshOpeningCount()
    }

    @objc private func kindChanged(_ sender: UISegmentedControl) {
        switch sender.selectedSegmentIndex {
        case 0: openingKind = .door
        case 1: openingKind = .window
        default: openingKind = .opening
        }
        // A kind change part-way through an opening would label it
        // as something the first tap was not placed for.
        if pendingCorner != nil {
            pendingCorner = nil
            removeLastMarker()
            refreshOpeningCount()
        }
        setStatus("Tap one bottom corner of a \(openingKind.rawValue)")
    }

    private func dropMarker(
        at p: SCNVector3,
        colour: UIColor = UIColor(
            red: 0.722, green: 0.588, blue: 0.314, alpha: 1
        )
    ) {
        // Smaller for openings: a corner marker is dropped on open
        // floor where a 4 cm ball reads clearly, while a window
        // corner sits against the reveal it is marking and a ball
        // that size covers the thing being measured.
        let sphere = SCNSphere(radius: markingOpenings ? 0.025 : 0.04)
        sphere.firstMaterial?.diffuse.contents = colour
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

    /**
     * Done, which means one of two things.
     *
     * On a floor trace it now hands over to marking the doors and
     * windows rather than ending the session. Same session on
     * purpose: the openings are measured in the frame the outline
     * was measured in, so they need no matching up afterwards.
     * Stopping and starting again would give them their own origin
     * and leave them to be fitted to the room by guesswork, which
     * is the mistake that was quietly dropping internal walls out
     * of whole-property scans.
     *
     * Pressing it a second time, in the openings phase, finishes
     * for real.
     */
    @objc private func finish() {
        if mode == .floor, !markingOpenings, points.count >= 3 {
            beginMarkingOpenings()
            return
        }

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
            "snappedPoints": snappedTaps,
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
            "snappedPoints": snappedTaps,
        ]

        /*
         * The doors and windows, as the two corners each was marked
         * by.
         *
         * Corners rather than a width and an offset, because the
         * app already knows how to drop a point onto the room's
         * outline and work out which wall it is in and how far
         * along -- it does exactly that for the LiDAR path. Sending
         * the raw points keeps one piece of that arithmetic in one
         * place, and it keeps this end honest: these are two things
         * that were measured, not a derived figure dressed up as
         * one.
         *
         * Same frame as pointsM, because they were marked in the
         * same session.
         */
        if !openings.isEmpty {
            payload["openings"] = openings.map { o in
                [
                    "kind": o.kind.rawValue,
                    "aM": ["x": Double(o.a.x), "z": Double(o.a.z)],
                    "bM": ["x": Double(o.b.x), "z": Double(o.b.z)],
                    "sillM": Double(min(o.a.y, o.b.y) - (floorY ?? min(o.a.y, o.b.y))),
                ]
            }
        }

        /*
         * The last thing they saw, to sit behind the numbers.
         *
         * The screen after this one reports what the trace measured,
         * and it used to do that on flat cream — the customer walks
         * out of a live view of their own kitchen into an abstract
         * readout, and the two have no visible connection. Handing
         * back the final frame lets that screen show the room the
         * figures describe, blurred behind them.
         *
         * Small on purpose. Downscaled to 720px and compressed hard,
         * because it is going to be blurred to within an inch of its
         * life: detail is wasted and this crosses the Capacitor
         * bridge as base64, which is a third bigger again. It is
         * held in memory for one screen and never written to the
         * draft — a photograph of someone's home does not belong in
         * localStorage.
         */
        if let shot = sceneView?.snapshot() {
            let maxSide: CGFloat = 720
            let scale = min(1, maxSide / max(shot.size.width, shot.size.height))
            let size = CGSize(
                width: shot.size.width * scale,
                height: shot.size.height * scale
            )
            UIGraphicsBeginImageContextWithOptions(size, true, 1)
            shot.draw(in: CGRect(origin: .zero, size: size))
            let small = UIGraphicsGetImageFromCurrentImageContext()
            UIGraphicsEndImageContext()
            if let data = small?.jpegData(compressionQuality: 0.4) {
                payload["frameJpegBase64"] = data.base64EncodedString()
            }
        }

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
        notePlane(anchor)
    }

    func renderer(_ renderer: SCNSceneRenderer, didUpdate node: SCNNode, for anchor: ARAnchor) {
        notePlane(anchor)
    }

    func renderer(_ renderer: SCNSceneRenderer, didRemove node: SCNNode, for anchor: ARAnchor) {
        // ARKit merges planes as it understands the room better, and
        // retires the losers. A retired wall left in the list is a
        // wall that is no longer there, and corners would still snap
        // to it.
        wallLines.removeValue(forKey: anchor.identifier)
    }

    /**
     * Sort a plane into floor, ceiling or wall.
     *
     * Previously every plane went through the horizontal path,
     * including the walls — so a wall's centre, about chest height,
     * was eligible to become the ceiling.
     */
    /**
     * How big a plane is, on any iOS this pod supports.
     *
     * `planeExtent` arrived in iOS 16 and deprecated `extent` in the
     * same release, so neither one spans the range on its own and
     * the pod targets 14.0. `height` and the old `z` are the same
     * measurement under different names.
     */
    private func planeSize(_ plane: ARPlaneAnchor) -> (w: Float, h: Float) {
        if #available(iOS 16.0, *) {
            return (plane.planeExtent.width, plane.planeExtent.height)
        }
        return (plane.extent.x, plane.extent.z)
    }

    private func notePlane(_ anchor: ARAnchor) {
        guard let plane = anchor as? ARPlaneAnchor else { return }
        switch plane.alignment {
        case .horizontal:
            noteHorizontalPlane(plane)
        case .vertical:
            noteVerticalPlane(plane)
        @unknown default:
            break
        }
    }

    /**
     * Remember a wall as a line on the floor.
     *
     * Reduced to looking down on it: the point it passes through,
     * the direction it runs, and how far it reaches either way. The
     * vertical part is thrown away because a corner is a position on
     * the floor, and the floor height is known separately.
     *
     * The direction is derived from the plane's normal rather than
     * from one of its own axes, because which local axis runs
     * horizontally is ARKit's business and has changed between
     * releases. The normal is unambiguous: it is the way the wall
     * faces, so the wall runs at right angles to it.
     */
    private func noteVerticalPlane(_ plane: ARPlaneAnchor) {
        let m = plane.transform

        // World normal: the plane's local +Y.
        let n = SIMD2<Float>(m.columns.1.x, m.columns.1.z)
        let nLen = simd_length(n)
        // A truly horizontal plane has no horizontal normal. Should
        // not reach here, but dividing by it would be a crash.
        guard nLen > 0.001 else { return }
        let nHat = n / nLen
        let dir = SIMD2<Float>(-nHat.y, nHat.x)

        // World position of the plane's centre, flattened.
        let c = m * SIMD4<Float>(plane.center.x, plane.center.y, plane.center.z, 1)
        let pos = SIMD2<Float>(c.x, c.z)

        // Which extent runs along the wall is the same question as
        // which axis does, so take the larger and be generous. Being
        // generous is the right error here: walls are usually mapped
        // in the middle and unmapped at the ends, which is precisely
        // where the corners are.
        let size = planeSize(plane)
        let half = max(size.w, size.h) / 2

        wallLines[plane.identifier] = (p: pos, d: dir, half: half)
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

        /*
         * How much floor has actually been mapped.
         *
         * Readiness used to turn on the instant any floor plane
         * appeared, which can be a scrap half a metre across. Taps
         * then fell straight through to estimated planes, and the
         * whole trace was built on ARKit's guesses while the
         * crosshair said it was ready. A long wall came back 60cm
         * short.
         *
         * Area is the honest measure of whether the sensor knows
         * the room yet, and it is the thing a few seconds of
         * sweeping actually improves. Four square metres is about
         * the floor you see walking into a small bedroom and
         * turning round: enough to have a plane worth extending
         * under the furniture, not so much that a cluttered room
         * can never reach it.
         */
        let size = planeSize(plane)
        if abs(y - (floorY ?? y)) < 0.15 {
            floorAreaM2 = max(floorAreaM2, Double(size.w * size.h))
        }

        if floorY == nil || y < floorY! {
            let firstFloor = floorY == nil
            floorY = y
            if firstFloor {
                floorAreaM2 = Double(size.w * size.h)
                setStatus(
                    "Floor found — keep sweeping it slowly for a moment so the "
                        + "measurements are accurate"
                )
            }
            refreshReadiness()
        }
        if ceilingY == nil || y > ceilingY! {
            ceilingY = y
        }
    }
}
