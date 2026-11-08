# Saved persona review receipt

The screen reads the current persona revision after four saved survey steps.
Approval names that exact version. A changed version reloads for review, and
an uncertain approval checks its original command. Access loss clears private
text. Editing, replacement and restart controls are still unavailable.

The captures use intercepted responses and a browser at 1280 and 390 pixels.
They show review, approved, absent, stale, denied and unavailable states.
They do not prove a live onboarding journey or server integration.

## Captures

| State | Desktop | Phone |
| --- | --- | --- |
| Review | [1280](review-1280.png) | [390](review-390.png) |
| Approved | [1280](approved-1280.png) | [390](approved-390.png) |
| No persona | [1280](absent-1280.png) | [390](absent-390.png) |
| Changed proposal | [1280](stale-1280.png) | [390](stale-390.png) |
| Access changed | [1280](denied-1280.png) | [390](denied-390.png) |
| Service unavailable | [1280](unavailable-1280.png) | [390](unavailable-390.png) |

## Local checks

- PASS: 52 focused welcome tests in each of two final runs.
- PASS: scoped ESLint, event catalogue check, Knip and changelog lint twice.
- PASS: the repository typecheck twice.
- PASS: two web builds and the intercepted browser captures at both widths.
- PASS: browser captures found no horizontal overflow or controls below 44 pixels.
- PASS: the review button shows keyboard focus and reduced motion is requested.
- NOT RUN: the root test suite and a live welcome journey. No dev stack ran.
