# Decision requests and release audit failures

Own checks on 29 October 2026, for PR #800 and card #49.
These checks use local test fixtures, not a fresh installation.

The release-helper changes did not introduce the reported decision failures.
Both revisions reproduced the same cache-volume HTTP 403 with an
`event_store_unavailable` diagnostic at the two-second request limit. Main also
reproduced the generic 403 at the same permission helper used by the failed CI
MCP case. The original CI failure's exact dependency cause remains unproved. This pass
adds assertions for dependency errors and permitted retries; it changes no production
behaviour and makes no claim of a failing-first production fix.

## Revisions and method

The fetch and rebase completed without conflicts. The rebased revision was
`94f8ec87e72217951f2a42c6ea82622fb8966726`, based on main
`3aa0cc64efaf0d5efa69fdc11d73eb305bdced5c`. No rebase remains active.
During the long comparison, the shared `origin/main` reference advanced to
`8b93ce3c155382bc681622e8e62a948216400f16`. The pushed branch retains the compared
base above; the later routine and memory changes are outside these test results.
Main was tested in its own detached checkout with its own `npm ci` installation. Both installed
dependency trees have the same 1,999 package/version entries. Both NATS and gateway
binaries have matching SHA-256 hashes. The comparison files are beside the test logs.

Each revision ran both complete files five times. Each command used one worker,
`nice -n 10` and the supplied local `PG_TEST_URL`. The two revision batches ran
alongside one another. The first repetitions used the original silent test logger.
Later repetitions enabled its existing warning logs and verbose case results to capture
fixed failure reasons. Both original test configurations were restored afterwards.
The production source and both selected test files stayed unchanged throughout.
The new test-only commit changes a separate file. Full lint and typecheck overlapped
the first repetitions. Other shared-host work continued.

```sh
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres \
  nice -n 10 npx vitest run \
  libs/models/test/mcp-dispatch.test.ts \
  libs/models/test/decision-cost.test.ts --maxWorkers=1
```

The logs are in `/tmp/p3-8-pr5a-fix3/`: `branch-1.log` through `branch-5.log`,
and `main-1.log` through `main-5.log`.

## Complete-file results

Each cell shows the result and the number of passing cases. Failed runs are kept.

| Run | Branch MCP, 180 | Branch cost, 28 | Main MCP, 180 | Main cost, 28 |
| --- | --- | --- | --- | --- |
| 1 | FAIL 179 | FAIL 27, HTTP 403 | FAIL 179 | FAIL 27, HTTP 503 |
| 2 | FAIL 179 | PASS 28 | FAIL 179 | FAIL 27 |
| 3 | PASS 180 | PASS 28 | PASS 180 | PASS 28 |
| 4 | FAIL 179 | PASS 28 | FAIL 178 | PASS 28 |
| 5 | FAIL 179 | FAIL 27, HTTP 403 | PASS 180 | FAIL 27, HTTP 403 |

The reported `keeps remote adapter failure unknown: gateway_502` case passed in all
five runs on each revision. The cache-volume case passed three of five runs on each
revision. The complete-file batches remain FAIL overall; each revision passed both
files together only in run 3. None of the complete runs skipped any of the 208 cases.

Run 5 closes the earlier attribution gap. Both revisions returned the same generic
403 at `decision-cost.test.ts:708`. The private warnings both named
`access_and_budget` and `event_store_unavailable`: 2,004 ms on the branch and
2,219 ms on main. This is a baseline decision-path failure at the existing request
limit, not a new typed refusal from the release helper. No production fix or longer
deadline was applied in this pass.

Failures outside the reported cache-volume case:

- Branch run 1: `restores drift only through exact live publication: exact` failed
  when its conversations replay command exited unsuccessfully.
- Branch run 2: `orders budget before tool admission and checks Stop between them:
  false` reached the test's 30-second timeout.
- Main run 1: `orders dispatch at the last gateway read, saved after read: true`
  replied before the final gateway read barrier.
- Main run 2: `keeps approvals valid only across uninterrupted renewal: fresh`
  failed to obtain an approval id. The private reason was `iam_projection_behind`
  during `access_and_budget`, after 1,125 ms.
- Main run 2: `refuses a Ready position changed after credentials without reserving
  money` reached its 40-second test timeout.
- Branch run 4: `consumes a published permit once, concurrent: true` reached the
  cleanup hook's 30-second timeout.
- Main run 4: `saves a checked remote response against its consumed permit once:
  result` received the generic 403 during permission preparation, described below.
- Main run 4: `keeps remote adapter failure unknown: redirect` failed with
  `Gateway delivery unavailable`.
