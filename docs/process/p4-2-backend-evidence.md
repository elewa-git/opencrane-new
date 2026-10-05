# P4-2 backend source evidence

Issue [#84](https://github.com/elewa-git/opencrane-new/issues/84), parent
[#82](https://github.com/elewa-git/opencrane-new/issues/82), decision D04. Source base:
`2329adc` on `work/p4-2-ownership`. Qualification dates: 2026-10-04–05 (UTC).
The [ownership HTTP interface](../api/ownership.md) is ready for later PPL-32–35
screens on the shared UI foundation. No screen, sample data or new dependency is added.

## Confirmed test seams

Authenticated HTTP through the real event store and disposable PostgreSQL/OpenFGA;
public migration, projection runner and OpenFGA replay interfaces. Fixtures use
normal test containers and the supplied PostgreSQL control URL. They do not touch
the owner stack or change Docker/network settings. Every suite/check runs at
`nice -n 10`. The full root suite starts with integer host load below 16 and two workers.

The first red test failed because `seedOwnership` did not exist. The successor's
existing group-management test then failed with 403 until ownership-derived roles
were used. Owner-role invitation acceptance and an active owner's reinvitation
both reproduced 200 responses before their guards; each now refuses without an
append. Migration tests insert a real concurrent member demotion before the seed:
the global conditional append refuses it and retry seeds only the remaining owner.

## Behaviour covered

- Idempotent migration, competing seeds and a membership change during seeding.
- One conditional appointment event, retaining the previous owner; original retry
  performs no append, and changed successor or stale sequence is refused.
- Owner-only edits; active silo successor; inactive, missing and foreign histories;
  strict input, current Owner/Admin reads and foreign-session refusals.
- Two competing step-down demotions produce one winner and one conflict. The last
  owner receives the named rule and appointment action. Step-down retains Admin.
- Lost acknowledgement returns unavailable; Check status finds the original actor,
  successor, event time and change id; content/IAM remain applying until projected.
- A newly appointed owner cannot edit before its IAM receipt. Member roles and
  OpenFGA converge, replay verification compares all tuples/receipts and content.
- Private conversation participation remains independent of ownership. Event
  receipts expose safe ownership evidence, and the organisation audit retains links.
- Existing Owner/Admin group, budget, tool policy, effect and audit checks consume
  ownership-derived roles and receipts. Model/MCP/destination authority includes
  only the exact ownership/member subjects and relevant event receipts.

## Commands and results

Focused source proof: the initial 10 tests passed; review regression tests add lost
step-down acknowledgement and delayed live IAM ordering. Final counts follow below.
Independent pass 1 found a seed overtaking a delayed legacy demotion and a pending
step-down status read returning 503. Both reproduced in failing tests. IAM silo
ordering and safe status-read rules fix them. Independent pass 2 found no remaining
code-review blockers and verified both regressions, the style fixes and upgrade
requirements. This completes the two permitted review passes. All required source gates now pass.
The feature exceeds the roughly 1,500-line guideline slightly because these public
runtime proofs, explicit braced guards and the browser assertion fix remain together.

```sh
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres nice -n 10 npm test -- --maxWorkers=2
nice -n 10 npm run lint
nice -n 10 npm run typecheck
nice -n 10 npm run check:events
```

The initial root run started at integer load 7 and was interrupted after review fixes
made it obsolete. It reported the old lost-step-down failure and the exact-subject
fixture expectation, both subsequently fixed, plus the existing Chromium integration
journey failure. This interrupted run is not a passing gate. The final complete run
and any necessary follow-up are recorded with their actual outcomes.

The first complete run started at load 15.38: **FAIL**, 1,536 passed / 3 failed /
15 skipped (1,687.97 seconds). The audit equivalence fixture now explicitly allows
the three ownership types while preserving its previous allow-list. The model
exact-subject fixture now includes `ownership-test`. The unchanged gateway
credential fixture failed at startup with `ECONNREFUSED`, before credentials were
tested. All three files then passed: 8 tests in 38.28 seconds. Both migration and
live IAM ordering regressions passed within this complete run too.

The next root run was interrupted after its Chromium protected-discovery assertion
failure was reproduced and fixed. Its focused red run failed at the same message check: 1 failed / 19
skipped. Clicking Check status clears the previous message synchronously; the
fixture counted it before the HTTP read and render completed. The test now waits
for the real status response and visible message, retaining its ten-second polling
bound. Product code and authority deadlines are unchanged. The focused green run
passed the full integration browser journey in 56.36 seconds; targeted lint and
server typecheck passed after the fixture fix.

Final complete root gate: **PASS**, 1,539 passed / 15 skipped, 98 passed / 4 skipped
files, 1,219.62 seconds. Started at load 10.79 on 4 October and finished on 5 October.
Every command used `nice -n 10`; root used the supplied PostgreSQL URL and two
workers. Full lint, typecheck and catalogue checking passed before this final run;
the browser fixture change also passed targeted lint and server typecheck.

| Gate | Result | Evidence |
| --- | --- | --- |
| `lint` | PASS | Code, dependency graph, unused code, Markdown, local links and fixture boundaries; seven code warnings, no errors |
| `typecheck` | PASS | All workspaces; server checked again after the browser fixture fix |
| `check:events` | PASS | 89 registry/catalogue event types agree |
| Full root suite | PASS | 1,539 passed / 15 skipped; all 12 ownership/migration/IAM-ordering tests pass |
| Independent review | PASS | Two permitted passes; demonstrated blockers fixed and verified |

The 100,000-unrelated-event benchmark also passed: p95 model 285.11 ms, MCP
151.85 ms and destination authority 65.05 ms (30 samples each). All use bounded
exact-subject reads. Existing Chromium integration, chat, production CSP and fold
checks passed; these do not qualify the later ownership screens.

## Remaining qualification

Backend source: **PASS**. Overall feature: **PARTIAL**. Desktop/390px review/success/unknown/conflict states:
**NOT RUN**, because UI belongs to the later Claude Design implementation on #130.
Fresh-install live journey: **NOT RUN**; this task qualifies the backend source
using disposable services. No managed-cluster, HA or backup claim is made.
P4-3 owns directory selection, non-owner role edits and safe member departure;
future owner-changing paths must use the single ownership invariant. The dispatcher
manifest changes and requires the existing controlled upgrade/rebuild procedure.
