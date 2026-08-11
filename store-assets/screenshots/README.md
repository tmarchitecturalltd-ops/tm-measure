# App Store screenshots

Generated, not hand-made. Regenerate whenever the UI changes:

```bash
npm run build:cap
node store-assets/screenshots/capture.mjs
```

Writes six screenshots per device into `out/`, which is gitignored.

| Device | Canvas | Apple's label |
| --- | --- | --- |
| `iphone65` | 1284 × 2778 | 6.5" iPhone |
| `ipad13` | 2064 × 2752 | 13" iPad |

## Why both sizes

Build 1020 was rejected under guideline 2.3.3 — the screenshots on the
listing were 455 × 864 marketing mockups, and Apple wants captures of
the app actually being used. The reviewer tested on an **iPad Air**, so
the iPad set is required, not optional.

The script walks a plausible job — a rear extension, a kitchen measured
at 4.20 × 3.10 — through project details, room measurements, individual
wall entry, the floor plan and the review screen. Five of the six show
the app in use; only the welcome screen doesn't, which keeps it well
inside Apple's "majority" rule.

## Uploading

App Store Connect → the version → Previews and Screenshots.

**Delete the existing iPhone set first.** Leaving the old mockups in
place reproduces the original rejection regardless of what is added
alongside them.

## When it breaks

The script finds fields and buttons by their visible text, so renaming a
label or a button will break the step that depends on it. It warns
rather than failing silently:

```
  ! no field for "Room name" — has the label text changed?
```

A run that prints no warnings and no size mismatch produced a good set.
The final size check exists because a wrong viewport yields screenshots
that look correct and are rejected on upload for being the wrong pixel
dimensions.

## Fonts

`fonts/` holds an optional shim for environments with no route to Google
Fonts. Normally unnecessary — see `fonts/README.md`, and read the note
about the unicode-range clamp before editing it.
