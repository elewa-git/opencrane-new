# Provider turn guard review fixes

Date: 9 October 2026. Source: `a64cd413`, plus documentation changes.
PR: [draft #300](https://github.com/elewa-git/opencrane-new/pull/300).
Base: `origin/main` at `8cccef18`, after #294 merged.
The rebase completed and the PR now targets `main`.

The review found missing tests. The existing guards refuse the reviewed inputs,
so this round changes tests and documentation. It adds no dispatch path.
The tests were committed before this receipt in `a64cd413`.

## Environment

Linux, Node 22.23.3. Service tests use disposable NATS, databases on the local
PostgreSQL test server, OpenFGA and the pinned real gateway. The gateway uses a
recording local upstream. The bridge test uses a real WebSocket connection and
verifies the signed turn pass. This is isolated service testing, not a fresh
customer installation. No paid provider call was made.

`PG_TEST_URL` was set for every test run. Vitest, lint and typecheck ran under
`nice -n 10`. No full root suite or live-view qualification batch was started.

## Failure proof

PASS: each of these 15 temporary guard removals made its test fail. Each source
file was restored before the final checks. The production source diff was empty
against the test commit after restoration.

| Guard removed or weakened | Observed failure |
| --- | --- |
| Both recorded-provider comparisons | A signed pass missing BOTH provider claims returned 200 instead of 403 |
| Recorded provider id comparison | A different provider reached the later managed-call refusal |
| Recorded binding position comparison | A different position reached the later managed-call refusal |
| Recorded model comparison | A different model reached the later managed-call refusal |
| Decision parser's required provider pair | An incomplete pair reached the turn-activity check |
| Decision parser's provider-id checks | Bad ids reached the turn-activity check |
| Decision parser's position checks | Invalid positions reached the turn-activity check |
| Issuance's recorded-task comparison | A changed task was signed |
| Start record's model-presence check | A missing or unbound model was accepted |
| Close record's model-presence check | A missing or unbound model was accepted |
| Close record's complete-pair check | Incomplete provider pairs were accepted |
| Budget replay's complete-pair check | Incomplete calls entered the replayed budget |
| Shared provider-id syntax and length checks | Signing and storage accepted bad ids |
| Shared safe-integer position check | Signing and storage accepted fractional or unsafe positions |
| Bridge's saved-model selection | The bridge connection closed instead of returning the saved-model pass |

The omitted-pair test checks both the decision endpoint and the real gateway.
With the guards intact, both refuse the request. No hold is saved and the upstream
receives no request. Tests for individual mismatches check the turn refusal itself,
so the later blanket refusal cannot hide a missing comparison.

The parser tests also check that malformed claims stop before the separate
turn-activity check. Closure cases keep the provider/model presence rule satisfied,
so that rule cannot hide a missing pair check. Replay receives malformed records
directly, so append validation cannot hide a missing replay check.

Failure logs are local files named `/tmp/p4-22-pr4-probe-<guard>.log`.
The table above records the results for later review.

## Final checks

All requested checks passed. The changed tests cover eight files.

| Command | Result | Observed result |
| --- | --- | --- |
| `npm run lint` | PASS | All lint stages passed; 15 existing warnings, no errors |
| `npm run typecheck` | PASS | All workspaces passed |
| `npm run check:events` | PASS | 99 event types agree |
| `npx knip` | PASS | No unused-code errors; two configuration hints |
| `npm run lint:changelog` | PASS | Release notes passed |
| Changed tests, run 1 | PASS | 86 tests in eight files |
| Changed tests, run 2 | PASS | The same 86 tests in eight files |

Both runs used this command:

```sh
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres \
  nice -n 10 npx vitest run \
  libs/models/test/provider-turn-contract.test.ts \
  libs/models/test/provider-turn-guards.test.ts \
  libs/models/test/provider-turn-replay.test.ts \
  libs/auth/test/tokens.test.ts \
  libs/auth/test/provider-turn-validation.test.ts \
  libs/events/test/provider-turn-validation.test.ts \
  apps/server/test/computer-turns.test.ts \
  apps/server/test/bridge-replay.test.ts --maxWorkers=1
```

The tests are:

- [Provider admission guards](../../libs/models/test/provider-turn-guards.test.ts).
- [Provider reservation and gateway contracts](../../libs/models/test/provider-turn-contract.test.ts).
- [Budget replay and non-zero duplicate settlement](../../libs/models/test/provider-turn-replay.test.ts).
- [Signer validation](../../libs/auth/test/provider-turn-validation.test.ts) and [existing token tests](../../libs/auth/test/tokens.test.ts).
- [Stored turn and reservation validation](../../libs/events/test/provider-turn-validation.test.ts).
- [Computer turn repeat and closure](../../apps/server/test/computer-turns.test.ts).
- [Bridge repeat and reconnect](../../apps/server/test/bridge-replay.test.ts).

The non-zero settlement test records one usage event, delivers it twice, restarts
the budget actor and delivers it again. It checks one saved charge and the original
provider, position, model, payer, cents and price table. Replay sends no request.

## Remaining qualification

NOT RUN: full root suite, fresh-install migration, managed dispatch and paid-provider
qualification. Activation and binding selection at admission remain outside this PR.
A second review pass has not been run by this task.
