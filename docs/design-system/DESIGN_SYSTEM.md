# TM Measure — design system

**Status:** authoritative. Supersedes `_stitch_extract/DESIGN.md` ("Architectural Editorial", gold-and-cream), which is kept only as history.
**Last revised:** 2026-10-25. See `CHANGELOG.md` in this folder.

The TM palette -- warm neutrals, brand gold, Noto Serif headings --
given the depth of a physical instrument: raised keys that press in,
recessed wells, panels that catch light from the upper left.

The depth language was taken from an industrial design system. The
cool-grey-and-orange palette that came with it was tried and
rejected: it was a different brand rather than a restyle of this
one. Colours here are TM's; the material treatment is what was kept.

---

## 1. How this is applied — read this first

Every component in this repo is written against **semantic Tailwind
tokens**, not raw colours: `bg-surface`, `text-on-surface-variant`,
`border-outline-variant`, `text-primary`, `font-headline`.

The visual system is therefore delivered by **repainting those tokens
in `app/globals.css`**, not by editing components. One `@theme` block
moves thirty-odd components and six routes at once.

**Consequence for anyone adding UI:** use the semantic class names.
A hardcoded hex is invisible to the token layer and will survive the
next restyle as a stray from the old palette. There were nine such
strays from the previous gold system; every one had to be hunted by
hand.

---

## 2. Authoritative tokens

Defined in `:root` in `app/globals.css`. Also in `tokens.json` in this
folder for programmatic use.

| Variable | Value | Role |
| --- | --- | --- |
| `--dp-color-chassis` | `#fcf9f5` | Page ground |
| `--dp-color-raised` | `#ffffff` | Keys, panels, decks |
| `--dp-color-well` | `#e5e2de` | Recessed material |
| `--dp-color-ink` | `#1c1c1a` | Primary text |
| `--dp-color-label` | `#4d4639` | Secondary text, labels |
| `--dp-color-field` | `#31302e` | Deep screen |
| `--dp-color-on-field` | `#f3f0ec` | Text on the screen |
| `--dp-color-on-field-muted` | `#ddd8d0` | Secondary text on screen |
| `--dp-color-accent` | `#b89650` | Brand gold |
| `--dp-color-accent-glyph` | `#7a6128` | Gold as text, see §7 |
| `--dp-typography-sans` | `"Manrope", sans-serif` | Reading, labels |
| `--dp-typography-serif` | `"Noto Serif", serif` | Headings |

| `--dp-typography-body` | `17px` | |
| `--dp-typography-reading` | `16px` | |
| `--dp-typography-metadata` | `13px` | |
| `--dp-typography-label` | `11px` | |
| `--dp-spacing-column-gap` | `25px` | |
| `--dp-spacing-compact-gap` | `12px` | |
| `--dp-radius-key` | `4px` | |
| `--dp-radius-circular` | `50%` | |
| `--dp-border-hairline` | `1px` | |
| `--dp-motion-navigation` | `130ms` | |
| `--dp-motion-key` | `140ms` | |
| `--dp-motion-dial` | `150ms` | |
| `--dp-motion-settle` | `cubic-bezier(0.3, 0.7, 0.4, 1.25)` | |

**Noto Serif** for headings, **Manrope** for reading and labels, both
loaded from Google Fonts in `app/globals.css`. The CSP in
`app/layout.tsx` permits them.

---

## 3. Semantic mapping — the table that matters

This is what components actually use. Change colour **here**, never in
a component.

