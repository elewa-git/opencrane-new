# Personal account revocation

## Original implementation

Part of #49. Date: 25 October 2026.
Source: `579f731243a8d91c421df805215188896517f621`.
Base: `8b757ac4f85877b54a2a529adb14b46cb0fe396c`.
Test-first commit: `86c8796d0` (originally `ad6d9e1f7`, before rebasing).

Members can revoke their own saved personal account through one POST route.
The existing command saves one conditional event. Exact retries return its original
receipt, including after a lost reply and expiry of broker deduplication. The existing
receipt GET returns unknown when evidence is missing. Local revocation does not
prove upstream revocation. No provider or custody work runs in the route or its reads.

The environment was a new worktree with `npm ci` and the requested tool symlinks.
Tests used disposable NATS and OpenFGA services and isolated databases through the
supplied `PG_TEST_URL` at port 55432. This was not a fresh product installation.
All tests and static checks used `nice -n 10`; Vitest used one worker.
No owner stack, model, host networking or daemon settings were changed.
External spending was 0 euro cents. No dependencies or event types were added.

| Check | Result | Observed result |
| --- | --- | --- |
| Tests before implementation | FAIL (expected) | All 25 cases failed with the route absent. Tests were committed first. |
| Final revoke suite, twice | PASS | 27 tests on each rebased run; the first also passed 27 command tests. |
| Existing receipt, profile, selection and bearer command suites | PASS | 116 tests. |
| Protected event security rules | PASS | All 438 tests; protected files unchanged. |
| API field names | PASS | Six names pass the unchanged risky-field matcher. |
| Event catalogue | PASS | 154 types agree. |
| Lint stages, including Knip and changelog | PASS | Full scan found four test errors; corrected and rebased files passed ESLint. All remaining stages passed. |
| Typecheck | PASS | Full workspaces, packaging and dev-stack checks passed; server and models passed again after rebasing. |
| Full root suite and fresh live use | NOT RUN | Outside this task. |

The first implementation run exposed a test expectation error: Fastify rejects
an overlong path before invoking the handler. Its existing response is 414.
The assertion was corrected; the final two complete revoke runs passed. Product
code needed no change. The broader run passed 580 of 581 tests before this correction.
Full ESLint then found four typing/stringification errors in the new tests. These
were corrected before the final checks.

Main advanced by one commit during validation. Rebasing kept both sets of README
changes. The route, registration and models export stayed byte-for-byte unchanged.
The full typecheck and initial full ESLint scan used the earlier base `f34ccba16`.
Final checks cover the corrected tests and files introduced by the rebase.

[Check output](checks.txt) records the test counts and field-name check.
Logs are `/tmp/p3-8-pr7f-red.log`, `/tmp/p3-8-pr7f-tests-1.log`,
`/tmp/p3-8-pr7f-final-tests-1.log` and `/tmp/p3-8-pr7f-final-tests-2.log`.
Static logs use the same prefix with `lint`, `lint-final-code`, `lint-rest`,
`typecheck`, `typecheck-final`, `events` and `field-names`.

## Permission check correction

Date: 25 October 2026. Source: `47390aa5084aa247720668c99e1d9547d385d6f1`.
Fetched base: `35e7e10e97854a706f69cebf22eee4e2c049e149`.
The rebase finished, and that base is an ancestor of the source commit.
Both server README conflicts kept the company opt-in and personal revoke descriptions.
Test-first commit: `8c5464604`. Implementation commit: `23226a330`.

The command now keeps preparation failures until it has checked current permission
once. A refused member receives 403 even if a later permissions call would fail.
The route preserves that refusal without making another permission check.
The final freshness check, two-second deadline and conditional append remain in place.
Profile history is read before that deadline starts. No conversation history is read.

The new regressions count checks after successful, failed, missing and stale preparation,
and deny permission before simulating a later OpenFGA failure. They also cover missing
configuration and member lookup, strict handler parameters, malformed actors, mismatched
target fields, each original-event identity field, missing readback, final access changes
and expiry. Two simultaneous HTTP requests save one revoke and recover the same receipt.
No existing assertion or access check was weakened.

The environment used the supplied test PostgreSQL on port 55432, isolated test databases,
and disposable NATS and OpenFGA services. All checks ran under `nice -n 10`.
Vitest used one worker. Test containers were removed by their fixtures.
No owner service, daemon or network setting was changed. This was not a fresh installation.

| Check | Result | Observed result |
| --- | --- | --- |
| Permission regressions before implementation | FAIL (expected) | Four cases checked twice; denial followed by dependency failure returned 503 instead of 403. All five regressions were committed before the fix. |
| Final revoke, bearer, profile and receipt suites, twice | PASS | 127 tests in four files on each final run. |
| Protected event security rules | PASS | 438 tests in the first broader run; the file is unchanged. |
| Full workspace typecheck | PASS | Includes package and dev-stack checks. Final server and models typechecks also passed after fixture corrections. |
| Initial full ESLint scan | FAIL (corrected) | Two unbound fixture methods; 25 existing warnings. Both errors were corrected. |
| Final ESLint checks | PASS | Changed production files passed; both final test files passed after binding the public SDK client. |
| Dependency rules and Knip | PASS | Replaced a forbidden private test import with the existing public OpenFGA SDK. Final dependency rules and Knip passed. |
| Other lint stages | PASS | Documentation, README, links, fixture, package licence and changelog checks passed. |
| Event catalogue | PASS | 154 event types agree. |
| Full root suite, mutation tests and fresh live use | NOT RUN | Outside this correction. HTTP success through real custody deletion and personal in-flight credential cancellation remain unqualified. |

The first broader run passed 557 of 558 tests. Its new expiry fixture moved the clock
while a position read was still pending, producing a timeout before the intended check.
The fixture now finishes those reads first; the exact expiry and no-append assertions
remain unchanged. Later fixture-only corrections bound the saved method and moved the
spy to the public SDK to meet lint and package import rules. Both final runs passed
again after those changes. No product change was needed for these fixture corrections.

The final test logs are `/tmp/p3-8-pr7f-fix-final-5.log` and
`/tmp/p3-8-pr7f-fix-final-6.log`. The initial reproduction is
`/tmp/p3-8-pr7f-fix-red.log`. Static logs use `/tmp/p3-8-pr7f-fix-` with
`lint`, `final-eslint-2`, `final-eslint-3`, `typecheck`, `final-typecheck-2`,
`deps`, `knip`, `docs`, `readmes`, `links`, `fixtures`, `licences`, `events`
and `changelog`. [Check output](checks.txt) records the final counts.
