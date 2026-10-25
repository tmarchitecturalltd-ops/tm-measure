# TM Measure — Industrial design system

**Status:** authoritative. Supersedes `_stitch_extract/DESIGN.md` ("Architectural Editorial", gold-and-cream), which is kept only as history.
**Last revised:** 2026-10-25. See `CHANGELOG.md` in this folder.

The app is one continuous instrument chassis: cool grey, recessed dark
screens, raised keys, engraved labels, small orange indicators. Depth
comes from highlights and shadows applied consistently; content stays
ordinary readable text and recognisable controls.

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
| `--dp-color-chassis` | `#cbd0d2` | Main cool-grey ground |
| `--dp-color-raised` | `#e7eaeb` | Keys, panels, decks |
| `--dp-color-well` | `#b6bec2` | Recessed material |
| `--dp-color-ink` | `#181e22` | Primary text |
| `--dp-color-label` | `#414b52` | Secondary text, labels |
| `--dp-color-field` | `#20272b` | Deep screen |
| `--dp-color-on-field` | `#f2f4f4` | Text on the screen |
| `--dp-color-on-field-muted` | `#d8dee1` | Secondary text on screen |
| `--dp-color-accent` | `#f15b22` | Indicators, action details |
| `--dp-typography-sans` | `"Industrial Host", sans-serif` | Headings, reading |
| `--dp-typography-mono` | `"Industrial Plex", monospace` | Small labels, metadata |
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

`"Industrial Host"` and `"Industrial Plex"` are the system's names for
the families. They resolve through to **Host Grotesk** and **IBM Plex
Mono**, loaded from Google Fonts in `app/globals.css`. The CSP in
`app/layout.tsx` already permits both.

---

## 3. Semantic mapping — the table that matters

This is what components actually use. Change colour **here**, never in
a component.

| Tailwind class | Value | Material role |
| --- | --- | --- |
| `bg-surface`, `bg-background` | `#cbd0d2` | Chassis |
| `bg-surface-container-lowest` | `#eef1f2` | Proudest raised part |
| `bg-surface-container-low`, `bg-surface-bright` | `#e7eaeb` | Raised panel / key |
| `bg-surface-container` | `#dde1e3` | Raised, slightly set down |
| `bg-surface-container-high` | `#d3d8da` | Transitional |
| `bg-surface-container-highest` | `#c3cacd` | Shallow recess |
| `bg-surface-dim`, `bg-surface-variant` | `#b6bec2` | Well, tray |
| `bg-inverse-surface` | `#20272b` | Deep screen / output deck |
| `text-on-surface` | `#181e22` | Ink |
| `text-on-surface-variant`, `text-secondary` | `#414b52` | Label |
| `text-inverse-on-surface` | `#f2f4f4` | On the screen |
| `border-outline` | `#8d979d` | Groove, divider |
| `border-outline-variant` | `#a8b1b6` | Hairline |
| `bg-primary` | `#f15b22` | Accent fill — keys, lamps |
| `text-on-primary` | `#181e22` | **Ink**, see §7 |
| `text-primary` | `#8f300d` | **Darkened**, see §7 |
| `bg-surface-tint` | `#d44d18` | Accent hover |
| `text-error` | `#b3261e` | Error |

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

Small key corners (`4px`) inside larger rounded cases (`10px`).

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

**1. Text on the accent is ink, never white.**
White on `#f15b22` is **3.3:1** and fails AA at normal size. Ink is
**5.0:1** and passes. This app puts whole sentences on filled buttons,
so it is not a large-text edge case.

**2. Accent used as a glyph darkens to `#8f300d`.**
The accent is a signal colour chosen to be seen against grey at a
glance, which is exactly what makes it poor as text — `#f15b22` on the
raised panels is **3.0:1**. So `text-primary` darkens; `bg-primary`
keeps the true accent. Inside dark decks it goes the other way and
brightens to `#ff8a5c`, because the dark orange disappears there.
Opt a genuine indicator back into the bright accent with
`.tm-accent-lamp`.

**3. Alpha tints of `on-primary` invert when `on-primary` flips.**
`bg-on-primary/20` was a 20% **white** veil while `on-primary` was
white. The moment the accent needed ink on it, the same class became a
20% **dark** veil and took a step numeral to 3.7:1 on the step it
exists to highlight. If a tint is meant to be light, say light
(`bg-surface-container-lowest/35`).

**Targets:** AA — 4.5:1 normal text, 3:1 for ≥24px or ≥18.66px bold.
Verify at the rendered width, not from the token table.

---

## 8. Images

Editorial photographs are **grayscale**, in a recessed well with a 1px
inset rim (`.hero-split-right`, `.tm-image-well`).

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
- Add glossy chrome, rust, hazard striping, animated fake telemetry, or
  unlabelled switches.
- Let texture or shadow muddy a reading area. Recessed reading needs
  strong contrast.
- Put physical decoration ahead of content or interaction.
