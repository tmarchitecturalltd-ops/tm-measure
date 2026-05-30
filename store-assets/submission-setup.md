# TM Measure — submission backend setup

Follow this once to wire up the Google Sheet + email backend. About 15 minutes end to end. After this is done, every Submit tap in the app will:

1. Append one row per room to your "Submissions" sheet.
2. Email you a nicely formatted HTML summary at `inquiries@tmdesignsltd.com` (which forwards to your Gmail).
3. Give the customer a "Thanks — your measurements are on their way" confirmation.

No servers, no hosting cost, no signup. It all runs inside your Google account.

---

## Part 1 — Create the Google Sheet (2 min)

1. Go to **https://drive.google.com** and sign in with the Gmail account you want submissions to live in.
2. Click **+ New → Google Sheets → Blank spreadsheet**.
3. Rename it at the top-left from "Untitled spreadsheet" to **"TM Measure — Submissions"** (this name is just for you; the script finds the right tab by tab name, not file name).
4. Leave the default "Sheet1" tab alone — the script will create its own "Submissions" tab on the first real submission.

Leave the sheet open; you need it for the next part.

---

## Part 2 — Paste the Apps Script (3 min)

1. Still in your new sheet, go to **Extensions → Apps Script**. A new tab opens with a code editor and a default `myFunction` stub.
2. Click anywhere in the editor, press **Ctrl+A** to select all, then **Delete** to clear it.
3. Open **`store-assets/google-apps-script.gs`** on your laptop (the file lives at `C:\Users\Harry\Downloads\Personal\TMDesigns\App\store-assets\google-apps-script.gs`). Copy the entire contents.
4. Paste into the empty Apps Script editor.
5. Click the **floppy-disk Save** icon (or Ctrl+S). The project auto-renames to "Untitled project" — click that name at the top and change it to **"TM Measure backend"**.

---

## Part 3 — Test it works locally (2 min)

Before deploying, confirm the script can write to the sheet and send an email from *inside* Apps Script.

1. In the function dropdown at the top of the editor (it probably says `doGet`), select **`testSubmission`**.
2. Click **Run**.
3. First time only, Apps Script asks for OAuth permissions:
   - **"Authorization required"** → **Review permissions** → pick your Google account → *"Google hasn't verified this app"* → click **Advanced** → **Go to TM Measure backend (unsafe)** → **Allow**. "Unsafe" is Google's default warning for any script you wrote yourself; it's only unsafe in the sense that they haven't reviewed it.
4. Run it again after accepting permissions. At the bottom of the editor you'll see "Execution completed".
5. **Check your sheet** — switch back to the Sheet tab, you should see a new "Submissions" tab with a black header row and one test row showing a kitchen with 4 walls, a ceiling, a door and a window.
6. **Check your inbox** — `inquiries@tmdesignsltd.com` should have an email titled *"TM Measure — Kitchen extension (test) — Test Customer"* with a nicely-formatted room card inside it. (If `inquiries@` is set up as an alias forwarding to your Gmail, the email will land in the Gmail inbox.)

If both appeared, the script is working. If either is missing, paste the error from the Apps Script execution log and I'll diagnose.

---

## Part 3.5 — Set the admin secret (1 min)

The customer-facing POST endpoint is open by design — anyone can submit a measurement. The architect-facing endpoints (`list`, `detail`, `approve`) are **not** open, because they expose customer PII. They're gated by a shared secret that lives in Apps Script's Script Properties (never in the source code, never in the deployed URL).

1. Generate a strong random string. On Windows, the easiest way: open PowerShell and run

   ```powershell
   [System.Guid]::NewGuid().ToString("N") + [System.Guid]::NewGuid().ToString("N")
   ```

   That gives you 64 hex characters — plenty.

2. Copy the string.
3. In the Apps Script editor, click the **gear icon** (Project Settings) on the left rail.
4. Scroll to **Script Properties** → **Edit script properties** → **Add script property**.
5. Property: `ADMIN_SECRET`. Value: paste the string. Click **Save script properties**.

Keep a copy of the secret in your password manager — you'll paste it into the architect console once per device on first use. Anyone with this secret can read every submission's full payload, so treat it like a database password.

If you don't set this property, the script still works for customers, but **the architect console will be unauthenticated** (anyone with the URL can read everything). You'll see a warning in the Apps Script execution log on every read.

---

## Part 4 — Deploy as a Web App (3 min)

This turns your script into a public HTTPS endpoint that the mobile app can POST to.

