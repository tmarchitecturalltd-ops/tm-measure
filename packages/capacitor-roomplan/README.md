# @tm-designs/capacitor-roomplan

Local Capacitor plugin that wraps **Apple RoomPlan** — the framework
that uses the LiDAR sensor on iPhone Pro / iPad Pro to produce an
architect-grade 3D sketch of a room.

## API

```ts
import { RoomPlan } from "@tm-designs/capacitor-roomplan";

const { supported, reason } = await RoomPlan.isSupported();

if (supported) {
  const result = await RoomPlan.startScan({ title: "Kitchen" });
  // result.rooms[0] → widthM, lengthM, heightM, walls[], doors[], windows[], openings[]
}
```

See `src/definitions.ts` for the full typed surface.

## Platform support

| Platform                                  | Behaviour                                  |
| ----------------------------------------- | ------------------------------------------ |
| iOS 16+, iPhone 12 Pro or newer Pro model | Native RoomCaptureView                     |
| iOS 16+, non-Pro iPhone                   | `supported: false` (no LiDAR)              |
| iOS 14-15                                 | `supported: false` (OS too old)            |
| Android / web                             | `supported: false` (JS WebPlugin fallback) |

The plugin ships the iOS side only. On every other platform the web
fallback in `src/web.ts` returns `{ supported: false }` so the calling
UI can route the user to a manual measurement path.

## Architecture

```
packages/capacitor-roomplan/
├── package.json                         ← npm entry, workspace-local
├── TmDesignsCapacitorRoomplan.podspec   ← iOS pod spec
├── README.md                            ← you are here
├── src/                                 ← TypeScript API
│   ├── definitions.ts                   ← typed interface
│   ├── index.ts                         ← registerPlugin bridge
│   └── web.ts                           ← browser / Android fallback
└── ios/Plugin/
    ├── RoomPlanPlugin.m                 ← CAP_PLUGIN registration
    ├── RoomPlanPlugin.swift             ← @objc Capacitor surface
    └── RoomCaptureRunner.swift          ← RoomCaptureView host + serializer
```

## How it's wired into the app

1. **`package.json`** pulls the plugin in via
   `"@tm-designs/capacitor-roomplan": "file:packages/capacitor-roomplan"`.
2. **`tsconfig.json`** has a `paths` mapping so imports resolve to
   `src/index.ts` during dev and build without needing a published
   package.
3. **`next.config.ts`** includes the package in `transpilePackages`
   so Next's SWC compiles the raw TS at build time.
4. **`capacitor.config.ts`** doesn't need to reference the plugin —
   Capacitor auto-discovers every `node_modules/*/package.json` with
   a top-level `"capacitor"` field.
5. **`components/measure/RoomScanOverlay.tsx`** calls
   `RoomPlan.isSupported()` on open and `RoomPlan.startScan()` from
   the LiDAR mode button.

## Building for iOS

This plugin's native code runs only on a Mac with Xcode. From the
repo root, after any change to Swift or plugin structure:

```bash
npm install                 # refresh node_modules symlinks
npm run build:cap           # Next static export (CAPACITOR=1)
npx cap sync ios            # regenerates Pods, links the plugin
cd ios/App && pod install   # if cap sync doesn't run it automatically
open App.xcworkspace        # archive + upload from Xcode, or use Codemagic
```

The plugin's `.podspec` declares `s.ios.deployment_target = '14.0'` to
match the app's floor, and weak-links RoomPlan. The Swift code
gates every RoomPlan symbol behind `@available(iOS 16.0, *)` plus
`#if canImport(RoomPlan)` so:

- On iOS 14 and 15 devices the scan modal never opens; `isSupported`
  returns `false` with a reason.
- On iPhones without LiDAR, `RoomCaptureSession.isSupported` is
  `false` at runtime and the plugin reports unsupported the same way.

## Info.plist requirements

RoomPlan uses the camera, which is already covered by the existing
`NSCameraUsageDescription` in `ios/App/App/Info.plist`. No extra
keys are needed.

## Testing on device

1. Build a development build signed with your Apple Developer account
   and install on an iPhone 12 Pro or newer Pro model.
2. Open the app → Measure → tap the scan button for any room.
3. In the scan overlay, tap the **LiDAR / AR** mode chip → the panel
   should say "Apple RoomPlan ready" — tap **Start RoomPlan capture**.
4. Walk slowly around the room keeping walls in view; Apple's guide
   surfaces arrows + progress indicators.
5. Tap **Done** in Apple's bottom bar. The modal dismisses and the
   overlay jumps to its "Scan Review" screen with your real
   dimensions, wall count, door count and floor area pre-filled.
