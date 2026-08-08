# App Privacy answers — App Store Connect

Derived from what the code actually transmits, not from memory. Verified
by reading the submission payload and searching the whole codebase for
analytics and third-party SDKs.

Apple asks these under **App Store Connect → TM Measure → App Privacy**.
Wrong answers here are a common rejection, and this is a legal
declaration about customer data, so it is worth matching reality
exactly.

## The short version

TM Measure collects the customer's **name, email address, photographs,
voice notes and the measurements they enter**, and sends them to TM
Designs' own endpoint so a survey can be produced.

There is **no tracking, no analytics, no advertising, and no third-party
SDK of any kind**. The only outbound request in the app goes to the
Google Apps Script endpoint that receives the survey.

## Answers

**Do you or your third-party partners collect data from this app?**
→ **Yes**

### Contact Info

| Data type | Collected | Linked to identity | Used for tracking | Purpose |
| --------- | --------- | ------------------ | ----------------- | ------- |
| Name | Yes | Yes | No | App Functionality |
| Email Address | Yes | Yes | No | App Functionality |

Both are entered on the first step and are needed to return the design
quote.

### User Content

| Data type | Collected | Linked to identity | Used for tracking | Purpose |
| --------- | --------- | ------------------ | ----------------- | ------- |
| Photos or Videos | Yes | Yes | No | App Functionality |
| Audio Data | Yes | Yes | No | App Functionality |
| Other User Content | Yes | Yes | No | App Functionality |

- **Photos** — room reference photos, exterior elevations, sketches.
- **Audio** — optional per-room voice notes.
- **Other User Content** — room names, dimensions, notes, and the
  written description of the work the customer wants.

All are "linked to identity" because they are submitted alongside the
customer's name and email.

### Everything else — answer No

Do **not** tick these; nothing in the app collects them:

- Financial Info, Health & Fitness, Location, Sensitive Info
- Contacts, Browsing History, Search History
- Identifiers (no device ID, advertising ID or user ID is collected)
- Usage Data, Diagnostics, Purchases

### Tracking

**Does this app track users?** → **No**

Nothing is shared with data brokers or advertisers, and there is no
cross-app or cross-site tracking.

## Things worth knowing when you answer

**Draft autosave is not "collected".** The in-progress survey is kept in
the device's own storage so a closed tab doesn't lose the work. It never
leaves the device and is deleted on successful submission, so it is not
a collection under Apple's definition.

**Camera and microphone are permissions, not collection.** They only
matter here because the resulting photos and voice notes *are*
submitted, which is already covered above.

**Motion data is used but not collected.** The phone's tilt is read to
work out distances while scanning. The angle is used on-device and never
transmitted — only the resulting measurement is.

## Also required at submission

- **Export compliance** — answer **No** to the encryption question.
  Standard HTTPS is exempt.
- **Privacy policy URL** — Apple requires a reachable one. It must
  describe the collection above.
- **Age rating** questionnaire.
- **Support URL**.
