# Group participant command checks

Date: 9 October 2026. Source: `fe733b2694a185573796b272e91f97ad4efdc18d`.
Base: `c438e01d`. Test-first commit: `1916d4af`. Branch: `work/p4-5-pr4`.
Environment: fresh disposable NATS, PostgreSQL and OpenFGA fixtures; `PG_TEST_URL` set.
These are service tests, not a fresh installed silo. No full root test suite ran.

| Check | Status | Observed result |
| --- | --- | --- |
| Failing-first participant tests | FAIL, expected | Five cases returned 404 before routes existed. |
| Four selected test files, first run | PASS | 73 tests; before the extra admission probe. |
| Four selected test files, final source | PASS | 74 tests; all six new cases included. |
| Six new cases again on final source | PASS | All six passed; changed tests ran twice. |
| Browser refusal and late results | PASS | 65 direct-chat and screenshot-capture tests. |
| Lint, typecheck, event catalogue, knip, changelog | PASS | Required local checks passed. |
| Independent review and final verification | PASS | No blocking source findings. |
| Fresh-install desktop and phone journey | NOT RUN | Group screens and creation/send work are separate. |
| Complete group-chat capability | PARTIAL | This change supplies participant commands only. |

Run selected Vitest files under `nice -n 10`: server `chat-access-regression`,
`direct-chat-http`, `chat-read-regressions`, and protocol `chat-mode`.
Run Angular tests for `direct-chat.spec.ts` and `screenshot-capture.spec.ts`.
Logs remain in `/tmp/p4-5-pr4-{red,tests-1,tests-2,changed-final,browser-tests}.log`.
Other logs use the same prefix with `lint`, `typecheck` and `admission`.
