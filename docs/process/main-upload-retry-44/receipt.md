# Journey on a fresh dev stack: FAIL (core journey)

12 November 2026. The final run used source `e7819000a`, a newly claimed secondary
stack and the stand-in provider. The fleet marker stayed set. Startup used
`infra/dev-stack/up.sh --fresh`; website readiness took 66.3 seconds.
Cleanup PASS: `down.sh` ran after every attempt and the final secondary claim was released.

The browser upload journeys completed at 390 px and 1280 px: a lost successful
response recovered through Retry without duplicate files; the PDF answer contained
Willow-47; native PDF rendering and original bytes, reload, malware/type/size
refusals and promoted text/image previews passed. The later audit journey failed
at `infra/dev-stack/browser-audit.ts:60` while looking for `Turn id filter`.
Later budget and replay checks were NOT RUN. The complete core journey remains FAIL.

Earlier fresh attempts also failed. The first attempt's private diagnostics were
removed by cleanup before retention. The second retained a timeout waiting for
Send while the preceding attachment reply was still running. A delayed-message
acknowledgement regression reproduced the premature Send-visibility check; the
journey now waits for the new reply's Done state before continuing.

The first commit, `813e06555`, reproduced Retry at 91 × 28 px at a 390 px viewport
before any product fix. Guard refusal regressions were also committed before their fixes.

Own checks:

- PASS: web tests, 81 files and 1,555 tests; test execution took 80.1 seconds.
- PASS: web production build, approximately 107 seconds, with style-budget and
  CommonJS warnings.
- PASS: 92 targeted dev-stack refusal, startup and model-environment tests,
  including empty fleet markers, both secondary ids and saved real mode on fresh starts.
- PASS: whole-workspace typecheck and a final dev-stack typecheck after the journey correction.
- PASS: full `npm run visual:chat`, including the delayed acknowledgement regression
  and Retry/Remove/cancellation targets at both widths.
- PASS: scoped ESLint, Knip, Markdown, event catalogue (174 types) and changelog checks.
  The repository excludes infrastructure from ESLint; the shared journey guard and
  both new browser helpers also passed explicit typed ESLint checks.
- NOT RUN: full root suite, owner-stack operations and real-provider qualification.

The orchestrator confirmed on 13 November that no independent review has run on
this PR and authorised continuing the repair. Independent review remains NOT RUN.
These own checks do not qualify a successful core journey.

Causes found:

- `6d879a75c` moved attachment buttons into the composer and gave them a 28 px minimum,
  outside the old workspace component's 44 px rule.
- `6d879a75c` moved status onto individual chips and delayed transcript cards until Send;
  `3391faf4f` also changed the unsupported-file wording that the old journey awaited.
- `2ecadcc3e` refused every fleet-marked journey, including secondary stand-in stacks.

The shared UI button rule now supplies the attachment target size. Remove also
cancels the active upload; there is no separate Cancel upload control.
The captures use an intercepted API and synthetic names, not live account data:
[390 px Retry](retry-390.png) and [1280 px Retry](retry-1280.png).

## Continuation on 13 November

Fetched origin. Main remained at `90a99afa7`, the branch base; no rebase was needed.
The first continuation attempt claimed secondary slot 1 and ran `up.sh --fresh`
with the stand-in provider. Startup failed during Zitadel setup before services or
browser journeys started. The expected `.keys/.zitadel-key` file was absent from
this checkout. Existing key files were then linked by path in the ignored `.keys/`
directory for a future authorised continuation. No credential value was read or
printed. This attempt supplies no new live qualification. The earlier full core verdict remains FAIL.

Traced the audit timeout to merged commit `4f06d18d0` (PR #1004). It removed the
conversation's Turn id and Request id inputs, Decision selection and Apply filters
button. Conversation history now has no filters; organisation history has the
new family, date, outcome and safe-reference filters. The old journey also expects
an exact decision label and `Observed outcome: Success`; the redesigned row combines
`Decision: allow` with `Observation: Confirmed`.

Repair is paused for one product decision. The
[P3-19 acceptance criteria](../../specs/phase-3/tickets.md#p3-19--explain-work-through-a-permission-scoped-audit-trail)
still require action history and change-history views with filters and keyboard
support. PR #1004 describes an organisation-history redesign, not the removal of
conversation filtering. Simply removing the journey's filtering and focus steps
would discard a checked user capability. The owner must choose:

- Restore conversation filtering while retaining the current visual design; treat
  its removal as a product regression and reproduce it with a failing test first.
- Intentionally remove conversation filtering, revise the acceptance criteria and
  approve the replacement journey assertion before calling the old journey stale.

No product or journey change was made while this decision was pending. New audit
screenshots are NOT RUN. The reported live-view `.caret` failure, budget checks,
replay and later checks remain NOT RUN in this continuation. Their causes have not
been classified. No independent review was requested or reported as passed.

Continuation checks:

- PASS: `down.sh --id 1`; the secondary claim was released.
- PASS: whole-workspace typecheck, Markdown lint, event catalogue, Knip and
  changelog checks.
- PASS: public privacy check and secret scan.
- NOT RUN: new code tests, scoped ESLint and repaired-step captures; only this
  receipt changed. Earlier code-check results above remain historical evidence.
