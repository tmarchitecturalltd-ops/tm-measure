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
 *   2. user taps Done      → "Add another room?" / "Finish"
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
        let closure = completion
        dismissModal { closure(result) }
    }

    // MARK: - RoomCaptureViewDelegate

    /// Returning true hands the raw scan to Apple's processing. The
    /// result arrives in didPresent, which is where we keep it.
    func captureView(shouldPresent roomDataForProcessing: CapturedRoomData, error: Error?) -> Bool {
        if let error = error {
            dismissModal { [weak self] in
                self?.finish(.failure(HouseError.captureFailed(error.localizedDescription)))
            }
            return false
        }
        return true
    }

    func captureView(didPresent processedResult: CapturedRoom, error: Error?) {
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
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        captureView?.captureSession.run(configuration: RoomCaptureSession.Configuration())
    }

    @objc private func cancelTapped() {
        captureView?.captureSession.stop()
        delegateRunner?.userCancelled()
    }
}

#endif
