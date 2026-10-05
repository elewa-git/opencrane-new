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
pending/failure red), model ids containing dots (400 red) and their passing fixes. A later custody check reproduced a caller-supplied
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

## Original implementation checks

These results describe `0a4d302`, before the rebase and fixes below.

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

Fresh-install live provider qualification and actual paid provider
calls, and all Claude Design/browser/390px states: **NOT RUN**. The Phase 3 complete
fresh-journey gate remains unclaimed. This is backend source evidence; it does not
close the whole visual ticket or establish a live capability PASS. See the
[screen binding contract](../api/providers.md).

## Dispatch and recovery fixes — 5 October 2026

Source: rebased commit `d0e5909` on main `ce0e07b`, plus the fixes committed with
this receipt. Environment: shared Linux development host, disposable local NATS,
PostgreSQL, OpenFGA and pinned agentgateway fixtures, not a fresh silo.
The rebase completed and main was checked as an ancestor. Its one conflict in
`gateway.ts` retained main's child cleanup support and the provider route import.

The first four new HTTP tests failed as expected: gateway 403/503 recorded failed
reachability and left undispatched priced reservations held. `/tmp/p4-21-red.log`
records 4 failed / 18 passed. The dispatch-evidence fix passed all 22 tests in
`/tmp/p4-21-green-b1.log`. With no dispatch event, result is unknown and the budget
actor releases the priced reservation at zero cents. Dispatched uncertain calls
remain held and cannot dispatch twice.

Secret rotation, rejected-append cleanup and provider audit exclusion also failed
before their fixes (`/tmp/p4-21-red-cleanup.log`). An exclusive-write retry with a
changed transient key failed before removing the key comparison
(`/tmp/p4-21-red-secrets.log`). The corrected checks passed 29 tests in
`/tmp/p4-21-green-cleanup.log`.

Additional own checks use the real gateway with a refused command and an unreadable
secret store, for reachability and priced tests. They prove no upstream contact,
unknown result and zero-cent release. Failed answers, malformed JSON, query strings,
internal command lookalikes and a revision change during a settled model call have
HTTP regressions. Projection rebuild preserves the recorded late outcome without
inventing current-key evidence. Provider and budget token audiences are separate.
The provider, secret and token set passed 36 tests in `/tmp/p4-21-provider-final.log`.

All calls used the local recording upstream; no paid model call was made. No owner
stack, Docker daemon or network settings were changed. No dependency was added.
MOD-04 reads and both dev-stack wiring gaps are documented in the API contract.

An intermediate focused run and two typecheck attempts failed because the new
orphan-cleanup test first accessed an untyped event, then treated the envelope
schema factory as a schema. The fixture now uses `parseEventByType`; these were
test-code errors, and their failed runs are retained rather than reported as passes.

The requested nine-file focused run (`/tmp/p4-21-focused-final.log`) reported
**FAIL**: 162 passed / 2 failed / 1 skipped in 738.93 seconds. One failure was the
fixture parser error above; the other was the existing 133-cent context-tier
case reaching its unchanged 40-second test limit under host load. The corrected
provider file passed all 33 tests in `/tmp/p4-21-provider-corrected.log` (47.55 s).

The unchanged three gateway context-tier cases then passed in 30.01 seconds
(`/tmp/p4-21-gateway-tier-rerun.log`). Its 78 filtered-out cases are not claimed
as passes. Final workspace typecheck and the 92-type catalogue check passed.
Code, dependency and unused-code lint passed; two Markdown blank-line errors were
fixed, and documentation, local links and fixture checks passed on rerun.

First full root run after these fixes: **FAIL**, 1,626 passed / 1 failed / 15 skipped,
98 passed / 1 failed / 4 skipped files (103 total), 1,577.12 seconds. It started at
integer load 15 and used the required PostgreSQL URL, two workers, verbose reporting
and `nice -n 10`. All 33 provider tests and all active gateway tests passed inside
this run. The sole failure was the existing concurrent approval forwarding case,
which expected HTTP 200 and received 403. `/tmp/p4-21-root-final.log` retains the
complete output; it is not counted as a passing root gate.

The failed approval case passed without source changes in an isolated rerun
(`/tmp/p4-21-approval-rerun.log`, 18.95 seconds; 1 passed, 26 filtered-out cases).
The failure occurred in its post-race approval-card read, which uses no provider
membership helper. This isolated pass does not replace the failed full-root gate.

Second complete root run on the same source: **FAIL**, 1,626 passed / 1 failed /
15 skipped in 1,331.20 seconds; 98 passed / 1 failed / 4 skipped files. It started
at integer load 10. The approval case passed in this run. The sole failure was
`records exhaustion once even when decision audit appends fail and callers retry`,
which reached its unchanged 40-second limit; it passed in the first complete run.
`/tmp/p4-21-review-fixes-root-second.log` retains the result. No passing root gate
is inferred by combining the two runs.