| Tailwind class | Value | Material role |
| --- | --- | --- |
| `bg-surface`, `bg-background` | `#fcf9f5` | Page ground |
| `bg-surface-container-lowest` | `#ffffff` | Proudest raised part |
| `bg-surface-container-low` | `#f6f3ef` | Raised panel / key |
| `bg-surface-container` | `#f0edea` | Raised, slightly set down |
| `bg-surface-container-high` | `#ebe8e4` | Transitional |
| `bg-surface-container-highest` | `#e5e2de` | Shallow recess |
| `bg-surface-dim`, `bg-surface-variant` | `#dcdad6` / `#e5e2de` | Well, tray |
| `bg-inverse-surface` | `#31302e` | Deep screen / output deck |
| `text-on-surface` | `#1c1c1a` | Ink |
| `text-on-surface-variant` | `#4d4639` | Label |
| `text-inverse-on-surface` | `#f3f0ec` | On the screen |
| `border-outline` | `#7f7667` | Groove, divider |
| `border-outline-variant` | `#d1c5b4` | Hairline |
| `bg-primary` | `#b89650` | Brand gold fill |
| `text-on-primary` | `#1c1c1a` | **Ink**, see §7 |
| `text-primary` | `#7a6128` | **Darkened**, see §7 |
| `bg-surface-tint` | `#a07f3d` | Gold hover |
| `text-error` | `#ba1a1a` | Error |

---

## 4. Typography

- **Headings and reading:** Host Grotesk (`font-headline`, `font-body`).
  Headings bold, tracking `-0.02em`.
- **Small labels and metadata:** IBM Plex Mono (`font-label`), tracking
  `0.08em`, with a 1px white text-shadow so they read as engraved.
- Opening headings scale 54px → 106px on wide layouts with compact
  leading. Reading text stays much smaller with clear spacing.
- **Floor:** 14px for any body text. Set in `globals.css` and
  non-negotiable — the customer is a homeowner in their forties or
  fifties holding a phone at arm's length.

---

## 5. Material and depth

**Light falls from the upper left, everywhere.** This single rule is
what makes a screen of grey rectangles read as one machined object.

- **Raised** (`bg-surface-container-low/-lowest/-bright`): pale top
  inner edge, dark lower inner edge, soft drop shadow.
- **Recessed** (`bg-surface-dim`, `bg-surface-variant`,
  `bg-surface-container-highest`): inset dark shadow at the top, pale
  line at the bottom. The reverse of raised.
- **Deep screen** (`bg-inverse-surface`): heavier inset shadow. Text on
  it uses its own light roles, not a dimmed ink.

These are applied by selector in `globals.css`. A component gets its
material by saying what it is — which it was already doing.

Small key corners (`4px`) inside larger rounded cases (`16px`).

---

## 6. Components and states

**Keys** (all buttons). Raised by default. Hover lifts 1px and deepens
the shadow; press sinks 1px and the shadow inverts to inset. Minimum
target 44×44px, enforced globally.

**Primary action.** `bg-primary` with `text-on-primary`. A dial-shaped
(circular) button is permitted for a single main action but remains a
button — do not introduce a rotary input unless the feature genuinely
needs one.

**Inputs.** Minimum height 44px. Recessed material reads as a screen
the value sits inside.

**Panels and cards.** Raised deck; content that is read sits in a bay
on it. Images sit in recessed wells (§8).

**Lamps and indicators.** Small accent marks. They must never imply a
real system state that is not being measured — no fabricated
telemetry, no decorative "status" lights.

**Disclosures.** Raised plus/minus keys; opened content stays in the
reading bay.

**Focus.** 2px solid ink, `outline-offset: 3px`. Outside the physical
edge so it survives the key sinking on press. Ink rather than accent
deliberately: on the chassis, accent is 3.3:1 and ink is 9.9:1, and a
focus ring exists purely to be seen.

---

## 7. Contrast rules — three traps, all hit in practice

These are the non-obvious ones. Each was a real defect.

**1. Text on gold is ink, never white.**
White on `#b89650` is **2.79:1** and fails AA outright. Ink is
**5.8:1**. This was a pre-existing fault, not one a repaint
introduced — it was simply never measured. The app puts whole
sentences on gold buttons, so it is not a large-text edge case.

