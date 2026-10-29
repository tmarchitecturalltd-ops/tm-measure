import ARKit
import Foundation
import UIKit
import simd

#if canImport(RoomPlan)
import RoomPlan

/**
 * HouseCaptureRunner — several rooms, one coordinate system.
 *
 * RoomCaptureRunner scans a single room and returns it in its own local
 * frame, which is all a per-room measurement needs. A floor plan needs
 * more than that: it needs to know where the kitchen is *relative to*
 * the hall. Scanning rooms separately cannot give you that, because
 * each capture starts a fresh world origin wherever the phone happened
 * to be.
 *
 * NOTE: this used to merge with StructureBuilder. It no longer
 * does -- see buildAndFinish. The description below is kept
 * because it explains why the shared session exists.
 *
 * StructureBuilder (iOS 17+) solves it. Hand it the CapturedRooms from
 * a sequence of captures and it returns a CapturedStructure with every
 * room, wall and opening expressed in one shared frame. That is the
 * difference between a list of room sizes and an actual plan — and it
 * is also where door and window POSITIONS come from, which manual
 * measurement cannot practically provide.
 *
 * Flow:
 *   1. present(from:)      → capture room 1
 *   2. user taps OUR Done  → "Add another room?" / "Finish"
 *
 * That Done button has to be built here. RoomCaptureView supplies the
 * coaching overlay and nothing else — no way to end a room. Without it
 * the only control on the screen was Cancel, so a customer could scan
 * a room and then had a choice between discarding it and being stuck
 * on the camera. Reported as not being able to "add room" or "come off
 * the scanning page", which is precisely what a screen with no Done
 * button feels like from the outside.
 *   3. add another         → capture room 2, ... (repeat)
 *   4. finish              → each room serialised on its own
 *
 * Cancelling the FIRST room aborts. Cancelling a later one keeps the
 * rooms already captured — losing four scanned rooms because someone
 * mis-tapped on the fifth would be indefensible.
 */
@available(iOS 17.0, *)
class HouseCaptureRunner: NSObject, RoomCaptureViewDelegate, RoomCaptureSessionDelegate {

    enum HouseError: LocalizedError {
        case cancelled
        case captureFailed(String)
        /// No longer thrown: nothing merges. Kept so an older build
        /// of the JS side still recognises the error shape.
        case mergeFailed(String)
        case nothingCaptured

        var errorDescription: String? {
            switch self {
            case .cancelled: return "Scan cancelled"
            case .captureFailed(let m): return m
            case .mergeFailed(let m):
                return "Could not combine the rooms into one plan: \(m)"
            case .nothingCaptured: return "No rooms were scanned"
            }
        }
    }

    /// iOS 17 for the shared-session capture, plus the same LiDAR
    /// requirement as a single-room scan.
    static func isSupportedOnThisDevice() -> Bool {
        return RoomCaptureSession.isSupported
    }

    private let unit: String
    private let completion: (Result<[String: Any], Error>) -> Void

    /**
     * One ARSession for the whole property. This is the fix for the
     * internal walls going missing after the third room.
     *
     * Each room used to get a fresh RoomCaptureView built with
     * `RoomCaptureView(frame:)`, which makes its own ARSession, and
     * the room was finished with a plain `stop()`, which pauses it.
     * So every room was surveyed in a world of its own, starting
     * wherever the customer happened to be standing and facing.
     *
     * StructureBuilder is then being asked to do something it was
     * never meant to do. It merges rooms that already share a
     * coordinate system; given rooms that do not, it falls back to
     * matching them up by shape. Two rooms it can usually place.
     * Three or four and the guesses compound, walls that are really
     * the same wall land in two different places, and the merge
     * resolves that by dropping them -- which is exactly the
     * reported symptom: the internal walls stop appearing once
     * there are a few rooms, while each room on its own is fine.
     *
     * Holding one ARSession across every capture, and stopping each
     * room with `pauseARSession: false`, means ARKit tracks
     * continuously as the customer walks from room to room. Every
     * room then lands in one frame, already in its true position,
     * and the merge has nothing left to guess.
     *
     * The cost is that walking between rooms now matters: lose
     * tracking on the way and the next room is adrift. That is the
     * right trade -- it is the same walk either way, and this way
     * it counts for something.
     */
    private let sharedARSession = ARSession()

