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
  projectTapToFloor,
  sortFloorCornersClockwise,
  type CameraPose,
  type ScanConfidence,
  type TapPoint,
} from "@tm-designs/measure-core";
import {
  RoomPlan,
  type RoomPlanScanResult,
} from "@tm-designs/capacitor-roomplan";

/**
 * LIDAR_ENABLED — build-time gate for the Apple RoomPlan / LiDAR path.
 *
 * Set NEXT_PUBLIC_ENABLE_LIDAR=1 in the build environment to re-enable.
 * When false the isSupported() probe is short-circuited so the overlay
 * always defaults to the camera corner-tap method; the LiDAR chip in the
 * mode picker still renders (so the UI stays intact) but shows the
 * "not available" fallback message rather than the Start button.
 */
const LIDAR_ENABLED = process.env.NEXT_PUBLIC_ENABLE_LIDAR === "1";

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
  /** Time and position of the last accepted corner tap, for double-tap rejection. */
  const lastTapRef = useRef<{ t: number; x: number; y: number } | null>(null);
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
  /** Phone pitch recorded at each corner tap — see processCornerTapMeasurement. */
  const tiltPerCornerRef = useRef<number[]>([]);
  /**
   * Which horizontal plane the corners are tapped on.
   *
   * Floor is the default, but in a furnished room the floor corners are
   * usually hidden behind furniture while the ceiling corners are clear.
   * Walls are vertical, so the ceiling outline equals the floor outline.
   * Ceiling mode needs a known ceiling height, since that sets the scale.
   */
  const [tapPlane, setTapPlane] = useState<"floor" | "ceiling">("floor");
  const [ceilingHeightM, setCeilingHeightM] = useState("2.4");
  /**
   * How much of the room is captured in one go.
   *
   * "room" — four corners in a single frame. Mathematically ideal but a
   *   ~70° phone lens can't see all four corners of a normal room unless
   *   you stand outside it.
   * "wall" — two corners of one wall, repeated for the adjacent wall.
   *   Each measurement is still a single fixed pose (so the maths holds)
   *   but only ever needs two corners in frame at once, which is
   *   achievable in a real, furnished room.
   */
  const [measureMode, setMeasureMode] = useState<"room" | "wall" | "span">("span");
  /**
   * Distance from the wall you're standing against to the phone, in
   * metres. Backs onto the wall, arms forward — about 10 cm. Added to
   * every span so the number is wall-to-wall, not phone-to-wall.
   */
  const BODY_OFFSET_M = 0.1;
  /** Completed wall lengths in metres, in tap order. */
  const [wallLengths, setWallLengths] = useState<number[]>([]);
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
   *  prompt + progress line so the camera view isn't obscured.
   *  Defaults to collapsed so first-time users see the room. */
  const [hudCollapsed, setHudCollapsed] = useState(true);
  /** Lets the user dismiss the setup gate and scan uncalibrated anyway. */
  const [setupDismissed, setSetupDismissed] = useState(false);
  /**
   * Camera-lens picker, collapsed by default.
   *
   * Recent iPhones report four lenses, and listing them all is what made
   * the method sheet taller than the screen in the first place. Almost
   * nobody needs to change lens, so it sits behind a disclosure and the
   * sheet stays short enough to take in at a glance.
   */
  const [lensPickerOpen, setLensPickerOpen] = useState(false);
  /**
   * Method chosen on the second gate. Kept separate from the setup gate so
   * every choice is made on a full screen, leaving the viewfinder
   * completely clear once tapping starts.
   */
  const [methodChosen, setMethodChosen] = useState(false);
  /**
   * Back cameras offered by the device, and which one is in use.
   *
   * The main lens sees ~50° across in portrait — not enough to frame both
   * ends of a wall from inside a normal room. Modern iPhones also expose
   * an ultra-wide (0.5×) lens at ~100°+, which fits a whole wall easily.
   * That's the practical answer to "the wall doesn't fit".
   *
   * Focal length is a property of the lens, so switching cameras
   * invalidates any existing calibration — cleared deliberately rather
   * than silently applying the wrong one.
   */
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  /** Lens the user explicitly picked. Null = let the browser decide. */
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null);
  /** Lens the browser actually opened — used only to show which is live. */
  const [detectedDeviceId, setDetectedDeviceId] = useState<string | null>(null);

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
    tiltPerCornerRef.current = [];
    subTapsRef.current = [];
    setSubTapCount(0);
    setWallLengths([]);
    // Clear in-flight calibration scratch state only — the resolved
    // focal length is persisted per device and rehydrated on mount,
    // so leave `calibratedFocalPx` alone here.
    calibTapsRef.current = [];
    setCalibTapCount(0);
    setCalibError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: activeDeviceId
          ? { deviceId: { exact: activeDeviceId }, width: { ideal: 1920 } }
          : { facingMode: { ideal: "environment" }, width: { ideal: 1920 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      // Labels are only populated once camera permission has been granted,
      // which is why this runs after getUserMedia rather than before.
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const cams = devices.filter((d) => d.kind === "videoinput");
        setVideoDevices(cams);
        // Record which camera the browser actually chose, for highlighting
        // only. Deliberately NOT written to activeDeviceId: that feeds
        // startCamera's dependencies, so setting it here would restart the
        // stream immediately after opening it.
        const current = stream.getVideoTracks()[0]?.getSettings?.().deviceId;
        if (typeof current === "string") setDetectedDeviceId(current);
      } catch {
        /* enumeration unsupported — the lens picker just won't appear */
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
    // activeDeviceId is read above when building the constraints, so it
    // must be a dependency — otherwise picking a different lens rebuilds
    // nothing and silently reopens the same camera.
  }, [calibratedFocalPx, activeDeviceId]);

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
    // startCamera changes identity when activeDeviceId changes, so
    // switching lens restarts the stream through this effect. The lens
    // button therefore only sets state — calling startCamera() there too
    // would open the camera twice.
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
  /**
   * True once a real device-orientation reading has arrived.
   *
   * tiltRef starts at FALLBACK_TILT_DEG, so a phone that never reports
   * orientation — permission denied, sensor unavailable, or the setup
   * gate dismissed — is indistinguishable from one genuinely held at
   * that angle. Every corner then records the assumed tilt and the
   * solver returns a normal-looking room measured from a guess.
   *
   * That is worse than refusing: 3° of tilt error is already 23% in
   * depth, and an assumption that is 15° out yields a number nobody
   * could tell was wrong. So measurement is blocked outright until the
   * sensor has spoken.
   */
  const hasTiltReadingRef = useRef(false);

  const onOrientation = useCallback((ev: DeviceOrientationEvent) => {
    if (typeof ev.beta !== "number" || Number.isNaN(ev.beta)) return;
    // Record that the sensor is genuinely reporting. Without this we
    // cannot tell a real -30° reading from the -30° fallback, and the
    // fallback must never be measured from — see the guard in
    // requireTiltReading.
    hasTiltReadingRef.current = true;
    /**
     * Camera pitch relative to the horizon, valid in ANY device
     * orientation.
     *
     * The old `beta - 90` shortcut only holds in portrait. That mattered
     * because a phone sees roughly 50° across in portrait but ~70° in
     * landscape — and landscape is the only way to fit both ends of a
     * wall in frame. Rotating the phone used to silently corrupt the
     * angle, so landscape wasn't usable.
     *
     * Deriving it from the full orientation instead: the rear camera
     * looks along the device's −Z axis, and with the W3C rotation
     * Rz(α)Rx(β)Ry(γ) that axis has a vertical component of
     * −cos(β)·cos(γ). Its arcsine is the elevation angle. Screen
     * rotation doesn't appear because the camera's physical direction
     * doesn't depend on how the UI is rotated.
     *
     * Sanity: portrait upright (β=90, γ=0) → 0°, level. Tilted down 30°
     * (β=60) → −30°, matching the old formula. Landscape (β=0, γ=60)
     * → −30° as well, which the old formula got badly wrong.
     */
    const b = (ev.beta ?? 0) * (Math.PI / 180);
    const g = (ev.gamma ?? 0) * (Math.PI / 180);
    const vertical = -Math.cos(b) * Math.cos(g);
    const tilt = (Math.asin(Math.max(-1, Math.min(1, vertical))) * 180) / Math.PI;
    // Full pitch range. This used to cap at +30°, which was harmless when
    // only floor scanning existed but silently broke ceiling mode: aiming
    // up at a ceiling line needs positive pitch, and anything steeper than
    // 30° was being reported as 30° — wrong angle, wrong distance.
    const clamped = Math.max(-90, Math.min(90, tilt));
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

  /**
   * Guard every measurement path: refuse to compute from the fallback
   * tilt. Returns true when it is safe to proceed.
   */
  const requireTiltReading = useCallback((): boolean => {
    if (hasTiltReadingRef.current) return true;
    setErrorMsg(
      "No reading from the phone's motion sensor, so the angle it's held at is unknown — and every measurement depends on it. Enable Motion & Orientation access, then scan again.",
    );
    setPhase("error");
    return false;
  }, []);

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
  /**
   * Wall mode: two taps → one wall length.
   *
   * Uses the same back-projection as the four-corner solver, just with a
   * pair of points instead of a quad. Because both taps come from one
   * stationary pose the single-pose assumption holds exactly — which is
   * why this is more reliable in practice than trying to fit a whole
   * room into one frame.
   */
  const processWallMeasurement = useCallback(() => {
    const video = videoRef.current;
    const taps = pixelTapsRef.current;
    if (!video || taps.length !== 2) {
      setErrorMsg("Need two taps to measure a wall — try again.");
      setPhase("error");
      return;
    }
    if (!requireTiltReading()) return;
    const imageWidthPx = video.videoWidth || video.clientWidth || 1920;
    const imageHeightPx = video.videoHeight || video.clientHeight || 1080;

    const tilts = tiltPerCornerRef.current;
    const meanTilt =
      tilts.length > 0
        ? tilts.reduce((a, b) => a + b, 0) / tilts.length
        : (tiltRef.current ?? FALLBACK_TILT_DEG);

    const pose: CameraPose = {
      heightM: cameraHeightM,
      tiltDeg: meanTilt,
      focalLengthPx: calibratedFocalPx ?? estimateFocalLengthPx(imageWidthPx),
      imageWidthPx,
      imageHeightPx,
    };

    const ceilH = Number(ceilingHeightM);
    const planeOffsetM =
      tapPlane === "ceiling" && Number.isFinite(ceilH) && ceilH > cameraHeightM
        ? ceilH - cameraHeightM
        : undefined;

    const a = projectTapToFloor(taps[0], pose, planeOffsetM);
    const b = projectTapToFloor(taps[1], pose, planeOffsetM);
    if (!a || !b) {
      setErrorMsg(
        tapPlane === "ceiling"
          ? "Those taps are below the horizon — point further up and re-tap the two ceiling corners."
          : "Those taps are above the horizon — point further down and re-tap the two floor corners.",
      );
      setPhase("error");
      return;
    }
    const lengthM = Math.hypot(a.xM - b.xM, a.zM - b.zM);
    if (!Number.isFinite(lengthM) || lengthM <= 0) {
      setErrorMsg("Couldn't compute that wall — re-tap the two corners.");
      setPhase("error");
      return;
    }

    const next = [...wallLengths, Number(lengthM.toFixed(2))];
    setWallLengths(next);
    // Reset for the next wall.
    pixelTapsRef.current = [];
    tiltPerCornerRef.current = [];
    subTapsRef.current = [];
    setSubTapCount(0);
    setCornerCount(0);
    setMarkers([]);

    // Two walls is enough for a rectangular room: width × length.
    if (next.length >= 2) {
      const [widthM, lengthM2] = next;
      setResult({
        widthM,
        lengthM: lengthM2,
        heightM: planeOffsetM !== undefined ? ceilH : DEFAULT_CEILING_HEIGHT_M,
        method: "corners",
        confidence: calibratedFocalPx !== null ? "medium" : "low",
        notes: [
          `Measured wall by wall: ${widthM.toFixed(2)} m × ${lengthM2.toFixed(2)} m.`,
          "Assumes a rectangular room — opposite walls taken as equal.",
          planeOffsetM !== undefined
            ? `Ceiling corners, ${ceilH.toFixed(2)} m ceiling.`
            : "Floor corners.",
          calibratedFocalPx === null
            ? "Not calibrated — run calibration for a tighter result."
            : "Calibrated lens.",
        ],
        areaM2: Number((widthM * lengthM2).toFixed(2)),
        rectangular: true,
      });
      setPhase("result");
    }
  }, [
    cameraHeightM,
    calibratedFocalPx,
    ceilingHeightM,
    tapPlane,
    wallLengths,
  ]);

  /**
   * Span mode: back against one wall, one tap at the base of the wall
   * opposite → that's the room dimension.
   *
   * The other methods all failed on framing: a phone lens simply can't
   * take in two corners of a wall, let alone four, from inside a normal
   * room. This needs a single point in view, which is always achievable,
   * and the phone is naturally still for a single tap.
   *
   * projectTapToFloor already returns the tapped point's position
   * relative to the camera, so the distance is just its magnitude —
   * no new geometry, only a different question asked of the same maths.
   */
  const processSpanMeasurement = useCallback(() => {
    const video = videoRef.current;
    const taps = pixelTapsRef.current;
    if (!video || taps.length < 1) return;
    if (!requireTiltReading()) return;
    const imageWidthPx = video.videoWidth || video.clientWidth || 1920;
    const imageHeightPx = video.videoHeight || video.clientHeight || 1080;

    const tilts = tiltPerCornerRef.current;
    const meanTilt =
      tilts.length > 0
        ? tilts.reduce((a, b) => a + b, 0) / tilts.length
        : (tiltRef.current ?? FALLBACK_TILT_DEG);

    const pose: CameraPose = {
      heightM: cameraHeightM,
      tiltDeg: meanTilt,
      focalLengthPx: calibratedFocalPx ?? estimateFocalLengthPx(imageWidthPx),
      imageWidthPx,
      imageHeightPx,
    };

    // Ceiling works exactly as well here: because walls are vertical, the
    // horizontal distance to where the far wall meets the ceiling is the
    // same span as where it meets the floor — and that junction is never
    // hidden behind furniture.
    const ceilH = Number(ceilingHeightM);
    const planeOffsetM =
      tapPlane === "ceiling" && Number.isFinite(ceilH) && ceilH > cameraHeightM
        ? ceilH - cameraHeightM
        : undefined;
    if (tapPlane === "ceiling" && planeOffsetM === undefined) {
      setErrorMsg(
        "Ceiling height must be greater than your eye height. Check both values.",
      );
      setPhase("error");
      return;
    }

    const p = projectTapToFloor(taps[0], pose, planeOffsetM);
    if (!p) {
      setErrorMsg(
        planeOffsetM !== undefined
          ? "That tap is below the horizon — aim higher, where the far wall meets the ceiling."
          : "That tap is above the horizon — aim lower, where the far wall meets the floor.",
      );
      setPhase("error");
      return;
    }
    // Horizontal distance from the camera to the tapped point, plus the
    // gap between the wall at your back and the phone.
    const spanM = Math.hypot(p.xM, p.zM) + BODY_OFFSET_M;
    if (!Number.isFinite(spanM) || spanM <= 0) {
      setErrorMsg("Couldn't read that tap — try again.");
      setPhase("error");
      return;
    }

    const next = [...wallLengths, Number(spanM.toFixed(2))];
    setWallLengths(next);
    pixelTapsRef.current = [];
    tiltPerCornerRef.current = [];
    subTapsRef.current = [];
    setSubTapCount(0);
    setCornerCount(0);
    setMarkers([]);

    if (next.length >= 2) {
      const [widthM, lengthM] = next;
      setResult({
        widthM,
        lengthM,
        heightM: planeOffsetM !== undefined ? ceilH : DEFAULT_CEILING_HEIGHT_M,
        method: "corners",
        confidence: calibratedFocalPx !== null ? "medium" : "low",
        notes: [
          `Wall-to-wall spans: ${widthM.toFixed(2)} m × ${lengthM.toFixed(2)} m.`,
          `Includes a ${(BODY_OFFSET_M * 100).toFixed(0)} cm allowance for the gap between the wall behind you and the phone.`,
          planeOffsetM !== undefined
            ? `Measured to the ceiling line using a ${ceilH.toFixed(2)} m ceiling — accuracy depends on that being right.`
            : "Ceiling height defaulted to 2.40 m — please confirm in review.",
          calibratedFocalPx === null
            ? "Not calibrated — run calibration for a tighter result."
            : "Calibrated lens.",
        ],
        areaM2: Number((widthM * lengthM).toFixed(2)),
        rectangular: true,
      });
      setPhase("result");
    }
  }, [
    cameraHeightM,
    calibratedFocalPx,
    wallLengths,
    tapPlane,
    ceilingHeightM,
  ]);

  const processCornerTapMeasurement = useCallback(async () => {
    const video = videoRef.current;
    const taps = pixelTapsRef.current;
    if (!video || taps.length !== 4) {
      setErrorMsg("Scan input was incomplete — please try again.");
      setPhase("error");
      return;
    }
    if (!requireTiltReading()) return;
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

    // Average the per-corner pitches rather than using whichever angle the
    // phone happened to hold on the final tap — one unlucky reading used to
    // rescale the entire room.
    const tilts = tiltPerCornerRef.current;
    const meanTilt =
      tilts.length > 0
        ? tilts.reduce((a, b) => a + b, 0) / tilts.length
        : (tiltRef.current ?? FALLBACK_TILT_DEG);
    const tiltSpread =
      tilts.length > 1 ? Math.max(...tilts) - Math.min(...tilts) : 0;

    const pose: CameraPose = {
      heightM: cameraHeightM,
      tiltDeg: meanTilt,
      // Use the calibrated focal length if the user ran the scale-bar
      // calibration step; otherwise fall back to the FOV heuristic.
      focalLengthPx: calibratedFocalPx ?? estimateFocalLengthPx(imageWidthPx),
      imageWidthPx,
      imageHeightPx,
    };
    // Ceiling mode aims at the plane above the camera; the offset is the
    // rise from eye level to the ceiling. Floor mode leaves it undefined
    // so the solver uses -heightM as before.
    const ceilH = Number(ceilingHeightM);
    const planeOffsetM =
      tapPlane === "ceiling" && Number.isFinite(ceilH) && ceilH > cameraHeightM
        ? ceilH - cameraHeightM
        : undefined;
    if (tapPlane === "ceiling" && planeOffsetM === undefined) {
      setErrorMsg(
        "Ceiling height must be greater than your eye height. Check both values and try again.",
      );
      setPhase("error");
      return;
    }

    const ordered = sortFloorCornersClockwise(taps as [TapPoint, TapPoint, TapPoint, TapPoint]);
    const out = estimateRoomFromFloorTaps({ corners: ordered, pose, planeOffsetM });

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
    const reproPx = meanReprojectionErrorPx(
      ordered,
      out.floorPoints,
      pose,
      planeOffsetM,
    );
    const reproThresh = pose.imageWidthPx * 0.015;
    const reproOk = Number.isFinite(reproPx) && reproPx < reproThresh;

    // Opposite walls are averaged to absorb small tap jitter.
    const widthM = Number(((out.wallsM[0] + out.wallsM[2]) / 2).toFixed(2));
    const lengthM = Number(((out.wallsM[1] + out.wallsM[3]) / 2).toFixed(2));
    const notes = [
      ...out.notes,
      planeOffsetM !== undefined
        ? `Measured from ceiling corners using a ${ceilH.toFixed(2)} m ceiling — accuracy depends on that height being right.`
        : "Ceiling height defaulted to 2.40 m — please confirm in review.",
    ];
    // The solver assumes one fixed camera pose. A wide pitch spread means
    // the phone was tilted or turned between corners, which distorts scale
    // badly — say so plainly rather than presenting a confident wrong number.
    if (tiltSpread > 10) {
      notes.unshift(
        `Phone moved between corners (${Math.round(tiltSpread)}° of tilt change) — measurements are unreliable. Stand where all four corners are visible and rescan without moving.`,
      );
    }
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
    // A moved phone invalidates the single-pose model outright, so this
    // outranks the re-projection check below.
    if (tiltSpread > 10) confidence = "low";
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
      // In ceiling mode the user has told us the ceiling height, so use
      // it rather than the 2.40 m placeholder.
      heightM:
        planeOffsetM !== undefined ? ceilH : DEFAULT_CEILING_HEIGHT_M,
      method: "corners",
      confidence,
      notes,
      areaM2: out.areaM2,
      rectangular: out.rectangular,
    });
    setPhase("result");
  }, [
    cameraHeightM,
    liveTiltDeg,
    calibratedFocalPx,
    tapPlane,
    ceilingHeightM,
  ]);

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
      // Reject the second half of a double-tap. iOS delivers both taps
      // as ordinary clicks, so double-tapping to zoom also dropped two
      // corner markers a few pixels apart — the user sees stray dots
      // appear and has no way to tell which one the solver used.
      // 320 ms is above the double-tap threshold and well below any
      // plausible deliberate re-tap of the same corner.
      const now = Date.now();
      const last = lastTapRef.current;
      if (last && now - last.t < 320 &&
          Math.abs(e.clientX - last.x) < 44 && Math.abs(e.clientY - last.y) < 44) {
        return;
      }
      lastTapRef.current = { t: now, x: e.clientX, y: e.clientY };
      // Tier-2: drop the tap if the phone is moving — far better to
      // make the user re-try than to lock in a smeared corner.
      if (!isStable) return;
      // Calibration only ever uses two taps. Bail out before drawing a
      // marker once we have them, otherwise extra taps leave dots on
      // screen that count for nothing — which reads as "re-tapping isn't
      // working" when in fact the taps are simply being ignored.
      if (phase === "calibrate" && calibTapsRef.current.length >= 2) return;
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
      // Remember the phone's pitch for this corner. The solver takes a
      // single pose, so we average these and warn when they diverge —
      // divergence means the phone moved between taps, which silently
      // wrecks the scale.
      tiltPerCornerRef.current = [
        ...tiltPerCornerRef.current,
        tiltRef.current ?? FALLBACK_TILT_DEG,
      ];
      subTapsRef.current = [];
      setSubTapCount(0);

      // pixelTapsRef is the source of truth for how many corners are done,
      // so derive the count from it rather than from state.
      //
      // The completion call must NOT live inside a setState updater:
      // React re-invokes updaters in development, which ran the wall
      // calculation twice. The first run consumed and cleared the taps,
      // so the second found none and reported "Need two taps".
      const next = pixelTapsRef.current.length;
      setCornerCount(next);
      const required =
        measureMode === "span" ? 1 : measureMode === "wall" ? 2 : 4;
      if (next >= required) {
        if (measureMode === "span") processSpanMeasurement();
        else if (measureMode === "wall") processWallMeasurement();
        else void processCornerTapMeasurement();
      }
    },
    [
      scanMode,
      phase,
      processCornerTapMeasurement,
      processWallMeasurement,
      processSpanMeasurement,
      measureMode,
      isStable,
    ],
  );

  /**
   * Probe Apple RoomPlan support exactly once per overlay open.
   * Runs on every platform — the plugin's web fallback cleanly reports
   * `supported: false` on Android / desktop, so no platform sniff is
   * needed on the React side.
   *
   * Gated by LIDAR_ENABLED: when false we skip the native probe entirely
   * and immediately report "no" so the overlay stays on corner-tap mode.
   * Re-enable by setting NEXT_PUBLIC_ENABLE_LIDAR=1 at build time.
   */
  useEffect(() => {
    if (!open) return;
    if (!LIDAR_ENABLED) {
      setRoomPlanSupport("no");
      setRoomPlanReason("LiDAR scanning is not enabled in this build.");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // Race against a 2 s timeout. Without this a hung promise — which
        // is what the Capacitor web fallback does when there's no native
        // implementation to answer — leaves the overlay pinned on
        // "Checking RoomPlan availability…" with no way forward.
        const timeout = new Promise<{ supported: boolean; reason?: string }>(
          (resolve) =>
            setTimeout(
              () =>
                resolve({
                  supported: false,
                  reason: "Availability check timed out — using corner-tap mode.",
                }),
              2000,
            ),
        );
        const r = await Promise.race([RoomPlan.isSupported(), timeout]);
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
          onDoubleClick={(e) => e.preventDefault()}
          // touchAction:none rather than "manipulation": the latter still
          // leaves double-tap zoom on the table in iOS Safari, and there
          // is no gesture on this surface that needs the browser's help.
          style={{ touchAction: "none", WebkitUserSelect: "none" }}
        />
      )}

      {markers.map((m, i) => (
        <div
          key={`${m.x}-${m.y}-${i}`}
          className="pointer-events-none absolute z-[8] h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#1c1c1a] bg-[#b89650]"
          style={{ left: `${m.x}%`, top: `${m.y}%` }}
        />
      ))}

      {/* The reticle reads as "aim here and shoot", which is the opposite
          of what corner-tap needs: you must hold the phone still and tap
          each target where it appears on screen. Users were centring the
          crosshair on each point and tapping the middle, so every tap
          landed at the same screen position and the solver saw a
          zero-size room. Shown only for LiDAR/video modes, where aiming
          genuinely is the interaction. */}
      {(phase === "camera" || phase === "calibrate") &&
        scanMode !== "corners" && <Reticle />}

      {/* Corner-tap: a small fixed hint instead of a reticle. */}
      {(phase === "camera" || phase === "calibrate") &&
        scanMode === "corners" && (
          <div
            className="pointer-events-none absolute left-1/2 top-6 z-10 -translate-x-1/2 rounded-full px-3 py-1.5 text-center text-[11px] font-semibold"
            style={{ backgroundColor: `${HUD}dd`, color: GOLD }}
            aria-hidden
          >
            Tap the target on screen — don&apos;t aim, don&apos;t move the phone
          </div>
        )}

      {/* Top bar.
          The overlay covers the whole screen, so this bar sits under
          the status bar unless it clears the safe-area inset — the room
          name collided with the clock and the battery icon. min-w-0 and
          truncate stop a long room name pushing the Close button off
          the edge. */}
      <div
        className="relative z-20 flex items-center justify-between gap-3 px-4 py-3"
        style={{
          backgroundColor: `${HUD}e6`,
          paddingTop: "calc(0.75rem + env(safe-area-inset-top))",
        }}
      >
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em]" style={{ color: GOLD }}>
            Scan your room
          </p>
          <p className="truncate text-sm font-semibold text-white/90">{roomLabel || "Room"}</p>
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

        {/* ── Setup gate ──────────────────────────────────────────────
            Motion sensor and calibration decide whether any measurement
            is meaningful, so they get the screen to themselves before
            anything else appears. Once both are done (or explicitly
            skipped) this disappears for good and the viewfinder is
            left as clear as possible. */}
        {phase === "camera" &&
          scanMode === "corners" &&
          !setupDismissed &&
          (tiltPermission !== "granted" || calibratedFocalPx === null) && (
            /* Same structure as the method gate below: pinned title,
               scrolling body, pinned action. Centring content that is
               taller than the screen left the buttons unreachable, with
               force-quit as the only way out. */
            <div className="pointer-events-auto absolute inset-0 z-[20] flex items-center justify-center bg-black/80 px-6 py-6">
              <div
                className="flex max-h-full w-full max-w-sm flex-col overflow-hidden rounded-2xl"
                style={{ backgroundColor: `${HUD}f5` }}
              >
                <p
                  style={{ color: GOLD }}
                  className="shrink-0 px-5 pb-1 pt-5 text-sm font-bold uppercase tracking-widest"
                >
                  Set up first
                </p>
                <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-2">
                <p className="mb-4 text-xs text-white/70">
                  Two quick steps. Without them the measurements will be
                  badly wrong.
                </p>

                {/* Step 1 — motion sensor */}
                <div className="mb-3 rounded-lg bg-white/5 p-3">
                  <p className="mb-2 text-xs font-semibold text-white">
                    1. Motion sensor{" "}
                    {tiltPermission === "granted" && (
                      <span style={{ color: "#9ce29c" }}>✓</span>
                    )}
                  </p>
                  <p className="mb-2 text-[11px] text-white/60">
                    Lets the app read the angle your phone is pointing at.
                  </p>
                  {tiltPermission !== "granted" && (
                    <button
                      type="button"
                      onClick={() => void requestTiltPermission()}
                      className="w-full rounded-full px-4 py-2.5 text-[11px] font-bold uppercase tracking-widest text-[#1c1c1a]"
                      style={{ backgroundColor: GOLD }}
                    >
                      Enable motion sensor
                    </button>
                  )}
                </div>

                {/* Step 2 — calibration */}
                <div className="mb-4 rounded-lg bg-white/5 p-3">
                  <p className="mb-2 text-xs font-semibold text-white">
                    2. Calibrate{" "}
                    {calibratedFocalPx !== null && (
                      <span style={{ color: "#9ce29c" }}>✓</span>
                    )}
                  </p>
                  <p className="mb-2 text-[11px] text-white/60">
                    Put a long object <strong className="text-white">on the
                    floor</strong> — a 1 m tape, floor tile edge or A4 sheet —
                    and tap each end. Teaches the app your camera lens.
                  </p>
                  {calibratedFocalPx === null && (
                    <button
                      type="button"
                      disabled={tiltPermission !== "granted"}
                      onClick={() => {
                        calibTapsRef.current = [];
                        setCalibTapCount(0);
                        setCalibError(null);
                        setMarkers([]);
                        setCornerCount(0);
                        pixelTapsRef.current = [];
                        tiltPerCornerRef.current = [];
                        setPhase("calibrate");
                      }}
                      className="w-full rounded-full px-4 py-2.5 text-[11px] font-bold uppercase tracking-widest text-[#1c1c1a] disabled:opacity-40"
                      style={{ backgroundColor: GOLD }}
                    >
                      Start calibration
                    </button>
                  )}
                </div>

                </div>

                <div
                  className="shrink-0 border-t border-white/10 px-5 pt-3"
                  style={{
                    paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setSetupDismissed(true)}
                    className="w-full text-[11px] font-bold uppercase tracking-widest text-white/50 underline"
                  >
                    Skip — measure anyway (less accurate)
                  </button>
                </div>
              </div>
            </div>
          )}

        {/* ── Method gate ─────────────────────────────────────────────
            Second full screen: what you're measuring and which plane.
            Choosing here rather than on the live camera means the
            viewfinder is unobstructed once tapping begins. */}
        {phase === "camera" &&
          scanMode === "corners" &&
          (setupDismissed ||
            (tiltPermission === "granted" && calibratedFocalPx !== null)) &&
          !methodChosen && (
            /* This sheet was `flex items-center justify-center` with no
               overflow handling. Any phone reporting four camera lenses
               — which is most recent iPhones — made the content taller
               than the screen, and "Start measuring" was pushed off the
               bottom with no way to scroll to it. The scan could not be
               started and force-quitting was the only way out.

               Scrolling the whole backdrop was the first fix and it
               worked, but it meant hunting for the button at the bottom
               of a long page. The panel now owns its own scrolling: the
               title is pinned, the options scroll, and the action stays
               on screen at all times. Nothing has to be found. */
            <div className="pointer-events-auto absolute inset-0 z-[20] flex items-center justify-center bg-black/80 px-6 py-6">
              <div
                className="flex max-h-full w-full max-w-sm flex-col overflow-hidden rounded-2xl"
                style={{ backgroundColor: `${HUD}f5` }}
              >
                <p
                  style={{ color: GOLD }}
                  className="shrink-0 px-5 pb-3 pt-5 text-sm font-bold uppercase tracking-widest"
                >
                  How do you want to measure?
                </p>

                {/* min-h-0 is load-bearing: without it a flex child
                    refuses to shrink below its content height and the
                    overflow never engages. */}
                <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-2">
                <p className="mb-2 text-[11px] uppercase tracking-widest text-white/45">
                  Method
                </p>
                <div className="mb-4 flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={() => setMeasureMode("span")}
                    className="rounded-lg p-3 text-left"
                    style={
                      measureMode === "span"
                        ? { backgroundColor: GOLD, color: "#1c1c1a" }
                        : { border: "1px solid rgba(255,255,255,0.2)" }
                    }
                  >
                    <span className="block text-xs font-bold uppercase tracking-widest">
                      Wall to wall · easiest
                    </span>
                    <span
                      className={`mt-0.5 block text-[11px] ${measureMode === "span" ? "text-[#1c1c1a]/70" : "text-white/60"}`}
                    >
                      Back against one wall, one tap at the base of the wall
                      opposite. Nothing to fit in frame.
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setMeasureMode("wall")}
                    className="rounded-lg p-3 text-left"
                    style={
                      measureMode === "wall"
                        ? { backgroundColor: GOLD, color: "#1c1c1a" }
                        : { border: "1px solid rgba(255,255,255,0.2)" }
                    }
                  >
                    <span className="block text-xs font-bold uppercase tracking-widest">
                      One wall at a time
                    </span>
                    <span
                      className={`mt-0.5 block text-[11px] ${measureMode === "wall" ? "text-[#1c1c1a]/70" : "text-white/60"}`}
                    >
                      Two corners per wall. Needs both ends in frame.
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setMeasureMode("room")}
                    className="rounded-lg p-3 text-left"
                    style={
                      measureMode === "room"
                        ? { backgroundColor: GOLD, color: "#1c1c1a" }
                        : { border: "1px solid rgba(255,255,255,0.2)" }
                    }
                  >
                    {/* Worded bluntly on purpose. "Needs a lot of space"
                        read as a mild caveat, so it was picked for an
                        ordinary room and failed — all four floor corners
                        genuinely have to be in one frame, which a phone
                        cannot manage indoors unless the space is large
                        or you can stand well back through a doorway. */}
                    <span className="block text-xs font-bold uppercase tracking-widest">
                      Whole room · rarely fits
                    </span>
                    <span
                      className={`mt-0.5 block text-[11px] ${measureMode === "room" ? "text-[#1c1c1a]/70" : "text-white/60"}`}
                    >
                      All four floor corners must be visible at once. Only
                      works in large rooms — use Wall to wall otherwise.
                    </span>
                  </button>
                </div>

                <p className="mb-2 text-[11px] uppercase tracking-widest text-white/45">
                  Tap which corners?
                </p>
                <div className="mb-4 flex gap-2">
                  {(["floor", "ceiling"] as const).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setTapPlane(p)}
                      className="flex-1 rounded-lg px-3 py-2 text-[11px] font-bold uppercase tracking-widest"
                      style={
                        tapPlane === p
                          ? { backgroundColor: GOLD, color: "#1c1c1a" }
                          : {
                              border: "1px solid rgba(255,255,255,0.2)",
                              color: "rgba(255,255,255,0.8)",
                            }
                      }
                    >
                      {p === "floor" ? "Floor" : "Ceiling"}
                    </button>
                  ))}
                </div>
                {tapPlane === "ceiling" && (
                  <div className="mb-4">
                    <label className="flex items-center gap-2 text-[11px] text-white/70">
                      <span className="uppercase tracking-widest text-white/45">
                        Ceiling height
                      </span>
                      <input
                        type="number"
                        inputMode="decimal"
                        min={1.8}
                        max={6}
                        step={0.01}
                        value={ceilingHeightM}
                        onChange={(e) => setCeilingHeightM(e.target.value)}
                        className="w-20 rounded bg-white/10 px-2 py-1 text-right font-mono text-white outline-none"
                      />
                      <span className="text-white/40">m</span>
                    </label>
                    {/* In ceiling mode this number IS the scale — leaving it
                        at the default silently multiplies every measurement
                        by the wrong factor. A 2.4 default in a 3.5 m room
                        makes results roughly half what they should be. */}
                    <p
                      className="mt-1.5 rounded-md px-2 py-1.5 text-[11px]"
                      style={{
                        backgroundColor: "rgba(184,150,80,0.16)",
                        color: GOLD,
                      }}
                    >
                      Measure this properly — don&apos;t guess. In ceiling
                      mode it sets the scale, so if it&apos;s wrong every
                      measurement is wrong by the same proportion.
                    </p>
                  </div>
                )}

                {/* Lens picker. An ultra-wide lens is the difference between
                    a wall fitting in frame and not. */}
                {videoDevices.length > 1 && (
                  <>
                    <button
                      type="button"
                      onClick={() => setLensPickerOpen((o) => !o)}
                      className="mb-2 flex w-full items-center justify-between rounded-lg border border-white/15 px-3 py-2 text-left"
                    >
                      <span className="text-[11px] uppercase tracking-widest text-white/45">
                        Camera lens
                      </span>
                      <span className="text-[11px] font-semibold" style={{ color: GOLD }}>
                        {lensPickerOpen ? "Hide" : "Change"}
                      </span>
                    </button>
                    <div className={lensPickerOpen ? "block" : "hidden"}>
                    <p className="mb-2 text-[11px] text-white/60">
                      Can&apos;t fit the wall in? Pick an ultra-wide lens — it
                      sees roughly twice as much.
                    </p>
                    <div className="mb-4 flex flex-col gap-1.5">
                      {videoDevices.map((d, i) => (
                        <button
                          key={d.deviceId || i}
                          type="button"
                          onClick={() => {
                            if (d.deviceId === (activeDeviceId ?? detectedDeviceId))
                              return;
                            // Different lens = different focal length, so the
                            // stored calibration no longer applies.
                            setCalibratedFocalPx(null);
                            try {
                              window.localStorage.removeItem(calibStorageKey);
                            } catch {
                              /* noop */
                            }
                            // The camera restarts via the open/startCamera
                            // effect once this lands — calling startCamera
                            // here as well would open the stream twice.
                            setActiveDeviceId(d.deviceId);
                            setSetupDismissed(false);
                          }}
                          className="rounded-lg px-3 py-2 text-left text-[11px] font-semibold"
                          style={
                            d.deviceId === (activeDeviceId ?? detectedDeviceId)
                              ? { backgroundColor: GOLD, color: "#1c1c1a" }
                              : {
                                  border: "1px solid rgba(255,255,255,0.2)",
                                  color: "rgba(255,255,255,0.8)",
                                }
                          }
                        >
                          {d.label || `Camera ${i + 1}`}
                        </button>
                      ))}
                    </div>
                    </div>
                  </>
                )}

                </div>

                {/* Pinned footer. The action is never more than a glance
                    away, however many camera lenses the phone reports. */}
                <div
                  className="shrink-0 border-t border-white/10 px-5 pt-3"
                  style={{
                    paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setMethodChosen(true);
                      setHudCollapsed(true);
                    }}
                    className="w-full rounded-full px-4 py-3 text-[11px] font-bold uppercase tracking-widest text-[#1c1c1a]"
                    style={{ backgroundColor: GOLD }}
                  >
                    Start measuring
                  </button>
                </div>
              </div>
            </div>
          )}

        {(phase === "camera" || phase === "calibrate") && (
          <>
            {/* Mode picker is irrelevant mid-calibration and was eating a
                third of the viewfinder — hide it until calibration ends. */}
            <div
              // Corner mark is already the chosen mode by this point, so the
              // mode chips are pure clutter over the viewfinder.
              className={`pointer-events-auto mx-4 mb-3 flex-wrap gap-2 rounded-xl p-3 ${
                phase === "calibrate" || scanMode === "corners"
                  ? "hidden"
                  : "flex"
              }`}
              style={{ backgroundColor: `${HUD}e8` }}
            >
              <ModeChip
                active={scanMode === "lidar"}
                onClick={() => {
                  setScanMode("lidar");
                  setCornerCount(0);
                  setMarkers([]);
                  pixelTapsRef.current = [];
                  tiltPerCornerRef.current = [];
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
                  tiltPerCornerRef.current = [];
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
                  tiltPerCornerRef.current = [];
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

            {/* Hidden during calibration: both panels rendered together
                covered the viewfinder, so you couldn't see the reference
                object you were meant to be tapping the ends of. */}
            {scanMode === "corners" && phase !== "calibrate" && (
              <div
                className={`pointer-events-auto mx-4 mb-3 rounded-xl text-xs text-white/75 ${hudCollapsed ? "p-2" : "p-4"}`}
                style={{ backgroundColor: `${HUD}ee` }}
              >
                <div
                  className={`flex items-start justify-between gap-2 ${
                    cornerCount === 0 &&
                    (tiltPermission !== "granted" || calibratedFocalPx === null)
                      ? "opacity-50"
                      : ""
                  }`}
                >
                  <p style={{ color: GOLD }} className="mb-1 flex-1 font-semibold">
                    {/* The solver applies one camera pose to all four taps,
                        so every corner must be visible in a single view and
                        the phone must not move between taps. Standing in the
                        middle and turning breaks that assumption and
                        collapses the room to a sliver. */}
                    {/* Terse on-camera prompts only. The full explanation
                        lives on the gate screens, so nothing here competes
                        with the viewfinder. */}
                    {measureMode === "span" ? (
                      <>
                        {cornerCount === 0 &&
                          (wallLengths.length === 0
                            ? tapPlane === "ceiling"
                              ? "Back against a wall — tap where the far wall meets the CEILING ×3"
                              : "Back against a wall — tap where the far wall meets the FLOOR ×3"
                            : "Now turn 90°, back to the next wall — tap opposite ×3")}
                        {cornerCount >= 1 && "Measuring…"}
                      </>
                    ) : measureMode === "wall" ? (
                      <>
                        {cornerCount === 0 && "Tap the LEFT end of the wall ×3"}
                        {cornerCount === 1 && "Now the RIGHT end ×3"}
                        {cornerCount >= 2 && "Measuring…"}
                      </>
                    ) : (
                      <>
                        {cornerCount === 0 && "Tap corner 1 ×3"}
                        {cornerCount === 1 && "Corner 2 — clockwise ×3"}
                        {cornerCount === 2 && "Corner 3 ×3"}
                        {cornerCount === 3 && "Corner 4 ×3"}
                        {cornerCount >= 4 && "Measuring…"}
                      </>
                    )}
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
                    Same spot 3 times — the median absorbs tremor. Stay still.
                  </p>
                )}

                {/* Method and plane are chosen on the gate before the
                    camera appears, so nothing but progress and the live
                    readouts belongs here. */}

                {/* Which plane is live, always visible. Getting this wrong
                    produces a confusing "aim at the floor" error while
                    you're pointing at the ceiling, so it shouldn't be
                    buried on a previous screen. */}
                {cornerCount === 0 && (
                  <div className="mb-2 flex items-center gap-2">
                    <span className="text-[10px] uppercase tracking-widest text-white/45">
                      Tapping
                    </span>
                    {(["floor", "ceiling"] as const).map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => {
                          setTapPlane(p);
                          setMarkers([]);
                          setCornerCount(0);
                          pixelTapsRef.current = [];
                          tiltPerCornerRef.current = [];
                          subTapsRef.current = [];
                          setSubTapCount(0);
                        }}
                        className="rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest"
                        style={
                          tapPlane === p
                            ? { backgroundColor: GOLD, color: "#1c1c1a" }
                            : {
                                border: "1px solid rgba(255,255,255,0.25)",
                                color: "rgba(255,255,255,0.7)",
                              }
                        }
                      >
                        {p}
                      </button>
                    ))}
                    {tapPlane === "ceiling" && (
                      <span className="text-[10px] text-white/50">
                        ceiling {ceilingHeightM} m
                      </span>
                    )}
                  </div>
                )}

                {/* Progress through the two spans / walls. */}
                {(measureMode === "wall" || measureMode === "span") &&
                  wallLengths.length > 0 && (
                    <p className="mb-2 rounded-md bg-white/10 px-2 py-1.5 text-[11px] text-white/85">
                      First measurement ={" "}
                      <strong className="text-white">
                        {wallLengths[0]?.toFixed(2)} m
                      </strong>
                      .{" "}
                      {measureMode === "span"
                        ? "Now stand with your back to an adjacent wall and tap the one opposite."
                        : "Now turn to an adjacent wall and tap its two corners."}
                    </p>
                  )}

                <div className="mb-3 flex items-center gap-2">
                  <div className="flex gap-1">
                    {(measureMode === "span"
                      ? [0]
                      : measureMode === "wall"
                        ? [0, 1]
                        : [0, 1, 2, 3]
                    ).map((i) => (
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
                    {measureMode === "span"
                      ? `Span ${wallLengths.length + 1} / 2 · Tap ${subTapCount} / ${TAPS_PER_CORNER}`
                      : measureMode === "wall"
                        ? `Wall ${wallLengths.length + 1} / 2 · End ${Math.min(cornerCount + 1, 2)} / 2 · Tap ${subTapCount} / ${TAPS_PER_CORNER}`
                        : `Corner ${Math.min(cornerCount + 1, 4)} / 4 · Tap ${subTapCount} / ${TAPS_PER_CORNER}`}
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
                    <>
                    <button
                      type="button"
                      onClick={() => {
                        calibTapsRef.current = [];
                        setCalibTapCount(0);
                        setCalibError(null);
                        setMarkers([]);
                        setCornerCount(0);
                        pixelTapsRef.current = [];
                  tiltPerCornerRef.current = [];
                        setPhase("calibrate");
                      }}
                      // Quiet chip on purpose: calibration is now prompted
                      // prominently on the setup gate before the camera
                      // opens, so this is just the escape hatch for redoing
                      // it mid-scan and shouldn't compete with the viewfinder.
                      className="rounded-full border border-white/20 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-white/80"
                    >
                      Calibrate
                    </button>
                    </>
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
                  tiltPerCornerRef.current = [];
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
                {/* Verbose setup copy only before the first tap. From the
                    first tap onward this collapses to a single line so the
                    viewfinder — and the object being tapped — stays visible.
                    Taps landing on top of each other was traced to the
                    panels covering the camera. */}
                {calibTapCount === 0 ? (
                  <>
                    <p style={{ color: GOLD }} className="mb-1 font-semibold">
                      Scale-bar calibration
                    </p>
                    <p className="mb-3 text-white/65">
                      Lay a{" "}
                      <strong className="text-white">tape measure or ruler flat on the floor</strong>
                      , turned{" "}
                      <strong className="text-white">left-to-right across your view</strong>{" "}
                      — not pointing away from you. Then tap each end, so the
                      two dots sit side by side on screen.
                    </p>
                    <p className="mb-3 text-[11px] text-white/45">
                      Both taps must touch the floor. The side of a bin or box
                      won&apos;t work — those points sit above it. And an
                      object pointing away from you gives the maths almost
                      nothing to work with.
                    </p>
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
                  </>
                ) : (
                  <p style={{ color: GOLD }} className="mb-2 font-semibold">
                    {calibTapCount === 1
                      ? `Tap the far end · ${calibLengthCm} cm`
                      : `Both ends marked · ${calibLengthCm} cm`}
                  </p>
                )}
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
                  tiltPerCornerRef.current = [];
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
