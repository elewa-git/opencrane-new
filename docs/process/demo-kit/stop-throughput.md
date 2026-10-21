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
