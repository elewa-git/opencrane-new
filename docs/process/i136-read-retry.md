# Issue #136: bounded event-store read retries

Receipt date: 4 October 2026 (UTC). Source: branch `work/i136-read-retry`, based on
main `1354051f9c07135905cd5cde80f27724f37f78eb`; the containing commit supplies the
final source. Environment: shared Linux development host, Node 22.23.3, disposable
R1 NATS/TLS fixtures, PostgreSQL test service at port 55432, OpenFGA and gateway
fixtures. This is source qualification, not a fresh silo install.

## Functional outcome

`head`, `readStream` and subscription read-ahead recover from transient unavailable
errors for at most one second per NATS read. Each request keeps its 250 ms timeout,
and retries use jittered exponential backoff capped at 500 ms. Permanent service
errors still throw immediately. An earlier caller deadline rejects late replies and stops retries;
subscription aborts and the first failed batch read stop sibling reads and retries.

The existing live-view 1,200 ms check and 1,500 ms lease, two-second authority
snapshot, gateway and approval bounds remain. Their credential, policy, membership,
fence and approval-history reads share the existing deadline. Failed reads grant no
permission and renew no lease. Append still has its ten-second retry budget.

The approval race proves exactly one 200 response, one refused/unavailable loser,
one forwarded request and one `approval.used`. The bridge recovery poll treats
unavailable reads as not yet ready and reconnects after close code 1011; it still
requires report sequences `[1, 2, 3, 4]`.

## Tests first

Confirmed seams: the public event-store read methods, caller deadlines, the
approval single-use race, the bridge's persisted report sequence and the WebSocket
viewer lease and denial behaviour.

Real NATS requests followed by a controlled 260 ms busy stall reproduced
`TimeoutError` for global head, history metadata, history messages and subscription
read-ahead before the corresponding retry changes. Each recovery slice then passed.
No host load generator was used. The final regressions also cover entity/category
heads, an outage that remains pending at 999 ms and fails at 1,000 ms, a caller
deadline that remains pending at 99 ms and fails at 100 ms, refusal of a late reply,
immediate permanent errors and subscription aborts. The reviewed late-reply test
now receives the SDK reply before a 150 ms stall crosses its 100 ms caller deadline;
the SDK timeout has already been cancelled. The outage/deadline checks use
a controlled clock; only the NATS boundary and external promise timer are intercepted.

An intermediate integration run was **FAIL**: 218 passed, 2 failed, 5 skipped.
It used cached pre-abort adapter code for the new abort test and exposed the changed
authority-expiry error message. The final adapter stops abort retries, and authority
expiry retains its existing error message with the store error as its cause.

The next integration run was also **FAIL**: 217 passed, 3 failed, 5 skipped.
The failures were a dispatcher-fixture JetStream heartbeat miss, an approval 503
instead of 200, and `Gateway stopped` during fixture startup. The affected approval
cases passed in isolation (4 tests), as did the gateway case (1 test). Their original
assertions remain. These results do not turn the failed batch into a pass.

## Initial source checks

All lint, typecheck and test commands run under `nice -n 10`. Tests use
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres` and `--maxWorkers=2`.
The root suite starts only after the integer part of `/proc/loadavg` is below 16
and no live-view qualification batch is running.

| Check | Result | Evidence |
| --- | --- | --- |
| Event-store regression and append checks | PASS | 27 tests; `/tmp/i136-store-final.log` |
| Final lint | PASS | All lint checks; existing size warnings only; `/tmp/i136-lint-final.log` |
| Final typecheck | PASS | Every workspace; `/tmp/i136-typecheck-final2.log` |
| Event catalogue | PASS | 86 event types agree; `/tmp/i136-events.log` |
| Focused integration batch | FAIL | 217 passed / 3 failed / 5 skipped; `/tmp/i136-focused-final.log` |
| Failed-case reruns | PASS | 5 tests; `/tmp/i136-approval-failures.log`, `/tmp/i136-gateway-failure.log` |
| Full root suite | PASS | 1,486 passed / 15 skipped; 89 files passed / 4 skipped; 1,571.07 s |

The root run started at 18:18:19 UTC with load 9.74 and no live-view qualification
process running. It covers all requested event-store, live-view, approval, gateway
and bridge tests against the initial source. The 15 opt-in tests remain **NOT RUN**.
The [retained check summaries](i136-read-retry-checks.txt) include the failed batches,
isolated reruns and final root result. Two orphaned NATS fixtures from the earlier
failed runs were stopped after checking their worktree path and absent parent.

The focused command is:

```sh
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres nice -n 10 npx vitest run \
  libs/event-store/test apps/server/test/live-view apps/server/test/approvals.test.ts \
  libs/models/test/gateway apps/server/test/bridge libs/models/test/authority \
  --maxWorkers=2
