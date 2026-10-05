# P4-21 provider backend evidence

Issue [#103](https://github.com/elewa-git/opencrane-new/issues/103), parent
[#82](https://github.com/elewa-git/opencrane-new/issues/82). Base main:
`2329adc95f9ba806d2e269f895bf5b3f64dbed2f`. No screen is included; MOD follows
Claude Design handoff 08-mod on UI foundation #130. P4-22 owns grants, ordinary
model route replacement and provider retirement with actual dependencies.

The confirmed test seams are authenticated HTTP, the event-store command
interface, real gateway to recording upstream, safe projection reads and replay.
TDD receipts in `/tmp/p4-21-*.log` cover creation/status (404 red), key save
(404 red), metadata read (404 red), Skip (404 red), reachability (recorded
pending/failure red), model ids containing dots (400 red) and their passing fixes. A later self-review reproduced a caller-supplied
reference bypass (200 red); the collection now accepts only Create/Models, and
the key route alone can establish custody. Shared secret-reference and generated
OpenFGA model equivalence failures were repaired using their existing contracts.
The registry-wide money tests also caught a positive-only amount schema; the
event now uses the shared non-negative integer-cent schema, while priced tests
still require a positive quote. All 38 money/model projection assertions pass.
Dependencies and pinned fixture tools were installed before behavioural checks;
initial setup failures are not counted as behavioural red evidence.

## Functional and security evidence

The focused journey covers owner creation, one immutable key reference, retry and
original-change reconciliation, separate saved/reachable/model-answer facts,
explicit Skip, integer-cent quote/consent/reservation/settlement, one real gateway
dispatch, header stripping, rotation and exact key use at the recording upstream.
Unknown/unpriced models, missing consent, altered quotes and stale configuration
are refused before spending. Budget refusal makes no provider call; a 504 leaves
its reservation held and repeating the original attempt does not dispatch again.

The lost-save-reply probe performs a real NATS append, then returns an unavailable
adapter response. HTTP reports unavailable; the original status read finds the
accepted revision and the repeated command adds no secret or event. Secret-store
failure accepts no key change and exposes no raw key/error. Verified cookie roles
cannot replace current event-backed roles; member, foreign silo, forged Origin,
missing-session and revoked-role reads/writes fail closed. NATS/IAM outages deny
access. The fixed gateway request is authorised against exact subjects and the
shared deadline, with key injection only after admission.

Projection rebuild and OpenFGA rebuild preserve safe metadata and provider
management relations with zero upstream calls. The key value is absent from events
and gateway configuration. No browser or production credential was used. The
18 tests use disposable NATS, PostgreSQL, OpenFGA and the pinned real agentgateway;
only the provider is a recording HTTP fixture. No Docker daemon/network settings
or owner stack were changed. No dependency was added.

The fixed upstream contracts were cross-checked against official
[OpenAI model-list documentation](https://developers.openai.com/api/reference/resources/models/methods/list),
[OpenAI text-generation documentation](https://developers.openai.com/api/docs/guides/text),
[OpenAI token accounting](https://developers.openai.com/api/docs/guides/token-counting)
and [Anthropic model-list documentation](https://platform.claude.com/docs/en/api/models/list).
The repository's registry and tariff remain the model and price contract.

## Required checks

| Check | Result |
| --- | --- |
| Focused provider journey | PASS: 18 provider tests plus 310 shared security assertions |
| Root lint | PASS: code, dependencies, unused exports, docs, links and fixtures |
| Workspace typecheck | PASS |
| Event catalogue | PASS: 92 types |
| Full root suite | PASS: 1,562 passed / 15 skipped; 96 passed / 4 skipped files |

First full root run: **FAIL**, 6 failed / 1,556 passed / 15 skipped across
100 files (4 failed / 92 passed / 4 skipped), 1,825.34 seconds. Its six failures
were the reproduced custody bypass, two shared secret-reference assertions,
OpenFGA DSL/JSON equivalence and two shared integer-cent schema assertions.
The focused fixes above pass. The second full run started at integer load 14:
**FAIL**, 2 failed / 1,560 passed / 15 skipped in 1,405.79 seconds. The existing
100,000-event benchmark received an MCP 403; the standalone authority expiry
fixture timed out at 40 seconds. Both pass without source changes in isolated
reruns: the benchmark in 89.10 seconds and all three standalone tests in 16.34
seconds. These failures remain recorded; an isolated pass is not a root gate PASS.
Final full run: **PASS**, started at integer load 10 on 4 October and completed
on **5 October 2026 UTC**, with the same source and the required PostgreSQL URL.
Both authority tests pass inside this complete run. Lint, typecheck and catalogue
also pass in the final source-gate run started at integer load 15.

```text
 Test Files  96 passed | 4 skipped (100)
      Tests  1562 passed | 15 skipped (1577)
   Start at  23:47:14
   Duration  1223.19s (tests 95%, import 5%)
```

The full root run uses `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`
and `--maxWorkers=2`, starting only when the integer load is below 16. Lint,
typecheck and every test run use `nice -n 10`.

Independent review, fresh-install live provider qualification, actual paid provider
calls and all Claude Design/browser/390px states: **NOT RUN**. The Phase 3 complete
fresh-journey gate remains unclaimed. This is backend source evidence; it does not
close the whole visual ticket or establish a live capability PASS. See the
[screen binding contract](../api/providers.md).
