# P3-15 backend: monetary reconciliation

Scope: issue [#56](https://github.com/elewa-git/opencrane-new/issues/56), spec #41,
D21. Branch `work/p3-15-reconcile`, rebased onto `65364a0` from main (#111, issue #70). Backend only:
the owner requires Claude Design prompt 3 before building the resolution screen.
No styled or unstyled screen, stack changes, paid calls or live deployment.

## HTTP contract for the design

All routes require an authenticated session in the silo and current Owner/Admin
membership. Responses use `Cache-Control: no-store`. Reads use recorded evidence;
checking status never calls the provider or repeats an external action.

| Method and route | Response or input |
| --- | --- |
| `GET /api/org/effects` | `{ effects: EffectStatus[] }` |
| `GET /api/org/effects/:permitId` | `EffectStatus` plus a session/permit-bound `csrf` token |
| `POST /api/org/effects/:permitId/resolve` | Command below, with matching `Origin` and `X-CSRF-Token` from the detail read |

`EffectStatus` contains `permitId`, `reservationId`, `reservedAt` (reservation event
time), `reservedCents`, nullable `settledCents`, `model`, pinned `priceTableId`,
`sequence` (effect stream head), `state`, `label`, `conflict`, `reasons`,
`observations` and nullable `resolution`. Observations expose only event id,
outcome, integer cost and token usage. Resolution exposes outcome, amount and
safe evidence references. Conversation, requester, thread, computer tokens,
credentials, provider bodies and raw gateway diagnostics are omitted.

States are `outcome_unknown` (label **Outcome unknown**), `resolution_pending`,
`settled` and `released`. A resolution command returns 202 after its one append;
refresh the detail until the settlement reaction runs. An identical retry with
the same command id and authenticated operator returns 202 without another event.
Two operators cannot overwrite each other, even after restart.

Example settlement command (all money is a safe integer in euro cents):

```json
{
  "commandId": "resolution-unique-id",
  "expectedSequence": 42,
  "outcome": "settled",
  "settledCents": 600,
  "evidence": [
    {
      "kind": "provider_receipt",
      "reference": "receipt-opaque-id",
      "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "amountCents": 600
    }
  ]
}
```

For release, use `outcome: "released"`, `settledCents: 0`, and evidence objects
`{ kind: "dispatch_record", reference, digest, notDispatched: true }`.
The operator attests a receipt or non-dispatch record held outside this response;
this command does not claim to verify a provider receipt automatically. References
are opaque ids (`[\w-]{1,200}`), hashes are SHA-256 hex, and evidence has 1–10 items.
No free-text credential or conversation fields are accepted.

Statuses: 401 no session; 403 identity/role/Origin/CSRF refusal; 400 malformed input,
empty evidence, fractional/negative/unsafe amounts; 404 unknown reservation;
409 `conflict` for stale sequence or competing resolution, or `held` for conflicting
or insufficient evidence; 503 unavailable authority or event store. A 202 confirms
recording only. Conflicts preserve both the full hold and the largest recorded charge.

## Original source evidence before rebase

Tests run at the confirmed command/event-store, projection/replay, budget actor,
gateway settlement and HTTP seams. The new suite first demonstrated the dropped
late observation, absent resolution interface, absent HTTP routes, lost-computer
handling, malformed native usage and pending-resolution race, then passed after
implementation. It uses disposable NATS and PostgreSQL fixtures, with
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
Existing gateway fixtures stream final SSE usage through the pinned real gateway,
including cached input and cache writes. New regression vectors ignore gateway
timestamps with dropped fractional zeros, month boundaries and malformed values.

The original receipt reported two money-validation review passes and a verified
JSON-rounding fix. That report did not qualify the populated list or a green root
gate. The current independent feature review pass 1 is **FAIL**; its correction
evidence follows below, without claiming a reviewer verification pass. Effect
routes retain raw JSON in an isolated parser scope. The existing lossless reader rejects
fractional/underflow number text before conversion for both settlement and receipt
amounts. Six raw HTTP vectors return 400 with unchanged effect heads. The HTTP
regression also applies the recorded resolution through the actual decision HTTP
route twice and verifies Released. No new runtime dependency was introduced.

A later gate regression check also found that expiry repeated an already-recorded
native uncertainty. A small deduplication guard preserves the first uncertainty
while still recording new final usage. The same tests caught property-order
differences after the lint cleanup; payloads now pass through their event schema
before comparing them, matching stored event field order. That guard was
test-verified after the original money-validation checks.

The original source checks used Node **22.23.3**. No stack or host network was changed.

| Check | Result | Evidence |
| --- | --- | --- |
| `npm ci` | PASS | Clean worktree install; no new dependency |
| `npm run lint` | PASS | All six checks; existing warnings only; 377.715 s |
| `npm run typecheck` | PASS | Every workspace |
| `npm run check:events` | PASS | 85 catalogue/registry event types |
| Reconciliation seam suite | PASS | 18 tests on the corrected source; 70.17 s |
| HTTP resolution/refusal regression | PASS | Safe reads, CSRF, six raw money refusals, one append and duplicate reaction |
| Real gateway settlement regressions | PASS | 11 tests, including SSE cache read/write, original tariff, definite rejection and transport hold; 127.15 s |
| `npm run build -w apps/web` | PASS | Existing bundle/style/CommonJS warnings; 62.249 s |
| `npm run test -w apps/web` | PASS | 11 files / 60 tests |
| `npm test -- --maxWorkers=2` | FAIL | 7 files failed / 70 passed / 3 skipped; 32 tests failed / 1,362 passed / 14 skipped; 1,880.331 s |

The broad run started before the final deduplication fixes. Twenty of its failures
are the duplicate observation/expiry cases that pass on the corrected source.
The remaining twelve include 5 s/60 s test timeouts, NATS request timeouts and
authority-read refusals. The broad run reported failures in unchanged live-view, upload, approval, IAM
and bridge tests, alongside settlement deduplication regressions from the earlier
source. The affected settlement cases pass when rerun on the final source.
The unchanged slow-authority live-view case also failed in isolation (403 rather
than 200). The shared host reported load averages around 24–28; that is a condition,
not proof that every failure is environmental. The full root gate is **not green**;
landing requires a fresh green root run. Source qualification remains **PARTIAL**.
At that original receipt, main had advanced to `65364a0` (#111, authority-read
optimisation), while this branch still had its `ed8066f` base. The correction
receipt below supersedes that base and gate status.
Fresh-install journey, designed desktop/390px resolution view and real-provider
resolution: **NOT RUN**. This backend does not close the full P3-15 capability.

## Independent feature review pass 1 corrections — 4 October 2026

The populated-list blocker was reproduced before implementation: the new HTTP
regression returned **503**, where **200 within 2,000 ms** was required. It creates
50 reservations through the budget actor, records 25 held and 25 settled effects,
and checks the complete list and both held/settled detail reads through HTTP.
It also checks safe cache headers, literal amounts/states and unchanged event heads.
The fixture uses real disposable NATS, OpenFGA and PostgreSQL; it makes no provider call.

The listing now uses **one finite replay**, through a captured event-log head,
using the existing reader's batches of at most 64 requests. It builds the budget
and groups effect evidence in memory, then formats each reservation without any
per-item I/O. A two-second deadline bounds the replay. Detail reads retain exact
budget/effect subjects and share one two-second deadline. The role fence still
runs before returning a response. This bounded replay can refuse when a silo's
whole log outgrows two seconds; a replayable effect projection is the next step
if that ceiling is reached.

`git rebase origin/main` completed successfully from `3047e9e` onto `65364a0`.
The rebased parent is `f3a6581`; `git merge-base --is-ancestor origin/main HEAD`
returned 0, and no rebase directory remained. Node is **22.23.3**. Tests use
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`. No stack or host networking was changed; only normal test fixtures ran.

The first corrected-source HTTP rerun also failed at shared-host load around 28:
the populated read returned 503 and the existing resolution test timed out.
Those failures are recorded, not counted as passes. A lower-load rerun and the
full gate results follow.

The corrected HTTP rerun passed at **11:38:54 UTC**, after the two-minute load
poll recorded **14.48**: **2 tests passed / 18 not selected**, 30.67 s including
fixture setup. The populated-list and both detail requests returned **200 in
less than 2,000 ms**. The existing resolution/refusal journey also passed.
The full root suite started at **11:39:33 UTC**, only after a separate load
check recorded **13.56**, with `--maxWorkers=2` and the PostgreSQL URL above.

| Corrected-source check | Result | Evidence |
| --- | --- | --- |
| `npm run lint` | PASS | All six checks; existing warnings only |
| `npm run typecheck` | PASS | Every workspace; rerun after the final test edit |
| `npm run check:events` | PASS | 85 catalogue/registry event types |
| Populated-list and resolution HTTP regressions | PASS | 50 reservations, 25 held / 25 settled; list and both details under 2 s |
| `npm run test -w apps/web -- --watch=false` | PASS | 11 files / 60 tests; 24.84 s |
| `npm run build -w apps/web` | PASS | 33.238 s; existing bundle/style/CommonJS warnings |
| `PG_TEST_URL=… npm test -- --maxWorkers=2` | PASS | 80 files passed / 3 skipped; 1,403 tests passed / 14 skipped; 1,140.60 s |

Source under test is rebased parent `f3a6581` plus the correction diff. SHA-256:

```text
448187412872024b11c8bb0de15596c762d61b6d1c1a96ff131a20f11004bd8b  libs/models/src/reconciliation.ts
05f4900ea0c9b03bd34c11d2014d228c9f52df5116461f3fb18f92eaa9c1da76  libs/models/src/actor.ts
f7147f30a25cade4e7da6a0cfc96a63203a4ce73a4082fe044afd850168435cf  apps/server/test/integrations.test.ts
```

The root process exited **0**. This fresh green run supersedes the original red
root gate; the listing regression passed before the full run and again as part
of that run. No unchanged test failed in this gate, so no `origin/main` comparison
was needed. Skipped opt-in conditions remain **NOT RUN**, including paid-provider
and stack-dependent journeys. Source checks are **PASS**. Independent reviewer
verification of these corrections remains pending; this builder run is not a
review pass. The designed resolution screen, fresh-install journey and
real-provider resolution remain **NOT RUN**, so full P3-15 qualification is
**PARTIAL**. No stack or host networking was changed.