The gateway exhaustion case passed unchanged in isolation in 15.86 seconds
(`/tmp/p4-21-exhaustion-rerun.log`, 1 passed / 80 filtered-out cases). A further
custody check found that blindly accepting an existing file could accept an
incomplete concurrent write. The controlled filesystem-boundary test failed with
an empty key (`/tmp/p4-21-red-publication.log`). Keys are now written privately and
published only when complete, using an exclusive same-directory link. Both secret
adapter tests pass (`/tmp/p4-21-green-publication.log`); no stored key is read to
compare. Temporary files are removed when the operation finishes, including errors.

Third complete root run: **FAIL**, 1,625 passed / 3 failed / 15 skipped across
96 passed / 3 failed / 4 skipped files, in 2,149.37 seconds. It started at integer
load 15 with the required PostgreSQL URL, two workers and `nice -n 10`.
All 33 provider tests passed. Angular did not publish its startup URL within the
Chromium fixture's 60-second wait; the slow-NATS models fixture exited before
readiness; the gateway upgrade/replay migration subprocess was killed at its
existing time limit. `/tmp/p4-21-review-fixes-root-third.log` retains all errors.
These three cases passed in both earlier complete runs. Their failures in this
run remain failures; no passing root gate is inferred by combining runs.

The real-gateway refusal fixture now keeps a valid signed command and changes its
route or model-test body. It proves actual HTTP 403 and no key read for both kinds
of check. Restoring the earlier key-read ordering made precisely those two tests
fail (`/tmp/p4-21-red-key-order.log`, 31 passed / 2 failed, 54.66 seconds).
With the final ordering restored, all 37 provider, secret and token tests pass
(`/tmp/p4-21-green-key-order.log`, 47.97 seconds). Refused and unreadable gateway
steps release undispatched priced reservations and never invent provider failure.

All three failures from the third root run passed unchanged in a targeted serial
rerun (`/tmp/p4-21-third-failures-rerun.log`, 106.86 seconds; 3 passed and 109
filtered-out cases). The migration took 11.67 seconds, the Chromium journey
65.36 seconds including its browser steps, and the slow-NATS case 7.70 seconds.
This check retains the original limits and does not replace a complete root gate.

The cleanup change then reproduced a concurrent-save race at the real conditional
append boundary: one refusal deleted the candidate and another retry returned
HTTP 200 with a missing key file. `/tmp/p4-21-red-custody-race.log` records 1 failed /
33 passed in 111.47 seconds. Cleanup now retains a candidate while its recorded
revision can still accept an in-flight retry. A configuration change makes that
reference obsolete; the rejected save or a stale original retry can then delete it.
Retired accepted references are removed as before. No lock or additional state was
added. One lint attempt was stopped with exit 143 to make this correction; that
interrupted attempt is not counted as a passing check.

The complete provider, secret and token set now passes all 38 tests in
119.17 seconds (`/tmp/p4-21-green-custody-race.log`). This includes a real
configuration conflict that deletes an obsolete candidate, and the concurrent
retry that must keep its candidate until acceptance.

## Own checks before main advanced — 5 October 2026

