# Packaged event-log readiness

Date: 26 October 2026. Part of #576.
Base: `5557c51ba707bbcfb96b2e510193f9fe44c7519a`.
Tested source: `a0cb1407b446bdae07cd3116faa24bfb46868f50`.

## Cause and remaining limit

The original R3 test failed on reproduction run 05 with
`JetStreamApiError: no suitable peers for placement, peer offline`, from
`EventStore.ensureStream`. Runs 01–04 passed. The fixture had already checked
complete routes and successful `healthz?js-meta-only=true` responses on all peers.
The test ran with another file, two workers and two-CPU affinity. Other real NATS
tests ran alongside it. No service or host network settings were changed.

A snapshot taken immediately after the failed create showed the following:

| Reporting peer | Metadata leader | Other peers reported current |
| --- | --- | --- |
| peer-1 | peer-2 | peer-2 true; peer-3 false |
| peer-2 | peer-2 | peer-1 true; peer-3 true |
| peer-3 | peer-2 | peer-1 false; peer-2 true |

Followers do not track whether every other follower is current. Bootstrap must
read the leader's report. Requiring all followers to report each other as current
was an incorrect intermediate implementation and timed out in two tests.

NATS also needs each placement peer's storage statistics. Its
[placement code](https://github.com/nats-io/nats-server/blob/v2.15.0/server/jetstream_cluster.go#L10228)
uses the same offline refusal when those statistics have not arrived.
[The peer check](https://github.com/nats-io/nats-server/blob/v2.15.0/server/server.go#L407)
requires both configuration and statistics. The metadata report does not expose
that cache. The first loaded run of the new metadata wait still failed with this
same placement refusal. A leader and three current metadata peers are therefore
insufficient to close the whole race.

The source adds the requested bounded metadata check. It creates the stream only
once and preserves every other refusal. A question to the owner asks whether an
explicit placement refusal may be retried within the same deadline. That change
is not authorised yet. The complete flake fix remains PARTIAL; the loaded
acceptance gate is FAIL.

## Failing-first evidence

Test commit `0957ad7ee` preceded the implementation. The new deadline test failed
because provisioning resolved and created a stream when readiness never arrived.
With the wait, it refuses before creating a stream or consumer. Other tests cover
missing peers, missing leaders, offline and lagging peers, duplicate names,
follower reports, standalone R1 and immediate refusal of monitoring access errors.
All replica, owner-setting, consumer-inheritance and incompatible-stream checks
from #725 remain. The new permission checks use real NATS refusals for every
non-command identity and for raw system subjects.

## Environment and commands

This worktree ran `npm ci` and symlinked the requested NATS and Lychee tools.
Tests used disposable TLS NATS processes, separate storage folders and loopback
ports. NATS was version 2.15.0 and Node was version 22.23.3. No dev stack or owner
service was changed. The selected tests do not need PostgreSQL; the requested
`PG_TEST_URL` was supplied to two changed-file confirmation runs and the event
security run. No root or projection suite was run.

All lint, typecheck and tests used `nice -n 10`. The stress runner restricted both
processes to CPUs 0 and 1. Each used `--maxWorkers=2 --fileParallelism`. Bootstrap
ran with `libs/event-store/test/cluster-stream.test.ts` in the same invocation.
A single companion process repeatedly ran the event-store security, provision and
cluster-failover files. A finished companion was replaced while bootstrap continued.
Every numbered result is retained; no failed run is replaced by a passing repeat.
The final confirmation also overlapped the last stress iteration. Twelve orphaned
NATS processes left by the timed-out intermediate implementation were removed
after run 20; the continuous companion load remained in place.

## Results

The [numbered run list](ci-flakes-15-runs.txt) records every stress result.

| Check | Result | Observed result |
| --- | --- | --- |
| Clean install | PASS | `npm ci` completed in this worktree. |
| Changed files twice | PASS | 52 tests passed in each of two runs with the requested PG setting, plus the earlier confirmation. |
| Typecheck | PASS | All workspaces and package/dev-stack tools passed. |
| Event catalogue | PASS | All 154 event names agreed. |
| Event security rules | PASS | All 438 tests passed. |
| Changelog lint | PASS | The branch fragment passed. |
| Documentation lint | PASS | Markdown and privacy checks passed. |
| Full lint including Knip | PASS | Every lint stage passed; the receipt table spacing was fixed and rechecked. |
| Loaded bootstrap batch | FAIL | 28/30 passed; runs 01 and 26 failed at R3 creation. |
| Companion batch | FAIL | 58/69 passed; ten port collisions and one missing-leader assertion. |

Run 01 failed in the original R3 provisioning test. Run 26 failed in the new
readiness test after its synthetic metadata responses became ready. Both reached
real R3 creation and received the same placement refusal. The new test therefore
also remains flaky until the placement-statistics race is resolved.

Companion runs 08, 17, 30, 32, 41, 44, 49, 60, 62 and 64 failed when the unchanged
cluster-failover fixture restarted a peer on a port acquired by another process.
Run 50 failed in that file because `stream.info` had no leader yet; `toMatch`
received `undefined`. All failures remain FAIL. No failed invocation was retried
to change its recorded result. A missing blank line in this receipt's table was
fixed before the successful full lint invocation.

Full root suite, fresh-install Kubernetes qualification and pushed-branch CI are
NOT RUN. The unrelated live-view lease file passed its baseline invocation and
was left unchanged.
