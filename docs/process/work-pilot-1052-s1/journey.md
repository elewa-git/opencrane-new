# Ordinary third-party tool server journey

Date: 13 November 2026.
Checked source: `ec790fbe9625a5cfdc548931b929976b0c17bd53`.
Base: `1e85888428e91cec9a39bfada3b7f99649b61766`, including personal keys and installation naming.
Environment: separately claimed fresh secondary slot 1 for each attempt.
Each run used `claim.sh`, `up.sh --fresh` and `down.sh`.

## Result

Journey on the final rebased source: PARTIAL

At 1280 px, an admin installed the standard HTTPS demo, discovered its ordinary
MCP 2026-07-28 definitions, saved Allow and Ask, granted person and assistant access,
reviewed Needs no key and published. The member's real assistant turn returned the
quote, then an approved Ask call changed its delivery slot exactly once. Changing
the listed definition blocked the next live call and showed the admin-review reason.
Only two tool executions reached the recorder. The refused third call did not execute.

At 390 px, the first rebased startup passed but the slice collector failed sign-in.
The slice actions were NOT RUN. A separately claimed fresh diagnostic attempt failed
startup in the shared Spending budget editor before the slice collector started.
No authentication or budget fix is claimed. Both attempts were torn down successfully.
The complete 390 px slice previously passed before the latest main rebase; that
older PASS does not qualify the final rebased source. This capability remains blocked
on final rebased 390 px live qualification and needs the owner to direct further work.

| Person's action | 1280 px | 390 px on rebased source |
| --- | --- | --- |
| Admin enters the ordinary HTTPS address. | [PASS](run-2026-11-13-rebased/install-1280.png) | NOT RUN |
| Admin discovers definitions without OpenCrane declarations. | [PASS](run-2026-11-13-rebased/ordinary-definitions-1280.png) | NOT RUN |
| Admin saves Allow, Ask and both audience grants. | [PASS](run-2026-11-13-rebased/modes-and-access-1280.png) | NOT RUN |
| Admin reviews Needs no key. | [PASS](run-2026-11-13-rebased/review-1280.png) | NOT RUN |
| Admin publishes and sees the matching acknowledgement. | [PASS](run-2026-11-13-rebased/published-1280.png) | NOT RUN |
| Member receives the quote from a live ordinary read. | [PASS](run-2026-11-13-rebased/read-turn-1280.png) | NOT RUN |
| Member sees the ordinary Ask card. | [PASS](run-2026-11-13-rebased/ask-waiting-1280.png) | NOT RUN |
| Member approves and receives exactly one changed result. | [PASS](run-2026-11-13-rebased/approved-write-1280.png) | NOT RUN |
| Changed definitions block the next live call. | [PASS](run-2026-11-13-rebased/drift-refused-1280.png) | NOT RUN |

[1280 px observations](run-2026-11-13-rebased/observations-1280.json) ·
[390 px sign-in failure](run-2026-11-13-rebased/signin-failed-390.json) ·
[390 px diagnostic startup failure](run-2026-11-13-rebased/startup-failed-390.json).

The quote remained 12500 euro cents. That quote amount is not a tool charge.
At 1280 px, both remote reply records had `costStatus: not_reported` and no `costCents`.
The separate gateway receipt for the local refusal had no remote adapter or cost.
The shared checker requires exactly these three records and their evidence fields.
The wire records show MCP 2026-07-28, no session or private revision header and only
public protocol metadata. No thread, model, sandbox or client-version details left.

The browser used real development-organisation sign-in and shipped controls. The
full server, models and gateway processes used the existing guarded HTTPS test
transport and `apps/demo-mcp` in standard mode. The free stand-in requested the real
offered tools and quoted their actual results, including the refusal. It supplied no
successful quote or refusal itself. No live vendor or paid model was used. Slice screenshots
mask credentials and email addresses and retain the requested width.

## Cause and repairs

The original `protocol_refused` was caused by the temporary journey collector. Its
`preSerialization` hook called `appendFile` with an options object in place of the
data. Test-first commit `c6451b18d` (replayed as `f81e38bf1`) reproduced the real dispatch failure: tools/list
returned HTTP 200, then tools/call raised `ERR_INVALID_ARG_TYPE`, the demo error
handler returned HTTP 400, and dispatch returned HTTP 502. Recording runs after
execution, so missing recorder output did not prove that no call reached the tool.

