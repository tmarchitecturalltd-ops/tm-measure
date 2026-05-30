"use client";

import dynamic from "next/dynamic";
import type { MouseEvent } from "react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  estimateFocalLengthPx,
  estimateRoomFromFloorTaps,
  calibrateFocalLengthPx,
  meanReprojectionErrorPx,
  sortFloorCornersClockwise,
  type CameraPose,
  type ScanConfidence,
  type TapPoint,
} from "@tm-designs/measure-core";
import {
  RoomPlan,
  type RoomPlanScanResult,
} from "@tm-designs/capacitor-roomplan";

const HUD = "#1c1c1a";
const GOLD = "#b89650";

/**
 * DEFAULT_CAMERA_HEIGHT_M — average adult phone-holding height when
 * pointing at floor corners. User can override in the HUD for taller
 * / shorter operators; affects linear scale of the scan.
 */
const DEFAULT_CAMERA_HEIGHT_M = 1.5;
/** Fallback tilt if DeviceOrientationEvent isn't available or denied. */
const FALLBACK_TILT_DEG = -30;
/**
 * Ceiling height can't be inferred from four floor taps. We emit a
 * sensible default and flag it so the review screen nudges the user.
 */
const DEFAULT_CEILING_HEIGHT_M = 2.4;

export type ScanDimensions = {
  widthM: number;
  lengthM: number;
  heightM: number;
  /** How the dimensions were produced, for downstream confidence logic. */
  method?: "corners" | "video" | "lidar";
  /** Overall confidence — propagated into RoomScanReviewFlow if present. */
  confidence?: ScanConfidence;
  /** Human-readable reasons from the scan engine. */
  notes?: string[];
  /** Shoelace-computed floor area if available. */
  areaM2?: number;
  /** True if opposite walls are within 10 % of each other. */
  rectangular?: boolean;
};

type Props = {
  open: boolean;
  roomLabel: string;
  onClose: () => void;
  onApply: (d: ScanDimensions) => void;
};

type ScanMode = "lidar" | "corners" | "video";
type Phase =
  | "boot"
  | "camera"
  | "calibrate"
  | "processing"
  | "result"
  | "error";

// Note: video-sweep + LiDAR-simulate code paths were removed for the MVP.
// Real measurements now come from one of two paths only:
//   • Corner tap → `processCornerTapMeasurement` (perspective geometry)
//   • Native RoomPlan → `applyRoomPlanResult` (iPhone Pro LiDAR)
// Both return ScanDimensions directly without any placeholder maths.

const RoomScanWirePreview = dynamic(
  () => import("@/components/measure/RoomScanWirePreview"),
  { ssr: false, loading: () => <div className="h-36 animate-pulse rounded-lg bg-[#0d0d0c]" /> },
);

function Reticle() {
  return (
    <div
      className="pointer-events-none absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2"
      aria-hidden
    >
      <svg width="200" height="200" viewBox="0 0 200 200" className="opacity-90">
        <circle
          cx="100"
          cy="100"
          r="72"
          fill="none"
          stroke={GOLD}
          strokeWidth="1.5"
          strokeDasharray="8 6"
        />
        <line x1="100" y1="20" x2="100" y2="60" stroke={GOLD} strokeWidth="2" />
        <line x1="100" y1="140" x2="100" y2="180" stroke={GOLD} strokeWidth="2" />
        <line x1="20" y1="100" x2="60" y2="100" stroke={GOLD} strokeWidth="2" />
        <line x1="140" y1="100" x2="180" y2="100" stroke={GOLD} strokeWidth="2" />
        <circle cx="100" cy="100" r="4" fill={GOLD} />
      </svg>
    </div>
  );
}

