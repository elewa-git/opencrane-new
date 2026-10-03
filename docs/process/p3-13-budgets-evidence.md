# P3-13 — Monthly budget evidence

3 October 2026; `work/p3-13-budgets`, base main `17c61d3` plus the change
containing this receipt. Node 22.23.3, Linux x86-64. Fixtures use fresh disposable
NATS streams, PostgreSQL databases, OpenFGA stores and agentgateway state with a
scripted SSE provider. PostgreSQL uses
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
The initial source checks below used disposable fixtures; final secondary-stack
qualification is recorded at the end. No paid calls, new dependency or push.

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
| Independent source review | PARTIAL: latest pass 1 found two upgrade blockers; fixes below, independent pass 2 NOT RUN |
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

## Upgrade blockers from independent review pass 1

3 October 2026; base `65b0ff5` plus this corrective change, same disposable
fixture environment and PostgreSQL test URL as above. No shared-stack operation,
paid provider call, dependency addition, push or deployment.

Each blocker had its failing upgrade test run before its fix:

- Existing budget startup: the recovered actor had no default paying group.
  The fix makes one conditional `budget.ceiling_set` append using the existing
  global ceilings, at startup under leadership and through the migration
  command wired into `up.sh`. Startup and command tests preserve daily, monthly,
  group and assistant ceilings, retain an existing default, append the default
  once across restarts and admit a personal chat turn.
- Legacy projection attribution: the running projection showed 0 reserved and
  0 settled group cents against the actor's 25 reserved and 9 settled cents.
  The budget worker now checks projection version 2 and rebuilds from events
  using the replay runner and an atomic shadow-table replacement. The test
  checks actor/projection global and group totals before and after verified
  operator replay, one generation increase for the repair and none on restart
  or equal replay. Both pending and settled legacy calls omit the paying group
  inside `modelCall`, as they did before this feature.

Focused validation: **PASS**, 13 tests across
`apps/server/test/models-main.test.ts` and `apps/ops/test/replay.test.ts`.

| Corrective-change check | Result |
| --- | --- |
| `npm run lint` | PASS, existing warnings only; final docs/link checks repeated after this receipt |
| `npm run typecheck` | PASS, all workspaces; ops repeated after the replay dispatch cleanup |
| `npm run check:events` | PASS, 75 matching event types |
| `PG_TEST_URL=… npm test -- --maxWorkers=2` | PASS, 66 files / 1,054 tests; 2 files and 10 opt-in tests skipped; 560 seconds |
| `npm run build -w apps/web` | PASS, existing size warnings |
| `npm run test -w apps/web -- --watch=false` | PASS, 8 files / 46 tests |
| Timing failures requiring isolated reruns | None in this run |

Safe local logs are `/tmp/p3-13-upgrade-{lint,typecheck,test,web-build,web-test}.log`
and `/tmp/p3-13-upgrade-ops-typecheck.log`. The first lint run rejected a CLI
complexity of 16; a command map replaced the dispatch chain and the rerun passed.
Independent review pass 2 and live fresh-silo upgrade qualification: **NOT RUN**.

## Not in this change

Phase 4 group administration, descendant/delegation orchestration, P3-14 hard-stop
cascades and P3-15 evidence-based uncertainty resolution remain separate. Existing
unknown reservations stay held. This receipt makes no owner-stack or
managed-cluster qualification claim.

## Final PR qualification

3 October 2026; review pass 2 was **LAND** at `86be76f`. A clean rebase onto
`origin/main` (`cc8d8c0`) completed without conflicts; the product changes are now
`f2e4e40` and `1a6e43e`, plus the journey fixes and evidence in this commit.
The live fixes below follow that reviewed revision; no third independent review
pass was run.
Environment: Linux x86-64, Node 22.23.3, k3d `ocn`, claimed secondary stacks only.
Zitadel management stayed within organisation `393311211338337681`. Model traffic
used the local SSE stub; no OpenAI key was loaded and no paid call was made.

| Final source check | Result |
| --- | --- |
| `npm run lint` | PASS, all checks; existing warnings only |
| `npm run typecheck` | PASS, every workspace |
| `npm run check:events` | PASS, 75 matching event types |
| `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test -- --maxWorkers=2 --testTimeout=20000 --retry=1 --reporter=verbose` | PASS, 66 files / 1,058 tests; 2 files / 10 opt-in tests skipped; 629 seconds; no retries used |
| `npm run build -w apps/web` | PASS, existing size warnings |
| `npm run test -w apps/web -- --watch=false` | PASS, 8 files / 46 tests |
| Infra TypeScript and shellcheck | PASS |
| Final secondary `up.sh --fresh`, then plain `up.sh` | PASS, claimed secondary stack 1; both complete browser journeys and successful `down.sh --id 1` |

