# Ordinary third-party tool server journey

Date: 13 November 2026.
Attempted source: `207644124155fadf0e67d0373fe427fccfdbba48`.
Later changes alter catalogue write validation and replay, full-list classification,
approval cards and cost report checks. This attempt does not qualify those changes.
Environment: secondary development slot 2, started with `up.sh --fresh`.

## Result

Journey on a fresh dev stack: NOT RUN

`requireAutomatedJourney` in [the journey guard](../../../infra/dev-stack/journey-guard.ts)
refused the inherited `OPENCRANE_FLEET_TASK` marker:

> Automated journeys require a secondary stack and no fleet task

The marker was preserved. No browser journey ran and no screenshots were captured.
The owner deferred another attempt until the main repair in PR #1119. The final source
still needs a fresh secondary stack and browser checks at 1280 px and 390 px.
Website readiness was an HTTP check; it does not prove a person's journey.

## Stack attempt

Both slots were initially busy. Retrying the claim obtained slot 2.
The Zitadel setup credential was supplied by path only. No credential or raw private
stack log is included here.

| Operation | Observed outcome | Verdict |
| --- | --- | --- |
| `infra/dev-stack/claim.sh` | Claimed secondary slot 2. | PASS |
| `infra/dev-stack/up.sh --fresh` | Bootstrap, managed provider setup and website readiness completed; the automatic journey guard then refused. Exit 1. | FAIL |
| `infra/dev-stack/status.sh` | Command exited 0 before teardown. | PASS |
| Explicit `requireAutomatedJourney` check | Refused the fleet marker again. Exit 1. | NOT RUN |
| `infra/dev-stack/down.sh` | Exit 0; the slot directory and process records were removed. | PASS |

## Browser steps

| Person's action | 1280 px | 390 px |
| --- | --- | --- |
| Admin installs a standard HTTPS server without OpenCrane declarations. | NOT RUN | NOT RUN |
| Admin reviews each tool and saves Allow, Ask or Block. | NOT RUN | NOT RUN |
| Admin publishes the review and grants member and assistant access. | NOT RUN | NOT RUN |
| Member asks their assistant to call a reviewed tool in a live turn. | NOT RUN | NOT RUN |
| Server changes its list; the next call is refused with a visible review reason. | NOT RUN | NOT RUN |

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
| Knip, Markdown, changelog, process/privacy checks and secret scan | PASS. |
| Changed-file ESLint | PASS: no warnings in changed functions. The untouched outer watch function retains its existing size warning; infrastructure is excluded by repository configuration. |

Journey: NOT RUN, explicitly deferred until PR #1119. No stack was claimed in this
round. The earlier stack was released. Fresh-stack browser PASS at 1280 and 390 px
matching the final source remains required before merge.