The fixed collector writes a JSON line and the guarded standard launch imports that
checked-in implementation. The regression checks the actual quote, exact protocol
facts and changed-list refusal before another execution. Product dispatch, protocol,
revision, access, money and credential-release checks did not change in this round.
The declared-server safeguards and personal-key identity/release paths remain tested.

Test-first commit `af86ef566` (replayed as `d1147b313`) reproduced the stand-in losing the actual review reason.
Its parser now quotes a returned error only for the current call. It never repeats a
failed call or substitutes a successful result.

The first fresh attempt after that repair, source `14039774f`, passed every slice
browser action at 1280 px, including read, approval and drift. Its final evidence
check failed with `3 !== 2`, so its overall verdict remains FAIL; 390 px was NOT RUN.
[That attempt's observations](run-2026-11-13-cost-check/observations-1280.json) retain
the failure. Teardown exited 0 and released the slot.

Test-first commit `58a16deb2` (replayed as `834a60199`) reproduced that count through real gateway requests
and usage ingestion. Two records were remote replies. The third was the gateway
receiving OpenCrane's local drift refusal, with no remote start or cost claim.
The corrected checker requires both remote cost records and the separate local
receipt by their full fields. It rejects an invented seven-cent amount. Both widths
then passed on fresh stacks before the later main rebase. Those earlier observations
remain linked below and do not qualify the latest rebased 390 px attempt.

## Rebase onto the installation-name change

Both widths had already passed on `99e785779` with the previous base, `7ec65e982`.
[Those 1280 px observations](run-2026-11-13-final/observations-1280.json) and
[390 px observations](run-2026-11-13-final/observations-390.json) remain available.
While waiting for CI, main moved to `1e8588842`. GitHub reported a merge conflict
and created no checks for the old pushed head, `fca2431f3`.

Rebased onto that main commit. Only the development-stack diagram conflicted; its
installation settings and tool checks were combined. MCP dispatch, personal-key
paths and the regression code were unchanged. Main had changed the development
web launcher, so fresh qualification was repeated through that launcher.
`ORGANISATION_NAME=OpenCrane 2 Dev` set only the public installation label.

The added launcher/settings batch exposed an existing refusal fixture assumption.
With the runner's private umask, mkdir's requested mode 755 became mode 700. The
fixture was safe, so startup correctly accepted it. Test-first commit `1f4a86f1f`
forces umask 077 and checks the actual input mode; it failed with mode 700 instead
of 755. The fixture now explicitly applies its intended mode before testing refusal
and restores the process umask afterwards. All original refusal, no-repair and
secret-canary assertions remain. No runtime permission check changed.

The fixed settings suite passed twice. Removing the real directory-mode check in a
controlled mutation made the unsafe-directory refusal assertion fail. The exact
original guard bytes were restored before any rebased stack started. That mutation is
separate from the in-memory catalogue and cost-check mutations described below.

## Sign-in interruption during rebased qualification

The first rebased 390 px attempt passed startup but the separate slice collector
failed at sign-in before any slice action. Its [FAIL observation](run-2026-11-13-rebased/signin-failed-390.json)
is retained. All slice actions in that attempt were NOT RUN. Teardown exited 0 and
released the claim. The generic helper did not preserve the underlying reason,
so no authentication cause is assigned.

A further separately claimed fresh 390 px attempt used the same source. Safe sign-in
phase and status diagnostics were added only to the temporary collector, with the same
flow and 30-second limits. That collector never ran: startup failed in the shared
Spending budget editor. The [startup screenshot](run-2026-11-13-rebased/startup-budget-failed-1280.png)
shows unavailable spending evidence and budget service at 1280 px during the built-in
journey. The safe diagnostic records no budget or effect read status, an unavailable
budget service and no loaded spending section. The error points to the unchanged
`browser-budgets.ts` editor loader. This PR changes neither that loader nor its budget
routes. A causal connection to ordinary MCP dispatch was not established; the underlying
service failure remains unconfirmed. Private launcher diagnostics were preserved before
cleanup. No startup check, authentication rule, retry or timeout was changed. Teardown
exited 0 and released the claim. No further attempt was started in this final rework round.

## Own checks in this round

All tests, typechecks, builds and lint commands ran under `nice -n 10`. Database
tests used the supplied shared disposable PostgreSQL database. No full root suite
ran. The final test passes used one worker and ran serially.

| Own check | Verdict |
| --- | --- |
| Final ordinary dispatch, gateway evidence, standard demo and personal-key regressions | PASS: 12 tests across four files twice, 73.45 and 77.36 seconds. |
| Changed stand-in and launch tests | PASS: 14 cases twice. |
| Selected declared-server contract and revision guards | PASS: two cases; 239 other file cases NOT RUN locally in this round. |
| Replica isolation and cleanup | PASS earlier in this round: all three cases, 92.83 seconds; backend and fixture code unchanged by the latest main commit. |
| Workspace and infrastructure typecheck | PASS after the rebase, followed by an infrastructure repeat for the permission fixture. |
| Custody settings and directory permissions | PASS: five cases twice with the private-umask regression. |
| Updated development web launcher | PASS twice: the public installation name, Angular serving and native PDF response policy. |
| Event catalogue | PASS: 174 event types agree. |
| Knip, Markdown and changelog | PASS; Knip retains its existing two configuration hints. |
| Scoped ESLint | PASS for the changed code; infrastructure files are ignored by repository configuration. |
| Catalogue-comparison mutation | PASS: bypassing comparison executed a second quote and failed the required refusal assertion. |
| Evidence-comparison mutation | PASS: bypassing comparison failed the invented-amount refusal assertion. |
| Fresh-stack slice on rebased source | PARTIAL: 1280 px PASS; 390 px slice actions NOT RUN after sign-in and startup failures. |

The initial expanded 12-case batch passed, but its concurrent repeat was FAIL:
11 passed and the gateway write returned 403. The reason was not captured and is
not assigned a cause here. The test now includes the response body in diagnostics.
A focused diagnostic run passed; the two final serial passes above then passed
without weakening a product check or extending a deadline. An initial mutation run
failed during gateway fixture setup and is not counted as mutation proof. The later
isolated mutation reached and failed the intended amount assertion. The catalogue and cost-check mutations
used in-memory test transforms; repository source was not modified by them. The
separate directory-mode mutation above was restored byte for byte before qualification.

CI run 43481164833 originally failed in unchanged replica-fixture cleanup code.
No connection to this PR's ordinary dispatch changes was found. The underlying
cleanup error was swallowed, so its exact cause remains unconfirmed; it may be a
flake. The one requested rerun of job 132078016076 passed, as did `ci-ok` for that
old head. The final pushed-head CI result is recorded in the PR Evidence after
`gh pr checks 1122 --watch`; it is not a local-test claim in this receipt.

## Startup, teardown and scope

Before each final claim, the runner waited while one-minute load exceeded 10.
The successful 1280 px stack and first rebased 390 px stack passed their executed
built-in checks, including browser checks, projection replay and token boundaries.
Their built-in approval journey remains SKIP as reported by startup; the slice's
ordinary Ask journey ran separately and passed only at 1280 px on this source.
The additional diagnostic stack failed its built-in Spending journey before the
slice collector ran. All three `down.sh` calls exited 0 and released their claims.
The fleet marker remained set. No owner stack, Docker daemon
setting or other organisation was changed.

Rebased onto `1e8588842` and confirmed that no rebase state remained. Before the
final fresh journeys, the runner fetched origin again and required the current
main commit to be an ancestor of the checked source. No new main commit was pending.
The final receipt commit adds documentation and screenshots to the checked source.
Only the builder's own checks are reported here.

## Earlier failed run before the recorder repair

Checked source: `2520b29e909bebc17b08fbb5e5fc651992b36e18`.
Evidence head: `54dda84c8e55958844971befb29a51c57af90108`.
The diagnosis below was unconfirmed at that time; the cause is established above.

### Failed live read before the repair

Journey on a fresh dev stack: FAIL

The failing step was **member asks their assistant to call the reviewed ordinary read
tool in a live turn at 1280 px**. The transcript marked `read_fixture_quote` as Failed
and answered: “The demo tool did not return a quote.” The expected quote did not appear
within the collector's unchanged 120-second wait.

The models process logged `Remote tool exchange failed` with `protocol_refused`.
The recorder saved no `tools/call` entry. The later recorder reproduction above explains
why that was not proof that execution was refused before reaching the tool. The remote HTTP check uses
that reason for an unexpected status, a session header or an invalid content type.
The likely cause is a live HTTP protocol mismatch between dispatch and the synthetic
HTTPS fixture. The exact refused status or header was not captured, so the root cause
and whether it belongs to the product or the fixture remain unconfirmed.

The run stopped at that failure. No product fix, longer timeout or repeat of the failed
read was attempted. The ordinary Ask write, changed-list refusal, live metadata and
cost-record checks, and the entire ordinary-server journey at 390 px are **NOT RUN**.
The passing built-in stack journey does not qualify those missing slice steps.

[Failed live read](run-2026-11-13/read-failed-1280.png) ·
[Structured observations](run-2026-11-13/observations-1280.json).

### Browser steps

| Person's action | 1280 px | 390 px |
| --- | --- | --- |
| Admin enters an ordinary HTTPS server address. | [PASS](run-2026-11-13/install-1280.png) | NOT RUN |
| Admin discovers two definitions without OpenCrane declarations. | [PASS](run-2026-11-13/ordinary-definitions-1280.png) | NOT RUN |
| Admin chooses Allow and Ask and grants person and assistant access. | [PASS](run-2026-11-13/modes-and-access-1280.png) | NOT RUN |
| Admin reviews the definitions and selects Needs no key. | [PASS](run-2026-11-13/review-1280.png) | NOT RUN |
| Admin publishes and sees the matching acknowledgement. | [PASS](run-2026-11-13/published-1280.png) | NOT RUN |
| Member asks their assistant to read the quote in a live turn. | [FAIL](run-2026-11-13/read-failed-1280.png) | NOT RUN |
| Member approves an ordinary Ask write. | NOT RUN | NOT RUN |
| Server changes its list; the next call shows a review-required refusal. | NOT RUN | NOT RUN |

The browser used real sign-in in the development organisation and the shipped controls.
The server was `apps/demo-mcp` in standard mode, reached through the existing guarded
Stage B HTTPS transport. Discovery saved digest version 2. The free model stand-in
requested the real offered tools. A temporary collector adapter could quote the actual
review-required tool result; that later step was never reached. It supplied no successful
quote or refusal of its own. No live vendor server or paid model was used.
Screenshots contain no credentials or email addresses. The 1280 px pages fit their viewport.

### Startup and teardown

The first fresh startup passed its built-in journey, but a newline-escaping error in the
temporary collector prevented the slice fixture from starting. No slice browser action
ran in that attempt: NOT RUN. Its logs were preserved privately and `down.sh` released
slot 2. Only the collector was corrected, and its generated TypeScript parse check passed.

A new claim and a second `up.sh --fresh` then passed the built-in journey, including its
1280 px and 390 px checks, replay checks and token boundaries. The guarded standard
fixture started successfully. The slice then failed at the read described above.
`down.sh` exited 0 and released slot 2 again. The fleet marker remained set throughout.
No owner stack, Docker daemon setting or other organisation was changed.

### Checks after the rebase

Both sets of changed tests were run twice, including the personal-key tests from the
base branch. Tests, lint and typecheck ran under `nice -n 10`; tests that need PostgreSQL
used the shared disposable test database. No full root suite ran.

| Own check | Verdict |
| --- | --- |
| First targeted application/library pass, 38 files | FAIL: 1,770 passed, nine failed, one skipped; 3,462.36 seconds. |
| Unchanged second targeted application/library pass, 38 files | PASS: 1,779 passed, one skipped; 2,154.67 seconds. All nine earlier failures passed. |
| Changed infrastructure tests, both passes | PASS: 111 each, no skips; 675.31 and 377.12 seconds. |
| Changed web specs, both passes | PASS: 150 each across four files; 155.39 and 116.26 seconds including builds. |
| Existing approval browser case gated by `APPROVAL_BROWSER=1` | NOT RUN locally. |
| Root workspace and infrastructure typecheck | PASS. |
| Event catalogue | PASS: 174 event types agree. |
| Knip, Markdown and changelog | PASS. |
| Changed-file ESLint | PASS after routing unchanged schema exports through their owning module. The existing outer catalogue-watch size warning remains; infrastructure is ignored by configuration. |

The first application pass failed at the Angular dev-server build limit, two gateway
responses containing an upstream error instead of JSON, and six routine send cases that
did not reach their expected hooks or result. The unchanged repeat passed all nine.
No product timeout or behaviour was changed. These passing tests do not turn the live
slice failure into a PASS.

The rebase retained both demo modes and the unchanged default, verified-key release,
ordinary catalogue validation and cost recording. Shared credential scanning still uses
one implementation. A combined event-schema file exceeded its existing limit by one
line; the public exports and registry now import the same schemas from their existing
module. No schema validation or size limit changed.

## Earlier guarded attempt

An earlier source (`207644124155fadf0e67d0373fe427fccfdbba48`) could not start the browser
journey because the old guard refused the fleet marker. It was recorded as NOT RUN and
its secondary stack was released. The earlier source checks below predate this rebase;
they do not qualify the current failed journey.

## Earlier source checks

These checks do not substitute for the browser journey.

| Check | Observed outcome |
| --- | --- |
| Complete dispatch and gateway-access regression batch | PASS: 253 tests, one worker, 1179.72 seconds. |
| Repeated changed/schema/dependency batch | PASS: 547 tests; the earlier corresponding batch passed 546 without the separate dependency case. |
| Changed ordinary, privacy and certificate cases | PASS: 13 focused cases before the complete regression batch. |
| Gateway-access file after restoring sanitised diagnostics | PASS: 23 cases before the complete regression batch. |
| Event registry and examples | PASS: 355 tests. |
| Snapshot, inventory and event-field security checks | PASS; the initially skipped database condition was subsequently exercised in the PostgreSQL replay run. |
| PostgreSQL catalogue replay | PASS: all 11 cases with the supplied disposable test database. |
| Web tests and repeated changed spec | PASS: 1,556 full web tests and all 8 initial-review tests on repeat. |
| Production web build | PASS, with existing stylesheet and CommonJS warnings. |
| Typecheck | PASS: root workspaces and infrastructure; subsequent changed models/server checks also passed. |
| Root workspace and infrastructure typecheck | PASS. |
| Event catalogue | PASS: 174 event types agree. |
| Knip, Markdown and changelog | PASS. |
| Knip, changed-file ESLint, Markdown and changelog | PASS; changed-file ESLint has no warnings. |
| Fixture boundary, package licences and offline links | PASS. |

The wire checks use a real recording HTTPS server, NATS, PostgreSQL and the gateway.
They check standard calls, Ask approval, catalogue drift before execution, complete
paginated lists, exact outgoing metadata and preserved argument number text.
Cost records distinguish reported integer cents from missing or invalid reports.
The default demo catalogue digest and declared-server safeguards remain checked.

An earlier regression run caught raw dependency error text added during cleanup.
The original sanitised diagnostic contract was restored; private canary assertions
remain unchanged. Certificate refusal cases now hold local validation clocks steady
while network timers remain real. Separate cases still check permit and access expiry.
No product timeout or lint limit was raised.

Manual guard mutations failed the matching tests: catalogue comparison, metadata
stripping, declared-server unknown cost, cost-record consistency and certificate
verification. Both certificate tests returned 200 instead of the required refusal
when verification was removed. All five mutations were restored.

## Second fix round

Checked source: `0b4cc6ffa`. The slice changes 1,400 shipped source lines, including
the Odoo source deletion. Tests and documents are excluded.

The legacy replay test failed with `Tool catalogue digest mismatch` before the fix.
The review script reproduced the failure too. After the fix, the adapted script reads
old dated history followed by a new discovery. A PostgreSQL test also rebuilds the
projection before and after that new discovery and compares the saved catalogue.
Unversioned stored events keep accepted-only digests during reads and rebuilds.
New discoveries save `digestVersion: 2` and validate accepted and rejected tools. Replay changes no saved events.

Money status checks permit only the three fixed report states. Numbers, unrestricted
strings and an extra enum value still fail under `costStatus`. Forwarding tests assert
the complete public request body and exact approved argument number text. Routine
fixtures now use the generic identities in their event examples. The original pinned
image inventory is restored; the historical image evidence is unchanged.

Four isolated mutations caused six expected test failures: checking old events with
the full-list rule, ignoring rejected revisions for new events, allowing amounts under
the report-status name, and forwarding agent metadata. Transforms affected only the
test processes; repository source was not changed by the mutations.

| Own check | Verdict |
| --- | --- |
| Final replay and money tests | PASS: 33 tests on each of two consecutive runs. |
| Event schemas, examples and replay | PASS: 1,238 tests. |
| Named CI regressions | PASS: 11 focused cases. |
| Ordinary classification and full-list dispatch drift | PASS: six cases. |
| Historical image licence evidence | PASS: 80 tests on each of two runs. |
| Root workspace and infrastructure typecheck | PASS. |
| Event catalogue, Knip, changelog and Markdown | PASS. |
| Changed-file ESLint | PASS: no warnings. |
| Process evidence and qualification index consistency | PASS; this checks records, not live behaviour. |

The PR's Evidence section records the longer targeted regression runs and the hosted
CI result for the final head. These checks do not qualify the browser journey.

Journey: NOT RUN until PR #1119 is repaired. A browser PASS at both widths remains
required before merge.
This receipt reports only the builder's own checks.

## Third fix round

Checked source: `3d3b2ded5`. The slice changes 1,439 shipped source lines, including
354 lines deleting the Odoo source. This repair adds 39 source changes to the earlier
1,400-line count. Tests and documents are excluded.

New appends and fresh captures use `validateNewMcpCatalogue`. It requires digest
version 2 and checks accepted and rejected tool revisions. Removing dates cannot bypass validation. Only stored-history
reads use `validateStoredMcpCatalogue`, which keeps the original accepted-only rule
for unversioned saved events. The schema still parses those older records.

The regression tests were committed before the fix. Three unversioned append cases
and an undated v2 accepted-only digest were incorrectly saved. The downgrade followed
by rejected-sibling removal reached `tools/call`. After the fix, the append is refused
without changing saved history, and the subsequent changed list blocks execution.
The replay test seeds an already stored legacy event, then appends a fresh v2 discovery
and rebuilds PostgreSQL. The original saved events remain identical.

Two manual mutations checked test strength. Removing the version requirement failed
the unversioned full-list test. Routing append through the stored-history validator
failed the three downgrade append cases and reached `tools/call` in the dispatch test.
Both source mutations were restored before final checks.

New-event fixtures also use v2, including the dev-stack catalogue builder. Its added
regression failed at the public append before the marker was added. It now saves the
catalogue and stops before any browser operation. Other affected fixtures were refused
by the new guard; their markers now match the current write contract. Empty lists use
the empty-list digest instead of an image digest. All existing refusal assertions remain.
The first hosted run of this round failed on those outdated fixture writes. The register
and inventory tests now seed their incomplete old catalogues as stored history and check
the saved events exactly; their current discoveries still use the normal append guard.
Snapshot integrity probes also use v2 so their refusals still test definitions and hashes.

The reviewer append/rebuild probes pass unchanged: four cases with the disposable
PostgreSQL test database. The downgrade dispatch regression uses the public conditional
append; a stored-history fixture deliberately bypasses that interface.

| Own check | Verdict |
| --- | --- |
| Targeted append, dispatch, declarations, watch and replay regressions | PASS: 129 tests on each of two consecutive runs (71.24 and 68.52 seconds). |
| New-event fixture regressions | PASS: 106 tests on each of two runs (70.81 and 71.41 seconds). The journey builder also passed a separate repeat. |
| Register and member inventory regressions | PASS: 96 register and 27 inventory cases twice; the register Chromium case was not selected locally and remains covered by hosted CI. |
| Bridge replay and routine expiry regressions | PASS: 84 cases on each of two runs (81.95 and 83.58 seconds). |
| Snapshot integrity probes with current write markers | PASS: 34 cases twice. |
| Selected Memory preview regressions | PASS: three cases on each of two runs; other file cases were not selected. |
| Reviewer append and rebuild probes | PASS: four cases. |
| Offline approval-evidence checks | PASS: 28 tests. |
| Selected watch restart and renewal cases | PASS: three cases; the remaining file cases were not selected. |
| Root workspace and infrastructure typecheck | PASS. |
| Event catalogue | PASS: 174 event types agree. |
| Knip, Markdown and changelog | PASS. |
| Knip, Markdown, changelog, process/privacy checks and secret scan | PASS. |
| Changed-file ESLint | PASS: no warnings in changed functions. The untouched outer watch function retains its existing size warning; infrastructure is excluded by repository configuration. |

Journey: NOT RUN, explicitly deferred until PR #1119. No stack was claimed in this
round. The earlier stack was released. Fresh-stack browser PASS at 1280 and 390 px
matching the final source remains required before merge.
