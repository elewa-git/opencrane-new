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

## Creation binding and reserved public identifiers

Date: 26 October 2026. Rebased base: `d45dd860c0730957bc044602184f2b8980294d2a`.
Source: `17c6f3f140679d6908daeeb709b46349ce294f0a`.
Failing tests were committed first in `54ebd8f36` and `4ab7dc5e1`.
The rebase completed; the base is an ancestor and no rebase state remains.

The regression creates an ordinary chat with the future occurrence's identifiers,
posts a human message, then calls the real claim command. Before the fix, preparation
returned that ordinary chat as confirmed. The fixed command refuses it without an append
or adoption. A genuine retry returns the saved preparation without appending.
The public-route regression initially returned HTTP 200 for a reserved id; it now
expects HTTP 400 and no append for reserved conversation and command identifiers.

Only the preparation append adds `routinePreparation`, containing the routine,
occurrence, claim id, claim position and trusted worker id. Recovery compares every
field and requires creation after the claim. Tests also refuse a changed value in each
field and a retry by another worker. Public chat input cannot supply the field.
The existing conversation event schema and catalogue document this optional field;
no event type, dependency or production caller was added. Execution stays disabled.
Authority and event-security test files remain unchanged.

The checks use Node 22, disposable NATS and OpenFGA, and PostgreSQL 17.6 on a random
localhost port. `PG_TEST_URL` points to that throwaway database, as required for projection
tests. Tests, lint and typecheck run under `nice -n 10`; no full root suite or dev stack runs.
This is not a fresh installation. Live qualification and CI inspection: NOT RUN.

| Own check | Result |
| --- | --- |
| Ordinary chat and saved-binding regressions before the fix | FAIL, expected: ordinary chat adopted; worker binding absent |
| Reserved public-route regression before the fix | FAIL, expected: HTTP 200 instead of 400 |
| First selected test run | PASS: 162 tests across eight files |
| Second selected test run and unchanged security rules | PASS: 162 selected tests and 438 security tests |
| Edited test files repeated after type and lint corrections | PASS: 53 tests; both final-source passes are green |
| Final lint, including Knip | PASS: complete pipeline; zero code errors and 27 warnings |
| Final typecheck | PASS: all workspaces, package and dev-stack types |
| Event catalogue and changelog validation | PASS: 154 event types agree; fragment accepted |

The selected files are routine-session, routine-due, chat-http, chat, direct-chat-http,
and the events, authorisation and projection routines tests. The first run uses one
worker; the second uses two. Logs are `/tmp/p4-24-pr9a-fix-*.log`, including
`tests1.log`, `tests2-security.log`, `edited-repeat.log`, `lint-final.log` and
`typecheck-final.log` under that prefix.
The initial focused lint and typecheck found an unparsed append event, test-spy types
and two complexity limits. These were fixed without changing an assertion or rule.
The superseded full lint process was stopped; the final scan checks the complete tree.
PASS: the throwaway database and its volume were removed after the tests.
