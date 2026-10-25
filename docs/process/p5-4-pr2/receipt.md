# Three-peer NATS render receipt

Date: 25 October 2026. Source base: `772cc910d`; failing-first tests:
`614254839`. The implementation is the commit containing this receipt.
Environment: Linux, Node 22.23.3, Helm 3.19.1 and pinned NATS 2.15.0, disposable local
fixtures. No fresh Kubernetes installation or image promotion was attempted.

| Check | Expected and observed result | Status |
| --- | --- | --- |
| Failing-first Helm tests | New cluster requirements fail before implementation: 10 failures; default and installer refusals still pass | PASS |
| Final package tests, twice | 31 checks pass on each run, including pinned NATS parsing and installer refusal | PASS |
| TLS and account refusals | Existing cluster and client security suites pass, including plaintext and untrusted-certificate refusals | PASS |
| Security field rules | Unchanged security-rules suite passes; 481 tests pass across the three security files | PASS |
| Lint, typecheck, event catalogue, Knip and changelog | All requested gates pass; the catalogue agrees on 153 event types | PASS |
| Three-node placement and separate live PVCs | Rendered rules only; no Kubernetes placement measured | NOT RUN |
| R3 provisioning and bootstrap | Ordinary installer refuses; R1 bootstrap omitted from the cluster render | NOT RUN |
| Certificate rotation | No live certificate replacement attempted | NOT RUN |
| P5-5 node loss and rejoin | No node stopped or restarted | NOT RUN |

The three StatefulSets each request one peer and one persistent claim. Required
node anti-affinity prevents scheduling them together. The private discovery Service
publishes named peer addresses before readiness. A disruption budget requests two
available peers during voluntary eviction. These are rendered Kubernetes rules,
not evidence that an event stream has three copies or survives disruption.

Each peer mounts only its own route identity and the separate public route trust.
The packaged cluster configuration must match the shared source exactly. Its client
TLS and account policy still comes from the existing NATS configuration Secret.
Offline checks cannot inspect real Secret contents or establish issuer custody.
Future provisioning must verify those prerequisites before installation is enabled.

P5-4 qualification remains PARTIAL. Three-node placement, R3 bootstrap, rotation
and P5-5 remain NOT RUN. Later single-host k3d checks cannot prove resilience across
real zones or physical machines.

The package checks used:

```sh
nice -n 10 node --experimental-strip-types --test \
  infra/package/chart-render.test.mjs infra/package/preflight.test.mjs \
  infra/package/chart.test.mjs
```

The security checks used a throwaway PostgreSQL 17.6 fixture with `PG_TEST_URL`
set to its loopback connection. The container and its volumes were removed after:

```sh
nice -n 10 npx vitest run libs/event-store/test/cluster-routes.test.ts \
  libs/event-store/test/security.test.ts libs/events/test/security-rules.test.ts \
  --maxWorkers=2
```

No full root suite, dev stack or model call ran. The
[Helm assertions](../../../infra/package/chart-render.test.mjs) and
[TLS assertions](../../../libs/event-store/test/cluster-routes.test.ts) are the
repeatable source evidence. CI is not awaited by this builder.
