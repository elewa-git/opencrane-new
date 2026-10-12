# Native CONNECT routing receipt

Date: 12 October 2026. Source base: `f2f6049a`; failing-test commit: `3e8d9ab8`.
Final source is the accompanying branch diff. Environment: Linux x86_64,
Node 22.23.3, a clean worktree install, disposable NATS and a recording loopback
relay. This is an integration fixture, not a fresh customer silo.

Gateway: agentgateway v1.5.0, revision
`fe6732474a96a0363dfb9822859af4e9bab360fa`, binary SHA-256
`daca5cda76e8c5ab0c1a75912fecf2d6365095403f810db72029c49d14a37e7b`.
`startGateway` checks that digest before every launch. No image was built or deployed.

Scope: first part of #61 PR 2. The full route, guarded public sockets and receipts
need more than the requested 600-line budget. This part proves native routing and
reuses the existing final send gate; production startup keeps egress disabled.
Planning estimate for the full row: about 900–1,200 handwritten lines with its
security tests. The guard and its receipts need a follow-up before worker work.
The accepted [design](../specs/phase-3/p3-20-p3-21-egress.md) still governs the rest.

The first test run after fixture setup was corrected failed eight assertions:
CONNECT returned 405 instead of reaching JWT/extAuthz and the recording relay.
The tests were committed before implementation. The final tests require this order:
extAuthz, saved decision, saved final send permission, relay connection, payload.
They read the saved decision and dispatch events from real NATS.

Expected and observed: caller tokens and identity canaries never occur in the
relay's exact payload. A repeated permit makes only one relay connection. A saved
revoke or spending stop before final admission produces zero relay connections
and zero upstream bytes while retaining the earlier decision. Failed audit or
final-check responses, missing relay metadata and a non-loopback relay likewise
produce zero upstream bytes. Expired tokens save no admission. Normal startup
returns 405 for CONNECT. No assertion treats an open tunnel as a completed task.

All checks ran under `nice -n 10`. Tests used
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres` and at most two workers.

| Own check | Result |
| --- | --- |
| Clean `npm ci`; requested NATS and Lychee symlinks | PASS |
| `npm run lint`, including knip, docs, links and fixture checks | PASS; no errors |
| `npm run typecheck`; latest models typecheck and changed-file ESLint | PASS |
| `npm run check:events` | PASS; 127 event types agree |
| `npm run lint:changelog` | PASS |
| Focused egress, gateway, startup, dispatch and actor regressions | PASS; 138 tests |
| Paid provider test in that run | NOT RUN; one test skipped |
| Final changed egress tests, first run | PASS; 23 tests |
| Final changed egress tests, second run | PASS; 23 tests |
| Full root test suite | NOT RUN; excluded by the task |

Safe summaries: the test assertions and result counts above. Local command output
is in `/tmp/p3-20-pr2-{lint,typecheck,tests-1,changed-tests-1,changed-tests-2}.log`.
These files contain check output, not raw gateway traffic. The unchanged authority
tests were not edited or run as part of this limited route qualification.

The following remain NOT RUN: production capability admission; DNS pinning and
mixed/rebound answers; the complete forbidden destination/protocol matrix; TLS SNI;
expiry/revocation/outage closure of active sockets; durable outage observations;
fresh gVisor journeys; Helm/HA. The raw Host header is removed before extAuthz, so
authority/Host disagreement needs a separate proof or the accepted broker fallback.
No command worker, browser or route in the running stack was enabled.
