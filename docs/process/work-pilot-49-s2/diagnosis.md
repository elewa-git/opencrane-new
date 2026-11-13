# Concurrent personal release diagnosis

Date: 13 November 2026. Source: `51af08697` on `work/pilot-49-s2`.
Diagnosis only, under the owner's “Diagnose first” decision. No product fix.
The slice remains unqualified. The two-fix stop remains in force.

## Main finding

The shared budget writer serialises both requests' first slow receipt checks and
repeated live checks inside a two-second admission deadline; caching receipts
within each dispatch does not remove that queue wait or the stream-position work.

The two seconds do **not** bound a whole turn or a whole personal dispatch.
`decision.ts` issues a personal permit for at most 30 seconds and passes an infinite
original access deadline to dispatch. Each `confirmToolAccess` creates a new,
two-second authority check. `BudgetActor.admitDispatch` independently starts a
two-second deadline **before** entering its shared queue. The credential broker
starts another short check after loading its evidence. These distinctions explain
both successful dispatches longer than two seconds and the observed early refusals.

## Measurement method

Used the real branch's NATS, shared disposable PostgreSQL, OpenFGA, HTTPS remote,
budget writer, conditional appends and broker. Retained the latency test's actual
400 ms delay after each `checkApplied` reply; parallel receipt checks still share
elapsed time. No deadline, retry, permission rule or event changed.

Temporary function probes used monotonic time for durations and UTC for timestamps.
They recorded function names, outcomes and timings, never arguments or material.
Measured 20 uncontended requests, then 20 pairs with a fresh fixture for each pair.
Uncontended samples reused one fixture; their small histories therefore grew.
The pair samples used the original concurrent send order, A followed immediately
by B. Measurements include ordinary shared-host scheduling and service wait.
The observed host load varied; these are local results, not a capacity promise.

[Per-request measurements](diagnosis-test-requests.csv) and
[per-request step timestamps](diagnosis-test-steps.csv) include all 60 requests.
The test seeds turn-start events; it does not execute a model turn. Its timed
request begins at the real dispatch handler. Live turn-start timing is separate.
The step file includes each receipt batch, stream-position read, permission phase,
budget admission, conditional append, lock acquisition and credential send.
Parent and child spans overlap; their durations must not be added. Seven spans
were still pending when a timed-out handler returned; their durations are blank.
Their later completion is not invented or included in phase-duration totals.

The figures below are median / 95th percentile / maximum in milliseconds. Used
nearest-rank percentiles. A release time includes successful releases only;
refusals are reported separately. A phase not reached is absent, not a zero.

| Phase | Single, 20 requests | Pair A, 20 requests | Pair B, 20 requests |
| --- | --- | --- | --- |
| Dispatch start to release | 1560 / 2095 / 2147 | 1750 / 2191 / 2640 | 2561 / 3574 / 3574 |
| Complete handler, including refusal | 1602 / 2188 / 2266 | 1844 / 2228 / 2729 | 2468 / 3174 / 3639 |
| Waiting for budget queue | 0 / 0 / 0 | 0 / 2 / 3 | 674 / 849 / 856 |
| Elapsed excluding budget queue wait | 1602 / 2188 / 2265 | 1843 / 2228 / 2729 | 1809 / 2448 / 2783 |
| Budget admission, including queue wait | 688 / 854 / 858 | 682 / 853 / 857 | 1674 / 2002 / 2039 |
| Projection receipts, overlapping reads counted once | 413 / 422 / 424 | 413 / 454 / 461 | 429 / 471 / 477 |
| Stream-position reads, overlapping reads counted once | 415 / 506 / 596 | 512 / 644 / 819 | 456 / 653 / 731 |
| IAM permission reads, overlapping reads counted once | 153 / 190 / 199 | 150 / 185 / 208 | 158 / 240 / 251 |
| Conditional append spans, including their checks | 219 / 318 / 510 | 284 / 460 / 467 | 314 / 485 / 615 |
| Profile lock acquisition | 4 / 8 / 11 | 4 / 12 / 15 | 3 / 28 / 28 |
| Credential access check to send | 356 / 668 / 731 | 581 / 788 / 1029 | 324 / 657 / 657 |

A released 20/20 times; B released 16/20. All four refusals were
`Budget append unavailable`, before the broker or custody read. B's measured
queue waits for these failures were 702, 849, 674 and 758 ms. The budget deadline
was observed at 1999–2039 ms; timer/scheduler lateness grants no successful release.
The measurement runner completing is not a passing concurrency acceptance test.

A single request was not close to exhausting either short window in these samples:
its slowest budget admission left 1142 ms and its slowest credential check left
1269 ms. Its whole dispatch could nevertheless exceed two seconds. Do not compare
whole-turn or whole-dispatch duration directly with an individual authority window.

