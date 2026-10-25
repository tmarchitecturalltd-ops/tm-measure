# Where measurement error comes from

Findings from simulating the perspective solver against a known room.
Written up so the numbers aren't buried in a chat log.

## The geometry is exact

`projectTapToFloor` and `projectFloorToPixel` are true inverses —
round-tripping a tap through world space and back returns to within
1e-13 px. Given a correct camera tilt, both floor and ceiling modes
recover a 4.5 x 3.0 m room to the centimetre.

So the solver is not the source of the error seen in the field. Every
real-world discrepancy comes from the **inputs** it is given.

## Input 1: tilt (the dominant error in practice)

The pose uses one tilt value for all taps. Any error in it scales the
result, and depth suffers roughly twice as much as width:

| tilt error | floor mode (w / d) | ceiling mode (w / d) |
| ---------- | ------------------ | -------------------- |
| 0.5 deg    | +1.6% / +3.2%      | -1.6% / -3.3%        |
| 1 deg      | +3.3% / +6.7%      | -3.2% / -6.3%        |
| 2 deg      | +6.9% / +14.3%     | -6.1% / -11.9%       |
| 3 deg      | +10.9% / +23.0%    | -8.8% / -16.8%       |

Half a degree is a small hand movement. This is why holding the phone
still between taps matters more than anything else the customer does.

**Ceiling mode is not inherently worse than floor mode** — the two are
near mirror images. Ceiling mode was worth keeping.

**Depth is always the weaker axis.** When a result looks wrong, the
depth figure is the one to check first.

## Input 2: the plane offset (a scale factor)

The result scales linearly with the distance from camera to the target
plane, so a 10% error there is a 10% error in every dimension.

- **Floor mode** uses camera height, ~1.5 m. One estimate, one error.
- **Ceiling mode** uses ceiling height *minus* camera height.

That subtraction is the problem. With a 2.9 m ceiling and a 1.5 m
camera the offset is only 1.4 m, so if each figure is +/-0.1 m the
offset carries ~10% uncertainty against floor mode's ~7%. Subtracting
two similar numbers amplifies relative error.

This is what produced the bad field reading: a ceiling entered as
3.5 m when it was nearer 2.9 m is a 43% error in the offset, and the
measurements were wrong by proportionally that much. The solver was
behaving correctly throughout.

**Implication:** ceiling height should be measured, not estimated. It
is the one number the entire ceiling-mode result rests on.

## Input 3: calibration (sound, but sensitive to tap precision)

`calibrateFocalLengthPx` recovers a known focal length to within 0.09%,
and the monotonicity its bisection relies on holds across the whole
search range. No correctness problem.

Two field observations are worth separating, because they have
different causes:

**"Calibration could not converge"** is *not* about orientation. It
fires when both search bounds fall on the same side of the target,
which happens when a tapped point is not physically on the floor —
the side of a bin, an object on a drawer. There is no focal length
that makes an off-plane point fit, so the solver correctly refuses.
The error text already says this.

**"It only worked when the reference was horizontal"** is about
precision, not correctness. With perfect taps every orientation
calibrates identically. With a realistic +/-3 px finger error:

| reference orientation | tap separation | 95% of results within |
| --------------------- | -------------- | --------------------- |
| across view           | 527 px         | +/-0.9% focal         |
| diagonal 45 deg       | 429 px         | +/-1.5% focal         |
| receding from you     | 306 px         | +/-1.8% focal         |

A reference laid across the view spans roughly twice the pixels of one
pointing away, so the same finger error costs half as much. Laying it
horizontally is therefore worth advising — as guidance for a better
result, not as a requirement.

## What this means for the product

1. Encourage stillness between taps — it dominates everything else.
2. Treat the depth figure as the one most likely to be off.
3. Ceiling mode is sound, but is only as good as the ceiling height
   it is handed. Consider warning the customer of that directly.
4. Don't spend effort "fixing" the solver. It is correct. Effort is
   better spent on the quality of the tilt and offset it receives.

## Reproducing

The figures above came from simulating exact taps for a known room,
perturbing the tilt, and re-solving. Worth re-running if the pose
handling changes.
