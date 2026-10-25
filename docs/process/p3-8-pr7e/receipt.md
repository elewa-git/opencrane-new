# Current company account opt-in reads

Part of #49. Date: 25 October 2026.
Source: `77bf44a6e956bf8dc142d7a0a920e3184886f826`.
Base: `90ec96bc6aa12f907bbdf2524be66fad47068273`, including #695.
The test-only commit `d0100fdb7` precedes the implementation in `f7446796e`.

The GET route returns only the current enabled choice, sequence, connection id and
registration revision. History loads before one current admin access check, including
when loading fails. Re-registration invalidates earlier opt-in. Reads grant no tool
access, expose no profiles and start no effects.

The environment was a fresh worktree with `npm ci` and the requested tool links.
Tests used real disposable NATS, OpenFGA and PostgreSQL 17.6 fixtures, with
`PG_TEST_URL` pointing at the throwaway database. This was not a fresh product install.
Every suite and static check ran under `nice -n 10`; Vitest used one worker and no
file parallelism. Both throwaway databases and their volumes were removed.

| Check | Result | Observed result |
| --- | --- | --- |
| Failing-first HTTP tests | PASS | Tests were committed before the route existed. |
| Final company HTTP suite, twice | PASS | 21 tests passed on each run. |
| Existing company command/fold tests | PASS | 33 tests passed. |
| Protected security rules | PASS | 438 tests passed; file unchanged. |
| Full typecheck and final server typecheck | PASS | Both completed successfully. |
| Lint stages | PASS | Full code scan found one return-value error, corrected and rechecked on final files. All remaining stages passed, including knip, documentation, links and licences. |
| Event catalogue and changelog | PASS | 154 event types agree; fragment accepted. |
| Existing integration suite | FAIL | 96 of 97 tests passed. The Chromium refresh test's web build did not become ready within 60 seconds. This unlisted failure was not rerun or changed. |
| Full root suite and fresh live account qualification | NOT RUN | Outside this part. |

[Check output](checks.txt) records commands, counts and the browser failure.
The broader four-file run used `f7446796e`; final HTTP runs checked the handler fix.
Overall qualification is PARTIAL because the existing browser journey failed.
No owner stack, model or external account was used. External spending: 0 euro cents.
Company profiles, selection, dispatch, release, OAuth and screens remain later work.