1. In the Apps Script editor, click **Deploy → New deployment** (top-right blue button).
2. Click the **gear icon** next to "Select type" → pick **Web app**.
3. Fill in the form:
   - **Description:** `TM Measure v1`
   - **Execute as:** `Me (tmarchitecturalltd@gmail.com)`
   - **Who has access:** `Anyone` ← this is required; the app is unauthenticated. It's fine because the endpoint only accepts well-formed submissions and writes to your own sheet.
4. Click **Deploy**. (You may get another OAuth prompt — same as before.)
5. A dialog appears with **Web app URL** — it looks like:

   ```
   https://script.google.com/macros/s/AKfycby…………/exec
   ```

6. Click **Copy**. Leave this tab open — you'll need the URL for Part 5.

**Quick verification:** paste that URL into any browser tab. You should see:

```json
{"ok":true,"service":"TM Measure submission endpoint","note":"Use POST to submit. GET supports ?action=list|detail (read-only, secret required)."}
```

If you see that, deployment is correct.

---

## Part 4.5 — Open the architect console (2 min)

Now that the secret is set:

1. On any device, open the app and tap the **Architect console** link on the home screen.
2. Paste the same `/exec` URL into the **Apps Script endpoint** field.
3. Paste the secret string from Part 3.5 into the **Admin secret** field.
4. Click **Save & load**. The list will populate (empty until you have submissions).
5. When you're done on a shared/loaned device, click **Forget on this device** to wipe both values from local storage.

---

## Part 5 — Wire the URL into the app (2 min)

1. Open File Explorer and navigate to `C:\Users\Harry\Downloads\Personal\TMDesigns\App\`.
2. Create a new file called **`.env.local`** (exactly that, starts with a dot and has no other extension). Windows may complain about the dot — if it does, save it as `.env.local.` with a trailing dot and Windows will strip the trailing one.
3. Open it in Notepad and paste this, replacing the URL with the one you copied:

   ```
   NEXT_PUBLIC_MEASURE_SUBMIT_URL=https://script.google.com/macros/s/AKfycby…………/exec
   ```

4. Save and close.

**Important:** `.env.local` is git-ignored by default (the URL isn't secret, but it doesn't belong in version control either). If you later want CI or a teammate's machine to have this, set the same env var in the build environment rather than checking the file in.

---

## Part 6 — Rebuild and re-install (5 min)

The URL is baked into the app at build time, so you need to rebuild both web and native before the app knows about the endpoint.

From `C:\Users\Harry\Downloads\Personal\TMDesigns\App\` in a terminal:

```
npm run build:cap
npx cap sync
```

Then, in Android Studio:

1. **File → Sync Project with Gradle Files** (or just close/reopen the project).
2. **Build → Build App Bundle(s) / APK(s) → Build APK(s)** (or the terminal command `.\gradlew.bat assembleDebug` from the `android/` folder).
3. Copy the new `app-debug.apk` to your phone the same way as before (Google Drive link → download → install).

---

## Part 7 — End-to-end test (2 min)

On the borrowed phone:

1. Open TM Measure.
2. Fill in a real-looking project (your own name, your own email, one or two rooms with real dimensions).
3. Tap **Send to TM Designs**.
4. The button should change to **Sending…** for a second, then you should see the cream success card: *"Thanks — your measurements are on their way."*

Over the next 30 seconds:

- Your sheet picks up new rows (refresh the browser tab).
- Your inbox picks up a new email.

If the button shows an error card instead, the message will tell you what went wrong — paste it here and I'll debug.

---

## If you need to change the script later

You're editing a **deployed** web app. Every time you change the Apps Script code, you have to redeploy for the live URL to pick up the change:

**Deploy → Manage deployments → pencil icon on your existing deployment → Version: New version → Deploy.**

This keeps the same URL (your `.env.local` doesn't need updating) but serves the new code.

### Schema updates (e.g. the new Connections column)

When a new version of the script adds a column (for example v2 adds a "Connections" column that captures how rooms are linked), the script self-heals on the next submission: it detects your existing "Submissions" tab is missing the new header, physically inserts a blank column at the right index, and writes the header. Historical rows keep their existing data aligned under the correct headers — they just show empty for the new column.

You don't have to delete the tab; just paste the new code, Save, and Deploy → Manage deployments → New version.

---

## Tuning the script

Things you might want to change in `google-apps-script.gs`:

- **`CONFIG.recipientEmail`** — if you want submissions to go to a different address (e.g. a shared team inbox).
- **`CONFIG.sheetName`** — the name of the tab. Change before first submission or you'll end up with two tabs.
- **The HTML email template** — `buildHtmlEmail_` returns the full inline-styled HTML. The gold / cream / dark colours match the app's design tokens; change them if you rebrand.

Every code change requires a redeploy (see previous section).
