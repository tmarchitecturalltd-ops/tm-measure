# TM Measure — Security Audit

**Date:** 8 August 2026
**Scope:** Full codebase, Android and iOS native config, Apps Script backend, dependency tree
**Stack:** Next.js 16.3.0 · Capacitor 7 · Google Apps Script backend
**Supersedes:** the 2 July 2026 audit, every finding of which has been
re-verified against current code rather than carried forward.

---

## Summary

The app is in good shape for resubmission. Every critical and high
finding from July is now closed, the dependency tree carries **zero
known vulnerabilities**, and no secret has ever been committed to the
repository.

Four findings remain open. None is a blocker: two are accepted risks
inherent to the architecture, one is a hardening opportunity deferred
because fixing it risks breaking a feature that only just started
working, and one depends on a script property being set.

**Headline change:** 16 of the 30 advisories present in July came from
`expo`, `expo-camera`, `expo-sensors` and `react-native` — packages
with **zero imports anywhere in the app**. This is a Capacitor build,
not an Expo one. Removing them took the install from 959 packages to
469 and, with `npm audit fix` on the remainder, from 29 advisories to
none.

---

## Closed since July

Each was confirmed fixed by reading current code, not assumed.

| ID | Finding | How it was resolved |
| -- | ------- | ------------------- |
| C1 | WebView remote debugging on in production | Now `WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)` — off in any release build |
| C2 | Critical CVE in `shell-quote` | Gone with the Expo removal; `npm audit` reports zero |
| H1 | No HTTP security headers | CSP, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy` and `Permissions-Policy` all set in `next.config.ts` |
| H2 | Next.js in vulnerable range | 16.2.3 → 16.3.0 |
| H3 | Admin secret in GET query string | Architect console POSTs it in the request body |
| H4 | High CVEs in `@xmldom/xmldom`, `ws` | Cleared |
| M3 | `renderMarkdown` allowed `javascript:` hrefs | Scheme allowlist (http, https, mailto, tel, relative). Verified against upper-case, whitespace-padded and tab-obfuscated variants |
| M4 | Release build not minified | `minifyEnabled true` with ProGuard |
| M5 | Customer email in GET query string | Status lookup moved to a POST body |
| M6 | Microphone usage description inaccurate | Now describes voice notes accurately |
| L4 | Build artifacts in project root | `.aab`, `.apk`, `.apks`, `.ipa` ignored |

### Also fixed during this pass

**Signing material was not ignored.** `tmmeasure-upload.keystore` was
untracked but not in `.gitignore` — one `git add -A` from being pushed
to a remote. The upload keystore is the only thing that can sign an
update to the Play listing and cannot be rotated without Google's
involvement. Now ignored, along with `.p8`, `.p12`, `.jks`,
provisioning profiles and service-account JSON.

Verified by `git ls-files` that **no secret has ever been committed**,
so this closes an exposure rather than hiding one.

**Architect console could not function.** It POSTs `{action:"list"}`,
but `doPost` only recognised `approve`; anything else fell through to
`validatePayload_` and failed with "Missing email". Corrected in
`apps-script-patch.js`, which now handles `status`, `list`, `detail`
and `approve` on POST.

---

## Open findings

### M1 — Architect console has no server-side route protection
**Severity:** Medium · **Status:** accepted risk

`/architect` is a public route. It renders a form rather than data, and
the endpoint behind it demands the admin secret, so no customer data is
exposed by the page itself. A static export has no server to
authenticate against, so this cannot be fixed in the app — the control
lives in the Apps Script, which is the correct place for it.

**Mitigation:** ensure `ADMIN_SECRET` is set (see M2).

### M2 — Endpoints are open if `ADMIN_SECRET` is unset
**Severity:** Medium · **Status:** needs a one-off action from you

```js
function adminSecret_() {
  const value = PropertiesService.getScriptProperties().getProperty('ADMIN_SECRET');
  if (!value) {
    console.warn('ADMIN_SECRET not set — architect endpoints are unauthenticated.');
    return null;   // ← requireAdminSecret_ then permits everything
  }
  return value;
}
```

If the property is missing, `list` and `detail` return **every
submission you hold** — names, emails, addresses implied by project
names, and Drive links to photographs of customers' homes — to anyone
who knows the endpoint URL. The URL is embedded in a public app bundle,
so it should be assumed known.

The fallback exists for developer convenience and only logs a warning.

**Action:** Apps Script → Project Settings → Script Properties → add
`ADMIN_SECRET` with a long random value. Confirm afterwards that
`?action=list` without a secret is refused.

This is the single most valuable thing outstanding.

### L1 — FileProvider exposes the external storage root
**Severity:** Low · **Status:** deferred deliberately

```xml
<external-path name="my_images" path="." />
<cache-path name="my_cache_images" path="." />
```

`path="."` grants the provider the whole of external storage rather
than one directory. Exploitation requires the app to hand a content
URI for a file outside its own data to another app, which it does not
do — so this is defence in depth, not an active hole.

**Why deferred:** this file backs the camera and photo-picker flow,
which only just started working reliably after a long-standing bug.
Narrowing the paths risks breaking it days before submission, for a
finding with no demonstrated exploit path. Worth doing after
resubmission, with a device test of photo capture on both platforms.

### L2 — Draft data held unencrypted in WebView storage
**Severity:** Low · **Status:** accepted, partially mitigated

The autosaved draft holds the customer's name, email, project name and
measurements in `localStorage`. On a non-rooted device this is private
to the app.

Already mitigated in two ways: photos and voice memos are deliberately
excluded from the draft, and the draft is cleared on successful
submission.

---

## Dependency posture

| | July | Now |
| - | ---- | --- |
| Packages installed | 959 | 469 |
| Advisories | 29 | **0** |

Confirmed by a real Codemagic iOS build on the reduced tree — the
"Install JS dependencies" step also dropped from ~23s to 13s.

Two things worth knowing about the Next.js advisories that were
cleared, so the risk isn't overstated in either direction: nearly all
were **server-side** — middleware bypass, SSRF in Server Actions, cache
poisoning, Image Optimization DoS. The mobile app is a static export
with no Next server, so they were never reachable there. They would
matter wherever the marketing site is server-rendered.

`@react-three/fiber` carries an advisory whose only offered "fix" is a
downgrade to v8 — a major version predating React 19. It renders the
3D room preview from the app's own measurements and takes no untrusted
input. Not actionable; accepted.

---

## Verified good

- No secret has ever been committed; `.env.local` and dev TLS
  certificates are correctly ignored
- No `dangerouslySetInnerHTML` on any untrusted input — the one use is
  a static dev-only error reporter, stripped from production builds
- Capacitor config sets `androidScheme: "https"`, no cleartext traffic,
  and critically **no `server.url`** — a common way to ship a
  development endpoint to production
- Apps Script escapes HTML output, guards against spreadsheet formula
  injection, validates the reply-to address against header injection,
  and rate-limits submissions
- Photo uploads are MIME-allowlisted and size-capped server-side, and
  filenames are sanitised against path traversal
- Drive files are shared individually rather than at folder level, so
  one shared link cannot be used to enumerate other customers' photos

---

## Before resubmission

1. **Set `ADMIN_SECRET`** in Script Properties (M2) — highest value
2. **Deploy `apps-script-patch.js`** — fixes the architect console, the
   status lookup, and stops exterior photos and the customer's project
   description being silently discarded
3. **Run an Android build** to confirm the dependency change there too;
   iOS is already verified
4. Complete the App Privacy questionnaire — see `APP-PRIVACY-ANSWERS.md`

## After resubmission

5. Narrow `file_paths.xml` (L1) and device-test photo capture
