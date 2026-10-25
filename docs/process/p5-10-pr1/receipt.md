# Two-server realtime proof

Date: 25 October 2026. Part of #15, P5-10 PR 1; D02/D10/D11.
Base: `e063b98f1`. Test-first commit: `da656bbe9`. Source: `001e5da81`.
Environment: two local Node server processes, fresh NATS and OpenFGA fixtures,
and fresh PostgreSQL databases through the test service on port 55432.
This is source qualification, not a fresh packaged installation.

The first checker run used empty checks: 12 rejection cases failed and the valid
case passed. The cases cover repeated processes and ports, missing, duplicate,
reordered or changed delivery, stale-generation acceptance, protected records
around refusal and an incorrect close code. No production defect is claimed by
that failing-first result.

The live test stops the first process and resumes its last accepted position and
generation on the second. A database lock holds the history read while another
change is saved. The checker compares changes before disconnect, during absence,
during catch-up and afterwards. Numeric gaps caused by unrelated events are valid.
It also checks refusal after saved removal/demotion while SQL/OpenFGA lag, closes
on OpenFGA outage, keeps an authorised socket open through unrelated chat activity,
and resets a stale generation after repairing a disposable projection.

Vitest annotations retain process ids, ports, member ids, positions, generations
and close codes. They omit member rows, session values, service credentials and
child output. Cleanup owns only fixture processes, sockets, databases and containers.

## Recorded process outcomes

Second successful run; each pair used fresh shared services.

| Case | First PID / port | Second PID / port | Close codes by connection |
| --- | --- | --- | --- |
| Reconnect | 1422850 / 46073 | 1423067 / 43873 | 1001, 1001 |
| Removal | 1423833 / 35335 | 1424126 / 40941 | 1001, 1008 |
| Demotion | 1424665 / 45037 | 1424907 / 44965 | 1001, 1008 |
| OpenFGA outage | 1425492 / 45031 | 1425745 / 33337 | 1013, 1011 |
| Generation reset | 1426455 / 39075 | 1426828 / 40199 | 1001, 1013, 1001 |

Reconnect received alice at positions 1 and 2, then bob at 3 on the first process.
The second received carol at 4, dan at 5 and erin at 7, all in generation 0.
Position 6 belongs to the unrelated conversation event. Refused reconnects sent
only `refused` at position 2. The outage sent no further member records and no
reply records on the second process. Repair sent `resync` at position 0 in
generation 1, then reloaded alice at positions 1 and 2 in that generation.

## Checks

PASS: 18 changed tests twice; 438 security-rule cases once. Existing production
behaviour passed; no production change was needed. Early fixture identity and
annotation errors were corrected in the test code.

PASS: event catalogue and changelog checks. PASS: all workspace typechecks, with
the server rerun after correcting the Vitest declaration; package and dev-stack
typechecks also passed. The first aggregate typecheck returned a failure for that
declaration before the correction.

PASS: every lint stage, including knip. The first aggregate lint stopped at one
extra README blank line. Documentation and all remaining stages passed after the
spacing fix. Code lint reported 25 warnings in unchanged files and no errors.
Commands use `nice -n 10` and the supplied `PG_TEST_URL`.
The test commands were:

```sh
nice -n 10 npx vitest run apps/server/test/realtime-replicas-check.test.ts \
  apps/server/test/realtime-replicas.test.ts --maxWorkers=1
nice -n 10 npx vitest run apps/server/test/realtime-replicas-check.test.ts \
  apps/server/test/realtime-replicas.test.ts \
  libs/events/test/security-rules.test.ts --maxWorkers=1 --reporter=verbose
```

No full root suite, owner stack or model calls. Fixture cleanup passed; the temporary
NATS directories and both server processes were removed after every case.

## Remaining qualification

NOT RUN: packaged replicas, budget single-writer failover, gateway/live-view/browser/
network isolation and scanner consumers. Full row acceptance still requires P5-5
and P5-6b. This source part needs no dev-stack branch.