    /// One processed room per completed capture.
    ///
    /// Each is serialised on its own at the end. An earlier version
    /// collected `CapturedRoomData` on the assumption that the raw
    /// scan was needed, which does not compile and was not true:
    /// the processed room retains the transforms that matter.
    private var capturedRooms: [CapturedRoom] = []
    private var roomNames: [String] = []
    /*
     * A photograph of each room, taken where the customer stood.
     *
     * Without this the survey ends upstairs and the customer walks
     * back down to every room they scanned to photograph it --
     * reported as "I've got to go back down stairs to each room and
     * then take a photo". The camera is already open, already in
     * the room, and already pointed at it, so the picture costs
     * nothing but the frame.
     *
     * It is also what tells somebody which room they are naming
     * afterwards. "Room 3 of 7" means nothing; a photograph of the
     * room means everything.
     */
    private var roomFrames: [String] = []
    /*
     * The camera's height above where the survey started, per room.
     *
     * The shared AR session keeps one origin for the whole house,
     * so the vertical position of the phone is directly comparable
     * between rooms. Walking upstairs moves it by a storey, and
     * nothing else a customer does during a survey moves it by
     * anything close -- so this is a reliable guess at which floor
     * a room is on, and it costs the customer nothing.
     *
     * A guess, and labelled as one: the app confirms it rather than
     * acting on it silently.
     */
    private var roomCameraY: [Double] = []
    private var startedAt: Date = Date()

    private weak var hostVC: UIViewController?
    private var modalVC: HouseCaptureModalViewController?

    /// Set while the customer is cancelling the CURRENT room, so the
    /// data that stopping the session produces is discarded rather than
    /// silently added to the plan they just chose not to keep.
    private var isCancellingRoom = false

    /// The completion closure must fire exactly once.
    private var hasCompleted = false

    init(unit: String, completion: @escaping (Result<[String: Any], Error>) -> Void) {
        self.unit = unit
        self.completion = completion
        super.init()
    }

    required init?(coder: NSCoder) { return nil }
    func encode(with coder: NSCoder) {}

    // MARK: - Presentation

    func present(from host: UIViewController) {
        self.hostVC = host
        self.startedAt = Date()
        presentCapture(roomNumber: 1)
    }

    private func presentCapture(roomNumber: Int) {
        isCancellingRoom = false
        // Per room, not per survey: each new room earns its own
        // "that's enough" the moment it has walls and a floor.
        enoughPromptShown = false
        guard let host = hostVC else {
            finish(.failure(HouseError.cancelled))
            return
        }
        let modal = HouseCaptureModalViewController(
            delegate: self,
            title: "Room \(roomNumber)",
            arSession: sharedARSession
        )
        modal.modalPresentationStyle = .fullScreen
        self.modalVC = modal
        host.present(modal, animated: true)
    }

