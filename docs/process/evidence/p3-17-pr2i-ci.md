# Takeover approval cancellation: CI failure comparison

Dates: 23–24 October 2026. Part of #58; draft PR #637.

## Source and result

Fetched main: `bae5d496c17e76b27ae4f9dc6af56a303b173453`.
Rebased branch tested: `4087a5d755321c9557bdc59e2395885457ff44fb`.
The rebase completed. The fetched main commit is an ancestor of the branch,
and no rebase state remains. The shared `origin/main` reference moved to
`dd1d6ef152a17aa38dde42c0b0061197fd7474ff` during checks; that later merge is not
part of this tested source.
Four README conflicts were resolved by keeping both the role-history additions
from main and the takeover-cancellation additions from this branch.

[CI run 40038936584](https://github.com/elewa-git/opencrane-new/actions/runs/40038936584)
failed on `1cbe79cc58041503b9d1b685819383452d003c99`.
The `wrong_id` case received 403 instead of 200 while requesting its initial permit.
The failure came before the remote response with the wrong id was sent.

Comparison: **PASS**, five runs on each source. Attribution: **PARTIAL**.
Neither source reproduced the failure. These runs establish neither a branch
regression nor a confirmed existing flake. The original CI failure remains a failure.

The test calls `publishedFixture('allow', true)`. Its permission request reaches
`approvalDecision`, which returns the Allow result before calling `askApproval`
or `readApproval`. The new takeover check runs inside `readApproval`. This explains
why the changed cancellation logic is not on this test's permission-request path;
it does not establish the cause of the original refusal.

No behaviour, test assertion or access deadline was changed during this follow-up.
No new failing-first test was needed for the documentation-only follow-up.
The original test-first commits remain separate from implementation after rebase.

## Comparison runs

Each entry ran only `keeps remote adapter failure unknown: wrong_id` from
`libs/models/test/mcp-dispatch.test.ts`. The other 172 cases were filtered out.

| Run | Main | Main seconds | Branch | Branch seconds |
| --- | --- | --- | --- | --- |
| 1 | PASS | 15.96 | PASS | 20.48 |
| 2 | PASS | 21.83 | PASS | 21.15 |
| 3 | PASS | 20.10 | PASS | 18.54 |
| 4 | PASS | 20.24 | PASS | 19.56 |
| 5 | PASS | 18.16 | PASS | 16.13 |

The detached main worktree had its own `npm ci` installation. It was clean before
removal, and was removed after all five runs. Both sources used the same lockfile,
Node 22.23.3 and Vitest 5.0.3. Tests used disposable NATS, OpenFGA and database
fixtures, with the requested PostgreSQL service at port 55432. This was the shared
development host, not a fresh installation. Lint, typecheck and the first browser
test run overlapped part of the comparison. All commands ran under `nice -n 10`.

```sh
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres \
nice -n 10 npm test -- libs/models/test/mcp-dispatch.test.ts \
  -t 'keeps remote adapter failure unknown: wrong_id' --maxWorkers=1
```

## Other checks

- **PASS**: `npm run lint`, with zero errors and 25 function-length warnings.
  This includes dependency checks, Knip, Markdown, README, link, fixture, package
  licence and `npm run lint:changelog` checks. Knip reported two configuration hints.
- **PASS**: `npm run typecheck` across all workspaces and both infrastructure checks.
- **PASS**: `npm run check:events`, with all 153 event types matching.
- **PASS**: browser approval tests twice, 84 tests each time. Vitest durations were
  17.72 and 19.61 seconds, after the Angular test builds.
- **PASS**: changed backend tests twice, 188 tests and one optional browser test
  skipped each time. Durations were 462.07 and 402.62 seconds.

The changed backend files were `apps/server/test/approvals.test.ts`,
`apps/server/test/bridge-approvals.test.ts`, `apps/server/test/bridge-gate.test.ts`
and `libs/protocol/test/approvals.test.ts`. Each run used `nice -n 10 npm test --`
followed by those four paths and `--maxWorkers=1`, with the PostgreSQL URL above.
The optional `APPROVAL_BROWSER=1` test is **NOT RUN**; its skip is not a pass.

The browser command, run twice, was:

```sh
nice -n 10 npm test -w apps/web -- \
  --watch=false --include=src/app/chat/approvals.spec.ts
```

Local logs remain in `/tmp/p3-17-pr2i-ci-logs/` on the builder host. The comparison
logs are `main-1.log` through `main-5.log` and `branch-1.log` through `branch-5.log`.
The backend logs are `changed-1.log` and `changed-2.log`; browser logs are
`web-1.log` and `web-2.log`. Check logs use the check name.

Full root suite and fresh-install/live qualification: **NOT RUN** in this follow-up.
The PR remains in draft. New CI results will not be awaited after pushing.
