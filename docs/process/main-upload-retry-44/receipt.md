# Qualification: PARTIAL

Journey on a fresh dev stack: PASS (three consecutive core journeys)

The two upload findings are repaired. An additional Change history read failed in an
earlier fresh run and its cause remains unproved. The three later passes do not
establish that this additional failure is fixed; the PR remains held for the owner.

13 November 2026. All three qualifying runs used source `9726a297f`, secondary
slot 1, the stand-in provider and a separate `claim.sh` / `up.sh --fresh` /
`down.sh` cycle. The fleet marker remained set. The owner stack was not used.
Only documentation, qualification test fixtures and captured evidence changed after
that core-journey source.

## Consecutive qualification

| Qualifying run | Fresh start (UTC) | Cleanup finished (UTC) | Core | Cleanup |
| --- | --- | --- | --- | --- |
| 1 | 10:21:58 | 10:34:25 | PASS | PASS |
| 2 | 10:34:37 | 10:48:56 | PASS | PASS |
| 3 | 10:52:35 | 11:04:12 | PASS | PASS |

Run 2 also passed 100 separate, read-only Change history navigations after the full
core journey. These navigations alternated 390 and 1280 px and stopped on a failure;
they did not retry a failed read. All three core runs used the same executable source.

Each PASS covers the complete core journey: real sign-in and refusals; streaming,
Stop and reload; uploads, lost-response Retry without duplicates, PDF answer and
original bytes, malware/type/size refusals and text/image previews; live-view
revocation; computer suspension, wake and Pod replacement with preserved files;
tool review and publication; visible Change history; budgets; members and MCP
catalogue replay verification; token boundaries, sign-out, reauthentication and
listener checks. Cleanup passed after every qualifying run.

Each run used this sequence from the worktree:

```sh
stack_id=$(infra/dev-stack/claim.sh) || exit 1
export DEV_STACK_ID="$stack_id"
export ZITADEL_KEY_FILE="$PWD/.keys/.zitadel-key"
export DEV_REAL_PROVIDER=0
nice -n 10 infra/dev-stack/up.sh --fresh
nice -n 10 infra/dev-stack/down.sh
```

A private wrapper always ran `down.sh` on exit, retained the verdict and UTC times,
and copied screenshots before cleanup. Each wrapper was syntax-checked before
execution and left unchanged while running. `up.sh --fresh` includes the full core
journey; it was not replaced by an upload-only check.

## Causes and repairs

- Ready used to mean the upload acknowledgement had arrived, while Send separately
  waited for `file.delivered`. A held-delivery composer test failed with Ready where
  Preparing files… was required. `UploadBatch` now derives both the visible chip
  and sendable ids from delivery. Both event orders are covered. The intercepted
  browser check holds delivery too. The real journey holds the actual delivery
  frame and later socket frames, checks Preparing with Send disabled, releases the
  frames in order, then checks Ready with Send enabled at 390 and 1280 px.
- The upload helper could read the old refusal after clicking Retry, then try the
  vanished Retry control again. The regression failed at the same target lookup
  as CI. The helper now waits for the clicked refusal control to leave before
  reading the next result. No retry, timeout or sleep was added.
- The new delivery hold initially opened a draft immediately after reload, before
  the personal assistant finished loading. Its failure capture showed the preparing
  assistant state with no Attach control. A browser test failed because the helper
  returned before Attach appeared. The helper now waits for Attach before opening
  the draft; the test passes twice.

The failing tests were committed before their fixes. Earlier repairs in this PR
retain the 44 × 44 px Retry/Remove targets, active-upload cancellation, keyboard
Change history checks, Older history coverage and the secondary stand-in launcher
refusal matrix. Access, integer money and memory assertions were not loosened.

## Additional unresolved history failure

The fresh run from 09:56:55 to 10:12:23 UTC at `9a0897d43` failed in
`checkChangeHistory`, waiting for History loaded. Its upload checks passed.
Cleanup passed. The server logs show successful API checks immediately beforehand,
but no subsequent browser history read. They cannot establish the browser's cause.

Both Action and Change history now share passive API status/transport collection and
save the failing screen before the browser closes. HTML page responses do not count
as API reads. No history retry, longer timeout or sleep was added. The subsequent
three full fresh runs and 100 independent history navigations did not reproduce the
failure. A separate held localhost read during normal OpenFGA fixture creation and
30 navigations during fixture creation also passed. Kernel logs show virtual-interface
changes near the failed read, but the controlled tests do not establish causation.
No Chromium, Docker daemon, bridge, route or host network setting was changed.

The earlier Action history follow-up remains open too. This continuation does not
claim that an unexplained core failure is repaired. Overall qualification stays
PARTIAL despite the three measured core PASS results.

## Attempts before the consecutive sequence

