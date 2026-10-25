# Budget approval retry

Part of #576. Local source work on 25 October 2026. Initial checks used `c2115e9f7`
on main `170bc4d4a`. The branch then rebased onto main `90ec96bc6`, after #695 merged.
Dispatch code and HTTP tests were unchanged by that rebase. The models documentation
keeps the company opt-in contract and adds this retry behaviour.
Fresh-install qualification: **NOT RUN**. Historical failures are retained below.
The [follow-up diagnosis](diagnosis.md) records the failing-first reproduction and correction.
The follow-up first rebased onto `11ed0475a`, then onto `e063b98f1` after main advanced.
The final rebase kept both company opt-in documentation and approval retry documentation.
The retry production and test files are byte-for-byte unchanged by that final rebase.
The base is an ancestor and the rebase finished. The test-first and fix commits are now
`f076abbbd` and `cda88344d` (originally `3fb8584f1` and `0c0b02438`).
The [real-clock follow-up](follow-up-races.md) passed all 60 races, including the
saved refusal outcome and exact consent-use, budget-admission and upstream-send counts.

## Behaviour

HTTPS dispatch saves its start before budget admission. A refusal before opening the
upstream connection can close that confirmed start with existing `not_dispatched`
and `adapter_dispatch_refused` evidence. The existing approval checks then allow an
explicit replacement use. The old permit stays consumed. Nothing resends automatically.

Evidence reads, save and readback share a separate one-second limit. This only saves
proof; it never extends permission to send. Missing or uncertain proof keeps retry
unavailable. Diagnostics contain fixed stage and reason labels and elapsed timings.
They contain no caught exceptions, arguments or permits.

The races use the existing free-tool fixture: no money is reserved or settled.
Each checks one upstream send, one successful retry and one competing refusal,
exactly two saved approval uses and one saved budget admission. Later retries send
nothing. Paid lost-reply holds and root recovery beyond deduplication retain their
unchanged regressions.

## Follow-up local checks

These checks use the supplied PostgreSQL test service at port 55432 and disposable
NATS, gateway and OpenFGA fixtures. The test service remains running; each fixture
creates and removes its own databases and processes. All suites, lint and typecheck
run under `nice -n 10`. No full root suite or live stack is started.

| Check | Result |
| --- | --- |
| Full lint, including knip and changelog | PASS; final receipt formatting corrected separately |
| Full typecheck | PASS before and after the final rebase |
| Event catalogue | PASS, 154 matching types |
| Separate knip and changelog commands | PASS |
| Real-clock approval races | PASS, 60/60 |
| Complete changed HTTP file | PASS twice, 23/23 each |
| Unchanged call-retry and root-budget files | PASS, 21 and 22 cases |
| Complete MCP dispatch file | PASS, 180 cases |
| Complete memory dispatch file | PASS, 94 cases |
| Both authority files | PASS, 6 cases |
| Unchanged event security rules | PASS, 438 cases |
| Nine-file broader batch | FAIL: 857 passed, one failed, one opt-in browser skip |
| Isolated approval-renewal reproduction | PASS unchanged |
| Post-rebase approval and HTTP files | FAIL: 96 passed, one failed, one opt-in browser skip |
| Post-rebase complete changed HTTP file | PASS, 23/23 |
| Isolated post-rebase audit refusal | PASS unchanged |
| Fresh-install qualification | NOT RUN |

The broader failure was the first call in “checks waiting approval after failed
and renewal”, before a card was created or the renewal was attempted. It returned
`Request refused or decision service unavailable` instead of an approval id.
The same case then passed unchanged on its own. Its underlying cause is unproven;
the focused pass does not clear that failed batch or establish a host-load cause.
The [diagnosis](diagnosis.md) separately retains the earlier mixed-clock probe and
the evidence-helper failure, with their follow-up checks.

The post-rebase failure was “refuses audit approval with zero upstream effects”,
which exceeded its existing 40-second test limit. The log does not identify which
await stopped progressing. The approval-renewal case passed in this run. Neither
the timeout nor the earlier initial-call refusal is attributed to host load.
The audit-refusal case then passed unchanged on its own. Both failed batches
remain recorded, and source validation is **PARTIAL**.

The two passing changed-file runs are the HTTP file within `targeted-1.json` and
`changed-final.json` in `/tmp/budget-approval-fix/`. The earlier `changed-2.json`
run had 22 passes and the evidence-helper failure; it is not counted as a pass.
The money-safety test files and `CHANGELOG.md` have no diff from main.