    /// Ask whether to keep going. Presented from the host once the
    /// capture modal has fully dismissed — presenting from a controller
    /// that is mid-dismissal silently does nothing, which would strand
    /// the user on the camera screen with no way forward.
    private func askForNextStep() {
        guard let host = hostVC else {
            buildAndFinish()
            return
        }
        let count = capturedRooms.count
        /*
         * Walking to the next room is the join.
         *
         * The session keeps running between rooms, so the walk is
         * what puts the next room in the right place relative to
         * this one. Said here because it is the one moment the
         * customer could put the phone down or take a detour, and
         * the consequence of doing so is invisible until the plan
         * comes out wrong.
         */
        let alert = UIAlertController(
            title: "\(count) room\(count == 1 ? "" : "s") scanned",
            message: "Keep the phone up and walk through to the next room. "
                + "That walk is what tells us where the rooms sit.",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "Next room", style: .default) { [weak self] _ in
            guard let self else { return }
            /*
             * Wait for the alert to actually be gone.
             *
             * This called presentCapture directly, and the button
             * did nothing. A UIAlertAction handler runs while the
             * alert is still dismissing, so the host still has a
             * presented view controller and UIKit refuses the second
             * presentation -- silently, with only a console warning.
             * The customer presses "Next room" and stays where they
             * are, which is the end of a whole-property scan.
             */
            self.whenHostIsFree {
                self.presentCapture(roomNumber: self.capturedRooms.count + 1)
            }
        })
        alert.addAction(UIAlertAction(title: "That's the lot", style: .default) { [weak self] _ in
            self?.buildAndFinish()
        })
        host.present(alert, animated: true)
    }

    /**
     * Run `work` once the host has nothing presented over it.
     *
     * UIKit will not present a second view controller while the
     * first is still on its way out, and says so only in the
     * console. Rather than guessing at an animation duration, this
     * polls briefly for the host to be free.
     *
     * Bounded: twenty tries at 50ms is a second, far longer than a
     * dismissal takes. If it somehow has not cleared by then the
     * work runs anyway, because a missed animation is better than a
     * survey that stops.
     */
    private func whenHostIsFree(_ work: @escaping () -> Void, attempt: Int = 0) {
        guard let host = hostVC else { work(); return }
        if host.presentedViewController == nil || attempt >= 20 {
            work()
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
            self?.whenHostIsFree(work, attempt: attempt + 1)
        }
    }

    private func dismissModal(then work: @escaping () -> Void) {
        guard let modal = modalVC else { work(); return }
        modal.dismiss(animated: true) { [weak self] in
            self?.modalVC = nil
            work()
        }
    }

    /// Cancel button. Only aborts outright if nothing has been captured
    /// yet; otherwise we offer to keep what we have.
    func userCancelled() {
        isCancellingRoom = true
        if capturedRooms.isEmpty {
            dismissModal { [weak self] in
                self?.finish(.failure(HouseError.cancelled))
            }
            return
        }
        dismissModal { [weak self] in
            self?.askForNextStep()
        }
    }

    // MARK: - Merge

    private func buildAndFinish() {
        guard !capturedRooms.isEmpty else {
            finish(.failure(HouseError.nothingCaptured))
            return
        }
        let rooms = capturedRooms
        let elapsed = Date().timeIntervalSince(startedAt)
        let names = roomNames
        let frames = roomFrames
        let cameraY = roomCameraY
        let lowestY = cameraY.min() ?? 0

        /*
         * Keep the rooms as the customer drew them. No merge.
         *
         * This handed the captured rooms to StructureBuilder, whose
         * job is to work out how a set of rooms fit together. With
         * every room now captured in one shared ARSession it has
         * nothing left to work out -- the rooms are already in one
         * coordinate system, in their true positions -- and what it
         * does instead is re-decide where one room ends and the
         * next begins. It merges through wide openings and splits
         * rooms that are not rooms to it. A tester scanned what he
         * considered two rooms and was handed something else.
         *
         * The customer already answered that question, once per
         * room, by walking out and pressing Done. That answer is
         * better than a reinterpretation of it: they know which
         * space is the kitchen and the sensor does not.
         *
         * So each room is serialised on its own, through exactly
         * the same path a single-room scan takes. Their positions
         * relative to each other survive because originM is the
         * room's own corner measured in the shared frame, which is
         * what the app places them by.
         */
        var roomDicts: [[String: Any]] = []
        for (i, room) in rooms.enumerated() {
            let one = CaptureSerializer.serialize(captured: room, durationS: elapsed)
            guard var dict = (one["rooms"] as? [[String: Any]])?.first else { continue }
            dict["name"] = i < names.count ? names[i] : "Room \(i + 1)"
            if i < frames.count, !frames[i].isEmpty {
                dict["frameJpegBase64"] = frames[i]
            }
            /*
             * Which storey, guessed from how high the phone was.
             *
             * Measured against the lowest room of the survey and
             * divided by a storey, so a room scanned two and a half
             * metres above the first one is on floor 1. Floors are
             * never negative here: a customer who starts in the
             * basement and walks up gets 0, 1, 2, and the basement
             * is the one they correct, rather than everything
             * being off by one.
             */
            if i < cameraY.count {
                let rise = cameraY[i] - lowestY
                dict["floorGuess"] = Int((rise / 2.5).rounded())
            }
            roomDicts.append(dict)
        }

        guard !roomDicts.isEmpty else {
            finish(.failure(HouseError.nothingCaptured))
            return
        }

        finish(
            .success([
                "rooms": roomDicts,
                "durationS": elapsed,
                "complete": true,
                "merged": true,
            ])
        )
    }

    private func finish(_ result: Result<[String: Any], Error>) {
        guard !hasCompleted else { return }
        hasCompleted = true
        /*
         * The one place the AR session is allowed to stop.
         *
         * Every room now ends with `pauseARSession: false` so
         * tracking carries on through the walk to the next room,
         * which means nothing else switches the camera off. Left
         * running past the end of the survey it would hold the
         * camera and keep draining the battery behind a screen the
         * customer has already left.
         */
        sharedARSession.pause()
        let closure = completion
        dismissModal { closure(result) }
    }


    // MARK: - Coaching

    /**
     * Required, and deliberately empty.
     *
     * Every other method on RoomCaptureSessionDelegate ships with a
     * blank default implementation; this one does not, so conforming
     * without it fails to compile. We take the delegate purely for the
     * coaching instructions below, and RoomCaptureView draws the live
     * model itself.
     */
    /**
     * Nudge the customer to show us the doorways.
     *
     * RoomPlan finds walls readily and doors only if they are looked
     * at -- a doorway swept past at an angle is often missed. Those
     * doors are what tell us how the rooms join up, and without them
     * the app has to ask the customer to arrange the rooms by hand on
     * a floor plan afterwards. Every door the sensor sees is a step
     * the customer does not have to do.
     *
     * Fired the first time a room is added with no doors on it, and
     * not repeated -- a prompt that keeps reappearing while somebody
     * is concentrating is worse than one they missed.
     */
    /**
     * Say when the room is complete enough to finish.
     *
     * Asked for directly: signal when the sensor is confident
     * enough, then offer to move on or stop. Without it the only
     * way to judge a scan is to press Done and look at what comes
     * back, which is the wrong end of the process to find out at.
     *
     * The honest measure is what the room has, not a percentage.
     * A room needs its walls and its floor: four walls and a floor
     * surface is an ordinary room captured properly, and anything
     * short of that is a room captured from the doorway. So the
     * line says what is there, in those terms, and the Done button
     * comes forward when it is enough.
     *
     * Deliberately not a hard gate. A customer who wants to stop
     * at three walls may have a reason -- an alcove they will
     * measure another way, a room they only need roughly -- and
     * being locked in a room by an app is worse than a slightly
     * thin scan of it.
     */
    func captureSession(
        _ session: RoomCaptureSession,
        didUpdate room: CapturedRoom
    ) {
        let walls = room.walls.count
        let hasFloor = !room.floors.isEmpty
        let ready = walls >= 4 && hasFloor

        /*
         * Say it once, out loud, when the room is complete.
         *
         * The readiness line updates continuously, which is right
         * for something you glance at and wrong for the one moment
         * that actually matters -- the point where there is enough
         * to finish. Somebody concentrating on sweeping a room does
         * not notice a label change, and carries on scanning a room
         * that was already done.
         *
         * Once per room, through the coaching strip, which is the
         * channel the customer is already being spoken to on.
         */
        if ready && !enoughPromptShown {
            enoughPromptShown = true
            DispatchQueue.main.async { [weak self] in
                self?.modalVC?.showCoaching(
                    "You can press Done whenever the room is covered."
                )
            }
        }

        DispatchQueue.main.async { [weak self] in
            guard let self, let vc = self.modalVC else { return }
            vc.setReadiness(
                ready: ready,
                /*
                 * No counts, and no instruction to move on.
                 *
                 * This read "4 walls and the floor. Ready to finish
                 * this room" halfway round a room, which the
                 * customer reasonably took as the app saying the
                 * room was done -- reported as "it's like 4 walls
                 * done, move onto next room, except I've done like
                 * half the room". The sensor cannot know how many
                 * walls a room has, so a count is a number that
                 * invites exactly that reading and tells nobody
                 * anything. Only the customer knows when the room
                 * is covered, so the line says what to do and
                 * leaves the deciding to them.
                 */
                text: ready
                    ? "Keep going until the whole room is covered"
                    : hasFloor
                        ? "Keep going round the room"
                        : "Point the phone down to pick up the floor"
            )
        }
    }

    func captureSession(_ session: RoomCaptureSession, didAdd room: CapturedRoom) {
        roomsSeen += 1

        /*
         * Half a room is worse than no room.
         *
         * RoomPlan reports a room as soon as it is confident enough to
         * call it one, which on a quick sweep through a doorway can be
         * two walls and a guess. That room reaches the drawing looking
         * like every other, and nothing about it says it was captured
         * from the threshold rather than walked round.
         *
         * Four walls is the ordinary case. Fewer than three and the
         * customer is told, while they are still standing in it and can
         * do something about it.
         */
        if room.walls.count < 3 && !partialPromptShown {
            partialPromptShown = true
            DispatchQueue.main.async { [weak self] in
                self?.modalVC?.showCoaching(
                    "Only part of that room was captured - walk round the walls you missed"
                )
            }
            return
        }

        guard !doorPromptShown, room.doors.isEmpty else { return }
        doorPromptShown = true
        DispatchQueue.main.async { [weak self] in
            self?.modalVC?.showCoaching(
                "Point at each doorway as you pass it - it tells us how the rooms join up"
            )
        }
    }

    /// One "that's enough" prompt per room. Reset in presentCapture.
    private var enoughPromptShown = false
    /// One doorway prompt per scan. See captureSession(_:didAdd:).
    private var doorPromptShown = false
    /// One partial-room prompt per scan, for the same reason.
    private var partialPromptShown = false
    /// How many rooms this scan has produced so far.
    private var roomsSeen = 0

    /**
     * Apple's own scanning advice, in our words and our size.
     *
     * RoomPlan watches the scan and reports when it is going badly:
     * moving too fast, too close to a wall, too dark, or pointed at a
     * blank surface it cannot get a fix on. RoomCaptureView shows these
     * as a small grey pill, which Charlie's recording did not show at
     * all — either it never fired or it was too faint to notice while
     * walking round a room holding a phone up.
     *
     * Taking the session delegate is what makes this possible, and it
     * has one consequence worth stating: only one object can be the
     * delegate, so Apple's own pill stops. That is the intent — ours
     * replaces it — but if the live 3D model ever stops drawing during
     * a scan, this is the first thing to suspect and removing the
     * `captureSession.delegate` assignment is the whole revert.
     *
     * `.normal` clears the message rather than showing "carry on",
     * which would be a permanent nag saying nothing.
     */
    func captureSession(
        _ session: RoomCaptureSession,
        didProvide instruction: RoomCaptureSession.Instruction
    ) {
        let text: String?
        switch instruction {
        case .moveCloseToWall:  text = "Move a little closer to the wall"
        case .moveAwayFromWall: text = "Step back from the wall"
        case .slowDown:         text = "Slow down. Move the phone more gently"
        case .turnOnLight:      text = "It's a bit dark. Turn a light on"
        case .lowTexture:       text = "Point at something with more detail. A plain wall is hard to read"
        case .normal:           text = nil
        @unknown default:       text = nil
        }
        DispatchQueue.main.async { [weak self] in
            self?.modalVC?.showCoaching(text)
        }
    }

    // MARK: - RoomCaptureViewDelegate

    /// Returning true hands the raw scan to Apple's processing. The
    /// result arrives in didPresent, which is where we keep it.
    func captureView(shouldPresent roomDataForProcessing: CapturedRoomData, error: Error?) -> Bool {
        // Cancel stops the session as well, and a stopped session offers
        // its data here whatever the reason. Processing it would add the
        // room the customer just declined to keep.
        if isCancellingRoom { return false }
        if let error = error {
            dismissModal { [weak self] in
                self?.finish(.failure(HouseError.captureFailed(error.localizedDescription)))
            }
            return false
        }
        return true
    }

    func captureView(didPresent processedResult: CapturedRoom, error: Error?) {
        if isCancellingRoom { return }
        if let error = error {
            dismissModal { [weak self] in
                self?.finish(.failure(HouseError.captureFailed(error.localizedDescription)))
            }
            return
        }
        capturedRooms.append(processedResult)
        roomNames.append("Room \(capturedRooms.count)")
        roomFrames.append(modalVC?.lastFrameJpeg ?? "")
        roomCameraY.append(
            Double(sharedARSession.currentFrame?.camera.transform.columns.3.y ?? 0)
        )
        dismissModal { [weak self] in
            self?.askForNextStep()
        }
    }
}

