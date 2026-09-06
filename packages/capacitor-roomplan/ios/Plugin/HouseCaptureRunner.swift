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
class HouseCaptureRunner: NSObject, RoomCaptureViewDelegate {

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

        NSLayoutConstraint.activate([
            label.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
            label.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
            cancel.centerYAnchor.constraint(equalTo: label.centerYAnchor),
            cancel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),
        ])
        self.cancelButton = cancel

        // "Done with this room" — the control that was missing.
        //
        // Ending a room is what leads to the "Scan another room /
        // Finish" prompt, so without this button the customer could
        // neither add a second room nor get off the camera screen with
        // anything kept. Named for what it does rather than just
        // "Done", because on a multi-room scan "Done" reads as "done
        // with the whole house".
        let done = UIButton(type: .system)
        done.setTitle("Done with this room", for: .normal)
        done.setTitleColor(.black, for: .normal)
        done.titleLabel?.font = .systemFont(ofSize: 18, weight: .bold)
        done.backgroundColor = .white
        done.layer.cornerRadius = 28
        done.layer.cornerCurve = .continuous
        done.translatesAutoresizingMaskIntoConstraints = false
        done.addTarget(self, action: #selector(doneTapped), for: .touchUpInside)
        view.addSubview(done)
        NSLayoutConstraint.activate([
            done.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            done.bottomAnchor.constraint(
                equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -28),
            done.widthAnchor.constraint(greaterThanOrEqualToConstant: 240),
            done.heightAnchor.constraint(equalToConstant: 56),
        ])
        self.doneButton = done

        // Processing takes several seconds with no indication from
        // Apple. Silence there reads as a hang, at the exact moment the
        // customer is waiting to learn whether the room counted.
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
            status.bottomAnchor.constraint(equalTo: done.topAnchor, constant: -14),
            status.leadingAnchor.constraint(
                greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
        ])
        self.statusLabel = status
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !hasStartedSession else { return }
        hasStartedSession = true
        captureView?.captureSession.run(configuration: RoomCaptureSession.Configuration())
    }

    @objc private func doneTapped() {
        guard !isFinishing else { return }
        isFinishing = true
        doneButton?.isEnabled = false
        doneButton?.alpha = 0.5
        doneButton?.setTitle("Finishing…", for: .normal)
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