`withConnectionStage` hashes silo, person, server and profile, so these people do
not contend for the same advisory lock. There is no deliberate cross-person
credential lock. The profile-lock measurements include pool checkout and database
round trips; shared service/scheduler contention cannot be attributed exactly to
one other request. “Elapsed excluding queue wait” includes that uncertainty, not
just CPU execution. The directly attributable wait is the budget queue.

The budget writer also repeated conditional appends: A made 21 attempts across 20
requests, while B made 30, with up to three attempts for one admission. The store
binds an access check to a global log position. Another append between that check
and publication can require recovery and another live check. This is additional
contention, not another advisory lock; dropping that precondition would require a
security redesign. The timing probes retain each attempt but do not record its
returned NATS conflict classification, so this attribution is a code-supported
explanation rather than a measured per-conflict cause.

The control without any product probes used another ten fresh pairs. Its 20
responses were 13 HTTP 200 and seven HTTP 403. This rules out an instrumentation-only
failure. It ran under higher host load, so it does not estimate probe overhead.
The [control records](diagnosis-control.json) retain each pair's start, duration
and status. An earlier control omitted status collection and is not used as proof.

“Release” in this timing table means handing credential material to the send
callback. The audit event is saved earlier; it does not prove the remote tool ran.
The step file retains the audit append separately. A gateway permit is issued in
authorisation, before dispatch. There is no additional credential-lease queue:
the signed personal permit is single-use and bounded by 30 seconds and current
policy expiry. Exact live permit timing is recorded separately below.

## Catalogue investigation

The retained failed run started A at 19:10:57.891 and B at 19:10:59.375 UTC.
Their model authorisations succeeded. No MCP decision, MCP admission or credential
release followed. Therefore this run did not exercise the release latency failure.

The saved read showed top-level freshness 19:10:34.121–19:15:34.121, while the
embedded discovery retained 19:05:59.932–19:10:59.932. `applyCheck` intentionally
updates top-level dates without replacing the saved tool definitions. Availability
reads use those top-level dates. `turnToolReaders` never uses embedded discovery
dates to decide availability. Bearer identity verification has no five-minute
account expiry; its saved account expiry is `Number.MAX_SAFE_INTEGER`.

A real-service control saved and selected a verified personal key, appended a valid
unchanged catalogue renewal, advanced only the control's clock beyond the embedded
discovery expiry, and called the real turn-tool readers. They still offered one
server. PASS: the timestamp mismatch alone does not remove the tool.
No product clock was changed in a stack. The original catalogue read was taken at
19:14:10.696, after the failed turns; it cannot establish every intervening state.
The retained event extract omits catalogue checks and tool execution output, so it
cannot identify the historical pre-MCP failure by itself.

The bridge has a separate 1000 ms tool-build limit in `bridge-conversation.ts`.
`toolsForMessageOrEmpty` catches a build failure or timeout, logs `build_failed`,
and caches an empty list for that turn. The model can then complete without making
an MCP request. The free model's deferred-tool helper refuses a list without
exactly one matching read tool, and its answer reports no quote.

A focused control through the real bridge code made an otherwise successful IAM
check take 1100 ms. The first turn frame contained no tools; a later resend retained
the empty list after the permission work completed. PASS: this mechanism reproduces
an empty offer without a failed membership or changed catalogue. This control uses
the bridge test's synthetic store and IAM boundary, not a live stack.

## Fresh live measurements

Claimed slot 1 through `claim.sh` at one-minute load 8.98. Started with
`up.sh --fresh`; startup qualification and health checks passed. Its bundled Ask
journey was skipped by the existing runner: NOT RUN, outside this diagnosis.
Waited again before the guarded TLS launcher; its launch load was 9.93. Subsequent
host load varied during measurement and was not held constant. The two personal
computers, real sign-in, product controls, NATS, PostgreSQL, OpenFGA, gateway,
credential custody and demo server were real. Only the model and remote transport
used the existing guarded local fixtures. No paid provider was called.

The collector's first lookup preceded asynchronous discovery, and its publication
screen did not refresh after its status check. Continued the original discovery
and read the original publication as `ready`. Neither registration nor publication
was repeated. Both people then verified and selected separate synthetic keys through
My tools and completed plain warm-up turns.

Retained all planned samples: 20 simultaneous pairs and 20 single turns, at 1280 px.
No failed sample was retried into a pass. The outcomes were:

| Live outcome | Paired turns, 40 | Single turns, 20 |
| --- | --- | --- |
| Own account returned | 25 | 10 |
| Tool list hit its one-second build deadline; no MCP request | 14 | 10 |
| MCP reached the broker, but release was refused | 1 | 0 |

These are measurements, not a passing slice journey. Revocation and mobile
qualification remain NOT RUN in this diagnosis.