export default function RoomScanOverlay({
  open,
  roomLabel,
  onClose,
  onApply,
}: Props) {
  const [mounted, setMounted] = useState(false);
  const [phase, setPhase] = useState<Phase>("boot");
  // MVP default — Corner-mark uses real perspective-geometry math from
  // measure-core. The "video 360°" mode is disabled in the UI below
  // because it currently produces placeholder numbers. LiDAR is still
  // selectable on iPhone Pro where Apple's RoomPlan returns real data.
  const [scanMode, setScanMode] = useState<ScanMode>("corners");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [cornerCount, setCornerCount] = useState(0);
  const [markers, setMarkers] = useState<{ x: number; y: number }[]>([]);
  const [processPct, setProcessPct] = useState(0);
  const [processLine, setProcessLine] = useState("");
  const [result, setResult] = useState<ScanDimensions | null>(null);
  /** Stable user-adjustable camera height; changing this re-runs math. */
  const [cameraHeightM, setCameraHeightM] = useState(DEFAULT_CAMERA_HEIGHT_M);
  /** Live tilt from DeviceOrientation, null until we get a reading. */
  const [liveTiltDeg, setLiveTiltDeg] = useState<number | null>(null);
  /** Tracks whether we've asked iOS for orientation permission. */
  const [tiltPermission, setTiltPermission] = useState<
    "unknown" | "granted" | "denied" | "unsupported"
  >("unknown");
  /**
   * Native RoomPlan availability — probed once per overlay open on iOS.
   * "unknown" until the plugin responds, then "yes" on LiDAR iPhone Pro,
   * or "no" with a human-readable reason for everything else.
   */
  const [roomPlanSupport, setRoomPlanSupport] = useState<"unknown" | "yes" | "no">(
    "unknown",
  );
  const [roomPlanReason, setRoomPlanReason] = useState<string | null>(null);
  /** Set while the native capture modal is on screen so we can show a HUD state. */
  const [roomPlanRunning, setRoomPlanRunning] = useState(false);

  /**
   * Scale-bar calibration — when the user taps two ends of a known-length
   * object lying on the floor, we back-solve the camera's focal length.
   * If non-null, this value replaces estimateFocalLengthPx() in subsequent
   * corner-tap measurements; if null we fall back to the FOV heuristic.
   *
   * Persisted in localStorage keyed by user-agent so a device only has to
   * be calibrated once. Stored as `tm.calib.<hash>` so different devices
   * sharing the same browser profile don't clobber each other.
   */
  const [calibratedFocalPx, setCalibratedFocalPx] = useState<number | null>(null);

  /** Stable per-device key for the calibration cache. */
  const calibStorageKey = useMemo(() => {
    if (typeof window === "undefined") return "tm.calib.unknown";
    // 32-bit FNV-1a of the user-agent string keeps the key short and
    // doesn't expose the UA to other origins via the storage event.
    const ua = navigator.userAgent || "unknown";
    let h = 0x811c9dc5;
    for (let i = 0; i < ua.length; i++) {
      h ^= ua.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return `tm.calib.${h.toString(16)}`;
  }, []);
  /** Pixel-accurate taps captured during a calibration session. */
  const calibTapsRef = useRef<TapPoint[]>([]);
  const [calibTapCount, setCalibTapCount] = useState(0);
  /** Reference length the user entered, in centimetres. Stored as a string so
   *  the input can be temporarily empty without blowing away the parse. */
  const [calibLengthCm, setCalibLengthCm] = useState("100");
  const [calibError, setCalibError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  /**
   * Pixel-accurate taps captured in parallel to the % markers.
   * Holds the *final* per-corner positions (median-of-3 per corner)
   * after each corner is confirmed. Length 0–4.
   */
  const pixelTapsRef = useRef<TapPoint[]>([]);
  /**
   * Sub-tap buffer for the corner currently being entered. The user
   * taps the same corner 3 times in succession and the median is
   * pushed into pixelTapsRef. Reduces single-tap jitter from ±5 px
   * to ±2 px and roughly halves the wall-length error budget.
   */
  const subTapsRef = useRef<TapPoint[]>([]);
  const [subTapCount, setSubTapCount] = useState(0);
  /** Last known tilt in degrees (camera pitch, 0 = horizontal). */
  const tiltRef = useRef<number>(FALLBACK_TILT_DEG);

  /** How many taps to average per corner. 3 is a good compromise
   *  between precision (more taps lower jitter) and user friction. */
  const TAPS_PER_CORNER = 3;

  /** Collapsed HUD shrinks the corner-tap panel to a single
   *  prompt + progress line so the camera view isn't obscured. */
  const [hudCollapsed, setHudCollapsed] = useState(false);

  /** Median of an array of numbers — small helper so we can median
   *  x and y independently to robustly absorb a single mis-tap. */
  const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  useEffect(() => {
    setMounted(true);
  }, []);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const startCamera = useCallback(async () => {
    setErrorMsg(null);
    setPhase("boot");
    setCornerCount(0);
    setMarkers([]);
    setResult(null);
    setProcessPct(0);
    pixelTapsRef.current = [];
    subTapsRef.current = [];
    setSubTapCount(0);
    // Clear in-flight calibration scratch state only — the resolved
    // focal length is persisted per device and rehydrated on mount,
    // so leave `calibratedFocalPx` alone here.
    calibTapsRef.current = [];
    setCalibTapCount(0);
    setCalibError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      // Tier-2: ask the browser if it can tell us the camera's intrinsic
      // focal length. Only Chrome on a few Android devices populates this
      // — but when it does it's better than any heuristic and skips the
      // calibration step entirely.
      try {
        const track = stream.getVideoTracks()[0];
        const settings = track?.getSettings() as
          | (MediaTrackSettings & { focalLengthPx?: number })
          | undefined;
        const focal = settings?.focalLengthPx;
        if (typeof focal === "number" && focal > 0 && calibratedFocalPx === null) {
          setCalibratedFocalPx(focal);
        }
      } catch {
        /* noop — non-fatal */
      }
      setPhase("camera");
    } catch {
      setErrorMsg("Camera access was denied or is unavailable.");
      setPhase("error");
    }
  }, [calibratedFocalPx]);

  useEffect(() => {
    if (!open) {
      stopStream();
      setPhase("boot");
      return;
    }
    void startCamera();
    return () => {
      stopStream();
    };
  }, [open, startCamera, stopStream]);

  // ── Device-orientation (tilt) capture ──────────────────────────────
  // beta ∈ [-180, 180] is the phone's front-back pitch. When the phone
  // is vertical in portrait, beta ≈ 90 and the rear camera is horizontal.
  // As the user tilts the top of the phone forward to see the floor,
  // beta drops below 90 and the rear-camera pitch is (beta − 90).
  /**
   * Rolling buffer of the last few tilt readings. We use the spread
   * (max − min) over a short window to detect whether the phone is
   * being held still enough to tap accurately. If it's moving by more
   * than 2° between samples, taps are blocked and the user is told
   * to hold still.
   */
  const tiltHistoryRef = useRef<{ t: number; tilt: number }[]>([]);
  const [tiltSpreadDeg, setTiltSpreadDeg] = useState(0);

  const onOrientation = useCallback((ev: DeviceOrientationEvent) => {
    if (typeof ev.beta !== "number" || Number.isNaN(ev.beta)) return;
    const tilt = ev.beta - 90;
    // Clamp to physically sensible rear-camera pitch range.
    const clamped = Math.max(-90, Math.min(30, tilt));
    tiltRef.current = clamped;
    setLiveTiltDeg(clamped);

    // Push into the rolling buffer and drop entries older than 350 ms.
    const now = Date.now();
    const hist = tiltHistoryRef.current;
    hist.push({ t: now, tilt: clamped });
    while (hist.length && now - hist[0].t > 350) hist.shift();
    if (hist.length >= 2) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const h of hist) {
        if (h.tilt < lo) lo = h.tilt;
        if (h.tilt > hi) hi = h.tilt;
      }
      setTiltSpreadDeg(hi - lo);
    } else {
      setTiltSpreadDeg(0);
    }
  }, []);

  /** True when the phone is moving — used to reject taps mid-shake. */
  const STABILITY_THRESHOLD_DEG = 2.0;
  const isStable = liveTiltDeg === null || tiltSpreadDeg < STABILITY_THRESHOLD_DEG;

  const requestTiltPermission = useCallback(async () => {
    if (typeof window === "undefined") return;
    const DOEvent = (
      window as unknown as {
        DeviceOrientationEvent?: typeof DeviceOrientationEvent & {
          requestPermission?: () => Promise<PermissionState | "granted" | "denied">;
        };
      }
    ).DeviceOrientationEvent;
    if (!DOEvent) {
      setTiltPermission("unsupported");
      return;
    }
    // iOS 13+ requires an explicit request gated behind a user gesture.
    if (typeof DOEvent.requestPermission === "function") {
      try {
        const state = await DOEvent.requestPermission();
        if (state === "granted") {
          window.addEventListener("deviceorientation", onOrientation, true);
          setTiltPermission("granted");
        } else {
          setTiltPermission("denied");
        }
      } catch {
        setTiltPermission("denied");
      }
      return;
    }
    // Android / desktop Chrome: no permission required.
    window.addEventListener("deviceorientation", onOrientation, true);
    setTiltPermission("granted");
  }, [onOrientation]);

  useEffect(() => {
    if (!open) return;
    // On non-iOS browsers we can attach the listener straight away —
    // iOS will silently emit nothing until requestPermission() resolves.
    if (typeof window === "undefined") return;
    window.addEventListener("deviceorientation", onOrientation, true);
    return () => {
      window.removeEventListener("deviceorientation", onOrientation, true);
    };
  }, [open, onOrientation]);

  /**
   * Turn the four captured pixel taps + pose into a ScanDimensions via
   * the perspective-geometry module. Runs a short "processing" flash so
   * the UI feels consistent with the other scan modes, then sets result.
   */
  const processCornerTapMeasurement = useCallback(async () => {
    const video = videoRef.current;
    const taps = pixelTapsRef.current;
    if (!video || taps.length !== 4) {
      setErrorMsg("Scan input was incomplete — please try again.");
      setPhase("error");
      return;
    }
    const imageWidthPx = video.videoWidth || video.clientWidth || 1920;
    const imageHeightPx = video.videoHeight || video.clientHeight || 1080;

    // Run the processing animation concurrently with the (instant) maths
    // so there's a consistent feedback beat between tap-4 and the result.
    setPhase("processing");
    setProcessPct(0);
    const lines = [
      "Reading camera pose…",
      "Back-projecting corner rays to floor…",
      "Fitting rectangle & computing wall lengths…",
    ];
    const animate = (async () => {
      for (let p = 0; p <= 100; p += 10) {
        setProcessPct(p);
        setProcessLine(lines[Math.min(Math.floor((p / 100) * lines.length), lines.length - 1)] ?? "");
        await new Promise((r) => setTimeout(r, 55));
      }
    })();

    const pose: CameraPose = {
      heightM: cameraHeightM,
      tiltDeg: tiltRef.current ?? FALLBACK_TILT_DEG,
      // Use the calibrated focal length if the user ran the scale-bar
      // calibration step; otherwise fall back to the FOV heuristic.
      focalLengthPx: calibratedFocalPx ?? estimateFocalLengthPx(imageWidthPx),
      imageWidthPx,
      imageHeightPx,
    };
    const ordered = sortFloorCornersClockwise(taps as [TapPoint, TapPoint, TapPoint, TapPoint]);
    const out = estimateRoomFromFloorTaps({ corners: ordered, pose });

    await animate;

    if ("error" in out) {
      setErrorMsg(out.error);
      setPhase("error");
      return;
    }

    // Tier-2 sanity check: re-project the world-space corners back to
    // the camera and compare against the original taps. If the average
    // pixel error exceeds ~1.5 % of image width the geometry didn't
    // close and we knock confidence down a step.
    const reproPx = meanReprojectionErrorPx(ordered, out.floorPoints, pose);
    const reproThresh = pose.imageWidthPx * 0.015;
    const reproOk = Number.isFinite(reproPx) && reproPx < reproThresh;

    // Opposite walls are averaged to absorb small tap jitter.
    const widthM = Number(((out.wallsM[0] + out.wallsM[2]) / 2).toFixed(2));
    const lengthM = Number(((out.wallsM[1] + out.wallsM[3]) / 2).toFixed(2));
    const notes = [
      ...out.notes,
      "Ceiling height defaulted to 2.40 m — please confirm in review.",
    ];
    // If tilt came only from fallback, downgrade confidence a notch.
    const tiltFromDevice = liveTiltDeg !== null;
    let confidence: ScanConfidence = tiltFromDevice
      ? out.confidence
      : out.confidence === "high"
        ? "medium"
        : out.confidence;
    if (!tiltFromDevice) {
      notes.push("Phone tilt sensor unavailable — used 30° default. Accuracy ±15 cm.");
    }
    if (!reproOk) {
      // Knock the confidence down one notch if the corners don't
      // re-project tightly. The math is still returned — just flagged.
      confidence = confidence === "high" ? "medium" : "low";
      notes.push(
        `Re-projection error ${reproPx.toFixed(0)} px (limit ${reproThresh.toFixed(0)} px) — geometry didn't close cleanly. Re-tap the corners or recalibrate.`,
      );
    } else {
      notes.push(`Re-projection error ${reproPx.toFixed(1)} px — geometry closes cleanly.`);
    }

    setResult({
      widthM,
      lengthM,
      heightM: DEFAULT_CEILING_HEIGHT_M,
      method: "corners",
      confidence,
      notes,
      areaM2: out.areaM2,
      rectangular: out.rectangular,
    });
    setPhase("result");
  }, [cameraHeightM, liveTiltDeg, calibratedFocalPx]);

  /**
   * Resolve the calibration once both calibration taps have been
   * captured. Reads `calibLengthCm` for the user-entered reference
   * length, calls calibrateFocalLengthPx() and either stores the
   * resulting focal length or surfaces the error inside the panel.
   */
  const resolveCalibration = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const imageWidthPx = video.videoWidth || video.clientWidth || 1920;
    const imageHeightPx = video.videoHeight || video.clientHeight || 1080;
    const cm = parseFloat(calibLengthCm);
    if (!Number.isFinite(cm) || cm <= 0) {
      setCalibError("Enter a reference length in centimetres first.");
      return;
    }
    const taps = calibTapsRef.current;
    if (taps.length !== 2) {
      setCalibError("Tap both ends of the reference object.");
      return;
    }
    const result = calibrateFocalLengthPx(taps[0], taps[1], cm / 100, {
      heightM: cameraHeightM,
      tiltDeg: tiltRef.current ?? FALLBACK_TILT_DEG,
      imageWidthPx,
      imageHeightPx,
    });
    if (typeof result === "number") {
      // Second-stage sanity check: a converged focal length that
      // landed within 3 % of either search bound usually means the
      // solver hit its rails because the input was bad (taps too
      // close, wrong reference length). Refuse to persist it.
      const lower = imageWidthPx * 0.51;
      const upper = imageWidthPx * 1.37;
      if (result < lower || result > upper) {
        setCalibError(
          "Calibration result looks implausible — re-tap the ends of the reference (e.g. a 1 m tape) more carefully.",
        );
        return;
      }
      setCalibratedFocalPx(result);
      // Persist for next session on the same device. Failures (private
      // mode, quota) are silently ignored — the calibration is still
      // valid for the current session.
      try {
        window.localStorage.setItem(
          calibStorageKey,
          JSON.stringify({ focalPx: result, savedAt: Date.now() }),
        );
      } catch {
        /* noop */
      }
      setCalibError(null);
      // Clear calibration taps + markers and drop the user back into
      // the camera phase so they can tap room corners next.
      calibTapsRef.current = [];
      setCalibTapCount(0);
      setMarkers([]);
      setPhase("camera");
    } else {
      setCalibError(result.error);
    }
  }, [calibLengthCm, cameraHeightM, calibStorageKey]);

  /** Rehydrate a previously-saved calibration on mount. Stale data
   *  older than 180 days is ignored — phones get repaired, sold,
   *  or get camera firmware updates. */
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(calibStorageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { focalPx?: number; savedAt?: number };
      const age = Date.now() - (parsed.savedAt ?? 0);
      const ttl = 180 * 24 * 60 * 60 * 1000;
      if (typeof parsed.focalPx === "number" && parsed.focalPx > 0 && age < ttl) {
        setCalibratedFocalPx(parsed.focalPx);
      }
    } catch {
      /* noop */
    }
  }, [calibStorageKey]);

  const onCornerTap = useCallback(
    (e: MouseEvent<HTMLElement>) => {
      if (scanMode !== "corners") return;
      if (phase !== "camera" && phase !== "calibrate") return;
      // Tier-2: drop the tap if the phone is moving — far better to
      // make the user re-try than to lock in a smeared corner.
      if (!isStable) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      const y = ((e.clientY - rect.top) / rect.height) * 100;
      setMarkers((m) => [...m, { x, y }]);

      // Map the rendered tap into the video's INTRINSIC pixel grid.
      // The <video> uses object-fit: cover, which scales-to-fill and crops
      // the overflowing axis — so a 50 % element-tap isn't at 50 % of the
      // intrinsic image on the cropped axis. We undo the cover transform
      // here so the focal-length estimate (which is in intrinsic pixels)
      // stays consistent with the tap coordinates.
      const video = videoRef.current;
      const vw = video?.videoWidth || 0;
      const vh = video?.videoHeight || 0;
      const ew = rect.width;
      const eh = rect.height;
      let xPx: number;
      let yPx: number;
      if (vw > 0 && vh > 0 && ew > 0 && eh > 0) {
        const aspectV = vw / vh;
        const aspectE = ew / eh;
        const xInElem = (x / 100) * ew;
        const yInElem = (y / 100) * eh;
        if (aspectE >= aspectV) {
          // Element wider than video → video scaled to fill width, top+bottom cropped.
          const renderedH = ew / aspectV;
          const cropTop = (renderedH - eh) / 2;
          xPx = (xInElem / ew) * vw;
          yPx = ((yInElem + cropTop) / renderedH) * vh;
        } else {
          // Element taller/narrower → video scaled to fill height, sides cropped.
          const renderedW = eh * aspectV;
          const cropLeft = (renderedW - ew) / 2;
          xPx = ((xInElem + cropLeft) / renderedW) * vw;
          yPx = (yInElem / eh) * vh;
        }
      } else {
        // Fallback: naive proportional mapping.
        xPx = (x / 100) * (vw || ew);
        yPx = (y / 100) * (vh || eh);
      }
      if (phase === "calibrate") {
        // Calibration taps go into a separate buffer; max 2. Confirm
        // happens via a button so the user can re-tap if they missed.
        if (calibTapsRef.current.length >= 2) return;
        calibTapsRef.current = [...calibTapsRef.current, { xPx, yPx }];
        setCalibTapCount(calibTapsRef.current.length);
        return;
      }

      // Multi-tap averaging: collect TAPS_PER_CORNER taps for the current
      // corner, then push the median into pixelTapsRef before moving on.
      subTapsRef.current = [...subTapsRef.current, { xPx, yPx }];
      const subN = subTapsRef.current.length;
      setSubTapCount(subN);
      if (subN < TAPS_PER_CORNER) return;

      const xs = subTapsRef.current.map((t) => t.xPx);
      const ys = subTapsRef.current.map((t) => t.yPx);
      const cornerTap: TapPoint = { xPx: median(xs), yPx: median(ys) };
      pixelTapsRef.current = [...pixelTapsRef.current, cornerTap];
      subTapsRef.current = [];
      setSubTapCount(0);

      setCornerCount((c) => {
        const next = c + 1;
        if (next >= 4) {
          void processCornerTapMeasurement();
        }
        return next;
      });
    },
    [scanMode, phase, processCornerTapMeasurement, isStable],
  );

  /**
   * Probe Apple RoomPlan support exactly once per overlay open.
   * Runs on every platform — the plugin's web fallback cleanly reports
   * `supported: false` on Android / desktop, so no platform sniff is
   * needed on the React side.
   */
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await RoomPlan.isSupported();
        if (cancelled) return;
        if (r.supported) {
          setRoomPlanSupport("yes");
          setRoomPlanReason(null);
          // Prefer LiDAR-driven RoomPlan whenever the device supports it
          // — architect-grade accuracy, no calibration needed. Only auto-
          // switch if the user hasn't already touched the mode picker
          // (i.e. we're still on the default "corners" choice).
          setScanMode((current) => (current === "corners" ? "lidar" : current));
        } else {
          setRoomPlanSupport("no");
          setRoomPlanReason(r.reason ?? null);
        }
      } catch {
        if (!cancelled) {
          setRoomPlanSupport("no");
          setRoomPlanReason("Native RoomPlan bridge unavailable in this build.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  /**
   * Turn a native RoomPlan result into the ScanDimensions contract used
   * throughout the review flow. RoomPlan is architect-grade, so we tag
   * every scan high-confidence and surface a notes summary describing
   * what it detected (walls, doors, windows, openings).
   */
  const applyRoomPlanResult = useCallback(
    (r: RoomPlanScanResult): ScanDimensions | null => {
      const room = r.rooms[0];
      if (!room) return null;
      const notes: string[] = [];
      notes.push(
        `RoomPlan detected ${room.walls.length} wall${room.walls.length === 1 ? "" : "s"}, ` +
          `${room.doors.length} door${room.doors.length === 1 ? "" : "s"}, ` +
          `${room.windows.length} window${room.windows.length === 1 ? "" : "s"}, ` +
          `${room.openings.length} opening${room.openings.length === 1 ? "" : "s"}.`,
      );
      if (!room.rectangular) {
        notes.push(
          "Floor polygon is non-rectangular — room may have bays, alcoves or irregular corners.",
        );
      }
      notes.push(`Scan completed in ${r.durationS.toFixed(1)} s.`);
      return {
        widthM: Number(room.widthM.toFixed(2)),
        lengthM: Number(room.lengthM.toFixed(2)),
        heightM: Number(room.heightM.toFixed(2)),
        method: "lidar",
        confidence: "high",
        notes,
        areaM2: room.floorAreaM2,
        rectangular: room.rectangular,
      };
    },
    [],
  );

  /**
   * Kick off Apple's native RoomCaptureView. We stop our own
   * getUserMedia stream first so the camera isn't contended between
   * the WKWebView and the native view controller.
   */
  const handleLidarStart = useCallback(async () => {
    if (roomPlanSupport !== "yes") return;
    setErrorMsg(null);
    setRoomPlanRunning(true);
    stopStream();
    try {
      const r = await RoomPlan.startScan({ title: roomLabel || "Scan this room" });
      const dims = applyRoomPlanResult(r);
      setRoomPlanRunning(false);
      if (!dims) {
        setErrorMsg("RoomPlan returned no room data — please try again.");
        setPhase("error");
        return;
      }
      setResult(dims);
      setPhase("result");
    } catch (err) {
      setRoomPlanRunning(false);
      const msg =
        err instanceof Error && err.message ? err.message : "RoomPlan scan failed.";
      // "Scan cancelled" is the user backing out — just restart the web preview.
      if (/cancel/i.test(msg)) {
        void startCamera();
        return;
      }
      setErrorMsg(msg);
      setPhase("error");
    }
  }, [
    roomPlanSupport,
    roomLabel,
    stopStream,
    startCamera,
    applyRoomPlanResult,
  ]);

  const hud = open && mounted && (
    <div
      className="fixed inset-0 z-[200] flex select-none flex-col bg-black"
      style={{
        fontFamily: "var(--font-body, Manrope, system-ui)",
        WebkitUserSelect: "none",
        WebkitTouchCallout: "none",
        WebkitTapHighlightColor: "transparent",
      }}
    >
      <video
        ref={videoRef}
        className="absolute inset-0 h-full w-full object-cover"
        playsInline
        muted
        autoPlay
      />

      <div
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/50 via-transparent to-black/70"
        aria-hidden
      />

      {(phase === "camera" || phase === "calibrate") && scanMode === "corners" && (
        <button
          type="button"
          className="absolute inset-0 z-[5] cursor-crosshair select-none"
          aria-label={phase === "calibrate" ? "Tap reference object ends" : "Tap corners on video"}
          onClick={onCornerTap}
          style={{ touchAction: "manipulation", WebkitUserSelect: "none" }}
        />
      )}

      {markers.map((m, i) => (
        <div
          key={`${m.x}-${m.y}-${i}`}
          className="pointer-events-none absolute z-[8] h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#1c1c1a] bg-[#b89650]"
          style={{ left: `${m.x}%`, top: `${m.y}%` }}
        />
      ))}

      {(phase === "camera" || phase === "calibrate") && <Reticle />}

      {/* Top bar */}
      <div
        className="relative z-20 flex items-center justify-between px-4 py-3"
        style={{ backgroundColor: `${HUD}e6` }}
      >
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.2em]" style={{ color: GOLD }}>
            Scan your room
          </p>
          <p className="text-sm font-semibold text-white/90">{roomLabel || "Room"}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-full px-4 py-2 text-xs font-bold uppercase tracking-wider text-white/80 transition hover:bg-white/10 hover:text-white"
        >
          Close
        </button>
      </div>

      {/* This flex-1 column visually contains the bottom panels but the
          empty space ABOVE them must let taps fall through to the camera
          tap-target (z-5). pointer-events-none on the container, then
          pointer-events-auto on each panel below, achieves that. */}
      <div className="pointer-events-none relative z-20 flex flex-1 flex-col justify-end">
        {phase === "error" && (
          <div className="pointer-events-auto mx-4 mb-24 rounded-xl p-6" style={{ backgroundColor: `${HUD}f2` }}>
            <p className="text-sm text-red-200">{errorMsg}</p>
            <button
              type="button"
              onClick={onClose}
              className="mt-4 rounded-lg px-6 py-3 text-xs font-bold uppercase tracking-widest text-[#1c1c1a]"
              style={{ backgroundColor: GOLD }}
            >
              Dismiss
            </button>
          </div>
        )}

        {(phase === "camera" || phase === "calibrate") && (
          <>
            <div
              className="pointer-events-auto mx-4 mb-3 flex flex-wrap gap-2 rounded-xl p-3"
              style={{ backgroundColor: `${HUD}e8` }}
            >
              <ModeChip
                active={scanMode === "lidar"}
                onClick={() => {
                  setScanMode("lidar");
                  setCornerCount(0);
                  setMarkers([]);
                  pixelTapsRef.current = [];
                }}
                label="LiDAR / AR"
              />
              <ModeChip
                active={scanMode === "corners"}
                onClick={() => {
                  setScanMode("corners");
                  setCornerCount(0);
                  setMarkers([]);
                  pixelTapsRef.current = [];
                  if (tiltPermission === "unknown") {
                    void requestTiltPermission();
                  }
                }}
                label="Corner mark"
              />
              {/* MVP: video-sweep mode is disabled — it currently produces
                  placeholder numbers, not real measurements. Re-enable once
                  the on-device vision pipeline lands. */}
              <ModeChip
                active={false}
                disabled
                onClick={() => {}}
                label="Video 360° · soon"
              />
            </div>

            {scanMode === "lidar" && (
              <div
                className="pointer-events-auto mx-4 mb-3 rounded-xl border border-white/10 p-4 text-xs leading-relaxed text-white/75"
                style={{ backgroundColor: `${HUD}ee` }}
              >
                {roomPlanSupport === "yes" ? (
                  <>
                    <p className="mb-2 font-semibold" style={{ color: GOLD }}>
                      Apple RoomPlan ready — full LiDAR sweep in one pass.
                    </p>
                    <p className="mb-3 text-white/60">
                      Hold the phone vertically and walk slowly around the room
                      keeping the walls in view. Apple's guide will highlight
                      what to cover and tell you when it's done.
                    </p>
                    <button
                      type="button"
                      onClick={() => void handleLidarStart()}
                      disabled={roomPlanRunning}
                      className="w-full rounded-lg py-3 text-xs font-bold uppercase tracking-widest text-[#1c1c1a] disabled:opacity-50"
                      style={{ backgroundColor: GOLD }}
                    >
                      {roomPlanRunning ? "Opening RoomPlan…" : "Start RoomPlan capture"}
                    </button>
                  </>
                ) : roomPlanSupport === "no" ? (
                  <>
                    <p className="mb-2 font-semibold" style={{ color: GOLD }}>
                      Native LiDAR not available on this device.
                    </p>
                    <p className="mb-3 text-white/60">
                      {roomPlanReason ??
                        "Apple RoomPlan needs an iPhone / iPad Pro with a LiDAR sensor running iOS 16 or newer."}
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setScanMode("corners");
                        setCornerCount(0);
                        setMarkers([]);
                        pixelTapsRef.current = [];
                        if (tiltPermission === "unknown") {
                          void requestTiltPermission();
                        }
                      }}
                      className="w-full rounded-lg py-3 text-xs font-bold uppercase tracking-widest text-[#1c1c1a]"
                      style={{ backgroundColor: GOLD }}
                    >
                      Switch to Corner mark
                    </button>
                  </>
                ) : (
                  <p className="text-white/60">Checking RoomPlan availability…</p>
                )}
              </div>
            )}

            {scanMode === "corners" && (
              <div
                className={`pointer-events-auto mx-4 mb-3 rounded-xl text-xs text-white/75 ${hudCollapsed ? "p-2" : "p-4"}`}
                style={{ backgroundColor: `${HUD}ee` }}
              >
                <div className="flex items-start justify-between gap-2">
                  <p style={{ color: GOLD }} className="mb-1 flex-1 font-semibold">
                    {cornerCount === 0 && `Tap corner 1 of 4, ${TAPS_PER_CORNER} times.`}
                    {cornerCount === 1 && `Now corner 2 — clockwise from the first.`}
                    {cornerCount === 2 && `Corner 3 — diagonally opposite corner 1.`}
                    {cornerCount === 3 && `Last one — corner 4 closes the loop.`}
                    {cornerCount >= 4 && "Measuring…"}
                  </p>
                  <button
                    type="button"
                    onClick={() => setHudCollapsed((c) => !c)}
                    aria-label={hudCollapsed ? "Expand instructions" : "Minimise instructions"}
                    className="material-symbols-outlined shrink-0 rounded-full p-1 text-white/65 hover:bg-white/10"
                    style={{ fontSize: "18px" }}
                  >
                    {hudCollapsed ? "expand_less" : "expand_more"}
                  </button>
                </div>
                {!hudCollapsed && (
                  <p className="mb-1 text-white/55">
                    Tap the same spot 3 times — the median absorbs tremor. Stay still between taps.
                  </p>
                )}
                <div className="mb-3 flex items-center gap-2">
                  <div className="flex gap-1">
                    {[0, 1, 2, 3].map((i) => (
                      <span
                        key={i}
                        className="h-2 w-6 rounded-full"
                        style={{
                          backgroundColor:
                            i < cornerCount ? GOLD : "rgba(255,255,255,0.15)",
                        }}
                      />
                    ))}
                  </div>
                  <span className="text-white/50">
                    Corner {Math.min(cornerCount + 1, 4)} / 4 · Tap {subTapCount} / {TAPS_PER_CORNER}
                  </span>
                </div>

                {!hudCollapsed && (
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 text-[11px] text-white/70">
                    <span className="uppercase tracking-widest text-white/45">Eye height</span>
                    <input
                      type="number"
                      inputMode="decimal"
                      min={1.0}
                      max={2.2}
                      step={0.05}
                      value={cameraHeightM}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (Number.isFinite(n)) setCameraHeightM(n);
                      }}
                      className="w-16 rounded bg-white/10 px-2 py-1 text-right font-mono text-white outline-none focus:bg-white/15"
                    />
                    <span className="text-white/40">m</span>
                  </label>

                  <span className="text-[11px] text-white/60">
                    Tilt:{" "}
                    <span className="font-mono" style={{ color: GOLD }}>
                      {liveTiltDeg === null
                        ? `${FALLBACK_TILT_DEG}° (default)`
                        : `${liveTiltDeg.toFixed(0)}°`}
                    </span>
                  </span>

                  {!isStable && (
                    <span
                      className="rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-widest"
                      style={{ backgroundColor: "rgba(244,168,156,0.18)", color: "#f4a89c" }}
                      title={`Tilt spread ${tiltSpreadDeg.toFixed(1)}° — hold still to tap`}
                    >
                      ✋ Hold still
                    </span>
                  )}

                  {/* Live accuracy pill — gives the user an at-a-glance
                      sense of how good the result will be BEFORE they
                      finish all four taps. Combines tilt quality, tilt
                      sensor availability, and calibration status into a
                      single HIGH/MEDIUM/LOW bucket. */}
                  {(() => {
                    const tilt = liveTiltDeg ?? FALLBACK_TILT_DEG;
                    let score = 0;
                    const reasons: string[] = [];
                    if (tilt < -15 && tilt > -50) score += 2;
                    else if (tilt <= -10) {
                      score += 1;
                      reasons.push("steeper tilt → better");
                    } else {
                      reasons.push("tilt too shallow");
                    }
                    if (liveTiltDeg !== null) score += 1;
                    else reasons.push("no tilt sensor");
                    if (calibratedFocalPx !== null) score += 2;
                    else reasons.push("uncalibrated");
                    const bucket = score >= 4 ? "HIGH" : score >= 2 ? "MEDIUM" : "LOW";
                    const colour = bucket === "HIGH" ? "#9ce29c" : bucket === "MEDIUM" ? GOLD : "#f4a89c";
                    return (
                      <span
                        className="rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-widest"
                        style={{ backgroundColor: `${colour}22`, color: colour }}
                        title={reasons.length ? `Issues: ${reasons.join(", ")}` : "All good"}
                      >
                        Accuracy {bucket}
                      </span>
                    );
                  })()}

                  {tiltPermission !== "granted" && tiltPermission !== "unsupported" && (
                    <button
                      type="button"
                      onClick={() => void requestTiltPermission()}
                      className="rounded-full border border-white/20 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-white/80 hover:bg-white/10"
                    >
                      Enable motion sensor
                    </button>
                  )}

                  {/* Scale-bar calibration entry point. Optional but
                      strongly recommended — replaces the FOV heuristic
                      with a focal length solved from a known reference
                      object on the floor. */}
                  {calibratedFocalPx === null ? (
                    <button
                      type="button"
                      onClick={() => {
                        calibTapsRef.current = [];
                        setCalibTapCount(0);
                        setCalibError(null);
                        setMarkers([]);
                        setCornerCount(0);
                        pixelTapsRef.current = [];
                        setPhase("calibrate");
                      }}
                      className="rounded-full border border-white/20 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-white/80 hover:bg-white/10"
                    >
                      Calibrate (recommended)
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        try {
                          window.localStorage.removeItem(calibStorageKey);
                        } catch {
                          /* noop */
                        }
                        setCalibratedFocalPx(null);
                        calibTapsRef.current = [];
                        setCalibTapCount(0);
                        setCalibError(null);
                        setMarkers([]);
                        setCornerCount(0);
                        pixelTapsRef.current = [];
                        setPhase("calibrate");
                      }}
                      className="rounded-full bg-white/10 px-3 py-1 text-[10px] font-bold uppercase tracking-widest hover:bg-white/15"
                      style={{ color: GOLD }}
                      title="Tap to re-calibrate"
                    >
                      Calibrated · {calibratedFocalPx.toFixed(0)} px · redo
                    </button>
                  )}
                </div>
                )}
              </div>
            )}

            {phase === "calibrate" && (
              <div
                className="pointer-events-auto mx-4 mb-3 rounded-xl p-4 text-xs text-white/75"
                style={{ backgroundColor: `${HUD}ee` }}
              >
                <p style={{ color: GOLD }} className="mb-1 font-semibold">
                  Scale-bar calibration
                </p>
                <p className="mb-3 text-white/65">
                  Lay a known-length object flat on the floor (door frame, tape measure, A4 sheet). Tap each end. We&apos;ll back-solve the camera focal length for ±3 cm accuracy.
                </p>
                <div className="mb-3 flex items-center gap-2">
                  <div className="flex gap-1">
                    {[0, 1].map((i) => (
                      <span
                        key={i}
                        className="h-2 w-8 rounded-full"
                        style={{
                          backgroundColor:
                            i < calibTapCount ? GOLD : "rgba(255,255,255,0.15)",
                        }}
                      />
                    ))}
                  </div>
                  <span className="text-white/50">{calibTapCount} / 2 taps</span>
                </div>
                <label className="mb-3 flex items-center gap-2 text-[11px] text-white/70">
                  <span className="uppercase tracking-widest text-white/45">Reference length</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={5}
                    max={500}
                    step={1}
                    value={calibLengthCm}
                    onChange={(e) => setCalibLengthCm(e.target.value)}
                    className="w-20 rounded bg-white/10 px-2 py-1 text-right font-mono text-white outline-none focus:bg-white/15"
                  />
                  <span className="text-white/40">cm</span>
                </label>
                {calibError && (
                  <p className="mb-2 text-[11px] text-red-200">{calibError}</p>
                )}
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={resolveCalibration}
                    disabled={calibTapCount !== 2}
                    className="rounded-full px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-[#1c1c1a] disabled:cursor-not-allowed disabled:opacity-40"
                    style={{ backgroundColor: GOLD }}
                  >
                    Confirm calibration
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      calibTapsRef.current = [];
                      setCalibTapCount(0);
                      setCalibError(null);
                      setMarkers([]);
                    }}
                    className="rounded-full border border-white/20 px-3 py-2 text-[10px] font-bold uppercase tracking-widest text-white/80"
                  >
                    Re-tap
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      calibTapsRef.current = [];
                      setCalibTapCount(0);
                      setCalibError(null);
                      setMarkers([]);
                      setPhase("camera");
                    }}
                    className="rounded-full border border-white/20 px-3 py-2 text-[10px] font-bold uppercase tracking-widest text-white/80"
                  >
                    Skip
                  </button>
                </div>
              </div>
            )}

            {scanMode === "video" && (
              <div
                className="pointer-events-auto mx-4 mb-3 rounded-xl p-4 text-xs text-white/75"
                style={{ backgroundColor: `${HUD}ee` }}
              >
                <p style={{ color: GOLD }} className="mb-2 font-semibold">
                  Video 360° is not yet available.
                </p>
                <p className="text-white/55">
                  We&apos;re still working on the on-device vision pipeline. For now, please
                  switch to <span className="font-semibold">Corner mark</span> — it uses the
                  same camera and gives you a real measurement in four taps.
                </p>
              </div>
            )}

            {/* The Video 360° record button used to live here. It's removed
                for the MVP because the chip that toggles it is disabled
                above and the underlying pipeline returns placeholder data. */}
            <div
              className="pointer-events-auto flex flex-wrap items-center justify-between gap-3 px-4 pb-8 pt-2"
              style={{ backgroundColor: HUD }}
            >
              <p className="text-[10px] uppercase tracking-widest text-white/40">
                HUD · {HUD} / {GOLD}
              </p>
            </div>
          </>
        )}

        {phase === "processing" && (
          <div className="pointer-events-auto mx-4 mb-16 rounded-xl p-6" style={{ backgroundColor: `${HUD}f0` }}>
            <p className="mb-2 text-xs font-bold uppercase tracking-widest" style={{ color: GOLD }}>
              Processing
            </p>
            <p className="mb-4 text-sm text-white/80">{processLine}</p>
            <div className="h-2 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full transition-all duration-150"
                style={{ width: `${processPct}%`, backgroundColor: GOLD }}
              />
            </div>
            <p className="mt-2 text-right text-xs text-white/40">{processPct}%</p>
          </div>
        )}

        {phase === "result" && result && (
          <div className="pointer-events-auto mx-4 mb-8 space-y-4 rounded-xl p-5" style={{ backgroundColor: `${HUD}f2` }}>
            <div className="flex items-center justify-between">
              <p className="text-xs font-bold uppercase tracking-widest" style={{ color: GOLD }}>
                Scan captured
              </p>
              {result.method === "corners" && result.confidence && (
                <ConfidencePill c={result.confidence} />
              )}
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <DimChip label="Width" v={result.widthM} />
              <DimChip label="Length" v={result.lengthM} />
              <DimChip label="Height" v={result.heightM} />
            </div>
            {result.method === "corners" && typeof result.areaM2 === "number" && (
              <p className="text-center text-[11px] text-white/55">
                Floor area{" "}
                <span className="font-mono text-white/80">{result.areaM2.toFixed(2)} m²</span>
                {result.rectangular === false ? " · non-rectangular" : ""}
              </p>
            )}
            {result.notes && result.notes.length > 0 && (
              <ul className="space-y-1 rounded-lg bg-white/5 p-3 text-[11px] leading-relaxed text-white/70">
                {result.notes.map((n, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="mt-[2px]" style={{ color: GOLD }}>
                      •
                    </span>
                    <span>{n}</span>
                  </li>
                ))}
              </ul>
            )}
            <RoomScanWirePreview
              widthM={result.widthM}
              lengthM={result.lengthM}
              heightM={result.heightM}
            />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  onApply(result);
                  onClose();
                }}
                className="flex-1 rounded-lg py-3 text-xs font-bold uppercase tracking-widest text-[#1c1c1a] sm:flex-none sm:px-8"
                style={{ backgroundColor: GOLD }}
              >
                Apply to form
              </button>
              <button
                type="button"
                onClick={() => {
                  setResult(null);
                  setCornerCount(0);
                  setMarkers([]);
                  pixelTapsRef.current = [];
                  void startCamera();
                }}
                className="rounded-lg border border-white/20 px-6 py-3 text-xs font-bold uppercase tracking-widest text-white/80 hover:bg-white/5"
              >
                Rescan
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  if (!mounted || !open) return null;
  return createPortal(hud, document.body);
}