// MARK: - Modal host

@available(iOS 17.0, *)
private class HouseCaptureModalViewController: UIViewController {

    private weak var delegateRunner: HouseCaptureRunner?
    private let titleText: String
    /// Shared across every room of the property. See sharedARSession.
    private let arSession: ARSession
    private var captureView: RoomCaptureView?
    private var doneButton: UIButton?
    private var cancelButton: UIButton?
    private var statusLabel: UILabel?
    private var readinessLabel: UILabel?
    private var coachingLabel: UILabel?
    private var hasStartedSession = false
    private var isFinishing = false
    /// Recovery timer for a Done press that never comes back.
    private var stuckWork: DispatchWorkItem?

    init(delegate: HouseCaptureRunner, title: String, arSession: ARSession) {
        self.delegateRunner = delegate
        self.titleText = title
        self.arSession = arSession
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        // Built on the property's own ARSession rather than letting
        // the view make one, so this room shares a coordinate system
        // with the rooms before it. See sharedARSession.
        let cv = RoomCaptureView(frame: view.bounds, arSession: arSession)
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

        let label = UILabel()
        label.text = titleText
        label.textColor = .white
        label.font = .systemFont(ofSize: 15, weight: .semibold)
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)

        let cancel = UIButton(type: .system)
        cancel.setTitle("Cancel", for: .normal)
        cancel.setTitleColor(.white, for: .normal)
        cancel.titleLabel?.font = .systemFont(ofSize: 15, weight: .semibold)
        cancel.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
        cancel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(cancel)