The following figures are median / 95th percentile / maximum in milliseconds.
Tool-build and first-model figures include all submitted turns. MCP phases include
26 paired requests and ten single requests that reached dispatch; release-to-send
figures include only the 25 and ten successful sends. Missing phases are censored,
not zero. With ten successful single releases, the nearest-rank 95th percentile
is the observed maximum.

| Live phase | Single | Paired |
| --- | --- | --- |
| Message posted to credential send | 7702 / 8366 / 8366 | 8785 / 10531 / 12147 |
| Agent turn-start event to credential send | 5878 / 6529 / 6529 | 6607 / 8080 / 8807 |
| Message posted to tool-build start | 388 / 546 / 2121 | 542 / 1469 / 1742 |
| Tool-list build | 998 / 1021 / 1022 | 911 / 1024 / 1027 |
| First model authorisation | 425 / 634 / 716 | 491 / 794 / 1039 |
| Budget queue wait in that first model authorisation | 0 / 0 / 0 | 0 / 255 / 401 |
| MCP authorisation | 1240 / 1441 / 1441 | 1174 / 1483 / 1515 |
| Budget queue wait in MCP authorisation | 0 / 0 / 0 | 0 / 9 / 34 |
| Gateway permit creation | 1 / 4 / 4 | 1 / 3 / 3 |
| Dispatch start to credential send | 1852 / 2142 / 2142 | 2307 / 3052 / 3075 |
| Dispatch elapsed excluding budget queue wait | 1935 / 2245 / 2245 | 2446 / 3152 / 3174 |
| Budget admission, including queue wait | 429 / 531 / 531 | 611 / 941 / 1021 |
| Waiting for budget queue during dispatch | 0 / 0 / 0 | 0 / 9 / 31 |
| Projection receipts during dispatch | 54 / 77 / 77 | 50 / 118 / 326 |
| Stream-position reads during dispatch | 371 / 467 / 467 | 520 / 716 / 793 |
| IAM permission reads during dispatch | 394 / 769 / 769 | 621 / 864 / 866 |
| Conditional append spans during dispatch | 274 / 324 / 324 | 504 / 728 / 887 |
| Profile lock acquisition, including pool wait | 54 / 158 / 158 | 52 / 146 / 146 |
| Credential material read | 76 / 130 / 130 | 137 / 251 / 451 |
| Credential access check to send | 598 / 765 / 765 | 1061 / 1277 / 1417 |

The slowest successful uncontended live admission left 1469 ms of its two-second
budget window. Its slowest credential check left 1235 ms. Whole dispatches above
two seconds therefore do not by themselves establish a broken authority deadline.
All 35 saved credential leases had a 30,000 ms lifetime. They were not extended.

Ten of the eleven pairs that both reached dispatch overlapped there, by 318–2151 ms.
Gateway calls nevertheless often arrived apart, and their budget sections usually
did not overlap. The maximum measured dispatch queue wait was 31 ms; the first
model authorisation could wait 401 ms. These live figures do not contradict the
HTTP test's 674 ms median B wait: that test deliberately adds the 400 ms receipt
work before either admission can leave the shared writer. The gap before tool
assembly includes polling, projection progress and preparation; it is not measured
as a wait exclusively caused by the other person.

[Live requests](diagnosis-live-requests.csv) join each turn, authorisation, permit,
dispatch and release by conversation and request id. [Step timestamps](diagnosis-live-steps.csv)
retain the underlying probes. [Saved events](diagnosis-live-events.json),
[catalogue samples](diagnosis-live-samples.json) and
[model observations](diagnosis-model-observations.jsonl) preserve the independent
readbacks without keys, request bodies or private text.

A credential audit's event `time` is set from the lease's `issuedAt`, not its
physical append time. The request CSV therefore keeps `releaseAuditEventTime`
separate from the probe's client-observed `releaseAuditConfirmedAt`. Use saved
positions for event order and the timed append spans for latency.

## Reproduced missing MCP request

The first live pair reproduced the retained run's symptom before the embedded
catalogue expired. B's timeline was:

| UTC on 13 November | Observation |
| --- | --- |
| 20:30:19.538 | Message posted |
| 20:30:20.105 | Tool-list build started |
| 20:30:20.209 | Server policy read started; completed in 44 ms |
| 20:30:20.252 | Person permission read started; completed in 55 ms |
| 20:30:20.308 | Assistant permission read started; completed in 133 ms |
| 20:30:20.440 | Selection read started |
| 20:30:20.767 | Selection access check started; completed in 332 ms |
| 20:30:21.098 | Final server-expiry read started and was still pending at cutoff |
| 20:30:21.105 | One-second build deadline fired; offer became empty |
| 20:30:21.433 | Agent turn-start event |
| 20:30:21.625 | Computer turn-start event |
| 20:30:24.514 | First model decision allowed |
| 20:30:27.666 | Model output recorded `Expected one published demo tool`; no quote |
| 20:30:28.574 | Agent turn completed without an MCP decision or release |

