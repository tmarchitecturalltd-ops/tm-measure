# Terms of service — brief for a solicitor

TM Measure currently has a privacy policy and **no terms of service**.
This is a note of what the app actually does, so a solicitor can draft
terms without having to reverse-engineer it. It is not legal drafting
and is not a substitute for advice.

**Prepared by:** the development side, August 2026
**For:** TM Architectural Designs Ltd (company 16719956)

---

## What the app is

A homeowner measures rooms in their own property and sends the
measurements, photographs and voice notes to TM Architectural Designs,
who use them to prepare architectural drawings and a quote.

Free to download. No account, no login, no payment in the app. It is a
lead-generation and data-collection tool for a design practice, not a
product sold to consumers.

## What the customer provides

- Room dimensions they measure themselves, by hand or with the phone camera
- Photographs of the inside and outside of the property
- Optional voice notes
- Their name, email, and a description of the work they want

## What we do with it

Prepare a quote or proposal. Retain it as a business record. Nothing
else — no marketing, no sale of data, no profiling.

---

## The clauses that matter, and why

### 1. Accuracy and reliance — the important one

**The measurements are taken by the customer, not by us.** The app
provides three routes of differing reliability:

- a LiDAR scan on supported iPhones
- a camera-based estimate that depends on lens calibration and the
  angle the phone is held at
- typing figures from a tape measure

The app labels which was used and, where a position was set by dragging
rather than measuring, records it as approximate. It also warns that
scan results should be checked against a tape.

Terms need to be explicit that TM Designs does not warrant measurements
it did not take, that drawings produced from customer-supplied
measurements are subject to verification, and that the customer remains
responsible for confirming dimensions before anything is built. **This
is the single largest exposure**: a wall measured 100 mm short becomes a
drawing, and eventually a building.

Worth advice on how this interacts with the Consumer Rights Act 2015,
since the customer is a consumer and the drawings are a paid service.

### 2. The app is not a survey

TM Measure does not produce a measured building survey, a structural
assessment, or anything relied upon for building control or party wall
purposes. Terms should say so, in those words.

### 3. Content the customer submits

Photographs of their home, possibly including people, possessions and
neighbouring property. Needed:

- a licence to TM Designs to use it for the purpose of the work
- a warranty from the customer that they have the right to photograph
  what they photographed, and consent from anyone identifiable
- what happens to it if no contract follows

Note the practical position: submitted content is never published and
is never shown to other users. It goes to a private Drive folder
visible only to TM Designs. That materially reduces the usual
user-generated-content exposure, and the terms should reflect the
reality rather than borrowing platform boilerplate.

### 4. Service availability

The backend is Google Apps Script and Google Drive. No uptime promise
should be made. There is a rate limit; a customer who hits it is told
to try again later.

### 5. Arbitration / dispute resolution

Requested. Worth advice on enforceability against UK consumers —
mandatory pre-dispute arbitration clauses are treated very differently
here than in the US, and an unenforceable clause is worse than none.
Governing law is England and Wales, matching the privacy policy.

### 6. Liability

Cap, exclusions, and the interaction with the design contract that
follows. The app is free; the exposure comes from the paid work
downstream, and the terms should not accidentally cap that.

### 7. Termination and data

The customer can ask for deletion. The privacy policy already commits
to retention periods: six years for signed-off project records (HMRC),
twelve months for enquiries that go nowhere.

---

## Technical facts a draft may need

| | |
| --- | --- |
| Platforms | iOS 15+, Android |
| Account required | No |
| Payment in app | No |
| Data location | Google Workspace / Drive, UK and EU |
| Third-party processors | Google only. No analytics, no advertising SDKs, no AI services |
| AI | None. The scan is perspective geometry and Apple's RoomPlan, both deterministic |
| Age | Adults commissioning work on their own property; not directed at children |
| Existing policy | https://tmdesignsltd.com/privacy — updated August 2026 |

## Where the terms need to appear

- Linked from the App Store and Play listings
- Linked in the app, next to the privacy policy link
- Referenced at the point of submission, since that is when the
  customer hands over the data

Apple requires a licence agreement for paid apps and accepts its
standard EULA by default; for a free app, custom terms still need to be
reachable from the listing.