- Branch run 5: `keeps another server approval through memory reload` reached its
  60-second test timeout.

## Further cache-volume checks

Two focused main runs passed without edits. One request took 1,974 ms against the
unchanged 2,000 ms assertion. A further paired run exercised the same unchanged
case on both revisions alongside the ongoing complete-file runs. Both failed:

- Branch: HTTP 503, `Decision audit unavailable`. The private warning reported
  `access_and_budget`, `decision_unavailable` and 2,013 ms.
- Main: HTTP 200, but the elapsed-time assertion failed at 2,000 ms.

The branch therefore also produces the 503 previously seen on main. These results
show sensitivity to the existing time limit; they do not identify the dependency
behind the original CI refusal. No clock, delay, assertion or deadline was changed.
Logs: `main-cache-1.log`, `main-cache-2.log`, `branch-cache-paired.log` and
`main-cache-paired.log`. Each focused run selects one case and skips the other 27;
these runs do not replace any of the five complete-file repetitions.

## Existing decision error handling

The failed CI case stopped in `permit`, called by `remoteOutcomeFixture`, before
the test configured a simulated gateway 502. The CI log has no private failure reason.

Main run 4 reproduced that generic HTTP 403 in the same `remoteOutcomeFixture`
permission request, in `saves a checked remote response against its consumed permit
once: result`. Its private warning named `access_and_budget`,
`iam_projection_behind` and 1,122 ms. That fixture requests permission before the
test configures its outside response. The public error was exactly
`Request refused or decision service unavailable`.

The existing code explains how a dependency failure can take this path:

1. `libs/authz/src/client.ts` gives an IAM request one second. A failed check returns
   `status: unavailable` and `allowed: false`.
2. `libs/authz/src/members.ts` keeps only `allowed` in the boolean `applied` helper.
3. `libs/models/src/authority.ts` reports `IAM projection behind` for a false receipt.
4. `libs/models/src/decision.ts` can return that ordinary error as generic HTTP 403.

All four files match main. The private label cannot distinguish a missing receipt
from a failed dependency check. It proves neither member removal nor demotion.
This PR did not introduce that conversion, and its internal release helper is not
called by this decision path. The precise dependency failure in the original CI
run remains unproved because that run did not retain the private diagnostic.

The unchanged `decision-refusal.test.ts` checks a permitted resumed caller, injects
an event-read dependency error, and requires the existing generic 403 response with
the private `decision_unavailable` reason. It passed on main and on the branch.
The first branch attempt failed earlier with a gateway `InvalidSignature` 401;
the second attempt passed. The first failure remains FAIL and did not reach the
dependency-error assertion. Logs: `main-refusal.log`, `branch-refusal.log` and
`branch-refusal-2.log` in the same directory.

The generic dependency-error 403 therefore exists without this PR. It is not evidence
that the release helper converted a failure into a `MemberAccessRefused`.

## Release error checks

Test commit `4d7533cd5` strengthens the existing helper tests. No production
change was needed for these assertions to pass:

- A decision or profile history outage returns only `Release unavailable`, without
  a cause. It is not a `MemberAccessRefused`. The attempt checks permission once and
  saves nothing. After the read is restored, a new attempt checks permission again
  and confirms exactly one saved audit with the expected binding.
- A thrown append failure or an unavailable append result is not a
  `MemberAccessRefused`. Read-only recovery still requires the exact saved audit.
  Missing evidence never causes another append.
- Existing removed and demoted member cases retain the original typed refusal,
  including invalid input, failed history and later append errors.

PASS: 20 focused cases against unchanged production code.
PASS twice: all 139 connection-selection/release tests and all 10 release schema
tests, with no skipped cases in either complete run.

PASS: full lint (33 warnings, no errors), full typecheck, `check:events` (157 types),
separate Knip and `lint:changelog`. All commands used `nice -n 10`.

## Scope and remaining work

The only production change under `libs/models` relative to the compared main revision is
the new internal
`credential-release.ts`. Only its test file imports it. The decision handler,
membership and authority checks, both reported test files and their shared fixture
match main. Package versions, lockfile and original test configuration also match.
The shared decision schema adds an optional release binding; existing decision
writers do not supply it.

The existing decision catch handler can return the generic 403 before an attempt
to save an Allow decision. It can return 503 after that attempt, or if saving a Deny
decision fails. The status alone does not identify the failed dependency or prove
that a permission denial occurred.

Forwarding remains closed. No production caller, credential reader, provider call,
lease, budget allocation or charge was added. Full root suite and fresh-install/live
qualification: NOT RUN. CI will not be awaited after pushing.