**2. Gold used as a glyph darkens to `#7a6128`.**
Gold is a fill colour. As text on cream it is **2.62:1**. So
`text-primary` darkens; `bg-primary` keeps the brand gold. Inside
dark decks it brightens to `#e7c177` instead. Several components had
already hand-darkened gold to `#8a6f2f` locally — the same instinct
without a rule. Opt a genuine indicator back into true gold with
`.tm-accent-lamp`.

**3. Alpha tints of `on-primary` invert when `on-primary` flips.**
`bg-on-primary/20` was a 20% **white** veil while `on-primary` was
white. The moment gold needed ink on it, the same class became a 20%
**dark** veil and took a step numeral to a failing ratio on the step
it exists to highlight. If a tint is meant to be light, say light
(`bg-surface-container-lowest/35`).

**Targets:** AA — 4.5:1 normal text, 3:1 for ≥24px or ≥18.66px bold.
Verify at the rendered width, not from the token table.

---

## 8. Images

Editorial photographs sit in a **recessed well** with a 1px inset rim
(`.hero-split-right`, `.tm-image-well`). They are not desaturated:
this brand is warm, and a grayscale house photograph sells nothing.

**Survey photographs are never filtered.** A customer's room photos are
evidence a draughtsman reads — damp staining, a brick course, which way
a window opens. Draining the colour from those to match a house style
would be the style damaging the product. Any new image treatment must
be scoped to marketing surfaces explicitly.

Reserve image dimensions. Describe meaningful subjects in alt text;
vents, screws and grooves are decorative and take `aria-hidden`.

---

## 9. Motion

Short key and dial transitions (`140ms`/`150ms`) with the settling
ease. The chassis, vents and indicators stay still.

`prefers-reduced-motion: reduce` removes the **travel** and keeps the
**depth**: shadow and colour still change, the key does not move. The
lift and sink are the affordance, so they are replaced rather than
deleted.

---

## 10. Responsive

Mobile first — this app is used standing in someone's hallway.

- **≤370px:** reduce any dial assembly; stack comparison details.
- **≤760px:** stack large content areas; control assemblies become a
  horizontal unit beneath the heading. Facts stay in two columns;
  features, steps, quotes go vertical. Housing edge and bay numbering
  at smaller scale; two-column footer groups.
- **≤1100px:** narrow the opening's control column; simplify
  comparison modules.

---

## 11. Repository hazards

**`app/globals.css` stops rebuilding in `next dev`.** Observed
repeatedly. Two symptoms, in order of severity:

1. *Lag.* A new rule is not in `document.styleSheets` until the file
   is touched and the page hard-reloaded.
2. *Freeze.* Eventually the emitted chunk filename stops changing
   (`_next/static/chunks/app_globals_<hash>.css` keeps the same hash
   however often the file is saved) and **no further CSS change is
   served at all**. TSX recompiles normally throughout, so a new
   class appears in the markup with no rule behind it — which looks
   like a cascade or specificity problem and is not one.

**Diagnosis:** compare the chunk hash before and after a save. Same
hash means frozen.
**Fix:** restart the dev server. There is no in-session workaround.

Before concluding that a rule "does not work", confirm it was
actually emitted. `components/measure/GuidedScreen.tsx` uses inline
styles for its background because of this.

**Tailwind v4.** Tokens live in `@theme`. A bare `.text-primary`
override ties on specificity with the generated utility, so overrides
here use `:not(.tm-accent-lamp)` to win regardless of emission order.

**Do not move `store-assets/`.** `app/privacy/page.tsx` reads
`store-assets/privacy-policy.md` synchronously at build time; the icon
and screenshot scripts depend on the rest.

---

## 12. Do not

- Hardcode hex values in components. Use the semantic classes.
- Use white text on the accent.
- Use the bright accent for small text on light grounds.
- Apply image filters globally — survey photos stay true.
- Add fake telemetry, unlabelled switches, or decoration that implies
  a system state nothing is measuring.
- Let texture or shadow muddy a reading area. Recessed reading needs
  strong contrast.
- Put physical decoration ahead of content or interaction.
