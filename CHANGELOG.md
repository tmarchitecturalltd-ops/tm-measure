# TM Measure — changelog

All notable changes to the app are recorded here. Dates are in ISO 8601.

## [Unreleased]

### Added
- **Architect verification console** at `/architect`. List view, per-submission detail view at `/architect/review?id=…`, "Approve & export" that stamps the sheet and downloads the raw JSON for CAD import.
- **Customer status page** at `/status` — submission ID + email lookup so customers can check whether their quote has been approved without emailing in.
- **Scale-bar focal-length calibration** — two taps on a known reference object back-solve the camera's focal length to ±1 % accuracy. Persists per device for 180 days; auto-detected from `MediaTrackSettings.focalLength` when the browser exposes it.
- **Multi-tap corner averaging** — 3 taps per corner, median used. Halves the single-tap error budget.
- **Live accuracy pill** — HIGH / MEDIUM / LOW updates in real time as the user points the camera, factoring tilt, calibration, and sensor availability.
- **Tilt-stability guard** — rejects taps when the phone is wobbling >2° over 350 ms; "Hold still" pill appears in the HUD.
- **Re-projection cross-check** — `meanReprojectionErrorPx` in `measure-core` flags scans where the geometry doesn't close.
- **Per-wall photos** — each wall now carries its own optional photos for fine-grained architect verification.
- **Photo upload to Drive** — reference photos are now compressed (max 1600 px JPEG, q=0.8) and uploaded to a private Drive folder. The architect sees clickable thumbnails; previously only filenames were sent.
- **First-run tutorial overlay** — 4-slide onboarding shown once per device.
- **Project draft autosave** — debounced 400 ms save to localStorage; "Resume your previous project?" banner on form mount; cleared on submit.
- **Clickable step pills** — Project / Rooms / Plan / Review pills now navigate without re-running validation.
- **Anomaly validator before submit** — gate on ceiling-too-low, wall-too-long, missing-photo issues; bounces back to the rooms step.
- **Codemagic CI** — `codemagic.yaml` with iOS (TestFlight) + Android (Play Internal) workflows.
- **Daily backup job** — Apps Script `dailyBackup()` snapshots the Submissions sheet into a "TM Measure Backups" folder. Set up as a time-driven trigger.
- **Apps Script rate limit** — 60 submissions per UTC hour, enforced via CacheService.

### Changed
- **Auto-prefer RoomPlan** on LiDAR-equipped iPhone Pro / iPad Pro instead of defaulting to corner-tap.
- **Project step locks units** — Metric / Imperial toggle disables once you continue, preventing mid-survey mix-ups.
- **Mandatory reference photos** — at least one photo per room is now required before submit.
- **Inline submission ID** — success card now displays the submission ID with a link to `/status` for later progress checks.
- **`AndroidManifest.xml` `allowBackup="false"`** + Android 12 `data_extraction_rules.xml` exclude all app data from cloud and device-to-device transfer.

### Security
- **Architect endpoints now require an admin secret** set in Apps Script's Script Properties as `ADMIN_SECRET`. Constant-time compare on the server, password-style input on the console.
- **Approve via POST**, not GET — the secret never lands in URL query strings.
- **CSV / formula injection defused** — every customer-controlled cell prefixed with `'` when its first character is `=`, `+`, `-`, `@`, or whitespace.
- **Photo upload allowlist** — server-side MIME check (jpeg / png / webp only), 5 MB per file cap, strict filename allowlist (no `..`, no leading dots, no path separators).
- **Per-file Drive sharing** instead of folder-level. Photo URLs work directly but siblings can't be enumerated.
- **`replyTo` validation** — refuses headers (`\r`, `\n`, `,`, `;`, `<`, `>`) and length-limits to 254 chars.
- **Architect console URL allowlist** — only accepts `https://script.google.com/macros/.../exec`.
- **"Forget on this device" button** clears the endpoint + secret from localStorage on shared/loaned devices.
- **Rate limit** on `doPost` — 60 submissions per UTC hour.

### Fixed
- **LiDAR rooms inflated by ~25% when scanned at an angle** — RoomPlan plugin was returning the axis-aligned bounding box of the floor polygon in world coordinates. RoomPlan's world axes track the device's initial orientation, so a 4 × 3 m room scanned at 45° to world X came back as ~5 × 5 m. Now uses an oriented bounding box aligned with the room's longest wall.
- Corner-tap pointer-events bug on Android (was: empty space above HUD ate taps).
- Latent build error after renaming `randomDimensions()` to `placeholderDimensions()`.
- Several dead code paths (`runProcessing`, `onVideoStart/Stop`, WebXR probe) removed for MVP.

---

## [1.0.0] — initial scaffolding (pre-release)
Initial commit. Next.js 16.2.3 + Capacitor 7.6.1 shell, four-step measure form, basic camera scan, mailto fallback.
