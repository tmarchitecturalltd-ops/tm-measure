<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- The block above is generated. Everything below is hand-written;
     keep additions outside those markers so a regeneration cannot
     wipe them. -->

# UI work in this repo

## Read before writing any UI

`docs/design-system/DESIGN_SYSTEM.md` is authoritative. Read it before
generating or modifying any component, page, or stylesheet. The index
at `docs/design-system/README.md` is the fast path; `tokens.json` has
the values machine-readable.

`_stitch_extract/DESIGN.md` is **superseded** and describes an old
gold-and-cream system. Do not build from it.

## Hard constraints

1. **No hardcoded colour values in components.** Use the semantic
   Tailwind classes — `bg-surface`, `bg-surface-container-low`,
   `text-on-surface`, `text-on-surface-variant`, `border-outline-variant`,
   `bg-primary`, `text-primary`. A hex in a component is invisible to
   the token layer and becomes a stray at the next restyle. If a value
   you need has no token, add the token in `app/globals.css` and log it
   in `docs/design-system/CHANGELOG.md` — do not inline it.

2. **Never white text on the accent.** `#f15b22` with white is 3.3:1
   and fails AA. `text-on-primary` is ink and passes at 5.0:1.

3. **Never the bright accent as small text on a light ground.** It is
   3.0:1. `text-primary` is already darkened for glyph use; leave it.

4. **Reuse before creating.** Check `components/` for an existing
   component first — `AppButton`, `GuidedScreen`, `RoomsSoFar` and the
   rest exist to be reused. A new one-off variant of an existing
   control needs a reason stated in the code.

5. **Verify at the rendered width, not from the tokens.** Load the page
   and check contrast, focus visibility and reading order. Several
   defects here passed a token review and failed on a phone.

6. **Survey photographs are never filtered.** Image treatments are
   scoped to marketing surfaces explicitly.

7. **Preserve behaviour and copy.** Restyling must not change wording,
   routes, validation, or what a control does. Copy changes are a
   separate decision with its own reasoning.

8. **Accessibility is not optional.** 44px minimum tap targets, 14px
   minimum body text, visible focus outside the control's edge,
   `prefers-reduced-motion` honoured by removing travel and keeping
   depth.

## After changing anything visual

- Record it in `docs/design-system/CHANGELOG.md` with the reasoning.
- If a token value changed, update `tokens.json` in the same commit.
- Run `npx tsc --noEmit`, and the measure-core tests if geometry is
  involved.

## Known hazard

Rules added low in `app/globals.css` have more than once failed to
reach the browser. If a new rule has no effect, confirm it is actually
emitted (check `document.styleSheets`) before assuming a cascade
problem.
