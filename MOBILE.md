# TM Designs — Web, Expo (iPhone), and Capacitor

This repo has four surfaces:

1. **Next.js** (root) — marketing site + `/measure` web intake.
2. **`mobile/`** — **Expo + expo-router + react-native-web** app with the same **Stitch / PRD measurement rules** via `@tm-designs/measure-core`, plus **native Auto-Scan** (`expo-camera`, `expo-sensors`).
3. **Web portal tab** (in `mobile/`) — **`react-native-webview`** embeds your live Next **`/measure`** page inside Expo Go (configure `EXPO_PUBLIC_MEASURE_WEB_URL`; see below).
4. **Capacitor** — wraps a **static export** of the Next app from the `out/` folder (`capacitor.config.ts` → `webDir: 'out'`).

---

## HP laptop → physical iPhone (Expo Go)

1. Install **Expo Go** from the App Store on your iPhone.
2. On the HP, from the repo root:

   ```bash
   cd mobile
   npx expo start
   ```

3. Connect the **same Wi‑Fi** on laptop and iPhone (or use Expo’s **tunnel** if needed: `npx expo start --tunnel`).
4. When the CLI shows a **QR code**, open **Expo Go** on the iPhone and scan it (Camera app may also offer to open Expo Go).
5. Use the **Measure** tab for the native intake wizard; use **Auto-Scan Room** for the full-screen camera flow (LiDAR simulation, corner taps, or **video** recording with mock “AI” processing). Use the **Web portal** tab to open the **Next.js `/measure`** UI in an embedded browser (same flows as on your laptop, including the web Auto-Scan overlay).

**Note:** `expo-camera` and `expo-sensors` are supported in **Expo Go** for this SDK. If you later add custom native code not shipped with Expo Go, switch to a **development build** (`expo prebuild` + EAS).

### Web portal tab (`EXPO_PUBLIC_MEASURE_WEB_URL`)

On a **physical iPhone**, `http://localhost:3000` is the phone itself, not your HP. To load the Next measure page:

1. Start Next bound to all interfaces: `npm run dev:lan` (from repo root), or `npm run dev -- -H 0.0.0.0`.
2. Find your PC’s LAN IP (e.g. `192.168.1.100`).
3. In `mobile/`, copy `.env.example` to `.env` and set:
   `EXPO_PUBLIC_MEASURE_WEB_URL=http://192.168.1.100:3000/measure`
4. Restart Expo (`npx expo start` in `mobile/`) so the env var is picked up.

Then open the **Web portal** tab in Expo Go.

---

## Capacitor “native blueprint” (web shell)

Capacitor loads your **exported Next.js** build from `out/`:

```bash
npm run build:cap
npx cap sync
```

- **`capacitor.config.ts`** — `appId: com.tmdesigns.portal`, `webDir: 'out'`.
- **`ios/`** and **`android/`** were added with `npx cap add ios` / `android`. On Windows, **Xcode is not available**; the `ios/` folder is still useful for **CI / cloud Mac** workflows or when you borrow a Mac to open the workspace.

---

## EAS — build `.ipa` in the cloud (no Mac required for the build step)

1. Create an Expo account and install the CLI:

   ```bash
   npm i -g eas-cli
   eas login
   ```

2. In `mobile/`:

   ```bash
   cd mobile
   eas init
   ```

3. Configure **bundle identifier** in `app.json` under `expo.ios.bundleIdentifier` (must match Apple Developer setup, e.g. `com.tmdesigns.portal`).

4. Run a production iOS build:

   ```bash
   eas build --platform ios --profile production
   ```

5. EAS builds on Expo’s **macOS runners** and produces an **`.ipa`** (or submits to TestFlight if you configure credentials). You still need an **Apple Developer Program** membership and signing credentials configured in EAS (`eas credentials`).

Expo’s docs: [EAS Build](https://docs.expo.dev/build/introduction/) and [iOS app signing](https://docs.expo.dev/app-signing/app-credentials/).

---

## Shared measurement logic

`packages/measure-core` holds **types, parsing, units, and validation** used by:

- Next: `components/measure/MeasureIntakeForm.tsx` imports `@tm-designs/measure-core`.
- Expo: `mobile/app/(tabs)/measure.tsx` imports the same package.

Next transpiles the workspace package via `transpilePackages` in `next.config.ts`.

---

## Commands cheat sheet

| Goal | Command |
|------|---------|
| Next dev | `npm run dev` (repo root) |
| Next static export for Capacitor | `npm run build:cap` |
| Copy `out/` into native projects | `npx cap sync` |
| Expo dev server | `cd mobile && npx expo start` |
| From root shortcut | `npm run mobile` |

---

## Troubleshooting

- **Expo Go can’t reach the dev server:** try `npx expo start --tunnel`, or check Windows firewall for Node.
- **`npm run build:cap` fails:** ensure all routes are compatible with **`output: 'export'`** (no server-only APIs on those pages).
- **Capacitor iOS pods:** run `pod install` inside `ios/App` on a Mac when you have Xcode.

---

## Apple RoomPlan (native LiDAR scan) — `@tm-designs/capacitor-roomplan`

A local Capacitor plugin at `packages/capacitor-roomplan/` wraps Apple's
`RoomCaptureView` so the scan overlay's **LiDAR / AR** mode produces real,
architect-grade dimensions on iPhone Pro / iPad Pro devices.

- On iOS 16+ with LiDAR → Apple's guided scanning UI fires, returns a
  structured room (walls, doors, windows, openings, floor polygon).
- On every other platform → the plugin's web fallback reports
  `{ supported: false }` and the overlay falls back to the corner-tap
  path already in Plan A.

See [`packages/capacitor-roomplan/README.md`](packages/capacitor-roomplan/README.md)
for the full API and the rebuild recipe. The one-time Windows flow after
pulling this code is:

```
npm install        # picks up the new workspace dep
npm run build:cap
npx cap sync       # auto-links the plugin pod on iOS; skips it on Android
```

Then in Android Studio rebuild the APK, or (for iOS) archive the
workspace on Codemagic / a borrowed Mac.
