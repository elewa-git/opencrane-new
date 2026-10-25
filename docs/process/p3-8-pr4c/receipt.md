# Saving company account opt-in

Part of #49. Date: 25 October 2026.
Source: `a7ae10473bafd7564ec86e921bc316927bf0f9fd`.
Base and prerequisite #703 merge: `e063b98f1b646d2b2d3fed05a32671dad91005ad`.
Test-only commit: `4a678db8d`. Implementation: `e379ab2b9`.

The POST route saves or removes opt-in through the unchanged command. It takes
identity from the signed session and configuration, checks the exact Origin and
accepts a strict JSON body up to 4096 bytes. Every reply has no-store. History loads
before the command's short write access check. Exact retries recover the original
receipt; opt-in grants no tool access and company selection remains unavailable.

The worktree used `npm ci` and the requested test-tool links. Tests used real,
disposable NATS, OpenFGA and PostgreSQL 17.6. `PG_TEST_URL` pointed at the throwaway
database on a dynamically assigned loopback port. Its container and volume were
removed. This was not a fresh product install. No owner stack, provider or model
was used. External spending: 0 euro cents.

| Check | Result | Observed result |
| --- | --- | --- |
| Failing-first HTTP cases | PASS | All 37 cases failed at the absent POST route before implementation. |
| Final HTTP cases, twice | PASS | 37 POST and 21 existing GET cases passed each time. Later edits only changed TypeScript annotations and imports. |
| Company command and fold | PASS | 33 existing cases passed; command unchanged. |
| Protected security rules | PASS | 438 cases passed once; file unchanged. |
| Existing personal selection suite | FAIL | 87 of 88 cases passed. The first explicit-selection case failed during fixture setup with `Connection coordination unavailable` at the database lock. Not rerun; outside the listed flakes. |
| Typecheck stages | PASS | The workspace run found test typing errors. The corrected server, every other workspace and both infrastructure checks passed. |
| Lint stages | PASS | The full code scan found errors in an earlier test version. Final changed files pass ESLint, and all remaining stages pass, including knip. |
| Event catalogue and changelog | PASS | 154 event types agree; the branch fragment is accepted. |
| Full root suite and live company-account use | NOT RUN | Outside this change. |

The initial HTTP runs exposed fixture mistakes, which were corrected before the two
passing runs. They included a missing selection-route configuration. The full static
scan also found test typing errors; final checks cover their corrections.
The protected authority tests, event schemas and budget, memory and scanner code
are unchanged. No dependency was added. Existing request and receipt field names
avoid the exact RISKY_FIELD_NAME expression. Overall qualification remains PARTIAL
because the existing selection test failed and live account use is not qualified.
[Command record](checks.txt) contains safe counts and the retained failure.
