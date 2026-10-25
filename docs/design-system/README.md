# Design system — index

Start here. Three files, one job each.

| File | What it is | When to read it |
| --- | --- | --- |
| `DESIGN_SYSTEM.md` | The full visual and interaction spec. Tokens, the semantic mapping, material and depth, components, contrast rules, image policy, motion, repo hazards. | **Before writing or changing any UI.** |
| `tokens.json` | The same tokens, machine-readable. | Generating or checking values programmatically. |
| `CHANGELOG.md` | Every visual revision, with reasoning. | Before changing a token or retiring a pattern. |

## The short version

The system is **Industrial**: one cool-grey instrument chassis, raised
keys, recessed wells, a deep screen for dark decks, orange for
indicators and action details only.

It is applied by repainting **semantic Tailwind tokens** in
`app/globals.css` — not by editing components. Components say
`bg-surface-container-low`, and the token layer decides what that
looks like.

## Three rules that cause real bugs if broken

1. **No hardcoded hex in components.** It is invisible to the token
   layer and survives the next restyle as a stray.
2. **Never white text on the accent.** 3.3:1, fails AA. Use ink.
3. **Never filter survey photographs.** They are evidence a
   draughtsman reads. Image treatments are scoped to marketing only.

## Where things live

- Tokens and all global rules: `app/globals.css`
- Fonts: imported in `app/globals.css`; CSP allows them in `app/layout.tsx`
- Superseded system: `_stitch_extract/DESIGN.md` — history only, do not build from it
- Product changelog (features, not styling): root `CHANGELOG.md`
