# Packaged event-log readiness

Date: 26 October 2026. Part of #576.
Rebased onto `f19d0db406e71e104b721849133cb0135ee7da6a`.
Test commit: `78236e67f` (previously `b1a66f8a4`).
Implementation: `dcc4601f4` (previously `708c6cf1a`).
Clock-fixture correction: `158bca94a`.

## Cause and fix

The metadata leader can report three current peers before receiving each peer's
storage statistics. NATS then refuses R3 stream creation with
`no suitable peers for placement, peer offline`. Metadata readiness alone did
not close this race: the earlier loaded batch passed 28/30, with failures on
runs 01 and 26. The earlier numbered results remain in the
[complete run list](ci-flakes-15-runs.txt).

The owner authorised a retry of this explicit placement refusal. Bootstrap now
requires a `JetStreamApiError` with status 400, code 10005 and the exact
peer-offline placement description before retrying. Only R3 stream setup uses
this retry. The backoff is 200 ms, shortened only at the deadline. Metadata
readiness and placement share the original 120-second deadline. A refused
placement at expiry reports a fixed error, closes the connection and adds no
consumer. The public bootstrap log names the placement refusal and expired limit
without printing the dependency error or private settings.

All other creation errors fail immediately. These include timeouts, lost replies,
other JetStream codes and statuses, matching text without a JetStream code, and
other placement refusals such as insufficient storage. R1 is never retried.
Every replica, owner-setting, consumer-inheritance and incompatible-stream check
from #725 remains. No access, money or memory check was changed.

## Failing-first checks

The test commit preceded production changes. The focused red run failed the
placement-recovery and shared-deadline tests; seven other-error and R1 checks
passed. The earlier full red run also reproduced the original R3 placement race.
That first run found an R1 test setup error: its fixture had already created the
stream. The committed test uses an empty fixture, and its focused red check
passed before implementation.

The new tests inject refusals at the NATS request boundary and retain real
TLS NATS peers. Recovery must create an R3 stream with one inherited dispatcher
consumer. The expiry test spends 119,800 ms of its injected clock on metadata
readiness, then verifies that a placement refusal uses only the remaining 200 ms.
It asserts one creation attempt, no stream and no private files. Other-error and
R1 checks assert one attempt, no backoff and no stream.

The first new stress batch exposed a fixture problem on run 12. Its injected
clock advanced through 120 seconds while real NATS still lacked placement
statistics. Bootstrap correctly refused, so the test could not reach its intended
recovery checks. The batch stopped after active runs finished: 12/13 bootstrap
runs and 28/28 companion runs passed. Those results remain in the run list.
The fixture now prepares real placement statistics, deletes its setup stream and
asserts that the account is empty before either synthetic-clock success test.
The exact attempt-count, elapsed-time, replica and consumer assertions remain.
The ordinary R3 test still starts without that preparation and uses real time.

## Environment and commands

The direct SDK import required a root development-dependency declaration.
Knip found the missing declaration in the first lint run. The fix declares the
already installed `@nats-io/jetstream` 3.4.0; its package and licence file both
state Apache-2.0. No SDK version or runtime image changes. Full lint then passed.
A clean `npm ci` and two fresh changed-file runs follow the fixture fix.

Tests use disposable NATS processes, private storage directories and loopback
ports. Node is 22.23.3 and NATS is 2.15.0. No dev stack, owner service, Docker daemon
or host network setting was changed. The selected files do not use PostgreSQL;
they receive the requested
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.

Changed-file confirmations run under `nice -n 10`:

```sh
npx vitest run infra/package/bootstrap.test.ts \
  libs/event-store/test/security.test.ts --maxWorkers=2 --fileParallelism
```

The loaded batch runs bootstrap with `libs/event-store/test/cluster-stream.test.ts`
in the same invocation. One other process continuously runs the event-store
`security.test.ts`, `provision.test.ts` and `append.test.ts` files. Both processes
use `nice -n 10`, CPUs 0 and 1, `--maxWorkers=2` and `--fileParallelism`. Each
invocation has its own text log and JSON result. A finished companion is replaced
while bootstrap continues; the final companion finishes before results are counted.
The new batch does not select the unrelated cluster-failover tests that failed
in the earlier companion batch.

The final batch paused between bootstrap invocations 02 and 03 for the second
rebase. Both active fixtures finished before files changed. Bootstrap source,
its test file and the NATS helpers had identical Git content hashes before and
after the rebase. Only unrelated upstream files and the merged package guides
changed. The batch's original source label is `c89b624cf`; the same tested content
is now at `158bca94a`. The pause is included in two parent-process wall times.
All numbered invocations are retained, and no bootstrap test ran between them.

## Results

The [complete numbered run list](ci-flakes-15-runs.txt) retains the original
batch, the stopped batch and the final batch. Logs and JSON reports are in
`/tmp/ci-flakes-15-fix1/`; the final batch uses its `qualified/` directory.

| Check | Result | Observed result |
| --- | --- | --- |
| Clean install | PASS | `npm ci` completed after the SDK declaration. |
| Changed files twice | PASS | 61 tests passed in each run after the fixture correction, with the requested PG setting. |
| Full lint including Knip | PASS | Every stage passed again after the final rebase; code lint reported no errors. |
| Typecheck | PASS | Every workspace and package/dev-stack tool passed after the final rebase. |
| Event catalogue | PASS | All 154 event names agreed after the final rebase. |
| Changelog lint | PASS | The branch fragment passed after the final rebase. |
| Final loaded bootstrap batch | PASS | All 30 consecutive invocations passed, with 35 tests each. |
| Final companion batch | PASS | All 61 invocations passed, with 58 tests each. |
| Loaded batch before fixture correction | FAIL | 12/13 bootstrap runs passed; run 12 exhausted the synthetic clock while real statistics were missing. All 28 companions passed. |

No assertion was loosened. The deadline remains 120 seconds, shared by metadata
readiness and R3 placement. The original replica and refusal checks still pass.

The earlier batch remains FAIL: bootstrap passed 28/30 and its companion passed
58/69. Ten companion failures were restart-port collisions; one was a missing
leader assertion. No earlier failure has been removed or relabelled.

Full root suite, fresh-install Kubernetes qualification and pushed-branch CI are
NOT RUN. Image promotion, controller and storage checks, and live Kubernetes
placement remain outside this source fix.
