# Checked routine scan dispatch

5 November 2026. Part of #106. Base: `47709d225`. Test-first commit: `5d52472b5`.
Implementation: `182f0f8d6`.

The internal dispatch call connects bounded inspection to the existing due, skip
and daily downtime writers. The [ops contract](../../../apps/ops/README.robot.md#bounded-routine-candidate-inspection)
describes progress, recovery and cancellation. No automatic invocation is registered.

Checks use fresh disposable PostgreSQL 17.6, NATS and OpenFGA, with controlled time.
The database uses a dynamically allocated loopback port; no owner stack is touched.
All lint, typecheck and test commands run under `nice -n 10`, with one test worker.
The first regression failed because scanning saved no due. Its implementation keeps
one occurrence and its original expiry after a lost reply, restart and dedupe expiry.

| Check | Result |
| --- | --- |
| Focused scan and dispatch tests twice | PASS: 41 tests on each run |
| Unchanged security rules once | PASS: 460 tests |
| Lint, typecheck, event catalogue, Knip, changelog | PASS |
| Full root suite and fresh-install journey | NOT RUN |

Local logs: `/tmp/p4-24-pr8f-*.log`. Weekly downtime writing, ticks, process
configuration and execution remain outside this change. No paid calls or new dependencies.
