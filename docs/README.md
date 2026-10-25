# docs

| Folder | Contents |
| --- | --- |
| `design-system/` | **Authoritative visual spec.** Read `DESIGN_SYSTEM.md` before any UI work. |
| `reference/` | Standing reference: measurement accuracy, mobile notes, security audit, UX recommendations, App Store privacy answers. |

Deliberately still at the repo root, because they are part of a live
workflow and people look for them there:

- `README.md` — project setup
- `RELEASING.md` — the App Store release run
- `CHANGELOG.md` — product changes (styling goes in `design-system/CHANGELOG.md`)
- `AGENTS.md` — agent rules, included by `CLAUDE.md`

`store-assets/` is **load-bearing** and must not be moved:
`app/privacy/page.tsx` reads `store-assets/privacy-policy.md`
synchronously at build time, and the icon and screenshot scripts depend
on the rest of it.
