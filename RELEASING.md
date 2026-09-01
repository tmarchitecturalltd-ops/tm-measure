# Releasing TM Measure

Written to be followed after a few weeks away, in order, without
remembering anything.

Four parts. Do them in this order — the backend has to be live before
the apps that talk to it.

- [1. Push the code](#1-push-the-code)
- [2. Deploy the backend](#2-deploy-the-backend-apps-script)
- [3. Release on iOS](#3-release-on-ios)
- [4. Release on Android](#4-release-on-android)

---

## 1. Push the code

Open Command Prompt and paste:

```
cd C:\Users\Harry\Downloads\Personal\TMDesigns\App
git push
```

That is all this step is. Everything else is triggered by it.

**Do not skip it and go straight to Codemagic.** Codemagic builds what
is on GitHub, not what is on this computer. Build 43 was started
without a push and silently built a commit three days old — it looked
like a normal build, produced a normal IPA, and did not contain any of
the work it was started for.

To be sure, paste this before you build:

```
git status -sb
```

If the first line ends with `[ahead 2]` or similar, there are commits
here that GitHub has not got. Push them.

---

## 1b. Bump the version number

**Every submission to Apple needs a version number higher than the last
approved one.** Reusing one fails at the very end of the build, after
fifteen minutes, with `Invalid Pre-Release Train` and
`CFBundleShortVersionString must contain a higher version`.

Once 1.1 is approved, 1.1 is closed forever — even for TestFlight.

Two files, and they must agree:

1. `ios/App/App.xcodeproj/project.pbxproj` — `MARKETING_VERSION`, in
   **two** places. Change both.
2. `android/app/build.gradle` — `versionName`

The build *number* is handled automatically from the Codemagic counter;
this is the version *name* only.

Then commit and push before building.

---

## 2. Deploy the backend (Apps Script)

**Skip this only if `apps-script-COMPLETE.js` has not changed since the
last release.** If in doubt, do it — redeploying unchanged code is
harmless.

1. Open `apps-script-COMPLETE.js` from the App folder in Notepad
2. **Ctrl+A**, then **Ctrl+C**
3. Go to the Apps Script editor, open **Code.gs**
4. Click inside the code, **Ctrl+A**, **Delete**, then **Ctrl+V**
5. Click the **save** icon
6. **Deploy → Manage deployments → pencil icon → Version: New version →
   Deploy**

Paste the whole file. Pasting a section over the top of the old code
once broke the live backend for a day.

### Check it worked

Open your `/exec` URL in a browser with `?action=list&secret=test` on
the end. You want:

```
{"ok":false,"error":"Use POST for list. Query-string secrets are not accepted."}
```

Any other response means the new code is not live.

---

## 3. Release on iOS

### 3a. Build it

1. **Codemagic → tm-measure → Start new build**
2. Workflow: **TM Measure — iOS release**, branch `main`
3. Wait ~15 minutes

Note the build number it produces — you will need it.

### 3b. Create the new version in App Store Connect

A version number can only be released once. If 1.0 is live, this update
must be 1.1.

1. **App Store Connect → TM Measure → Distribution**
2. Left sidebar, next to **iOS App**, click the blue **+**
3. Enter the version number — it must match `MARKETING_VERSION` in the
   Xcode project. Currently **1.2**
4. Fill in **What's New in This Version**

### 3c. Attach the build

Wait for the TestFlight email saying the build is processed — usually
5–15 minutes after Codemagic finishes.

1. On the version page, scroll to **Build**
2. Hover the row and click the **⊖** to remove any old build
3. Click **+**, pick the new one
4. If it says **Missing Compliance**, click **Manage** and answer **No**
   to the encryption question — standard HTTPS is exempt
5. **Save**

### 3d. Test it first

Install from TestFlight and use it properly for ten minutes. Every bug
found so far was found this way and none of them were found by reading
the code.

### 3e. Submit

1. Left sidebar → **App Review**
2. **Submit to App Review** (or **Resubmit to App Review**)
3. Confirm

**Then check the left sidebar says "Waiting for Review".** This is the
only thing that means it has actually been sent. A submission once sat
in "Ready for Review" for three days because the final button was never
pressed and nobody checked the label.

Apple takes 24–48 hours. Release is automatic on approval.

---

## 4. Release on Android

### 4a. Build it

1. **Codemagic → Start new build**
2. Workflow: **TM Measure — Android release**, branch `main`
3. Wait ~8 minutes
4. Open the finished build → **Artifacts** → download the `.aab`

### 4b. Upload to internal testing

1. **Play Console → TM Measure → Test and release → Testing → Internal
   testing**
2. **Create new release**
3. Drag in the `.aab`
4. Release notes: copy the block from
   `store-assets/play-release-notes.txt`
5. **Save → Review release → Start rollout to Internal testing**

### 4c. Test on a real Android phone

Install from the internal testing link. Check the photo picker
specifically — it is the part most likely to behave differently on
Android.

### 4d. Promote to production

1. Same release → **Promote release → Production**
2. **Save → Review release → Start rollout to Production**

Google's review is usually hours, but can be up to seven days.

---

## Version numbers

Two numbers, and they are not the same thing.

| | What it is | Where it lives | Who sets it |
| --- | --- | --- | --- |
| **Version** (1.1) | What customers see | `MARKETING_VERSION` in the Xcode project; `versionName` in `android/app/build.gradle` | You, by hand |
| **Build** (1034) | Which upload it is | — | Codemagic, automatically |

**The one that catches people out:** Apple will not accept a new build
under a version that has already been released. Bump the version number
in the Xcode project *before* building, or you get a build that uploads
successfully and then cannot be attached to anything.

---

## If something goes wrong

| Symptom | Cause |
| --- | --- |
| Build fails in Codemagic on an Android resource | Usually an XML comment containing `--`, which XML forbids |
| Build uploads but cannot be selected | Version number already released — bump it and rebuild |
| Submission never reaches Apple | The final confirm was not pressed. Check the sidebar reads "Waiting for Review" |
| App approved but not in search | Indexing lag, up to 24 hours. The direct link works immediately |
| New build not on TestFlight | Processing takes 5–15 min. If longer, check the build has a group in the Groups column |