- 09:25:43–09:36:54 UTC: the full core journey passed at `ecfdf9b94`, but the
  temporary wrapper failed with a shell parse error after it had been edited while
  running. Cleanup passed. This attempt is recorded as FAIL and does not count.
- 09:37:46–09:43:38 UTC: FAIL at `ecfdf9b94` before the first upload because the
  delivery helper opened a draft before assistant loading completed. Cleanup passed.
  The failing browser test and Attach wait above repair that cause. The count was
  restarted on the corrected source.
- 09:44:41–09:56:16 UTC: full fresh core PASS at `9a0897d43`, cleanup PASS.
  The following Change history failure above restarted the consecutive count.

Earlier review-fix attempts included an exact-title locator mismatch and an absent
Send after a ready upload. The held-delivery regression reproduces the Ready/Send
mismatch; the original failed live run had no retained trace to establish its exact
cause. An earlier Action history load failure also remains an explicit follow-up.
No retry or timeout increase is claimed as a repair for either symptom.

## CI qualification fixture repair

CI on the first pushed head `2a4badbe8` passed Chromium but failed all nine hosted-MCP
fixture cases. The fixture removed function exports before evaluating the shared
journey guard, leaving its newly exported refusal constant as invalid script syntax.
The fixture now removes the runtime export keyword for every shared declaration.

That repair exposed a missing fleet refusal in hosted admission setup. The core
journey guard intentionally permits secondary stand-in fleet runs, so hosted admission
checks now separately refuse every fleet marker before Kubernetes calls. The owner
refusal remains in the shared guard. Both refusal messages are asserted exactly and
the test still requires no Kubernetes calls. The changed test was committed before
both repairs. After the parser repair it failed with Missing expected rejection for
the fleet case; after restoring the explicit refusal all nine cases passed twice.
Removing that refusal by hand made its test fail; it was restored.

Ops/dev-stack typecheck and scoped ESLint passed. These fixtures are not called by
the core journey, so its executable path and the three consecutive results above are
unchanged. No access, money or memory assertion was loosened.

## Own checks

- PASS: 183 focused Angular upload, composer, workspace, drag/drop and private-reply
  tests twice; five upload-batch tests twice, including both delivery orders.
- PASS: Chromium chat-frame qualification twice, with all four tests in
  `chat-browser.test.ts` passing on the second run, including production CSP.
- PASS: three browser target, Retry ordering and reload-startup tests twice after
  the final helper fix. The undersized-target refusal remains checked.
- PASS: audit API helper tests and the shipped audit browser case twice with the
  shared disposable PostgreSQL database. An earlier audit fixture invocation missed
  its existing Angular startup limit; no limit was raised.
- PASS: nine hosted admission fixture cases twice, with an additional hand-removal
  check for the fleet refusal; scoped Ops/dev-stack typecheck after that repair.
- PASS: full workspace, package and dev-stack typecheck; dev-stack typecheck again
  after the reload fix.
- PASS: event catalogue (174 types), Knip, changelog lint, Markdown lint and scoped
  configured ESLint. Infra is excluded from the repository's ESLint project and is
  covered by dev-stack typecheck and its browser tests.
- PASS: public privacy check and secret scan before pushing.
- NOT RUN: full root suite, real-provider qualification, owner operations and the
  approval journey that the core launcher explicitly skips.

CI is reported on the PR after this receipt is pushed. No additional independent
review was run in this owner-authorised round.

## Screenshots

The upload pairs below come from qualifying run 3. They show the held real delivery,
its release and the sent attachment. The history pairs also come from that run.
The retained Retry captures use intercepted fixtures.

| Step | 390 px | 1280 px |
| --- | --- | --- |
| Preparing with delivery held | [Phone](upload-preparing-390.png) | [Desktop](upload-preparing-1280.png) |
| Ready after delivery | [Phone](upload-ready-390.png) | [Desktop](upload-ready-1280.png) |
| Sent attachment | [Phone](upload-390.png) | [Desktop](upload-1280.png) |
| Retry and Remove | [Phone](retry-390.png) | [Desktop](retry-1280.png) |
| Action history | [Phone](audit-action-390.png) | [Desktop](audit-action-1280.png) |
| Category selection | [Phone](audit-category-390.png) | [Desktop](audit-category-1280.png) |
| Publication entry | [Phone](audit-publication-390.png) | [Desktop](audit-publication-1280.png) |
| Member refusal | [Phone](audit-refused-390.png) | [Desktop](audit-refused-1280.png) |

## Not in this PR

- Safe reference search is not checked: Change history shows no reference a person
  could copy (owner question).
- Diagnose intermittent Action/Change history load failure: correlate browser
  transport/status with server requests. The fresh Change history failure above is
  unresolved and holds the PR for the owner. No retry was added.

Part of #576.