```

The final root command was:

```sh
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres nice -n 10 npm test -- --maxWorkers=2
```

## Remaining qualification

Fresh-install live journeys, R3 failover and managed-cluster qualification are
**NOT RUN** by this task. The first independent review identified the late renewal
regression; verification of the review fixes is pending. The separate gateway-fixture
and projection-test fixes from the diagnosis are outside this change.

## First-review fixes

The late renewal regression is fixed at the view-access boundary: any error handled
at or after the shared 1,200 ms deadline is `ViewCheckUnavailable`. An error before
that deadline keeps its existing classification. A missed check grants no extra
lease time; a timely explicit denial still closes the viewer.

The WebSocket regression uses a controlled clock at the final event-store fence
reply to model the reply being handled after the deadline, before the overdue timer.
It failed with a closed viewer before the fix and passed after it. The existing
explicit OpenFGA denial control passed in both runs and requires closure within one
second, stricter than the requested two-second bound.

The sibling-read regression failed before batch cancellation: 64 initial reads grew
to 379 after the subscription had already failed. It passes with a per-batch abort
controller. Read retries now use jitter to spread concurrent requests. The late
reply regression failed when the after-reply deadline guard was temporarily removed:
the read returned sequence 1 instead of throwing. The guard was restored before
qualification. Timer and abort handling now use `Promise.withResolvers`; TypeScript
includes Node 22's Promise declarations without changing the language target.

Approval reads use a named options object for their clock and deadline. The shared
view check constant, retry explanation, wrapped lines, CHANGELOG and PARTIAL ledger
status address the remaining review fixes.

The review-fix focused batch was **FAIL**: 129 passed, one failed and one skipped
across 12 files. The authority-volume test measured p95 1,013.18 ms against a
1,000 ms assertion while shared-host load was above 16. The viewer regression,
explicit denial control, event-store, approval, bridge-channel and other authority
tests passed. The timing assertions remain unchanged.

| Review-fix check | Result | Evidence |
| --- | --- | --- |
| Focused batch | FAIL | 129 passed / 1 failed / 1 skipped; `/tmp/i136-review-focused.log` |
| Lint | PASS | Existing size warnings only; `/tmp/i136-review-lint-final.log` |
| Typecheck | PASS | Every workspace; `/tmp/i136-review-typecheck-final.log` |
| Event catalogue | PASS | 86 types agree; `/tmp/i136-review-events.log` |
| First full root suite | FAIL | 1,486 passed / 2 failed / 15 skipped; `/tmp/i136-review-root.log` |
| Failed-case reruns | PASS | Three tests; `/tmp/i136-review-reruns.log` |
| Final full root suite | PASS | 1,488 passed / 15 skipped; `/tmp/i136-review-root-final.log` |

The review-fix root suite started at 19:59:01 UTC with load 15.63, after the focused
batch finished and with no live-view qualification process running. It uses the
same PostgreSQL URL, `nice -n 10` and `--maxWorkers=2` as the initial run.

The review-fix root run failed after 1,612.61 seconds: 87 files passed, two failed
and four were skipped. The approval case had no card to decide after its unchecked
opening call. The gateway budget race returned `[403, 200, 402, 402, 402, 402, 402,
402]`, so only six of seven refusals had the required 402 status. No assertion was
changed. The new viewer and sibling-cancellation regressions passed, as did the
unchanged authority-volume test. The 15 opt-in tests remain **NOT RUN**.

All three failed cases passed on an unchanged-source rerun: the approval case,
the monthly budget case and authority-volume latency. The rerun began at
20:29:36 UTC with load 15.46 and passed three tests in 92.96 seconds. This does
not turn the earlier failed batches into passes.

The final full-root rerun was **PASS**: 1,488 passed and 15 skipped across 89 passing
files and four skipped files, in 1,406.81 seconds. It started at 20:32:29 UTC with
load 13.27 and no live-view qualification process running. It used the supplied
PostgreSQL URL, `nice -n 10` and `--maxWorkers=2`. All requested event-store,
live-view (all three files), approval, bridge-channel and authority tests passed
in this run. The 15 opt-in tests and fresh-install qualification remain **NOT RUN**.
The [retained summaries](i136-read-retry-checks.txt) preserve the failed batches,
passing reruns and final green root run.

## Rebase onto main — 4 October 2026

Rebased both commits ending at `0bf54c2` onto `089fa31`. This includes
PRs #139, #142, #140 and #145. Git completed the rebase and restored
`work/i136-read-retry`.

- `apps/server/src/chat/approvals.ts`: kept #142's CSRF and projection comments,
  step-up helper and named 300-second constant unchanged. Kept #136's shared
  authority deadline for history reads and named options objects for card and
  approval reads.
- `apps/server/src/computers/view-access.ts`: kept #139's `ViewCheckUnavailable`
  boundary labels and #145's denial-first `Promise.allSettled` decision order.
  Kept the shared `viewCheckMs = 1200` and deadline propagation through histories
  and fences. Replies handled at or after the deadline are unavailable with the
  `deadline` boundary; earlier store outages retain `event_store`, and earlier
  authorisation outages retain `authorisation`. Timely denials remain denials.
- `apps/server/src/computers/view.ts`: kept every #139 timing record and boundary
  field. The named timeout callback uses the shared constant and reports the
  `deadline` boundary. The 1,500 ms lease and every admission fence are unchanged.
- `CHANGELOG.md`, `ledger.md` and `benchmarks.jsonl`: retained the union of both
  tips' entries. Removed only the obsolete intermediate #136 changelog wording
  that Git had retained beside its final replacement.

The late-fence regression now covers both the exact deadline and one millisecond
later, and checks that the renewal timing record reports `unavailable` at the
`deadline` boundary. No existing assertion or timing bound was relaxed.

Rebase source checks on `089fa31`: lint, typecheck and `check:events` **PASS**
(86 event types). The final requested integration batch **PASS**: 14 files and
135 tests passed; one file and three opt-in tests skipped. Every command used
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres` and `nice -n 10`;
the integration batch used `--maxWorkers=1`.

The initial lint run rejected two Markdown layout issues in this note; both were
fixed. The initial integration batch was **FAIL**: 134 passed, one failed and
three skipped. The authority-volume test received MCP HTTP 403 instead of 200.
It passed unchanged in isolation, then the entire unchanged batch passed.
The [retained summaries](i136-read-retry-checks.txt) include all three test runs.
The two `LIVE_VIEW_K3D` tests and the `APPROVAL_BROWSER` test remain **NOT RUN**.
No full root suite or fresh-install journey was rerun for this rebase.

Main advanced during qualification with #148. The follow-up rebase onto
`b5e7d0e` completed without conflicts. A Git diff confirmed that every tested
server source file, library file and selected server test was unchanged from the
fully passing batch; #148 changes the frontend used by the live-view proxy test.
The union check also passed against this newer main tip.

Final checks on `b5e7d0e`: lint, typecheck and `check:events` **PASS**; both
live-view frontend proxy cases **PASS**. These follow-up checks use the same
PostgreSQL URL and CPU priority. The containing commit supplies the final source.
