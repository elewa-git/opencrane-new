# Journey on a fresh dev stack: PASS (core journey)

13 November 2026. The final run used source `72377ecc8`, a claimed secondary
stack, the stand-in provider and `infra/dev-stack/up.sh --fresh`. The fleet marker
remained set. The final journey uses passive browser-read diagnostics.
Cleanup PASS: every claimed stack was stopped with `down.sh` and released.
The owner stack was not used.

The complete core journey passed: real sign-in and refusals; chat, streaming,
Stop and reload; uploads, lost-response Retry without duplicates, PDF answer and
original bytes, malware/type/size refusals and text/image previews; live view;
computer suspension, wake and Pod replacement with preserved files; tool review
and publication; audit; budgets; members and MCP catalogue replay verification;
token boundaries, sign-out and reauthentication; and listener checks.

## Failures and changes

- Product regression: `6d879a75c` moved attachment controls into the composer with
  a 28 px minimum height. The shared button rule now gives Retry and Remove at
  least 44 × 44 px at both widths. Remove also cancels an active upload.
  The original phone measurement failed before the fix.
- Stale upload journey: `6d879a75c` moved status onto individual chips and delayed
  transcript cards until Send; `3391faf4f` changed unsupported-file wording.
  The journey follows each Ready/refusal status and waits for the new reply to
  finish before proceeding. A delayed acknowledgement test reproduced the race.
- Product/tooling regression: `2ecadcc3e` refused all fleet journeys, including
  secondary stand-in stacks. Secondary stand-in journeys are allowed; owner
  automation and fleet real-provider use remain refused. Refusal tests failed
  before the repair.
- Stale audit journey: `4f06d18d0` (#1004) removed conversation filters and changed
  row wording. Following the owner decision of 13 November, the journey selects
  Tools & models with the keyboard, checks every returned entry's category,
  searches for the saved publication by its safe reference and opens safe details.
  Escape and focus checks remain. P3-19 now states category/reference filtering
  and no conversation turn filter. Private-history refusals, member organisation
  refusal, integer money checks and UI/log canaries remain.
- Stale target measurement: the menu animation introduced by `ed21e0b42` can still
  reduce a 44 px control when Playwright considers its subpixel movement stable.
  Attempt 1 failed that assertion. Measurements now await finite animations on
  the control and its ancestors. The deterministic reproduction failed at
  43.956 px before the fix; a permanent 28 px control is still refused.
- Earlier setup failure: the expected local key-file path was absent. Ignored
  local links now refer to the existing files. Credential values were not printed.

The reported live-view `.caret` failure was not reproduced in this continuation.
The unchanged streaming assertion, actual assistant completion while viewing,
missing-grant refusal, revocation, pixel clearing and stop audit pass at both widths.

## Intermediate failure still unexplained

Attempt 2 showed Action history as unavailable, after its filtered API read had
passed. The corresponding browser read was not visible in the server log. A later
API read and a separate browser loaded the same history. Its exact cause remains
unproved; no product fix, retry or timeout increase is claimed for this failure.
Attempt 3 passed the full core with a temporary fetch diagnostic wrapper. The final
fresh run passed with that wrapper removed and passive status/transport diagnostics.

## Own checks

- PASS: final full fresh core journey and secondary cleanup.
- PASS: three targeted audit/animation tests, including malformed/missing money,
  wrong-call matches, missing publication and permanent undersizing refusals.
- PASS: removing the integer-money assertion made its test fail; restored afterwards.
- PASS: whole-workspace typecheck and final dev-stack typecheck.
- PASS: scoped typed ESLint for the changed journey code, fixtures and browser script.
- PASS: Markdown lint, event catalogue (174 types), Knip and changelog checks.
- PASS: public privacy check and secret scan before push.
- NOT RUN: full root suite, real-provider qualification, owner operations and the
  approval journey that the core launcher already skips. CI was not awaited.

Earlier branch checks passed 1,555 web tests, the production web build, 92 targeted
stack tests and the full chat visual check. Those checks were not repeated in this
continuation. No additional independent review was run.

## Screenshots

Each pair comes from the final fresh run, except the retained intercepted Retry
captures, which use synthetic records. All widths were checked from the PNG files.

| Step | 390 px | 1280 px |
| --- | --- | --- |
| Retry and Remove | [Phone](retry-390.png) | [Desktop](retry-1280.png) |
| Live upload | [Phone](upload-390.png) | [Desktop](upload-1280.png) |
| Action history | [Phone](audit-action-390.png) | [Desktop](audit-action-1280.png) |
| Category selection | [Phone](audit-category-390.png) | [Desktop](audit-category-1280.png) |
| Safe-reference search | [Phone](audit-reference-390.png) | [Desktop](audit-reference-1280.png) |
| Member refusal | [Phone](audit-refused-390.png) | [Desktop](audit-refused-1280.png) |
| Computer view | [Phone](live-view-390.png) | [Desktop](live-view-1280.png) |
| Revocation clears pixels | [Phone](live-revoked-390.png) | [Desktop](live-revoked-1280.png) |

Part of #576.