The embedded discovery still had 72 seconds left at the failed build. Later pairs
returned both accounts after that discovery expired, with a renewed top-level
expiry and the same older embedded dates. This rules out the date mismatch as a
sufficient cause in the real stack as well as the isolated control.

The reproduced cause is the one-second tool-list build limit and its cached empty
offer. The old run retained neither tool-build logs nor tool-execution output, so
its exact historical cause cannot be proved uniquely. The fresh reproduction
matches its completed model turns, no quote, no MCP decision and no release.

## Separate live append refusal

Pair 5 (sample 4 in the CSV), person A, reached the broker and returned `Release unavailable` after
three credential-audit append attempts. Its observed credential access window
lasted only 636 ms before refusal. Every traced access check completed without
an exception; there was no authority-expiry error and no saved credential audit
or material send. This is not the test's budget deadline failure.

The first two repeats imply `conflict` in the branch's bounded append loop. The
final append result classification was not recorded by the probes: PARTIAL for
that last dependency outcome. The claim path refuses an unconfirmed append, as
required. Extending two seconds alone would not address this observed refusal.

## Fix options for the owner

All options remain for the owner to choose under the two-fix stop. Options 1 and 2
preserve the access rules; option 3 requires a changed security decision.

1. Prepare immutable history and projection receipts before the budget queue;
   perform current permissions and small-stream position checks when the writer
   can act. Start the write's two-second authority check after queue admission.
   Keep the queue wait separately bounded by the unused permit lifetime. This can
   preserve AGENTS.md's two-second rule, provided no earlier access result is
   renewed or treated as current and the conditional append repeats live checks.
   Moving the test's one 400 ms receipt batch per person outside the serial section
   could remove roughly 800 ms from B's admission path. That estimate needs a new
   test and live proof; it is not an implemented or qualified improvement.
2. Reduce repeated position/history and permission round trips within a request,
   retaining the final current checks. Batch small-stream position reads and reuse
   immutable facts already captured at known positions. This preserves the
   two-second rule, but needs measured evidence of enough headroom under contention;
   another receipt-cache-only change does not address the measured queue.
3. Extend the admission/access lifetime or reuse authority across requests. This
   needs an explicit owner decision and a revised security contract. It weakens
   the current expiry or revocation guarantee and must not be taken by default.

None of the options should watch whole conversation streams, move conversation
history into the short access window, add a read authority fence, or treat ordinary
turn/file activity as an access change. Preserve one conditional business append,
event-only truth, current permission outages and late revocation refusals.

## Work log

1. Read the retained failure, branch contracts and exact release path.
2. Measured one uncontended dispatch, then simultaneous dispatches with fresh
   real-service fixtures. Separately reproduced refusals without product probes.
3. Tested an expired embedded discovery with a current top-level renewal.
4. Claimed a secondary slot below the load threshold, measured the fresh live run,
   removed every temporary source change, and released the slot.
5. Checked the documents, event contract, types and public-data boundaries. Left
   the worktree and draft PR available for the owner; no product fix was taken.

## Own checks and cleanup

- FAIL: concurrency acceptance condition reproduced: four of 20 B requests failed
  in the delayed-receipt measurement, and seven of 20 responses failed in the
  uninstrumented control. The original acceptance assertions and deadlines remain.
- FAIL: fresh live capability; 25 of 40 paired turns and ten of 20 single turns
  returned their own account. All other samples remain refusals in the evidence.
- PASS: focused controls for renewed top-level freshness with expired embedded
  discovery, and for an empty offer retained after slow successful permission work.
  Both controls used the original product rules. Temporary controls were removed.
- PASS: fresh startup qualification and health checks, apart from its explicit
  bundled Ask skip. No independent review verdict is claimed.
- PASS: stopped the guarded launcher and browser contexts, ran `down.sh --id 1`,
  and confirmed the slot ownership marker was removed. Preserved unrelated startup
  receipts outside the worktree and restored their tracked files.
- PASS: all temporary source probes and test changes removed. The final change
  contains documents and timing evidence only; no event, API, dependency or product
  behaviour changed. No changed code file needs an ESLint run.
- PASS: complete workspace, package and dev-stack typechecks; event catalogue
  agreement for 174 types; Knip, with its two existing configuration hints;
  Markdown lint across 511 files; changelog lint; public privacy; staged and
  commit-range secret scans. Tests, typechecks and lint ran under `nice -n 10`.
  Public privacy and the full commit-range secret scan are repeated before push.
- NOT RUN: full root test suite, independent review, mobile/revocation qualification,
  paid models, public third-party tool servers, and any proposed product fix.
