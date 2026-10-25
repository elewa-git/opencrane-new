# Personal account revocation

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
