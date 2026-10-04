# Issue #136: bounded event-store read retries

Receipt date: 4 October 2026 (UTC). Source: branch `work/i136-read-retry`, based on
main `1354051f9c07135905cd5cde80f27724f37f78eb`; the containing commit supplies the
final source. Environment: shared Linux development host, Node 22.23.3, disposable
R1 NATS/TLS fixtures, PostgreSQL test service at port 55432, OpenFGA and gateway
fixtures. This is source qualification, not a fresh silo install.

## Functional outcome

`head`, `readStream` and subscription read-ahead recover from transient unavailable
errors for at most one second per NATS read. Each request keeps its 250 ms timeout,
and retries use append's 25–500 ms backoff. Permanent service errors still throw
immediately. An earlier caller deadline rejects late replies and stops retries;
subscription aborts stop pending reads and retries.

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
approval single-use race and the bridge's persisted report sequence.

Real NATS requests followed by a controlled 260 ms busy stall reproduced
`TimeoutError` for global head, history metadata, history messages and subscription
read-ahead before the corresponding retry changes. Each recovery slice then passed.
No host load generator was used. The final regressions also cover entity/category
heads, an outage that remains pending at 999 ms and fails at 1,000 ms, a caller
deadline that remains pending at 99 ms and fails at 100 ms, refusal of a late reply,
immediate permanent errors and subscription aborts. The outage/deadline checks use
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

## Source checks

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
and bridge tests against the final source. The 15 opt-in tests remain **NOT RUN**.
The [retained check summaries](i136-read-retry-checks.txt) include the failed batches,
isolated reruns and final root result. Two orphaned NATS fixtures from the earlier
failed runs were stopped after checking their worktree path and absent parent.

The focused command is:

```sh
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres nice -n 10 npx vitest run \
  libs/event-store/test apps/server/test/live-view apps/server/test/approvals.test.ts \
  libs/models/test/gateway apps/server/test/bridge libs/models/test/authority \
  libs/models/test/approvals.test.ts --maxWorkers=2
```

The final root command was:

```sh
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres nice -n 10 npm test -- --maxWorkers=2
```

## Remaining qualification

Fresh-install live journeys, R3 failover, managed-cluster qualification and
independent review are **NOT RUN** by this task. The separate gateway-fixture and
projection-test fixes from the diagnosis are outside this change.
