# Prepare a private session for a claimed routine occurrence

Date: 26 October 2026. Part of #106.
Base: `7fb730399`. Test-first commit: `a9456c319`.
Source: `abaa7f30192a4e70beeaab3302dee7ec630ed64e`.
Environment: Node 22 on Linux, disposable NATS, OpenFGA and PostgreSQL fixtures.
This is a source check, not a fresh installation. Live qualification: NOT RUN.

The internal command reads saved facts, checks current access and recovers one private
session. It saves no input and has no production caller. Execution remains unavailable.
No event or public API was added. Identifier fields were checked against the unchanged
security field-name rule. The authority tests were not edited. No dependency was added.

| Own check | Result |
| --- | --- |
| Test-first run | PASS: missing module refused the new suite before implementation |
| Saved-owner regression | PASS: reproduced an accepted changed creator, then added full comparison |
| Changed tests, twice | PASS: 45 tests each; 45 also pass after formatting |
| Unchanged security rules | PASS: 438 tests, once |
| Typecheck, event catalogue, changelog | PASS |
| Lint, including Knip | PASS: all steps; code has size warnings and no errors |
| Fresh-install journey, full root suite, CI inspection | NOT RUN |

Logs: `/tmp/p4-24-pr9a-*.log`; final tests use `final-tests1.log` and `final-tests2.log`.
`npm ci` completed; NATS and Lychee use the requested
symlinks. Tests used one worker and a throwaway database through `PG_TEST_URL`;
the database and its volume were removed afterwards.
Lint, typecheck and tests run under `nice -n 10`. No development stack or model calls.
The first full code scan was stopped during heavy host swapping. The replacement checks
all 1,332 files selected by the existing ESLint configuration in sequential batches.
Its file list and results are in `lint-files.json` and `lint-batches.log` under the same
log prefix. Remaining lint steps use `lint-rest.log`; no rule or configuration changed.
Input, ticks, skip/missed writers, company-profile checks, wake, root allowance, current
budgets, Ask and activation remain later work. This draft returns without waiting for CI.
