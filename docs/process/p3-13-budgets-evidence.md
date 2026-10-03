# P3-13 — Monthly budget evidence

3 October 2026; `work/p3-13-budgets`, base main `17c61d3` plus the change
containing this receipt. Node 22.23.3, Linux x86-64. Fixtures use fresh disposable
NATS streams, PostgreSQL databases, OpenFGA stores and agentgateway state with a
scripted SSE provider. PostgreSQL uses
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
The shared dev stack was not changed. No paid calls, new dependency, push or deployment.

## Why and functional outcome

Issue #54 extends the existing fenced actor so monthly EUR spending checks global,
paying-group and optional assistant ceilings atomically. One reservation and one
settlement count towards every applicable ceiling; the daily safety cap remains.
Personal work binds the explicit installation default at admission; shared work
needs an existing local selected group and current requester membership. Retries retain their admitted attribution. Month/day
rollover keeps outstanding and uncertain reservations. Late usage retains its
original group, tariff and period. Owner/Admin can read and configure ceilings in
Models & budgets at 1280px and 390px. Verified budget refusals appear in chat
with an Owner/Admin or next-period action and survive replay.

## Architecture

The actor's existing serial queue and expected-stream-sequence fence cover
configuration, reservation, settlement and monthly timer commands. Each command
appends once to `budget-<silo>`; PostgreSQL holds the replayable fold only.
Configuration uses a 30-second command capability bound to the exact request,
with Origin/session checks at the server and live role/event/freshness checks
before the actor append. A stale editor receives 409. Unknown save outcomes require
a status read. Hosted provider tools remain disabled; reviewed non-metered MCP
calls require an explicit zero-cent price. There is no price editor or FX subsystem.

## Evidence and gates

Test-first failures demonstrated the missing actor configuration/period methods,
missing paying-group admission binding, missing POST route, missing UI and missing
explicit tool prices. Focused green runs exercise the same public interfaces.

| Command or journey | Result |
| --- | --- |
| `npm ci` | PASS, lockfile install |
| Real gateway concurrent reservations at each monthly ceiling | PASS, exactly one dispatch and one charge per race |
| Exact UTC month boundary, late usage, retained uncertainty, failover and PostgreSQL replay | PASS |
| Personal admission/retry; shared missing, invented, foreign and unauthorised group refusal | PASS |
| Owner/Admin configuration, member/foreign/Origin refusal, integer validation, retry, editor race and replay | PASS |
| `npm test -w apps/web -- --watch=false` | PASS, 8 files / 46 tests on final source |
| `npm run check:events` | PASS, 75 matching event types |
| `npm run lint` | PASS, all checks; existing warnings only |
| `npm run typecheck` | PASS, all workspaces |
| `npm run build -w apps/web` | PASS, existing size warnings |
| Independent source review | PASS after two passes; shared-group authority, launcher compatibility and refusal display verified |
| Authenticated configuration and chat refusal display in Chromium, 1280/390px | PASS in full root run |
| `PG_TEST_URL=… npm test -- --maxWorkers=2` | PASS, 66 files / 1,051 tests; 2 files and 10 opt-in tests skipped |
| Earlier gateway timing failures, rerun in isolation | PASS, both cap races and reviewed-tool revocation; 3 tests |
| Shared-stack or managed-cluster fresh install, paid provider and live cluster opt-in journeys | NOT RUN |

The root suite reuses the existing actor fencing, lost acknowledgements, streamed
usage, duplicate/conflicting/late usage, unknown tariffs, daily cap, token checks
and OpenFGA refusal vectors. The monthly races use two simultaneous callers on a
fresh fixture; no freshness bound is relaxed. The first full run exposed fixture/schema issues and busy-host timing failures;
those were repaired. The next run passed 1,050 tests with one subprocess that
read a schema export during edits; its isolated rerun passed. The settled-source full run passed all 1,051 enabled tests. Earlier gateway
timing cases are also rerun alone; the gate table records their outcome.

The Chromium journey checks authenticated configuration, no horizontal overflow
and 44px controls. Screenshots show [1280px](evidence/p3-13/budgets-desktop.png)
and [390px](evidence/p3-13/budgets-390.png). Screenshots come from the final authenticated Chromium journey.

## Not in this change

Phase 4 group administration, descendant/delegation orchestration, P3-14 hard-stop
cascades and P3-15 evidence-based uncertainty resolution remain separate. Existing
unknown reservations stay held. This receipt makes no shared live-stack or
managed-cluster qualification claim.
