# TM Measure — streamlining the data entry flow

Observations from the current intake form (`MeasureIntakeForm.tsx`, ~2,900 lines,
one continuous document with all rooms, walls, openings, photos and notes on
screen at once) and five recommendations for making it feel lighter.

---

## 1. One room per screen, not all rooms on one screen

Today every room expands inline on the same page, so a three-room survey is a
very long scroll and the user can never see how much is left.

Turn the rooms step into a pager: **Room 1 of 3** with Back / Next controls and
a progress bar. Same data, same order — but the user only ever faces one room's
worth of fields, and the progress bar answers "how much more of this is there?"
which is the main driver of form abandonment.

Low-risk to implement: the room array already exists; this is a render-time
slice plus two nav buttons.

---

## 2. Ask for the room shape first, then auto-generate the walls

Currently the user adds walls one at a time and types a length into each.

Instead open each room with a shape picker — Rectangular / L-shaped / Custom.
Choosing "Rectangular" instantly creates four walls and asks for just **two**
numbers (width and length) instead of four. Most domestic rooms are rectangular,
so this halves the typing for the common case while leaving "Custom" for the
awkward ones.

---

## 3. Progressive disclosure for the optional detail

Doors, windows, openings, voice memos, connectivity graph and floor-plan
placement are all visible up front, which is what makes the form read as "heavy"
even before anything is typed.

Collapse everything that isn't a wall dimension or a required photo behind a
single **"Add detail"** control per room, with a count badge once populated
(e.g. "Detail · 2 windows, 1 door"). The user sees a short room card by default
and opts into complexity only where it exists.

---

## 4. Smart defaults that are visibly editable

Ceiling height is asked for every room but is nearly always the same across a
property.

Capture it once at property level, then pre-fill each room with that value shown
as a soft/placeholder-style value with a small "same as property" tag. The user
taps only where a room differs (a loft, a vaulted extension). Same for units,
wall finishes, and room naming — offer "Kitchen, Living room, Bedroom 1…" as
one-tap chips rather than a free-text field.

The rule: pre-fill aggressively, but always make it obvious the value was
assumed and is editable — an unexplained pre-filled number erodes trust in the
survey.

---

## 5. Save-and-resume, surfaced explicitly

A full survey is realistically 20–40 minutes of work, often interrupted
(a phone call, a room in use, a flat battery).

Autosave to localStorage on every change — likely already partly happening via
`recentSubmissions` — and surface it: a persistent "Draft saved · 2 min ago"
line, plus a "Continue where you left off" card on AppHome. Knowing the work is
safe is what makes people willing to start a long form at all, and it turns a
single 40-minute commitment into three comfortable sittings.

---

### Suggested sequencing

| Order | Change | Effort | Expected impact |
|---|---|---|---|
| 1 | Progressive disclosure (#3) | Low | High — biggest perceived-weight win |
| 2 | Smart defaults (#4) | Low | High — removes the most repetitive typing |
| 3 | Save-and-resume surfacing (#5) | Low/Med | High — directly targets abandonment |
| 4 | One room per screen (#1) | Medium | Medium/High |
| 5 | Shape-first wall generation (#2) | Medium | Medium |

The first three are mostly presentation-layer changes over the existing data
model, so they can ship without touching the submission payload or the Apps
Script pipeline.