function ModeChip({
  active,
  onClick,
  label,
  disabled = false,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-disabled={disabled}
      className="rounded-full px-4 py-2 text-[10px] font-bold uppercase tracking-wider transition disabled:cursor-not-allowed"
      style={{
        backgroundColor: active ? GOLD : "rgba(255,255,255,0.06)",
        color: active
          ? "#1c1c1a"
          : disabled
            ? "rgba(255,255,255,0.30)"
            : "rgba(255,255,255,0.65)",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {label}
    </button>
  );
}

function DimChip({ label, v }: { label: string; v: number }) {
  return (
    <div className="rounded-lg bg-white/5 py-3">
      <p className="text-[9px] font-bold uppercase tracking-widest text-white/45">{label}</p>
      <p className="font-mono text-lg" style={{ color: GOLD }}>
        {v.toFixed(2)}m
      </p>
    </div>
  );
}

function ConfidencePill({ c }: { c: ScanConfidence }) {
  const colour =
    c === "high" ? "#4ade80" : c === "medium" ? "#facc15" : "#f87171";
  const label = c === "high" ? "High confidence" : c === "medium" ? "Medium confidence" : "Low confidence";
  return (
    <span
      className="rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-widest"
      style={{
        backgroundColor: `${colour}22`,
        color: colour,
        border: `1px solid ${colour}55`,
      }}
    >
      {label}
    </span>
  );
}
