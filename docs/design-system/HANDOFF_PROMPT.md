# Handoff prompt

Paste this at the start of a session in this workspace when you want
on-brand UI work.

---

Before writing any code, read these in order:

1. `docs/design-system/README.md`
2. `docs/design-system/DESIGN_SYSTEM.md`
3. `docs/design-system/CHANGELOG.md` (most recent entry)
4. `AGENTS.md`

Then update **[PAGE OR COMPONENT]** so that **[WHAT YOU WANT]**.

Work to these constraints:

- Style via the semantic Tailwind tokens (`bg-surface`,
  `bg-surface-container-low`, `text-on-surface`, `text-primary`, and
  the rest). No hardcoded hex in components. If a value has no token,
  add the token in `app/globals.css` and log it.
- Reuse existing components from `components/` before creating
  anything new; state a reason in the code if a new variant is
  genuinely needed.
- Do not change copy, routes, validation, or what any control does.
  Restyling only, unless I have asked otherwise.
- Keep 44px tap targets, 14px minimum body text, visible focus outside
  the control's edge, and `prefers-reduced-motion` honoured.
- Never white text on the accent; never the bright accent as small text
  on a light ground; never filter survey photographs.

Then verify before telling me it is done:

- Run the dev server and look at the result at 375px **and** desktop.
- Check contrast against AA at the rendered width, not from the token
  table.
- `npx tsc --noEmit`, and the measure-core tests if geometry changed.

Finally, record what changed and why in
`docs/design-system/CHANGELOG.md`, and update `tokens.json` in the same
commit if any token value moved.