        // Cancel left, room name centred, Done right — the iOS modal
        // convention. Cancel was on the right, which is where Done now
        // is; leaving it there would have put the destructive control
        // under the thumb aiming for the safe one.
        cancel.contentEdgeInsets = UIEdgeInsets(top: 12, left: 16, bottom: 12, right: 16)
        NSLayoutConstraint.activate([
            cancel.topAnchor.constraint(
                equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            cancel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 8),
            cancel.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: cancel.centerYAnchor),
        ])
        label.shadowColor = UIColor(white: 0.0, alpha: 0.7)
        label.shadowOffset = CGSize(width: 0, height: 1)
        self.cancelButton = cancel

        // Done, top-right.
        //
        // It was bottom-centre, which is where RoomCaptureView draws
        // its live 3D model of the room being scanned — so the button
        // and the model sat on top of each other and the customer
        // could see neither properly. The corners are the only part of
        // this screen Apple does not use.
        //
        // Cancel left, Done right is also the iOS convention for a
        // modal, so it is where a hand goes looking without being told.
        let done = UIButton(type: .system)
        done.setTitle("Done", for: .normal)
        done.setTitleColor(.black, for: .normal)
        done.titleLabel?.font = .systemFont(ofSize: 17, weight: .bold)
        done.backgroundColor = .white
        done.layer.cornerRadius = 22
        done.layer.cornerCurve = .continuous
        done.contentEdgeInsets = UIEdgeInsets(top: 10, left: 22, bottom: 10, right: 22)
        done.translatesAutoresizingMaskIntoConstraints = false
        done.addTarget(self, action: #selector(doneTapped), for: .touchUpInside)
        view.addSubview(done)
        NSLayoutConstraint.activate([
            done.topAnchor.constraint(
                equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            done.trailingAnchor.constraint(
                equalTo: view.trailingAnchor, constant: -16),
            done.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
        ])
        self.doneButton = done

        // Status under the top bar, for the same reason: the middle
        // and bottom of this screen belong to Apple's model preview.
        let status = UILabel()
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
            status.topAnchor.constraint(equalTo: done.bottomAnchor, constant: 12),
            status.leadingAnchor.constraint(
                greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
        ])
        self.statusLabel = status

        // Readiness line, under the status. Separate from the
        // coaching strip because coaching comes and goes and this
        // is a running state the customer should be able to glance
        // at whenever they like.
        let readiness = UILabel()
        readiness.translatesAutoresizingMaskIntoConstraints = false
        readiness.textColor = .white
        readiness.font = .systemFont(ofSize: 14, weight: .semibold)
        readiness.textAlignment = .center
        readiness.numberOfLines = 0
        readiness.shadowColor = .black
        readiness.shadowOffset = CGSize(width: 0, height: 1)
        view.addSubview(readiness)
        self.readinessLabel = readiness
        NSLayoutConstraint.activate([
            readiness.topAnchor.constraint(equalTo: status.bottomAnchor, constant: 6),
            readiness.leadingAnchor.constraint(
                greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
            readiness.trailingAnchor.constraint(
                lessThanOrEqualTo: view.trailingAnchor, constant: -24),
            readiness.centerXAnchor.constraint(equalTo: view.centerXAnchor),
        ])

        // Coaching panel — hidden until the sensor has something to say.
        let coaching = UILabel()
        coaching.numberOfLines = 0
        coaching.textAlignment = .center
        coaching.textColor = .white
        coaching.font = .systemFont(ofSize: 19, weight: .bold)
        coaching.backgroundColor = UIColor(white: 0.0, alpha: 0.78)
        coaching.layer.cornerRadius = 16
        coaching.layer.cornerCurve = .continuous
        coaching.layer.masksToBounds = true
        coaching.alpha = 0
        coaching.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(coaching)
        NSLayoutConstraint.activate([
            coaching.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            coaching.topAnchor.constraint(
                equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 96),
            coaching.leadingAnchor.constraint(
                greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
            coaching.trailingAnchor.constraint(
                lessThanOrEqualTo: view.trailingAnchor, constant: -24),
            coaching.heightAnchor.constraint(greaterThanOrEqualToConstant: 56),
        ])
        self.coachingLabel = coaching
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !hasStartedSession else { return }
        hasStartedSession = true
        captureView?.captureSession.delegate = delegateRunner
        captureView?.captureSession.run(configuration: RoomCaptureSession.Configuration())
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        // The room came back, so the "this is taking too long"
        // recovery is no longer wanted. Left scheduled it would fire
        // against a screen that has already gone.
        stuckWork?.cancel()
        stuckWork = nil
    }


    /**
     * A coaching message, centred, for three seconds.
     *
     * Sits in the upper third: the middle and bottom of this screen are
     * Apple's live model, and the top corners are Cancel and Done.
     *
     * `hideWork` is cancelled on every new message so a fresh one is
     * not wiped by the timer belonging to the last. Same instruction
     * twice running is ignored, which stops the panel flickering while
     * the sensor repeats itself.
     */
    private var coachingText: String?
    private var hideWork: DispatchWorkItem?

    /// See captureSession(_:didUpdate:). Done is emphasised rather
    /// than enabled: it works throughout, because a customer who
    /// wants to stop early is allowed to.
    func setReadiness(ready: Bool, text: String) {
        readinessLabel?.text = text
        doneButton?.backgroundColor = ready ? .white : UIColor(white: 1, alpha: 0.55)
        doneButton?.setTitle(ready ? "Done ✓" : "Done", for: .normal)
    }

    func showCoaching(_ text: String?) {
        guard text != coachingText else { return }
        coachingText = text
        hideWork?.cancel()

        guard let text else {
            UIView.animate(withDuration: 0.2) { self.coachingLabel?.alpha = 0 }
            return
        }
        coachingLabel?.text = text
        UIView.animate(withDuration: 0.2) { self.coachingLabel?.alpha = 1 }

        let work = DispatchWorkItem { [weak self] in
            UIView.animate(withDuration: 0.3) { self?.coachingLabel?.alpha = 0 }
            self?.coachingText = nil
        }
        hideWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.0, execute: work)
    }

    /**
     * The room as the customer is looking at it, as a small JPEG.
     *
     * Rendered from the capture view rather than from the AR frame
     * buffer, because that is what is on the screen: the room with
     * Apple's wireframe over it, which reads as "this is the room I
     * just scanned" far better than a bare camera frame would.
     *
     * 720px and quality 0.4, matching the camera tracer. It travels
     * in a JSON payload and sits in memory for the rest of the
     * survey; a full-resolution photograph of every room in a house
     * would be tens of megabytes of someone's home carried around
     * for a thumbnail.
     */
    /// Set at Done, read once the capture result comes back.
    private(set) var lastFrameJpeg: String?

    func snapshotJpegBase64() -> String? {
        guard let source = captureView ?? view else { return nil }
        let maxSide: CGFloat = 720
        let bounds = source.bounds
        guard bounds.width > 1, bounds.height > 1 else { return nil }
        let scale = min(1, maxSide / max(bounds.width, bounds.height))
        let size = CGSize(width: bounds.width * scale, height: bounds.height * scale)
        UIGraphicsBeginImageContextWithOptions(size, true, 1)
        defer { UIGraphicsEndImageContext() }
        source.drawHierarchy(
            in: CGRect(origin: .zero, size: size),
            afterScreenUpdates: false
        )
        guard let image = UIGraphicsGetImageFromCurrentImageContext(),
              let data = image.jpegData(compressionQuality: 0.4)
        else { return nil }
        return data.base64EncodedString()
    }

    @objc private func doneTapped() {
        guard !isFinishing else { return }
        isFinishing = true
        /*
         * Grab the picture now, not when the result arrives.
         *
         * By the time didPresent fires the capture view has swapped
         * the camera for Apple's finished 3D model, so a snapshot
         * taken then is a photograph of a grey mesh. The moment the
         * customer presses Done, the screen still shows the room.
         */
        lastFrameJpeg = snapshotJpegBase64()
        doneButton?.isEnabled = false
        doneButton?.alpha = 0.5
        doneButton?.setTitle("…", for: .normal)
        cancelButton?.isEnabled = false
        cancelButton?.alpha = 0.5
        statusLabel?.text = "Working out the measurements…"

        /*
         * A way out if the result never arrives.
         *
         * Done disables both buttons and sets the label to an
         * ellipsis, on the understanding that Apple's processing
         * will come back through didPresent in a second or two.
         * When it does not -- a capture it cannot process, an error
         * swallowed upstream -- the screen is left with a camera
         * view, a Done button showing "…" that does nothing, and a
         * Cancel button that has been switched off. There is no
         * route out of that except force-quitting the app, which
         * loses the whole survey.
         *
         * Fifteen seconds is far longer than processing a room
         * takes and short enough that nobody has decided the app
         * has crashed. Cancel comes back rather than Done, because
         * at this point the honest offer is to keep the rooms
         * already captured rather than to retry something that has
         * not answered.
         */
        stuckWork?.cancel()
        let stuck = DispatchWorkItem { [weak self] in
            guard let self, self.isFinishing else { return }
            self.statusLabel?.text =
                "That room is taking longer than it should. Keep the rooms you have, or try this one again."
            self.doneButton?.setTitle("Done", for: .normal)
            self.doneButton?.isEnabled = true
            self.doneButton?.alpha = 1
            self.cancelButton?.isEnabled = true
            self.cancelButton?.alpha = 1
            self.isFinishing = false
        }
        stuckWork = stuck
        DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: stuck)

        // Stopping hands the scan to Apple's processing; the room comes
        // back in didPresent, which is where it joins the plan.
        //
        // pauseARSession: false is the whole point. The default tears
        // the AR session down, and the next room then starts its own
        // world from wherever the customer is standing -- which is
        // what left StructureBuilder guessing how the rooms fit
        // together. Keeping it running means tracking carries on
        // through the walk to the next room.
        captureView?.captureSession.stop(pauseARSession: false)
    }

    @objc private func cancelTapped() {
        // Ignored once Done has been pressed — the result is already on
        // its way and cancelling now would discard a completed room.
        guard !isFinishing else { return }
        // Also left running: cancelling one room does not end the
        // survey, and the rooms already captured still need the
        // frame they were captured in.
        captureView?.captureSession.stop(pauseARSession: false)
        delegateRunner?.userCancelled()
    }
}

#endif