## Earlier local checks

Only isolated fixtures run. No owner stack or real model is used. Tests use a disposable
PostgreSQL 17.6 container, NATS, OpenFGA and the pinned gateway. Tests, lint and typecheck
run under `nice -n 10`. No full root suite is run.

- **PASS:** clean `npm ci` after moving aside an incomplete dependency directory.
- **FAIL, expected:** both HTTP regressions before implementation, committed as
  `f22000076`. The saved-start case already had a budget admission. The budget-refusal
  case had only the decision, without a start or unsent proof.
- **PASS:** full lint, including knip and changelog; all workspace and infrastructure
  typechecks; event catalogue, with 153 matching types.
- **PASS:** six focused HTTP cases: both retry races and four incomplete-proof refusals.
- **FAIL:** the broader six-file batch had 755 passes, one skip and one failure.
  The skip is the existing opt-in approval browser check.
  The unchanged MCP case “refuses a Block saved during the access read” timed out
  after 30 seconds. Its pause waits for a particular policy-read count. The same
  case passed unchanged in a focused run. That does not identify the timeout's cause
  or clear the failed batch; no host-load cause is established.
- **PASS:** event security rules and the unchanged call-retry and root-budget files
  within that broader batch. The forged-proof, changed-binding, lost-reply and
  revocation cases also passed.
- **PASS:** [both races repeated 30 times](races.md), 60/60 cases, using separate runs
  and fresh fixtures. These are source checks, not fresh-install qualification.
- **FAIL:** the second changed-file run had 20 passes and one cleanup timeout in
  “keeps approval retry unavailable after missing observation”. Its assertions
  completed, but `setup.close` exceeded the 30-second hook limit. The case passed
  unchanged in a focused run; the original cleanup failure remains unresolved.
- **PASS:** post-rebase documentation, README, link and changelog checks; the event
  catalogue now has 154 matching types after #695.
- **PASS:** full post-rebase typecheck and all 438 event-security cases.

At that point, local source validation was **PARTIAL**, because both failed full-file runs
remain recorded above. Their focused passes do not clear those failures. The
throwaway database and its volume were removed after the checks.

The first setup attempt lacked the pinned gateway binary; no product result was
claimed. The normal pretest script supplied it. During implementation, an explicit
infinite append deadline caused a 503 after a sent reply. The event store correctly
rejects that value. Optional deadlines are now omitted unless finite. The initial
no-connection assertion also overlooked the fixture's two discovery connections;
it now checks that the refusal adds none. The subsequent six-case run passed.

## Retained failures

The earlier 29/30 saved-start run included `access_deadline_expired` at `final_access`,
675 ms into dispatch. That explains why it refused, but not why the shared allowance
was exhausted. The later budget-writer run also passed 29/30; run 15 returned two
403 responses. Its underlying cause remains unresolved.

The retained 53/60 run had seven unexpected retry refusals across runs 3, 4, 5, 6, 8
and 15. Both calls returned 403 when one should have succeeded. Two further diagnostics
reached the original access deadline. They do not establish the cause of all seven
failures. These remain **FAIL**, not proven timing issues. A passing local repetition
cannot explain or erase those historical results.

These historical reports contain no per-request trace. The follow-up records a
reproducible cause of the same two-403 result and checks its correction; it cannot
recover which original request consumed consent in each of those seven runs.
Fresh-install qualification remains **NOT RUN**. No capability-done claim is made.

## Reproduction

The broad batch ran `nice -n 10 npx vitest run` with two workers against:

- `apps/server/test/integration-access-gateway.test.ts`
- `libs/models/test/mcp-dispatch.test.ts`
- `apps/server/test/approvals.test.ts`
- `libs/models/test/call-retry.test.ts`
- `libs/models/test/root-budget.test.ts`
- `libs/events/test/security-rules.test.ts`

The race command ran 30 separate times, with the disposable database supplied through
`PG_TEST_URL` and one JSON report retained per run:

```sh
nice -n 10 npx vitest run apps/server/test/integration-access-gateway.test.ts \
  -t 'restores one approval retry' --maxWorkers=1 --fsModuleCache \
  --reporter=json --outputFile=<temporary-evidence>/run.json
```

Only fixed case labels, results and timings are copied into the published race table.
