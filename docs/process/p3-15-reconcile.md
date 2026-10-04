# P3-15 backend: monetary reconciliation

Scope: issue [#56](https://github.com/elewa-git/opencrane-new/issues/56), spec #41,
D21. Branch `work/p3-15-reconcile`, based on `ed8066f` from main. Backend only:
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

## Source evidence

Tests run at the confirmed command/event-store, projection/replay, budget actor,
gateway settlement and HTTP seams. The new suite first demonstrated the dropped
late observation, absent resolution interface, absent HTTP routes, lost-computer
handling, malformed native usage and pending-resolution race, then passed after
implementation. It uses disposable NATS and PostgreSQL fixtures, with
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
Existing gateway fixtures stream final SSE usage through the pinned real gateway,
including cached input and cache writes. New regression vectors ignore gateway
timestamps with dropped fractional zeros, month boundaries and malformed values.

Independent review: pass 1 **FAIL** found JSON rounding before integer validation;
pass 2 **PASS** verified the fix and found no remaining blockers. Effect routes
retain raw JSON in an isolated parser scope. The existing lossless reader rejects
fractional/underflow number text before conversion for both settlement and receipt
amounts. Six raw HTTP vectors return 400 with unchanged effect heads. The HTTP
regression also applies the recorded resolution through the actual decision HTTP
route twice and verifies Released. No new runtime dependency was introduced.

A later gate regression check also found that expiry repeated an already-recorded
native uncertainty. A small deduplication guard preserves the first uncertainty
while still recording new final usage. The same tests caught property-order
differences after the lint cleanup; payloads now pass through their event schema
before comparing them, matching stored event field order. That guard is test-verified after the
second independent review; no third review was run.

Final source checks use Node **22.23.3**. No stack or host network was changed.

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
Main advanced to `65364a0` (#111, authority-read optimisation) during this build;
this branch retains its original `ed8066f` base. Rebase and requalification are
left to integration; no PR was opened and no push was made.
Fresh-install journey, designed desktop/390px resolution view and real-provider
resolution: **NOT RUN**. This backend does not close the full P3-15 capability.
