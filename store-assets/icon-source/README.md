# App icon — source of truth

`brand-logo-source.png` is Harry's logo export, unmodified. Every icon
in the iOS and Android projects is generated from it by
`render-app-icon.py`; nothing is hand-edited.

## Why this replaced the vector

`store-assets/app-icon.svg` used to be the source. Apple rejected build
1020 under guideline 2.3.8 — "the app icons appear to be placeholder
icons" — because the mark was 26-unit hairline strokes on flat cream.
At 60 px on a home screen those strokes fall below one pixel and the
icon reads as a grey smudge.

The fix keeps the artwork exactly as drawn and changes only the pen: the
ink mask is recovered from luminance (which also strips the paper
texture and the alpha channel Apple rejects), dilated to a heavier
weight, and composited onto a generated beige stock.

## Regenerating

    python3 store-assets/icon-source/render-app-icon.py

Writes every iOS and Android size in place. The texture is seeded, so
re-running produces byte-identical output.

## Constraints worth not breaking

- **iOS icons must have no alpha channel.** The build is rejected at
  upload, not at review.
- **Android adaptive foreground must have alpha**, and the mark must sit
  inside the central 66% — the launcher may mask it to a circle.
- **The adaptive background colour must match the texture's base tone**
  (`#F1E8D7`, in `values/ic_launcher_background.xml`). A mismatch shows
  as a ring around the mask on some launchers.
