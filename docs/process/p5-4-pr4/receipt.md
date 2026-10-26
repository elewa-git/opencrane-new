# Recorded package connection checks

Dates: 25–26 October 2026. Part of #15, P5-4 PR 4, first part.
Base: `2fed5714f`. Implementation: `592515e6f`.
Failing-first test commit: `4503890f0`.
Environment: separate worktree, Node 22.23.3, fresh `npm ci`, disposable command
fixtures, real Helm renders and the merged three-process NATS fixture.
No development stack or model call was started. No host network setting changed.

The five initial regressions failed before implementation. They showed private
preparation and forwarding using the shared cluster, Helm accepting a changed
connection, and cleanup consulting the shared cluster after losing its target.

This part keeps one checked connection through preparation, forwarding, Helm and
cleanup. R3 installation remains refused. The next part must validate prepared
identities and eligible nodes, wire the replica choice through bootstrap and
runtime settings, and promote new runtime bytes through digest and licence checks.
An existing runtime image cannot prove code added in that next part.

| Check | Result |
| --- | --- |
| Failing-first regressions | PASS — five expected failures before implementation |
| Changed tests twice | PASS — 38 claim, 12 chart and 19 route cases; serial repeat below |
| Real Helm, CNPG guards and default R1 | PASS — 126 CNPG checks after the correction below |
| Merged NATS cluster fixture and event security rules | PASS — 454 tests |
| Typecheck, event catalogue, Knip and changelog | PASS |
| Full lint | PASS — existing warnings only |
| Live three-node placement | NOT RUN — complete checked R3 installation is blocked |
| Certificate rotation | NOT RUN |
| Kubernetes node failure and rejoin | NOT RUN |
| Complete R3 bootstrap and runtime image promotion | NOT RUN — deferred to the next part |
| Full root suite | NOT RUN — outside this scoped task |

The tests use synthetic ownership records and temporary command executables.
They do not prove live Kubernetes scheduling or storage placement.

The NATS run used a throwaway PostgreSQL 17.6 container with `PG_TEST_URL` set to
its mapped loopback port. The container and its volume were removed afterwards.
The cluster fixture requires a leader and two current replicas. Conditional append,
stale-position refusal, non-writer publication refusal and R1/R3 mismatch without
mutation passed. These process checks do not establish Kubernetes node placement.

Commands used `nice -n 10`. No full root suite ran. The package regression command
selected claim, chart, chart-render, preflight, CNPG installer, fresh-twice and route
preparation files. The changed-file repeats select claim, chart and route preparation.
The event check selects only `cluster-routes.test.ts` and `security-rules.test.ts`,
with one worker. Lint uses a 6 GiB Node heap. Two extra blank lines found by the
first documentation check were removed; its repeat passed.

The broad package run initially returned FAIL: 281/282 passed. Its foreign-context
CNPG case expected the existing ownership-refusal error. The new target comparison
returned a different fixed error first. Ownership fields now refuse before the
namespace lookup. The unchanged CNPG installer file then passed all 126 cases.
A further 31 ownership and forwarding checks passed against that correction.

The first changed-file run passed 69/69. An additional ownership run overlapped
the second repeat. Both used the launcher's shared host lock; its non-blocking
claim correctly skipped a busy slot. Four fixture assertions failed because they
expected slot 1. This was a test-execution mistake. The failed run remains FAIL;
the serial claim repeat passed 38/38, without changed assertions or lock behaviour.
The other 31 cases passed again in the second run. Each changed test therefore
has two passing runs. [Check summaries](checks.txt) retain the failed attempts too.
