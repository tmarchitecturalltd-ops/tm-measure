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
 *   4. finish              → StructureBuilder merges, we serialise
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

    /// iOS 17 for StructureBuilder, plus the same LiDAR requirement as a
    /// single-room scan.
    static func isSupportedOnThisDevice() -> Bool {
        return RoomCaptureSession.isSupported
    }

    private let unit: String
    private let completion: (Result<[String: Any], Error>) -> Void

    /// One processed room per completed capture.
    ///
    /// StructureBuilder takes `[CapturedRoom]`. An earlier version of
    /// this file collected `CapturedRoomData` on the assumption that
    /// merging needed the raw scan, which does not compile and was not
    /// true: the processed room retains the transforms the merge aligns
    /// on.
    private var capturedRooms: [CapturedRoom] = []
    private var roomNames: [String] = []
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
        guard let host = hostVC else {
            finish(.failure(HouseError.cancelled))
            return
        }
        let modal = HouseCaptureModalViewController(
            delegate: self,
            title: "Room \(roomNumber)"
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
        let alert = UIAlertController(
            title: "\(count) room\(count == 1 ? "" : "s") scanned",
            message: "Walk to the next room and scan it, or finish and send this plan.",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "Scan another room", style: .default) { [weak self] _ in
            guard let self else { return }
            self.presentCapture(roomNumber: self.capturedRooms.count + 1)
        })
        alert.addAction(UIAlertAction(title: "Finish", style: .default) { [weak self] _ in
            self?.buildAndFinish()
        })
        host.present(alert, animated: true)
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

        Task { [weak self] in
            guard let self else { return }
            do {
                // beautifyObjects tidies the geometry the way Apple's own
                // demo does; without it walls come back with small kinks
                // that show up as jagged lines once drawn at 1:50.
                let builder = StructureBuilder(options: [.beautifyObjects])
                let structure = try await builder.capturedStructure(from: rooms)
                let payload = CaptureSerializer.serializeStructure(
                    structure: structure,
                    roomNames: names,
                    durationS: elapsed
                )
                await MainActor.run { self.finish(.success(payload)) }
            } catch {
                await MainActor.run {
                    self.finish(.failure(HouseError.mergeFailed(error.localizedDescription)))
                }
            }
        }
    }

    private func finish(_ result: Result<[String: Any], Error>) {
        guard !hasCompleted else { return }
        hasCompleted = true
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
    func captureSession(_ session: RoomCaptureSession, didAdd room: CapturedRoom) {}

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
        case .slowDown:         text = "Slow down — move the phone more gently"
        case .turnOnLight:      text = "It's a bit dark — turn a light on"
        case .lowTexture:       text = "Point at something with more detail — a plain wall is hard to read"
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
    private var captureView: RoomCaptureView?
    private var doneButton: UIButton?
    private var cancelButton: UIButton?
    private var statusLabel: UILabel?
    private var coachingLabel: UILabel?
    private var hasStartedSession = false
    private var isFinishing = false

    init(delegate: HouseCaptureRunner, title: String) {
        self.delegateRunner = delegate
        self.titleText = title
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

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

    @objc private func doneTapped() {
        guard !isFinishing else { return }
        isFinishing = true
        doneButton?.isEnabled = false
        doneButton?.alpha = 0.5
        doneButton?.setTitle("…", for: .normal)
        cancelButton?.isEnabled = false
        cancelButton?.alpha = 0.5
        statusLabel?.text = "Working out the measurements…"
        // Stopping hands the scan to Apple's processing; the room comes
        // back in didPresent, which is where it joins the plan.
        captureView?.captureSession.stop()
    }

    @objc private func cancelTapped() {
        // Ignored once Done has been pressed — the result is already on
        // its way and cancelling now would discard a completed room.
        guard !isFinishing else { return }
        captureView?.captureSession.stop()
        delegateRunner?.userCancelled()
    }
}

#endif
