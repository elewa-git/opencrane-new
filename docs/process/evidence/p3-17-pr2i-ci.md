# Takeover approval cancellation: HTTP write checks and CI comparison

Date: 24 October 2026. Part of #58; draft PR #637.

## Source and environment

The branch was rebased onto fetched main
`6da12a8f525c520178dbb1b18be816de8b491633`. The rebase completed without conflicts.
The fetched commit is an ancestor of the branch, and no rebase state remains.
The test commit is `68af99e2a4cb940e45917c9f2ed80cd9b6dbd73e`.
The implementation is `9a906e4d1df308f76de80fe8dd4a4c19ac03abdf`.
Final code: `acaac47064efff976668926a7c02e192785c94d7`. That later commit extracts
the invalidation save into a named function and adds an authorised-save check.

Checks ran on the shared development host, not a fresh installation. Backend tests
used `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres` and disposable
NATS, database, OpenFGA and gateway fixtures. All test, lint and typecheck commands
ran under `nice -n 10`. Vitest used one worker. No full root suite ran.

## HTTP invalidation ordering

**PASS**: a refused HTTP decision saves no approval cancellation. History loading
now prepares an invalidation without writing. The route checks the saved request's
conversation, requester and participation position, loads turn activity, and checks
current write authority. Only then can the decision save the prepared event, with
the original approval sequence and the two-second write deadline.

The three new tests failed before the implementation was changed. Each received
403 but found an extra `approval.cancelled` event. The cases were a known approval
from another person's chat, member removal during approval loading, and participant
removal during that loading. The tests were committed before the fix. All three
then passed, along with the existing test that refuses full conversation-history
reads inside the short access check.

## Initial MCP permit refusal

[CI run 40038936584](https://github.com/elewa-git/opencrane-new/actions/runs/40038936584)
failed on `1cbe79cc58041503b9d1b685819383452d003c99`. Its `wrong_id` case received
403 instead of 200 from `/authorize/mcp/fixture/installed`, before sending the
remote response with the wrong id. The body contained the fixed message
`Request refused or decision service unavailable`. That message hides several
possible exceptions, so the original log alone cannot identify the exception.

The earlier five isolated passes on each source did not establish a cause.
This comparison uses the same fetched main commit as the rebase, in a separate
worktree with its own `npm ci` installation. A temporary diagnostic line in the
permit route's exception handler prints the underlying exception and elapsed time.
It changes no return value, assertion, access check or deadline.

Attribution: **PARTIAL — unresolved**. The exact `wrong_id` test passed in the full
main file and in 100 consecutive repetitions on main. Each repetition called the
unchanged test function with its original assertions, including the initial 200
permit assertion. No latency, outage or clock change was injected. The run used
`--bail=1` so the first failure would stop it. No initial-permit 403 occurred.
These passes do not prove that main has the same flake or explain the original CI
failure. The finding remains open and must not be treated as fixed.

The full main file was **FAIL**: 171 passed and two failed in 1302.18 seconds.
`restores drift only through exact live publication: restart recovery` failed in
its replay subprocess. `saves tool.dispatch_started before any upstream byte and
keeps the outcome last` timed out, including its cleanup hook. Neither failure was
an initial-permit 403. The focused repetitions were **PASS**: 100 in 642.02 seconds.

On the branch, the exact case first failed before the permit request because the
gateway child was no longer available at delivery. The unchanged repeat passed in
19.53 seconds. This earlier delivery failure is also not evidence of the original
permit refusal. The receipt retains both outcomes instead of attributing one to
the other.

The temporary diagnostic and repetition changes are saved in the local
`main-diagnostic.patch` log artefact. They are not part of the PR. The temporary
main worktree was restored and removed after the comparison.

## Checks of the fix

- **PASS**: three new refusal tests failed before the fix, then passed. The failing
  test commit precedes implementation. The first green run also passed the existing
  history-deadline test: four selected tests, 51.88 seconds.
- **PASS**: changed backend/protocol files twice: 191 tests each time, with the
  optional `APPROVAL_BROWSER=1` test skipped. The first run also passed all 438
  unchanged event security tests, giving 629 passed in 738.66 seconds. The second
  changed-file run took 517.06 seconds.
- **PASS**: after extracting the save function, five focused tests passed twice
  in 53.98 and 41.89 seconds. These cover the three refusals, the history deadline,
  and an authorised cancellation that remains saved once after restart.
- **PASS**: browser approval tests twice: 84 each time, in 29.32 and 16.63 seconds
  after their Angular builds.
- **PASS**: workspace and infrastructure typecheck. Models typecheck passed again
  after the function extraction. Server typecheck passed again after the added
  authorised-save test.
- **PASS**: full lint after fixing one new complexity error, with zero errors and
  25 existing function-length warnings. This includes Knip (two configuration
  hints), dependency checks, Markdown, README, links, fixtures, package licences
  and `npm run lint:changelog`.
- **PASS**: `npm run check:events`, with all 153 types matching.
- **NOT RUN**: the optional browser journey, full root suite and fresh-install/live
  qualification. Takeover remains disabled. The PR remains draft.

The unchanged two-second root-stop assertion passed in both changed-file runs.
No access, money or memory assertion or deadline was loosened. Authority helpers
and their two protected test files are unchanged.

## Commands and local logs

Logs remain under `/tmp/p3-17-pr2i-fix/` on the builder host. `red.log`, `green.log`,
`changed-{1,2}.log`, `final-focused-{1,2}.log` and `web-{1,2}.log` record test runs.
`main-dispatch.log`, `main-permits.log`, `branch-wrong-id.log` and
`branch-wrong-id-2.log` record every comparison outcome above. `lint-final.log` and
`typecheck.log` contain the full checks; `typecheck-models-final.log` checks the
extracted helper. `typecheck-server-final.log` checks the final HTTP test file.
`main-install.log` records the separate installation.

```sh
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres \
nice -n 10 npx vitest run \
  apps/server/test/approvals.test.ts \
  apps/server/test/bridge-approvals.test.ts \
  apps/server/test/bridge-gate.test.ts \
  libs/protocol/test/approvals.test.ts --maxWorkers=1

NG_BUILD_MAX_WORKERS=2 nice -n 10 npm test -w apps/web -- \
  --watch=false --include=src/app/chat/approvals.spec.ts

nice -n 10 npm run lint
nice -n 10 npm run typecheck
nice -n 10 npm run check:events
```

The first backend command also included `libs/events/test/security-rules.test.ts`.
The main comparison used only `libs/models/test/mcp-dispatch.test.ts`; its repeated
run selected `compares initial permit on main`, with `--bail=1 --reporter=verbose`.
The repetition wrapper calls `keepsRemoteFailureUnknown('wrong_id')` unchanged.
