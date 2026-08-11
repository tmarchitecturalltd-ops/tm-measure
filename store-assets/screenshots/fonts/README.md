# Local font shim

Only needed where there is no route to `fonts.googleapis.com`. On a
normal machine the app fetches the real faces and `capture.mjs` skips
this entirely — delete `fonts.css` and it is ignored.

The `.woff2` files are **not** committed. To populate them:

    npm i --no-save material-symbols @fontsource/noto-serif \
        @fontsource/manrope @fontsource/noto-color-emoji
    mkdir -p out/_fonts
    cp node_modules/material-symbols/material-symbols-outlined.woff2 out/_fonts/
    cp node_modules/@fontsource/noto-serif/files/noto-serif-latin-{400,700}-normal.woff2 out/_fonts/
    cp node_modules/@fontsource/manrope/files/manrope-latin-{300,400,600,800}-normal.woff2 out/_fonts/
    cp node_modules/@fontsource/noto-color-emoji/files/*-400-normal.woff2 out/_fonts/

`fonts.css` is served from the built `out/` directory, so the paths are
`/_fonts/...`.

## The unicode-range clamp — do not remove it

The emoji faces are declared **under the app's own family names**
(`Manrope`, `Noto Serif`) rather than as a separate family, because CSS
gives no way to append a fallback to a font stack you do not control.
`unicode-range` is what keeps that from replacing the brand type.

Every emoji subset is clamped to `U+2600` and above. Noto Color Emoji's
published subsets include `0-9`, `#` and `*`, because keycap emoji
(1️⃣, #️⃣) are composed from those characters plus a variation selector.
Aliasing those ranges hands every digit in the app to the emoji face,
which has no standalone glyph for them — so `4.20 m` renders as `. m`
and the screenshots look fine at a glance while being quietly useless.
