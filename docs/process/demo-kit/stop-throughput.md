# Saving long streamed replies

The original throughput result is below. The later [Stop closure](#stop-closure)
section records the saved-closure fix and the remaining browser display delay.

21 October 2026. Part of #32. **PARTIAL: the live Stop blocker remains.**
Final source: `90829ad8c`; measured/live source: `3cf0a4aa7`; base: `a7b564bf4`.
Test-first commits: `5bcb65b8f`, `f0d4fbf4c`, `f2bba6809` (corrected browser wait),
`636b2f7f9`, `0a9c3443c`. This is the first part, not a completed live capability.

## Cause and measurements

Read the requested rehearsal receipt, five JSON files and both fleet reports first.
The regression drives the real WebSocket receiver, report saving code and NATS
with 2,700 small reports and at most 32 outstanding acknowledgements. Each report
previously read history updates, encrypted text, appended an event and read it back.
Event parsing rebuilt its schema each time. Personal reply reports do not perform
individual authority checks or wait for projections. Reconnect replay is not paced
by this test; the live backlog remains unresolved.

| Measurement | Before | Instrumented after |
| --- | ---: | ---: |
| Total milliseconds | 35,937 | 3,159 |
| History reads / milliseconds | 5,400 / 23,973 | 345 / 2,149 |
| Append attempts / milliseconds | 2,700 / 8,989 | 171 / 461 |
| NATS requests / milliseconds | 13,501 / 19,478 | 866 / 2,211 |
| Encryption milliseconds | 1,016 | 73 |
| Event validation milliseconds | 10,446 | 143 |
| JSON parsing milliseconds | 758 | 78 |
| Competing Stop append milliseconds | Not measured | 162 |

Nested times overlap: do not add them. After counts include Stop and conflicts. The first uninstrumented run also failed:
51,528 milliseconds against a 10,000-millisecond bound. Final regression runs passed
in 3,110 and 4,764 milliseconds, with Stop appends in 180 and 185 milliseconds.
All use `nice -n 10`. `strace -f` observed zero `fsync` or `fdatasync` calls across
the instrumented benchmark and its children. NATS time includes storage work;
this does not measure synchronisation in the live computer's journal.

## Changes and qualification

Adjacent queued reply pieces share an encrypted event. Every original sequence
and digest remains checked during replay. Queue limits, access, money and memory
checks remain. Schemas are reused; validation results are not. #547's separate
accepted-after-disconnect fix is excluded. Live Stop first lost three append races
with HTTP 409. Failing-first tests now cover Stop append priority and manual Stop
in the separate polling path; both fixes pass their tests.

Direct sending subscribed one socket three times, causing a 1008 closure and false
lost-access display. It now subscribes once and shows reconnecting for busy 1013.
HTTP 503 remains unavailable; genuine refusals still clear access. The historical
503 exceptions were not recorded. Bounded reads can produce 503; their exact cause
in that rehearsal remains unproven.

- FAIL: two-second live Stop on claimed secondary slot 1. After the fixes, Stop
  saved with HTTP 200, but no computer closure appeared within 30 seconds. The
  stopped/reload check timed out; a repeat failed too. A later reply did not start.
- PASS: busy live message and approval reads both returned 200.
- NOT RUN: successful live partial-reply retention after Stop and reload.
- NOT RUN: paid confirmation because the live gate failed. No provider key was read.

The slot used loopback ports starting at 25100, never the owner stack or 44200.
Both company ceilings were 300 euro cents. Its temporary stand-in emitted up to
2,700 pieces three milliseconds apart. Earlier setup failures included a schema
composition error and a conversation worker exiting on a NATS timeout; a fresh
rebuild restored the worker before the live failures above.

## Checks, calls and cleanup

PASS: installation; 542 broader tests including unchanged authority tests and all
438 security checks; 70 repeated bridge checks; 23 focused tests twice; 71 browser
tests twice; typecheck, event catalogue and the full lint chain, including knip and
changelog checks. The first CI run on `afe27448d` failed the old report-conflict
expectation in `chat-summary.test.ts`. Its corrected check now verifies the new
stream position, the competing event and duplicate recovery. Those 12 tests passed
twice. The final pushed-head CI result is in the PR.
Paid calls: **none**. Charged: **0 cents**. Held with real providers: **0 cents**.
The task limit was 300 cents including holds; the earlier 75 cents is outside it.
PASS: released slot 1, restored and removed temporary source fixtures, and removed
`pgtest-demo-stop-throughput` with its volume. No owner resources were removed.

## 21 October — batch acknowledgements and guard checks

PASS: fetched `origin` and rebased the whole branch onto `ff7095f9f`.
Git confirmed that the rebase finished and that this main commit is an ancestor.
The bridge conflict kept main's saving of accepted reports after disconnect.
The stacked `work/demo-stop-close` branch was not changed.

A concurrent writer could save a batch with the same final piece but different
text in an earlier piece. The losing writer then acknowledged text that was
never saved. Test commit `3302e097b` reproduces this on real NATS, both with
whole batches and with one writer saving separate groups. Both changed-text
cases failed before the fix. The server now checks every original sequence
and digest against saved receipts after append, including concurrent duplicate
results. It reads another saved event only when that original is absent from
the returned event. An unchanged regrouped batch remains accepted.

PASS: removing each requested guard made its tests fail. All guards were restored.

| Removed check | Observed failure |
| --- | --- |
| Check each original during replay | Four failures: an unsaved piece was skipped; changed earlier, later and reordered text was accepted |
| Earlier receipt integer sequence | The non-integer receipt was accepted |
| Earlier receipt digest format | The bad digest was accepted |
| Earlier receipt strict fields | The extra field was accepted |
| At least one earlier receipt | The empty array was accepted |
| At most 63 earlier receipts | All 64 otherwise valid receipts were accepted below final sequence 65 |
| Release waiting writes after failure | Both report and Stop waiters timed out |
| Keep waiting writes separate for each chat | The second chat's Stop timed out behind the first chat's report |

The remaining listed test gaps were left outside this change. No access, money,
memory or queue limit was weakened. No dependency or event type was added.

Validation uses `nice -n 10`, one Vitest worker, real NATS fixtures and a disposable
PostgreSQL 17.6 container. Its loopback port is 53256 and `PG_TEST_URL` is set for
all projection tests. Logs are in `/tmp/demo-stop-throughput-checks/` on this host.
Live qualification: NOT RUN in this round. Paid calls: none; charged and held
with real providers: 0 cents. No live stack was started or changed.

PASS: the concurrent membership acceptance test passed 10/10 repetitions on
rebased branch source `977cf2e85` plus the batch fix, and 10/10 on `origin/main`
`ff7095f9f`. Each repetition ran both same-command and different-command cases:
20 test cases passed on each revision, with zero failed repetitions. The full
104-test membership file also passed once on this branch. The failure from CI
run `39577821667` was not reproduced on either revision. This does not establish
that it is a known flake. Membership commands, their tests and the event-store
adapter were not changed.

PASS: 71 direct-chat browser tests, twice. The added batch-race and guard tests
are in commits `3302e097b` and `1d86bd21c`; the production fix is `4d0836dd3`.

PASS: all 83 tests across the seven targeted server/event files, twice. This includes
main's accepted-after-disconnect regression. The 2,700-report runs took 4,372 ms
and 2,435 ms; the competing Stop appends took 191 ms and 138 ms. Typecheck,
`check:events` and `lint:changelog` passed. No full root suite was run.
PASS: removed the disposable PostgreSQL container with its volume and the detached
main comparison worktree. The saved test logs remain available on this host.
PASS: the full lint chain, including knip, documentation, links, fixture boundaries,
licences and changelog checks. GitHub CI is tracked on the pushed commit in the PR
comments; these local results do not claim that CI or live qualification passed.

## Stop closure

21 October 2026. Stacked on #549; part of #32. Source `a3c1ea2bc`, rebased
onto `bb8278709` before installation. Test-first commits: `44613d784` and
`7f8e0506d`. The measurements below use one claimed secondary, slot 1, with
loopback ports starting at 25100. They never use the owner stack or port 44200.

Two delays compounded each other. On reconnect, the computer sent its whole
report journal at once. That exceeded the server's queue limit, closed the
connection and forced repeated replay. Stop and the closure report travelled
through those failed connections. Separately, saving and polling Stop read the
reply history again, despite the report writer already holding current facts.

The computer now waits for acknowledgements after at most 32 reports or 512 KiB.
Stop still runs immediately on that connection. Saving and polling Stop reuse
the existing bounded chat summary. Its additional entries count towards the
same memory limit. Reply text, reservations, holds and access checks are unchanged.
No polling interval, authority test, security rule or dependency changed.

### Hop timings

These are UTC timestamps on 21 October. Each saved-closure measurement starts
at the actual browser click. The stand-in kept emitting reply pieces every
20 milliseconds; Stop was clicked after 20 seconds of visible streaming.
Temporary probes recorded only timestamps, turn identifiers and socket state.
An earlier probe accidentally shadowed a local function and disabled polling;
that run was discarded. The complete baseline below was repeated with the probe
corrected. Probes are excluded from the published source and runtime image.

| Hop | Before, 1280 wide | After, 1280 wide | After, 390 wide |
| --- | --- | --- | --- |
| Browser click | 10:43:43.914 | 10:48:35.853 | 10:52:06.438 |
| Request received | 10:43:43.939 | 10:48:35.861 | 10:52:06.452 |
| Stop saved | 10:43:45.510 | 10:48:36.426 | 10:52:07.034 |
| First delivery attempt | 10:43:47.791, closed socket | 10:48:36.567 | 10:52:09.346 |
| Separate poll sees Stop | 10:43:48.225 | 10:48:36.488 | 10:52:07.135 |
| Computer receives Stop | 10:43:49.354 | 10:48:36.498 | 10:52:07.139 |
| Computer aborts model | 10:43:49.355 | 10:48:36.500 | 10:52:07.140 |
| Model stream closes | 10:43:49.424 | 10:48:36.552 | 10:52:07.155 |
| First closure report sent | 10:43:51.630 | 10:48:36.628 | 10:52:07.284 |
| Closure saved | 10:44:03.704 | 10:48:36.643 | 10:52:07.317 |
| Closure shown | 10:44:19.184 | 10:49:36.767 | FAIL: over 65 seconds |
| Partial retained after reload | 10:44:20.765 | 10:49:40.070 | 10:53:39.002 |
| Click to saved closure | FAIL: 19,790 ms | PASS: 790 ms | PASS: 879 ms |

The longest baseline delay was replaying the closure report: 12,074 ms from
its first send to saving it. Stop also spent 5,440 ms reaching the computer.
The first fix alone still took 7,385 ms after a long reply; reusing the chat
facts removed the remaining history-read delay. Two stand-in stops now meet
the saved-closure bound. The browser still drains old reply updates before
showing closure. That visible delay remains a separate, uncorrected limitation;
these results do not claim a two-second visual update.

### Calls and checks

PASS: failing-first regressions. Replaying a streaming reply originally lost
Stop when the report queue closed the socket. The separate history-read test
originally took 3,307 ms against its fixed 2,000 ms bound. The replay test covers
both small pieces and 64,000-byte pieces, and checks that all partial text remains.

PASS: both stand-in saved closures and reload retention at 1280 and 390 pixels.
The retained replies contained 26,728 and 27,066 characters. Screenshots:
[1280 pixels](stop-closure-1280.png), [390 pixels](stop-closure-390.png).
PARTIAL: live display catch-up; the wide page took 60.914 seconds and the narrow
page exceeded the 65-second observation window. A direct reload showed its saved
closure and retained text. No two-second visual-update claim is made.

PASS: one real-model Stop confirmation after those saved-closure and reload gates.
A fresh install used the clean image ending `f39451218d1825`. The browser clicked
at 10:57:07.350, the request arrived at 10:57:07.380, Stop saved at 10:57:07.808,
the poll saw it at 10:57:08.060 and closure saved at 10:57:08.353: **1,003 ms**.
Closure appeared at 10:57:16.927; reload passed at 10:57:18.282, retaining all
728 characters. [Paid confirmation screenshot](stop-closure-paid.png).
The private setup received only the authorised provider-key path. No credential
value was copied into probes, logs, events, errors or this receipt.

| Paid call, UTC | Reserved cents | Charged cents | Held cents |
| --- | ---: | ---: | ---: |
| 10:55:48.511 — required provider verification | 1 | 1 | 0 |
| 10:56:53.577 — long reply, then Stop | 16 | 0 confirmed | 16 |
| Total | 17 | 1 | 16 |

PASS: both company ceilings were set to 300 cents before provider setup. Charged
plus held was 17 cents when the slot stopped. The 16-cent hold has an unknown
outcome; it was not released or counted as a free call. The earlier 75 cents is
outside this task. There were no other paid calls and no full root test suite.

PASS: the 15 changed tests twice; 61 related tests, including both unchanged
authority files; 11 signed Stop-gate tests; all 438 security-rule checks; event
catalogue and changelog checks.
Checks ran under `nice -n 10`. PostgreSQL-dependent tests used the task's ready
throwaway database. The full typecheck passed after making a test callback's
sequence number explicit. PASS: the full lint chain, including knip, dependency,
documentation, link, fixture, licence and changelog checks. The pushed-head CI
result is reported in the PR. NOT RUN: the full root test suite, as requested.

PASS: released slot 1; removed the task's PostgreSQL container with its volume,
temporary source fixtures, instrumented local image tags and registry forwarder.
The clean pinned image remains available. The requested tool symlinks remain.
No owner resources were removed.

### CI correction

FAIL: the first CI run on `5d2a84fc0` exposed a shared-summary regression.
`chat-http.test.ts` could no longer post a later message after an old memory record
that strict memory reads reject. That record must still refuse memory operations,
but previously did not block ordinary chat commands. A new failing-first test,
`313ce3bc6`, reproduces that error. The summary now retains the memory refusal
and throws it only when execution or memory facts are requested. Chat commands
and Stop read their own facts. The refusal text counts towards the cache limit.

PASS: the corrected summary, Stop regressions and strict memory tests: 68 tests
twice. The previously failing HTTP journey also passed with a fresh test database.
PASS: server typecheck, focused lint, knip and documentation checks after the fix.
Its container and volume were removed. This correction does not change valid
streaming replies; the live measurements above remain tied to their stated SHA.
NOT RUN: another paid call after this correction; the single confirmation limit
is preserved. Final pushed-head checks are reported in the PR.

The first CI run also failed `upload.test.ts` because the MinIO image registry
refused its pull after exceeding a request quota. That failure is not on the
permitted rerun list and was not rerun on that head.

### Final rebase and stand-in repeat

PASS: rebased this branch onto updated #549 source `cae9e5b4e`; Git confirmed
completion and ancestry. Kept both sets of tests and both receipts when resolving
conflicts. The test-first commits after rebase are `ddb6de97a`, `9833a9657` and
`3d9680b8f`. Final measured source: `64f934382`, including the memory correction.
PASS: 73 targeted tests twice after the rebase, including the new batch checks.

Reclaimed the same secondary slot 1 and installed it fresh with the clean pinned
computer image. Both company ceilings were again 300 cents. These were stand-in
calls only; real charged plus held spending remains 17 cents.

| Width | Click, UTC | Closure saved, UTC | Elapsed | Reload retention |
| --- | --- | --- | --- | --- |
| 1280 | 12:00:36.555 | 12:00:37.516 | PASS: 961 ms | PASS: 28,574 characters at 12:01:59.404 |
| 390 | 12:02:43.011 | 12:02:44.440 | PASS: 1,429 ms | PASS: 29,068 characters at 12:04:19.421 |

PARTIAL: the page exceeded the 65-second display wait in both runs. Reload showed
the saved closure and kept the partial text, unchanged on a second reload.
Screenshots: [1280 pixels](stop-closure-rebased-1280.png) and
[390 pixels](stop-closure-rebased-390.png). No further paid call was made.

PASS: released slot 1 again and removed the final temporary probes. Server
typecheck, focused lint, knip, event catalogue and changelog checks passed on the
rebased source. Final pushed-head CI is reported in the PR.

### Saved id correction and replay checks

21 October 2026. Source `aeae092510`; fix `a76e493a9`; test-first commit `891657eb0`.
Environment: the existing development worktree, Node 22.23.3, disposable real NATS
and loopback WebSockets. This was not a fresh installation. No live stack,
provider call or runtime image build was used for this correction.

PASS: failing-first reproduction of the old-report id collision. The fixture
publishes an old report without a broker duplicate entry, representing an expired
duplicate window. Stop and a new message must both return `Id reused` and leave
the saved history unchanged. All four cold/warm cases initially failed because
the command saved a second event. They now pass. Every saved id keeps its first
position in the shared summary; retries still read and verify that event.
The 32 MiB cache limit is unchanged. Added report ids and numeric positions count
towards it without retaining reply text. The existing long-history and oversized
cache tests pass, preserving warm reads and rebuilds after eviction.

PASS: each requested guard has a test that fails when that guard is removed.
Each mutation was run separately and restored before the passing runs.

| Removed guard | Observed failure |
| --- | --- |
| Do not send an in-flight sequence again | The socket received the first report twice. |
| Clear pending reports on reconnect | Replay included the old pending report before the new reports. |
| Clear in-flight entries on reconnect | The old full window blocked replay. |
| Reset in-flight bytes on reconnect | The old byte count blocked the expected new window. |
| Keep the first position for a repeated stored id | The later position replaced the first one, 4 instead of 3. |

PASS: 31 focused tests in four files, twice, under `nice -n 10` with one worker.
Files: server `chat-summary.test.ts` and `chat-summary-memory.test.ts`; computer
`bridge-socket.test.ts` and `report-pressure.test.ts`. Both runs used
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`; these selected
files require no PostgreSQL fixture. Safe local logs are
`/tmp/demo-stop-close-red.log`, `/tmp/demo-stop-close-mutation-*.log` and
`/tmp/demo-stop-close-green-rebased-{1,2}.log`.

PASS: event catalogue check, with 149 event types agreeing.
NOT RUN: full root suite locally, live qualification, new image and paid calls.
The earlier image and live measurements above remain tied to their stated source.
Other listed coverage gaps remain outside this correction.

PASS: full lint, including knip, dependency, Markdown, local-link, fixture, licence
and changelog checks; full workspace and package typecheck. Both ran under
`nice -n 10`. The first lint attempt refused an unsafe type assertion in the new
socket fixture. The fixture now uses the existing object parser; every report
assertion is unchanged. The final lint and typecheck logs are
`/tmp/demo-stop-close-lint-rebased.log` and `/tmp/demo-stop-close-typecheck-rebased.log`.
The PR comment records CI for the pushed commit, including its `ci-ok` result.

PASS: rebased only this branch's 13 commits onto the updated #549 source
`0b1414804`. The first attempt to rebase normally tried to replay the old base's
commits and was aborted. Rebasing from the original base `cae9e5b4e` then finished
cleanly. `git range-diff` confirmed all 13 commits were unchanged. The focused
tests passed twice and full typecheck passed again on the rebased source.

## Stop display

21 October 2026. Stacked on #550; Part of #32. Production source `e765eca22`
(the first working fix was `db10e38f1`);
failing-first commit `0ffde53fd`. Fetched origin and completed the rebase onto
`52cb1ffae`, then installed this worktree's dependencies. Used only claimed
secondary slot 1, at loopback ports starting at 25100.

### Where the delay occurred

The conversation projection was behind the saved reply. Each worker committed
separately for every text event, including workers that ignored that event.
The conversation worker also reread and rewrote the same chat details for every
piece. Database probes found repeated commit waits, including WAL synchronisation.
The browser was already processing each received update quickly.

Adjacent reply deltas now share a bounded database transaction. The conversation
projection checks each event, reads each chat once and inserts the original rows
together. It keeps all saved positions, duplicate checks, rollback and partial text.
Other event types keep their separate transactions. No browser, access, event,
provider, dependency or authority-test contract changed.

Temporary probes saved timestamps, event ids, lengths and timings, never credentials
or reply text. The saved-event observer followed the live end. Projection polling was scheduled
every 50 ms; page sampling every 100 ms. Later runs also sampled after two animation
frames following a page change. Scheduling can add delay to these observations. Event timestamps below precede observer
arrival and give the stricter bound. Parse and apply are browser elapsed times.
The baseline worker was restarted midway to add query timing; this is a diagnostic
trace, not a pristine latency benchmark.

| Closure hop | Before, 1280 | First fixed run, 1280 |
| --- | --- | --- |
| Click, UTC | 12:55:36.336 | 13:11:31.454 |
| Saved event | 12:55:37.522 | 13:11:32.544 |
| Projection observed | 12:56:36.726 | 13:11:33.589 |
| Server sent | 12:56:36.786 | 13:11:33.592 |
| Browser received | 12:56:36.794 | 13:11:33.608 |
| Browser parse / apply | 0.2 / 1.5 ms | 0.2 / 11.3 ms |
| Page showed Stopped | 12:56:36.868 | 13:11:33.667 |
| Saved closure to display | FAIL: 59,346 ms | PASS: 1,123 ms |
| Click to display | FAIL: 60,532 ms | FAIL: 2,213 ms |
| Updates / bytes received | 455 / 258,053 | 441 / 251,273 |
| Retained characters | 29,484 | 30,212 |

Normal streaming also lagged before the fix: only 6,448 characters were visible
at Stop, while about 29,000 were saved. The largest measured text lag was 53,744 ms.
In the first fixed run it was 1,261 ms. That run overlapped the focused database
checks, passed reload retention and the saved-to-display bound, but missed the
click bound. It did not authorise a paid confirmation.

### Repeated stand-in checks

Early repeats remained FAIL: click/display, saved/display and largest streaming lag
were respectively 1,930/669/2,093 ms and 2,725/916/2,551 ms. The stack had inherited
low scheduling priority from the test launcher. Restarting only this slot's server
and workers at normal priority removed that setup mistake. The first desktop repeat
still missed the click bound (2,589/1,407/1,909 ms). These misses are retained here;
the result does not promise the timing bound under every shared-host load.

The following four consecutive runs passed. Tests were not running during them.
Each run sent a new long stand-in reply, clicked Stop, waited for the displayed
status and reloaded. Both desktop repeats and both narrow-screen repeats retained
exactly the stopped text. The provider was still the stand-in throughout.

| Width / run | Click to display | Saved to display | Largest streaming lag | Retained characters | Result |
| --- | --- | --- | --- | --- | --- |
| 390 / first | 1,315 ms | 583 ms | 1,331 ms | 29,614 | PASS |
| 1280 / second | 1,237 ms | 371 ms | 1,422 ms | 30,446 | PASS |
| 390 / second | 1,471 ms | 896 ms | 1,781 ms | 31,486 | PASS |
| 1280 / third | 1,462 ms | 667 ms | 1,495 ms | 30,784 | PASS |

The final desktop closure was saved at 13:43:20.302 UTC, observed in PostgreSQL at
20.867, sent at 20.929, received at 20.933 and displayed at 20.969. Browser JSON
parsing measured 0 ms at timer precision; validation and application took 3.8 ms.
It received 795 distinct row updates totalling 430,797 bytes. The final narrow run
used 904 updates / 486,300 bytes: saved at 13:42:27.770, projected at 28.520,
sent at 28.627, received at 28.634 and displayed at 28.666; parse/application
measured 0/7.1 ms. The browser still receives each original ordered row.

Streaming measurements matched each saved delta's cumulative character count to
the first page sample containing it. They stop at the saved Stop request, because
the page intentionally hides text saved after that request. Update totals count
distinct received row ids for that chat; reconnect duplicates are not counted twice.
The two-second bound is measured against the event timestamp, before its observer
arrival, so observer delay does not make the result look faster.

Screenshots after reload: [desktop](stop-display-1280.png) and
[narrow screen](stop-display-390.png). Detailed private timings and probe output
are in `/tmp/demo-stop-display/` on the development host.

### Paid confirmation

PASS: a fresh install on the same slot set both company ceilings to 300 cents
before provider setup. Only private setup received the provider credential path.
No credential value was copied into commands, timings or repository files.
The automatic stock chat journey was disabled for this run so it could not make
extra paid calls. Temporary setup and timing changes were then removed.

| Paid call, UTC | Reserved | Charged | Still held | Result |
| --- | --- | --- | --- | --- |
| 13:46:06.878, provider verification | 1 cent | 1 cent | 0 cents | PASS |
| 13:47:27.048, long reply and Stop | 16 cents | Not settled | 16 cents | PASS; interrupted outcome retains its reservation |

Total charged plus held: 17 cents, within the task's 300-cent allowance. No paid
retry ran. The earlier stand-in calls did not contact the paid provider.

The real-model Stop click was at 13:47:46.320 UTC. Closure was saved at 47.204,
sent at 47.422, received at 47.448 and shown at 47.469: PASS at 1,149 ms from click
and 265 ms from the saved event. JSON parsing measured 0 ms at timer precision;
validation and application took 2.2 ms. The page received 338 distinct updates /
176,324 UTF-8 bytes. The closure observer started late after its spending read failed
during the server restart, so its PostgreSQL hop is NOT RUN as a usable timing.
The server-send and browser probes were already running.

PASS: reload kept the 2,527 displayed characters (2,595 source characters including
Markdown). The first probe's extra prefix comparison failed because an unfinished
`**Inverness` became formatted bold text when the closing markers arrived. A read-only
follow-up confirmed exact equality across reload and confirmed the earlier prefix
once those Markdown markers were removed. It made no model call. The stand-in
streaming-lag calculation is not used for this formatted real reply, because source
and displayed character counts differ. [Real reply after reload](stop-display-real-1280.png).

### Checks and limits

- PASS: failing-first commit `0ffde53fd` reproduced the slow commit path without a
  stack or provider: 18,346 ms against a fixed 2,000 ms limit. The final test keeps
  that same limit for 28,224 characters and verifies every original row and closure.
- PASS: the final four changed tests passed twice (12.24 and 12.36 seconds for each
  complete file). PostgreSQL tests cover rollback, retry, duplicate ids and racing
  runners. In-memory SQL checks cover the timing bound and invalid middle deltas.
  One earlier invalid-delta check timed out at 30 seconds during the fresh stack
  restart; that validation-only check now uses the existing in-memory engine.
- PASS: lint, typecheck, event catalogue, knip, licence checks and changelog checks.
  Full code lint had no errors and 24 existing warnings. Its dependency check found
  a type-import cycle; moving the private batch functions into the runner fixed it.
  Changed code and the remaining lint steps were checked again afterwards.
- PARTIAL: the wider focused run passed 670 of 671 tests, including all projection
  tests, the unchanged authority tests, read regressions and event security rules.
  The unchanged 1,502-event socket test failed its 1,500 ms bound at 1,925.5 ms;
  the clean repeat also failed at 2,498.8 ms. This remains FAIL, not a waived check.
  No full root suite ran locally. Tests, lint and type checks used lowered priority.
- PASS: read and removal regression assertions in that focused run passed. No access
  checks were bypassed or changed. A separate manual participant-removal or browser
  403 journey is NOT RUN; these are covered by existing automated checks only.
- PASS: the stand-in repeats and one paid Stop/reload journey above passed on fresh
  slot installations. Earlier timing misses remain recorded. This is PARTIAL source
  readiness while the local socket timing failure remains unresolved; GitHub results
  are reported on the pull request for its pushed head.

- PASS: slot 1 was stopped and released after the paid read-only checks. Its services,
  containers and computer namespace were removed through the stack tooling. The
  task's throwaway PostgreSQL container and its volume were removed too. Temporary
  probe scripts were removed; private evidence remains under `/tmp/demo-stop-display/`.
  The requested tool symlinks remain. The owner stack was not used or changed.

### CI repair checks, 21 October 2026

PRODUCT CHANGE: no in this repair round. Runtime code, test code, assertions and
timeouts are unchanged from `25e12e066`.

PASS: fetched origin and ran the whole-branch rebase onto `origin/main` at
`1041206f322bdc584c1b32d2d486f96198cf5b76`. Git reported the branch was already
current. The merge base equals that main commit, and neither rebase directory
exists. Returned to `work/demo-stop-display` after the main comparison.

FAIL in [the earlier CI run](https://github.com/elewa-git/opencrane-new/actions/runs/39640193941):
Markdown rule MD022 found no blank line above `## Stop display`. Fixed in
`c16623236`. PASS: full Markdown lint after the correction.

The same CI run reported five MCP cleanup hooks exceeding 10,000 ms:
`guards published HTTPS tool calls: revision`, `held_start`, `watch_admission`,
`refuses a direct responded callback after a saved unknown outcome`, and
`saves a checked remote response against its consumed permit once: tool_error`.
It also reported missing quiet-proof fields in
`keeps automation under UID 1002 separate from full quiet proof`.

PASS: repeated each complete file five times on branch source `c16623236` and
five times on main source `1041206f3`. Each invocation used `nice -n 10`,
`--maxWorkers=1` and
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.

| Complete test file | Branch passes | Main passes | Failures |
| --- | --- | --- | --- |
| `libs/models/test/mcp-dispatch.test.ts` | 5/5 | 5/5 | 0 |
| `apps/computer/test/supervisor-identity.test.ts` | 5/5 | 5/5 | 0 |

Each MCP run passed 173 tests; each supervisor run passed five. All 1,780 test
executions passed, including every reported case. Neither failure reproduced on
either source. Treat the earlier test failures as load flakes on this evidence,
as requested. No branch-only failure needed a behaviour fix. The projection runner
keeps reply pieces inside its awaited run and sets no timer for later reply writes.
The supervisor and its fixture are unchanged by this PR. No check was weakened.

The environment was this Linux worktree with Node 22.23.3 and disposable test
services. Computer fixtures reused image `sha256:8874255dfbc3` with each source's
computer files mounted into fresh containers. The image id was unchanged for the
main comparison. PARTIAL: one extra MCP invocation was interrupted while reordering
the queue; it is excluded from the completed-run counts. Full run records are in
`/tmp/demo-stop-display-repeat.jsonl`; logs are
`/tmp/demo-stop-display-{branch,main}-{mcp,identity}-{1,2,3,4,5}.log`.

PASS: all four tests in `libs/projections/test/streaming.test.ts`, twice, with one
worker under `nice -n 10` (14.47 and 13.19 seconds for the complete file).
Used fresh PostgreSQL 17.6 at
`postgres://postgres:test-only@127.0.0.1:53525/postgres`, following the disposable
database rule for projection tests. Removed container
`pgtest-demo-stop-display-ci-20261021` and its volume with `docker rm -f -v`.
Logs: `/tmp/demo-stop-display-streaming-{1,2}.log` and
`/tmp/demo-stop-display-streaming-results.log`.

PASS: full lint, including knip and changelog lint; full workspace and package
typecheck; event catalogue check with 149 agreeing event types. All ran under
`nice -n 10` on `c16623236`. Logs:
`/tmp/demo-stop-display-{lint,typecheck,events}.log`. Markdown, local links and
changelog lint are checked again with this receipt before committing.

NOT RUN in this repair round: a live stack, fresh-install journey, paid calls or
the full root suite locally. The earlier live results keep their stated sources
and limits. The PR comment records CI for the pushed head and its `ci-ok` result.

## Stop label

22 October 2026. Part of #32. Product source:
`89ab910bf314069856d482814f675eb77f7be559`; base `06a0e47ac`.
Failing-first commit: `1ab6fe03b`. The two new cases failed before the fix:
each kept the stopped outcome and partial text but also added “Reply failed”.

### Cause and fix

A Stop request records what the person asked for. It does not prove why the turn
ended. The first version treated every later failure as stopped and hid its failure
activity. That also hid tool refusals and provider failures that raced with Stop.

The bridge now saves `stop_interrupted` only after a cancelled turn receives an
interrupted terminal report. Other runner failures save `model_error`. A tool refusal
keeps `restricted_tool_refused` even if Stop was also received. These are values of
the existing `reason` field, with no new event or field. The server checks and saves
them unchanged. Journal reload and duplicate delivery keep the same report.

The browser requires the saved ending reason as well as Stop before showing the
stopped outcome. Older `bridge_interrupted` reports following Stop keep their previous
display. Other failures keep “Reply failed” and their detail, live and after reload.
The first activity fix still adds “Reply failed” only for a derived `failed` turn.
No saved rows need rewriting. Human group chats use the separate direct-chat view.

The original live evidence below predates this correction. Its failure check had no
Stop request. The correction checks are recorded after that evidence.

### Live checks

Used only claimed secondary slot **1**, with a fresh install and the free stand-in.
The browser used the existing short-lived development Owner session format; product
APIs still checked access. No paid provider was configured or called. A temporary
stand-in fixture emitted 26-character pieces every 20 ms for long replies and
returned HTTP 400 for the failure check. Its source was restored after loading;
its process ends with this slot. No fixture change is part of the product fix.

[Original-guard reproduction](stop-label/baseline.json) confirms both labels live
and after reload, with 8,632 kept characters. It temporarily restored the old guard
on the stated source, then restored the fix before the checks below.
[Fixed results](stop-label/fixed.json), [shared results](stop-label/shared.json) and
[group results](stop-label/group.json) retain times, character counts and saved event
names/reasons. They contain no credentials or reply contents.

| Step | Result | Evidence |
| --- | --- | --- |
| Long reply, Stop, 390px first | PASS | 5,564 characters; zero “Reply failed” labels. [Before reload](stop-label/fixed-before-reload-390.png). |
| Reload at 390px | PASS | Exact same text and only the stopped label. [After reload](stop-label/fixed-after-reload-390.png). |
| Long reply, Stop, 1280px second | PASS | 5,902 characters; zero “Reply failed” labels. [Before reload](stop-label/fixed-before-reload-1280.png). |
| Reload at 1280px | PASS | Exact same text and only the stopped label. [After reload](stop-label/fixed-after-reload-1280.png). |
| Provider failure without Stop | PASS | “Reply failed” remains [live](stop-label/failed-before-reload-390.png) and [after reload](stop-label/failed-after-reload-390.png). Saved failure report, no Stop request. |
| Shared assistant at 390px | PASS | 4,706 characters and only stopped, [live](stop-label/shared-before-reload-390.png) and [after reload](stop-label/shared-after-reload-390.png). |
| Human group chat at 390px | PASS | Message survives reload; no agent turn or reply outcome. [Picture](stop-label/group-390.png). |
| Lost output without text | PASS | State test keeps “Didn't complete · nothing was repeated”. Live computer-loss check: NOT RUN. |
| Bundled startup journey | FAIL | Services started, but the existing tool review returned HTTP 409 at “Owner saves the exact tool review”. The targeted checks above used those live services. |
| First shared-check helper | FAIL | It waited for the composer without using Check status. [Receipt](stop-label/shared-first-attempt.json) and [picture](stop-label/shared-failure-390.png). The corrected helper uses the existing picker-status journey function; its repeat passed above. |
| Physical phone and Safari | NOT RUN | Pictures use Chromium windows. |
| Slot release and cleanup | PASS | `down.sh --id 1` removed this slot’s services, computers, data and claim. The owner stack and port 44200 were untouched. |

### Source checks

- PASS: `npm ci` in this worktree; requested NATS and Lychee symlinks in `.tools/`.
- PASS: all 23 tests in `chat-state.spec.ts`, twice after the fix. Existing failure
  and lost-output cases explicitly check their labels. The first failing run had
  21 passes and the two expected stopped-label failures.
- PASS: 438 event-security tests once and the existing conversation-projection test.
  Used throwaway PostgreSQL 17.6 at
  `postgres://postgres:test-only@127.0.0.1:53526/postgres`, following the later database
  setup rule. Removed `pgtest-demo-stop-label` and its volume afterwards.
- PASS: workspace/package typecheck, event catalogue (149 types), and separate Knip.
- PASS: full lint, including documentation, links, licences and changelog lint;
  24 existing code warnings and zero errors. Its first wrapper ended with signal 143
  after reaching changelog lint. Changelog lint passed separately, then the full
  repeat passed with an 8 GiB Node heap limit and the same lowered CPU priority.
- NOT RUN: full root suite locally. Tests, lint and typecheck used `nice -n 10`.
  No authority or event-security test changed; no dependency or event/API name was added.

The package READMEs and diagram describe the corrected outcome. The release note is
`changes/unreleased/work-demo-stop-label.md`; the later repository rule keeps
`CHANGELOG.md` unchanged. GitHub CI is reported for the pushed draft-PR head.

### Failure reasons after Stop

22 October 2026. Product source `3c1d08655aca126b4aa265366e87db9bfb0fc72a`.
Test-first commit `5d9152441` precedes this fix. The first runs failed on the two
hidden browser failures, three missing bridge reasons and two rejected server reasons.
The refusal case already kept its bridge reason; the new browser check exposed where
that reason was lost from the display.

| Check | Result | Evidence |
| --- | --- | --- |
| Stop then tool refusal, live calculation and replay | PASS | Keeps “Reply failed” and “Tool access refused”, with partial text. |
| Stop then provider failure, live calculation and replay | PASS | Keeps “Reply failed”; the bridge saves `model_error`. |
| Stop-caused ending, live calculation and replay | PASS | Saves `stop_interrupted`, keeps partial text and shows only the stopped outcome. |
| Older Stop plus `bridge_interrupted` | PASS | Keeps the previous stopped display. |
| No Stop plus `bridge_interrupted` | PASS | Keeps “Reply failed”. |
| Remove the browser reason check temporarily | PASS | Both unrelated-failure regressions fail. Restored the check afterwards. |
| Remove the bridge terminal-status check temporarily | PASS | Stop plus provider failure incorrectly saves `stop_interrupted`, and its regression fails. Restored the check afterwards. |
| Changed tests and nearby bridge checks | PASS | All 28 web state tests twice; all 495 tests in six server, bridge and event-security files twice. Uses the requested `PG_TEST_URL`, `nice -n 10` and one worker. |
| Journal reload and duplicate report delivery | PASS | New reasons remain identical after reload; the server saves each report once and recognises its duplicate. |
| Protected event-security tests | PASS | All 438 tests pass unchanged, including reason-code validation. |
| Typecheck, event catalogue, Knip and changelog lint | PASS | All workspaces and package types; 149 event types agree. |
| Full root suite | NOT RUN | Only the named test files ran. |

Used only claimed secondary slot **1**, with a fresh stand-in stack and no paid calls.
A temporary image added the two changed bridge files to the existing pinned computer
image. Its digest was
`sha256:b4f6fa8b0e61bec490254a1f7fdc2b8cc35d8fac652d993d7c9a9b43c7e851c7`.
The slot kept its strict image checks with that expected digest. The computer upgrade
used the slot's lifecycle account. The first administrator request and an incomplete
container patch were refused; neither refusal changed the computer.

The existing stand-in pauses after “Hello ” for the prompt “Say hello again.”
Both widths kept six characters, saved `stop_interrupted`, had zero “Reply failed”
activities, and kept identical text after reload. The pictures show the stopped label.
[Results](stop-label/recheck/results.json),
[390px before reload](stop-label/recheck/before-reload-390.png),
[390px after reload](stop-label/recheck/after-reload-390.png),
[1280px before reload](stop-label/recheck/before-reload-1280.png) and
[1280px after reload](stop-label/recheck/after-reload-1280.png).

Startup preparation first failed because this worktree had no local Zitadel key path.
The repeat used the existing configured key file. Provider setup passed with the free
stand-in. The bundled wider startup journey is PARTIAL: it was ended after the targeted
Stop checks passed. Its generated changes to existing pictures and records were restored.
The tool-refusal and provider-failure races were checked in tests; they were NOT RUN live.

Cleanup PASS: `down.sh --id 1` removed the slot's services, namespace, data and claim.
Removed the temporary image references from Docker and the cluster, the temporary registry
tag, the local forwarding process and the temporary helper files. The registry does not
allow manifest deletion; untagged build data remains as cache. No shared cache was cleared.
The owner stack and port 44200 were untouched. No access, spending or memory check changed.

Full lint PASS, with 24 existing warnings and zero errors. Documentation and local
links also passed after this receipt was updated. Fetch and rebase completed;
`origin/main` is an ancestor of this branch, with no rebase left in progress.
