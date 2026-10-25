# Design system — changelog

Visual and interaction changes only. Product and feature changes belong
in the root `CHANGELOG.md`.

Record a revision when a token value changes, a component pattern is
added or retired, or a rule in `DESIGN_SYSTEM.md` is altered. Say what
changed **and why**, so the next person does not undo it.

Dates ISO 8601.

---

## [2026-10-25b] — Brand palette restored, depth kept

The cool-grey-and-orange palette was tried on a phone and rejected:
it read as a different brand rather than a restyle of this one. The
physical treatment that arrived with it was worth keeping, so the two
were separated.

### Changed
- Palette back to TM's: cream grounds, brand gold `#b89650`, Noto
  Serif headings with Manrope for reading.
- `--dp-*` tokens repainted to the brand values, names kept so the
  docs and anything written against them still resolve.
- Editorial photographs keep the recessed well and lose the
  grayscale. This brand is warm and a desaturated house photograph
  sells nothing.

### Kept from the repaint
- Raised keys that lift on hover and sink on press; recessed wells;
  light from the upper left. The depth of an instrument suits a
  measuring tool regardless of its colours.
- Directional step transitions — forward from the right, back from
  the left.
- `text-on-primary` stays **ink**. White on gold is 2.79:1 and fails
  AA outright. That was a pre-existing fault, never measured until
  the repaint forced the question; restoring white would reintroduce
  a real defect for no gain.
- `text-primary` stays **darkened**, now `#7a6128`. Gold as text on
  cream is 2.62:1. Several components had already hand-darkened it to
  `#8a6f2f` locally — the same instinct without a rule.
- The focus ring stays ink rather than gold: 2.62:1 against roughly
  15:1, on the one element that exists purely to be seen.
- Every hardcoded hex found during the repaint stays as a semantic
  token.

### Verified
- Contrast audit on `/measure` at 375px: no failures.
- Gold key, ink label, key shadow, Noto Serif heading and the
  directional transition all confirmed live in the browser.

---

## [2026-10-25] — Industrial adopted (superseded same day)

Replaced the gold-and-cream "Architectural Editorial" styling with the
Industrial instrument-chassis system across the whole web layer.

### Added
- Full token set (`--dp-*`) in `:root`, with the app's semantic
  Tailwind tokens remapped onto it in `@theme`.
- Host Grotesk and IBM Plex Mono, bound as "Industrial Host" and
  "Industrial Plex".
- Material depth rules: raised, recessed and deep-screen treatments
  driven off the existing `bg-surface-*` classes.
- Key interaction: hover lifts, press sinks, with a reduced-motion
  variant that keeps the depth and drops the travel.
- `.tm-accent-lamp` — opts an element back into the bright accent where
  it is genuinely an indicator rather than text.
- Grayscale-in-a-well treatment for editorial photographs, scoped to
  marketing surfaces only.

### Changed
- `text-on-primary` from white to ink `#181e22`. White on the accent is
  3.3:1 and fails AA at normal size; the app puts real sentences on
  filled buttons.
- `text-primary` darkened to `#8f300d` for glyph use. The bright accent
  is 3.0:1 on raised panels. Fills keep `#f15b22`.
- Focus ring from brand colour to ink, offset 3px. On the chassis the
  accent is 3.3:1 and ink is 9.9:1.
- Step numeral veil from `bg-on-primary/20` to
  `bg-surface-container-lowest/35`. The old class meant a *white* veil
  when `on-primary` was white and silently became a dark one.
- `themeColor` meta from gold to chassis grey.

### Deprecated
- `_stitch_extract/DESIGN.md` ("Architectural Editorial"). Superseded,
  retained as history. Do not build from it.
- Gold `#b89650`, cream `#fcf9f5` / `#f6f3ef`, warm ink `#1c1c1a`, and
  the amber `#e7c177` badge colour. All occurrences replaced; a grep
  for these should return nothing in `app/` and `components/`.

### Verified
- Contrast audit over every text node on `/measure` at 375px: no
  failures against AA.
- Checked at 375px and desktop in the browser, not from the tokens.
- `tsc --noEmit` clean; 81 measure-core tests passing.

### Known limits
- The native camera screens (`packages/capacitor-roomplan/ios/`) are
  Swift and still use the old gold marker colour. They are outside the
  web token layer and were left alone deliberately; changing them is a
  separate, native-side decision.