The first two-worker root run failed both eight-caller cap races on the loaded
host. Both passed in isolation, then the complete single-worker run passed.
No production freshness limit or test assertion was relaxed.
During authority optimisation, the focused gateway suite passed its safety cases
but the existing reviewed-tool revocation timing check failed under host load,
including an isolated rerun. A diagnostic isolated run then passed all four
revocation cycles in roughly 0.9–1.5 seconds. Final complete-suite results are
recorded above.
Two later full runs each passed 1,057 tests but failed the existing gateway
credential fixture because my gate wrapper used `umask 077`. The container runs
as UID 65532 and could not read its generated mode-0600 configuration. An isolated
run reproduced the failure with that mask and passed with the normal `umask 022`;
the wrapper was corrected, while diagnostics remain in a private directory.
The normal-mask full run passed 1,056 tests but hit the default five-second Vitest
timeout in the existing authorisation recovery and legacy conversation tests.
The recovery case also timed out in isolation; measured PostgreSQL-backed OpenFGA
startup alone took 4.3 seconds on the busy shared host. A subsequent run with a
20-second harness timeout was interrupted after a monthly eight-caller cap race
failed; both cap races then passed unchanged in isolation. The final full rerun
uses two workers, a 20-second Vitest harness timeout and one retry for failed tests,
keeps explicit test timeouts and assertions, and leaves the production two-second
authority expiry unchanged.
The initial retry-enabled run was stopped early to enable the verbose reporter
and capture any retries in the final run.
The final full run passed every enabled test without a retry, including both
eight-caller cap races and the new category-read and budget-edit regressions.
The additional infra claim test could not bind port 25110 while another stack
owned it; its live shared-host run was **FAIL** for that environment condition.
The two isolated Zitadel setup tests passed. Paid-provider and managed-cluster
opt-in conditions remain **NOT RUN**.

Live attempts exposed two launcher defects, one fixture limit and a slow authority read:

- The inherited journey shadowed the selected namespace with `opencrane-dev`.
  This was repaired before the first startup. The journey now checks the selected
  namespace against its provisioned kubeconfig before issuing Kubernetes commands.
- The server lacked the selected decision URL. One failed budget save attempted
  the owner decision port and returned 503. The launcher now explicitly supplies
  the secondary decision port. No owner lifecycle command was run.
- The corrected fresh journey passed, but its unconfirmed Stop reservations
  left insufficient daily headroom for the complete plain journey. The owner UI
  now sets the daily cap to 5,000 cents after the fresh checks, keeping reservations
  and the 20,000-cent monthly ceilings. Plain startup checks that these settings
  survive migration.

- With enough budget headroom, the repeat Stop turn was allowed and audited but
  its reservation was released as not dispatched when the final authority fence
  expired. Authority checks read the entire growing journal one row at a time.
  They now read only the existing member, assistant, team, conversation and grant
  histories concurrently, keep the captured global head and event ordering, and
  check every IAM projection marker concurrently. Permission checks and the
  two-second freshness fence are unchanged. A real JetStream test covers category
  ordering, inclusive positions, empty results and wildcard-write refusal.

The first fresh run with the authority optimisation passed all checks. One plain
startup passed both browser chat/Stop checks, then timed out waiting for the
suspended-computer wake reply. Private failure capture now includes all computer
lifecycle events; the next attempt also keeps a private Kubernetes state snapshot.

The next plain run passed wake and all four required budget cases, then an extra
post-check ceiling restoration returned 503. Restoration is now done only after
the fresh checks, where it supplies the plain journey’s headroom; teardown deletes
the final plain fixture. The required ceiling saves/refusals and their assertions
are unchanged.

A further plain attempt returned 503 on a required ceiling save. A failing real
HTTP/JetStream/OpenFGA regression test reproduced the cause: closing an unrelated
computer turn changed the shared model-decision fence during a budget edit.
Budget edits now fence only the editing owner's membership stream, retain current
Owner/Admin checks against both OpenFGA and membership history, and keep the
same two-second expiry from command entry. Model/MCP decision fences are unchanged.
Companion regression cases refuse an edit after a role change during the command
and after expiry, without appending a ceiling.

Every completed attempt ended with successful `down.sh --id` for its claimed id.
Private diagnostics remain outside the repository under `/tmp/p3-13-final/`.

Final live evidence: **PASS**, 21 screenshots and sanitised startup/teardown
receipts in the [screenshot index](p3-13-live/README.md). Both complete journeys
prove normal stub chat and Stop at 1280px/390px, one installation default,
unchanged ceilings on repeated migration, owner group/assistant edits at both
widths, durable clear refusals after reload and no reservation for refused calls.
Plain startup preserves the owner’s 5,000-cent daily cap and 20,000-cent group
and assistant ceilings. No real OpenAI call was made.