The final complete root run is **PASS**, exit 0: 1,629 passed / 15 skipped;
99 passed / 4 skipped files (103 total), 1,569.18 seconds. It started at integer
load 11, with no detected live-view qualification batch, and used
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`, `--maxWorkers=2`
and `nice -n 10`. The source stayed unchanged during this run.
`/tmp/p4-21-custody-root-final.log` retains the complete output.
All three failures from the third run pass inside this complete final run.
The earlier failed and interrupted runs remain recorded above.

| Check | Result |
| --- | --- |
| Full lint | PASS: code, dependencies, unused exports, documentation, links and fixtures |
| Workspace typecheck | PASS |
| Event catalogue | PASS: 92 matching types |
| Focused provider, secret and token set | PASS: 38 tests |
| Requested provider file | PASS: 34 tests inside the final root run |
| Requested gateway and gateway-start files | PASS: 80 and 2 tests; optional paid-call case NOT RUN |
| Requested authority and pricing files | PASS: 3 and 30 tests |
| Requested projection and services files | PASS: 11 and 2 tests |
| Complete root suite | PASS: 1,629 passed / 15 skipped |
| Fresh-install provider qualification and MOD screens | NOT RUN |

Final lint, typecheck and catalogue output is in `/tmp/p4-21-custody-lint.log`,
`/tmp/p4-21-custody-typecheck.log` and `/tmp/p4-21-custody-events.log`.
All checks ran under `nice -n 10`; the final Markdown and link checks also cover
this receipt and the updated ledger. All model calls used recording fixtures.
No paid model call, owner-stack change, Docker daemon/network change or new
dependency was involved. These source gates passed on main `ce0e07b` before the
newer main integration below. A live provider capability remains unqualified
until its complete fresh-install journey passes.

## Newer main integration — 5 October 2026

Main advanced during these checks to `cfbf50a`, adding ownership transitions,
live-view pause handling, the organisation shell and dev-stack journey selectors.
The second rebase completed: feature commit `629cdb5` and fix commit `c8c87a3`
are based on that main, which was checked as an ancestor.
Both provider and ownership registrations and subscriptions are preserved.
The shared membership helper now delegates to main's `currentMembership`, using
the caller's fence for both membership and ownership history and IAM receipts.
The catalogue check passes with 95 types. The preceding 92-type and complete-root
results describe the earlier base; latest-base validation follows separately.

The provider, secret, token, group, ownership, ownership-ordering and ownership
migration files pass all 72 tests in 77.21 seconds on the newer base
(`/tmp/p4-21-latest-focused.log`, two workers, required PostgreSQL URL and
`nice -n 10`). The provider regressions remain intact after the role-helper merge.

The first complete root run on this newer base is **FAIL**, exit 1:
1,664 passed / 1 failed / 15 skipped across 103 passed / 1 failed / 4 skipped
files (108 total), in 1,449.54 seconds. It started at integer load 7 with
no detected live qualification batch, the required PostgreSQL URL, two workers
and `nice -n 10`. All 34 provider tests and all active tests in the seven
requested files pass. The approval fence fixture received HTTP 503 instead of
200 while approving its initial request, before installing its fault injection.
`/tmp/p4-21-latest-root.log` retains the failure. That case passed unchanged
in isolation in 10.85 seconds (`/tmp/p4-21-latest-approval-rerun.log`, 1 passed /
26 filtered-out cases). This isolated pass does not replace a complete root gate.

The second complete root run on this base is **FAIL**, exit 1:
1,663 passed / 2 failed / 15 skipped across 102 passed / 2 failed / 4 skipped
files (108 total), in 1,208.19 seconds. It started at integer load 6 with
no detected live qualification batch and the same required PostgreSQL URL,
two workers and `nice -n 10`. `/tmp/p4-21-latest-root-second.log` retains the
complete output. All 34 provider tests pass again. The earlier approval fence
case passes in this complete run. The OpenFGA rebuild handover case exceeded
its existing 1,000 ms SDK read timeout; a different approval fixture received
HTTP 403 while reading its card before a decision. No timeout or assertion was
relaxed. These failures are not converted into a passing root gate.

Both cases passed unchanged in a serial targeted rerun in 16.84 seconds
(`/tmp/p4-21-latest-failures-rerun.log`, 2 passed / 36 filtered-out cases).
This does not turn either failed complete root run into PASS.

## Final own checks on main cfbf50a — 5 October 2026

| Check | Result |
| --- | --- |
| Full lint | PASS: code, dependencies, unused exports, documentation, links and fixtures |
| Workspace typecheck | PASS |
| Event catalogue | PASS: 95 matching types |
| Focused provider, secret, token, group and ownership files | PASS: 72 tests |
| Requested provider file | PASS: 34 tests in both newer-base complete root runs |
| Requested gateway and gateway-start files | PASS: 80 and 2 tests; optional paid-call case NOT RUN |
| Requested authority and pricing files | PASS: 3 and 30 tests |
| Requested projection file | PASS: 11 tests in first newer-base root; FAIL: 10 passed / 1 SDK timeout in second root; unchanged targeted case PASS |
| Requested services file | PASS: 2 tests in both newer-base root runs |
| Latest complete root suite | FAIL: 1,663 passed / 2 failed / 15 skipped |
| Unchanged targeted rerun of latest root failures | PASS: 2 cases; does not replace the root gate |
| Fresh-install provider qualification and MOD screens | NOT RUN |

The final source status is **PARTIAL** because the complete root gate on this
base remains failed. A green complete run and hosted CI are required before
landing. The full lint, typecheck and catalogue logs are
`/tmp/p4-21-latest-lint.log`, `/tmp/p4-21-latest-typecheck.log` and
`/tmp/p4-21-latest-events.log`. Documentation checks were repeated after these
receipt and ledger updates. Source remained unchanged during the newer-base
root runs and targeted reruns. Every lint, typecheck and test command used
`nice -n 10`; both complete root runs used the required PostgreSQL URL and
`--maxWorkers=2`, after the integer load fell below 16 and no live qualification
batch was detected. All model calls used recording fixtures. No paid call,
owner-stack change, Docker daemon/network change or new dependency was involved.
