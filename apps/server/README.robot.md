# Server

For people, read [README.md](README.md) first.

## Provider access during startup

Provider routes return HTTP 425 with `{ status: 'access_applying' }` when the existing
membership check throws `AuthorityApplying`. This includes a saved `ownership.seeded`
event whose OpenFGA receipt is missing. The create has not reached its append at that
point. Retrying uses the same input and command id. Membership, admin permission and
applied-event checks still run on every attempt. Unavailable dependencies still return
503; a lost or uncertain write still requires reading its original result.

`test/provider-startup.test.ts` uses real NATS, PostgreSQL and OpenFGA. It withholds the
ownership receipt while the Owner already has admin permission. It checks 425 without
a create event, then 404 after ownership applies, then one accepted create on repeated
submission. See [the provider API](../../docs/api/providers.md#evidence-and-recovery).
The [startup check](../../docs/process/demo-provider-start.md) records local results and limits.

## Memory race scheduling

`test/memory.test.ts` pauses the first correction at append, then reads the second
request's history at the old revision. It lets the first request finish before
returning that history. The second request must return 409 with no second append.
Without this ordering, Forget can reach the occupied member/scope slot and receive
503 `memory_busy`, as the existing admission contract requires. No production
limit is changed. A separate correction test keeps the first append held until
the second HTTP response returns 409. Removing the `MemoryBusy` to `MemoryConflict`
guard makes that test fail with 503. It also checks one append and the new key.
[Own checks and the other 503 causes](../../docs/process/evidence/ci-flakes-3.md).

## Child retry tests and duplicate messages

The four tests that retry after the JetStream duplicate window use private
fixtures with a two-second window. The retry-command test also uses this window
to check that an old worker cannot save a failure after a newer attempt starts.
`test/support/duplicate-window.ts` checks that normal creation used 120 seconds,
then updates the empty private EVENTS stream through the NATS test connection.
Production still uses 120 seconds; there is no new production setting. Other
tests keep the normal window except for their individual expiry cases. The shared
`child-fixture.ts` and `child-summon.ts` helpers accept the prepared NATS fixture,
so setup saves its first event after the window is set.

Each shortened test publishes the same valid event twice and checks that NATS
stores it once. It then repeats that publish until NATS stores a new message,
with a five-second limit. Only then does it retry the child command and check
the saved result. The probe uses its own assistant subject and does not change
chat history or the permissions rebuilt by the tests.

NATS 2.15.0 resets an active duplicate-expiry timer before changing its window.
The timer can run between those steps and schedule its next check using the old
120-second value. Publishing checks the saved duplicate ids; it does not expire
them itself. A reported two-second configuration can therefore still suppress
the probe after five seconds. Setting the window on an empty stream avoids this
race because the first message starts the timer afterwards. The helper refuses
populated streams. `test/duplicate-window.test.ts` checks that refusal leaves the
original configuration and saved event intact. It also checks that the wait ends
with two identical events at different saved positions.

The relevant source is NATS 2.15.0's
[configuration update and duplicate-expiry timer](https://github.com/nats-io/nats-server/blob/v2.15.0/server/stream.go).

A disposable diagnostic reproduced this ordering with the same NATS binary. It
changed an active 120-second window to 100 ms, then published and checked storage
every 25 ms. On attempt 85 the reported window was 100 ms but the repeat still
had position 169 after 569 ms. Restarting NATS with the saved configuration let
the same repeat become position 170 immediately. The diagnostic was removed;
its own logs are `/tmp/ci-flakes-5-timer-diagnostic-2.log` and
`/tmp/ci-flakes-5-timer-proof.json`. It touched no shared service or dev stack.
The failing-first commit `e48a63bc5` fails because the old helper accepts a
populated stream. Its other test already passes the stored-repeat check.

### Own duplicate-window checks, 23 October 2026

All commands used `nice -n 10` and the supplied `PG_TEST_URL` at port 55432.
The tests used private NATS, disposable databases and OpenFGA. The root suite and
fresh-install journeys were NOT RUN. No access check, timeout or dependency changed.

- Expected FAIL: test-first commit `e48a63bc5` accepted a populated stream.
- PASS: the five affected test files twice: 105 tests in each pass.
  The first pass also ran all 438 unchanged event security tests: 543 total.
- PASS: typecheck, event catalogue, Knip and changelog validation.
- PASS: full lint. Its first attempt had a setup error because ESLint listed the
  temporary diagnostic before it was removed. The clean rerun passed.

The target case ran 30 times in order, each in a new Vitest process. A separate
companion process ran alongside it. Companion 1 supplied the second five-file
pass; later companions ran all 31 child-first-input tests. Each companion finished
before the report was written. No failed test was retried.

| Run | Result | Wall time (s) | Overlapping companions |
| --- | --- | --- | --- |
| 1 | PASS | 25.21 | 1 |
| 2 | PASS | 24.46 | 1 |
| 3 | PASS | 25.28 | 1 |
| 4 | PASS | 27.50 | 1 |
| 5 | PASS | 28.59 | 1 |
| 6 | PASS | 27.20 | 1 |
| 7 | PASS | 26.78 | 1 |
| 8 | PASS | 24.26 | 1 |
| 9 | PASS | 24.21 | 1, 2 |
| 10 | PASS | 27.56 | 2, 3 |
| 11 | PASS | 30.41 | 3 |
| 12 | PASS | 24.58 | 3, 4 |
| 13 | PASS | 23.34 | 4 |
| 14 | PASS | 24.94 | 4, 5 |
| 15 | PASS | 34.09 | 5 |
| 16 | PASS | 36.28 | 5, 6 |
| 17 | PASS | 31.62 | 6 |
| 18 | PASS | 33.53 | 6, 7 |
| 19 | PASS | 34.73 | 7 |
| 20 | PASS | 35.64 | 7, 8 |
| 21 | PASS | 33.33 | 8 |
| 22 | PASS | 37.35 | 8, 9 |
| 23 | PASS | 31.43 | 9 |
| 24 | PASS | 31.76 | 9, 10 |
| 25 | PASS | 30.78 | 10 |
| 26 | PASS | 32.02 | 10, 11 |
| 27 | PASS | 31.17 | 11, 12 |
| 28 | PASS | 32.29 | 12 |
| 29 | PASS | 25.57 | 12, 13 |
| 30 | PASS | 27.32 | 13 |

| Companion | Result | Tests | Wall time (s) |
| --- | --- | --- | --- |
| 1 | PASS | 105 | 212.26 |
| 2 | PASS | 31 | 48.04 |
| 3 | PASS | 31 | 50.69 |
| 4 | PASS | 31 | 46.10 |
| 5 | PASS | 31 | 64.97 |
| 6 | PASS | 31 | 60.10 |
| 7 | PASS | 31 | 65.79 |
| 8 | PASS | 31 | 69.22 |
| 9 | PASS | 31 | 60.14 |
| 10 | PASS | 31 | 57.89 |
| 11 | PASS | 31 | 59.59 |
| 12 | PASS | 31 | 57.11 |
| 13 | PASS | 31 | 46.25 |

Logs are `/tmp/ci-flakes-5-changed-1.log`, `/tmp/ci-flakes-5-repeats.log`,
`/tmp/ci-flakes-5-repeats/target-NN.log` and
`/tmp/ci-flakes-5-repeats/companion-NN.log`. The first companion log is
`companion-01-changed-2.log`. `results.json` in that directory records every
start, finish, wall time and result. Check logs use `/tmp/ci-flakes-5-` followed
by `lint-final.log`, `typecheck.log`, `events.log` and `changelog.log`.

### Retry setup correction, 23 October 2026

The retry suite still shortened the window after `summonFixture` saved eleven
events. The local baseline reproduced the setup failure from the empty-stream
guard, with all 25 retry tests skipped. The suite now creates the short-window
NATS fixture before passing it to `summonFixture`. The guard and all assertions
remain unchanged. This correction changes test setup only.

The call-site search covered `shortenDuplicateWindow`, `shortDuplicateWindowFixture`
and `summonFixture` throughout the repository. The other shortened fixtures already
set the window before saving events. The selected files are `child-first-input`,
`child-recovery`, `child-requests`, `child-retry`, `child-summon` and `duplicate-window`.

Own checks after rebasing onto `76238ab8c`:

- Expected FAIL: the unchanged retry suite refused the eleven saved events during setup.
- PASS: all six selected test files twice, with 131 tests in each run.
- PASS: full typecheck, event catalogue and full lint, including Knip and changelog
  validation. ESLint reported zero errors and 25 function-length warnings.

Both test runs used `nice -n 10`, one worker and
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
The full root suite and fresh-install journeys were NOT RUN.
Logs are `/tmp/ci-flakes-5-before.log`, `/tmp/ci-flakes-5-tests-1.log` and
`/tmp/ci-flakes-5-tests-2.log`. Static check logs use `/tmp/ci-flakes-5-fix-`
followed by `typecheck.log`, `events.log`, `lint.log` and `changelog.log`.

Main advanced during validation with computer test and documentation changes.
The final rebase onto `3a3202909` completed. Comparing the PR patch before and
after that rebase found identical bytes. The server test code is unchanged.

### Earlier short-window checks

Own checks, 22 October 2026, based on `8a334f3ee`, with Node 22.23.3:

- Test-first commit `c3b0b0976`: all four selected cases failed because the
  stream still had the normal 120-second window.
- PASS: the first complete four-file run passed all 102 tests.
- FAIL: the second run passed 100 of those 102 tests. Child review returned 503
  instead of 200 in `keeps outage queued then completes missing saves` and
  `hides failed status like an unknown request for removed`. These were not retried.
  The untouched baseline also failed nine recovery cases, including the latter.
- PASS: all four shortened cases passed in both complete runs. The second run
  also passed all 438 event security tests.
- PASS: removing the saved-failure guard made the shortened recovery case fail
  with six records instead of five. The production file was restored afterwards.

The table shows seconds from each JSON report's file start and end times. It
excludes initial file setup. All three batches used two workers and `nice -n 10`
on the same busy host, with disposable NATS, OpenFGA and PostgreSQL databases.
The throwaway PostgreSQL container and its volumes were removed afterwards.

| Test file | Before | After, first run | After, second run |
| --- | --- | --- | --- |
| child-recovery.test.ts | 292.22 (FAIL) | 184.62 | 202.34 (FAIL) |
| child-first-input.test.ts | 169.85 | 58.45 | 56.76 |
| child-summon.test.ts | 167.26 | 46.20 | 57.01 |
| child-requests.test.ts | 144.68 | 24.34 | 28.78 |

The recovery times include failed cases, so they are not a successful-run benchmark.
Local reports are `/tmp/ci-test-waits-before.json`,
`/tmp/ci-test-waits-after-1.json` and `/tmp/ci-test-waits-after-2.json`.
The red and mutation reports use the same prefix with `red` and `mutation`.
Full root tests and fresh-install qualification: NOT RUN.

### Recovery fixture cleanup

The recovery tests share two teams. Their old cleanup added Alice to both teams
again after every case, even when neither membership had changed. Later checks
then reread those extra events and checked each OpenFGA receipt within the same
two-second access deadline. The 503 happened when that deadline expired before
reading participation. The shortened duplicate window uses a separate fixture.

Cleanup now reads the saved team membership and restores Alice only after a
removal. It still applies each restoration through the normal event and permission
handler. The product deadlines, access checks and existing assertions are unchanged.

Own checks for this fix, 22 October 2026:

- PASS: the unchanged recovery file passed 35/35 during diagnosis. The fault
  depends on time spent checking receipts.
- Expected FAIL: test-first commit `ff6e477c3` showed that two cleanups without a removal
  added four events. The regression passed after the fixture fix.
- Expected FAIL: a temporary diagnostic ran 30 old cleanups and added 35 ms to
  each OpenFGA receipt lookup. Child review returned 503 after 67 receipt checks
  and 3.15 seconds. Its captured `TimeoutError` came from the participation read
  in `chat/access.ts`, using the deadline from `chat/child-requests.ts`.
- PASS: the same diagnostic returned 200 with the fixed cleanup. The temporary
  diagnostic and error logging were removed afterwards.
- PASS: full typecheck, event catalogue check, knip, changelog lint and all 438
  event security tests. Every command ran under `nice -n 10`.
- PARTIAL: the first full-lint attempt was stopped to use CI's 6 GiB Node
  heap allowance. Its log is `/tmp/ci-test-waits-fix-lint-default-heap.log`.
- PASS: full lint completed with `NODE_OPTIONS=--max-old-space-size=6144`.
  ESLint reported zero errors and 24 warnings in unchanged files. The final log
  is `/tmp/ci-test-waits-fix-lint.log`.

The four complete files then passed three consecutive runs under load. All used
`nice -n 10`, two workers, Node 22.23.3 and a throwaway PostgreSQL database set
through `PG_TEST_URL`. Every fixture kept its normal access and money checks.

| Run | Four changed files | Other test run |
| --- | --- | --- |
| 1 | PASS: 103/103 | FAIL: memory and chat access, 306/307 |
| 2 | PASS: 103/103 | PASS: recovery, 36/36 |
| 3 | PASS: 103/103 | PASS: recovery, 36/36 |

The first other run passed all 240 memory tests. Its unchanged
`chat-access-regression.test.ts` failed the long-session socket timing assertion:
2767.61 ms against a limit of 1500 ms. It was not retried or changed. That run
continued alongside runs 2 and 3, each of which also had its own recovery process.
The four-file sequence passed; the extra load-test results remain PARTIAL because
of this performance failure.

The file times below use the JSON reports' start and end times, excluding initial
file setup. They are local timings under load, not measured CI savings.

| Test file | Run 1, seconds | Run 2, seconds | Run 3, seconds |
| --- | --- | --- | --- |
| child-recovery.test.ts | 89.49 | 141.33 | 128.76 |
| child-first-input.test.ts | 36.36 | 73.16 | 50.17 |
| child-summon.test.ts | 31.91 | 38.63 | 42.99 |
| child-requests.test.ts | 19.51 | 24.66 | 24.38 |

Reports use `/tmp/ci-test-waits-fix-changed-<run>.json` and
`/tmp/ci-test-waits-fix-load-<run>.json`, with runs numbered 1 to 3. Their matching
`.log` files contain the command and output. The throwaway PostgreSQL container
and its volumes were removed after all test processes finished.

The diagnostic logs are `/tmp/ci-test-waits-fix-diagnostic.log`,
`/tmp/ci-test-waits-fix-red.log`, `/tmp/ci-test-waits-fix-green-focused.log`,
`/tmp/ci-test-waits-fix-cause-before.log` and
`/tmp/ci-test-waits-fix-cause-after.log`.

## Child activation test setup

The activation suite prepares its private NATS stream with the two-second duplicate
window before `summonFixture` saves any events. The empty-stream guard stays in place.
Shortening the window after setup fails because the fixture has already saved eleven
events. This change affects test setup only.

The call-site check covered both new activation test files and all duplicate-window
helper calls. The event-schema tests do not use NATS. The child-summon expiry case
already prepares its NATS stream before creating the fixture.

## Test dependencies

`test/recovery-stop.test.ts` checks restart recovery with the real journal, runner,
report writer and browser transcript. Other integration tests use the computer and
operator test helpers. The demo tool tests use `test/inventory.ts` to check their
public catalogue with the real inventory parser. Tests cannot import another
application’s source directly.

### Provider drain replay checks

The drain replay test compares every provider row and field in primary-key order.
It first rearranges the live table's physical storage with PostgreSQL `CLUSTER`.
This checks that replay keeps the same content even when database maintenance changes
where rows are stored. Neither query relies on the order of physical storage.

## Saved turn failure reasons

The bridge report reader accepts `stop_interrupted`, `model_error` and
`bridge_restarted` in the existing `reason` field and saves them unchanged.
A restart failure stays visible even if a Stop request was saved before the crash. Reports from older bridges
that omit a reason still save `bridge_interrupted`. Repeated reports keep the
original digest check. `tool-reports.test.ts` checks both saving and duplicates.

## Report delivery after a connection closes

The server finishes saving reports already accepted into its bounded bridge queue
after the connection closes. A later connection resumes from that saved position.
The queue still refuses more than 64 reports or 1 MiB per conversation. Report
validation, ordering and conditional writes remain required. The regression test
`test/bridge-pressure-recovery.test.ts` holds a write while the queue fills and
checks that all 64 accepted reports are saved after the connection closes.

## Closed chat cleanup

The bridge polls closed agent sessions as well as open ones. It reads the saved
conversation and computer events on every needed pass, including after a restart.
`chat/close-cleanup.ts` gives each waiting input a stable system
`agent.turn_failed` with reason `conversation_closed`. An admitted turn gets a
conversation-bound Stop while its original computer is ready. The Stop retries
after an uncertain send; it does not send the input again or wake a suspended
computer. A saved loss or replacement of the computer generation allows the
server to record failure. Terminal agent reports and `computer.turn_closed` are
repaired independently, using conditional appends. The existing computer turn
check prevents idle suspension before its ending is saved. No close route is
available yet. Confirmed Codex thread unload remains for a later change.

The progress cache checks one indexed position that includes both
`conversation-<id>` and older `participation-<id>` close events. An older close
therefore starts cleanup on the next pass, even if the running turn changed nothing else.
It keeps a settled chat cached when only the computer changes. A new saved
computer turn start still checks that chat again, so a late start can receive Stop.
The separate Stop watcher uses that same position, so an unchanged older close
does not make it reread the whole chat on every poll.
When cleanup ends a queued turn before its start report arrives, the chat summary
remembers that the system wrote the failure. `turnCommand` then saves a failed
`computer.turn_closed` with the reported thread and requester. The shared bridge
accepts only the matching terminal failure; other shared output still needs an
admitted start.

`test/bridge-control.test.ts` uses NATS, PostgreSQL and OpenFGA to check waiting
inputs, repeat passes, legacy close detection, terminal repair, Stop retry and a
lost computer. `test/shared-assistant.test.ts` checks the delayed shared start and
terminal failure on a real bridge, followed by another chat on that connection. Spend
reservations still follow their existing call reports; cleanup writes no budget
event. Fresh-install qualification: NOT RUN.

## Child origin GET

`chat/origin.ts` handles `GET /api/conversations/:conversationId/origin`, registered
inside `registerChatRoutes`. The [API contract](../../docs/api/group-chats.md#child-origin)
defines the strict linked and restricted replies. Session and active membership checks
precede creation and source reads, which share a separate ten-second deadline.
The source uses `readEventAt`; it must match the saved id, type, silo and parent id.
Child and parent participation checks follow, without an `authorityFence`.
Only a visible source allows the shared `list-summary.ts` reader to decrypt a title.
Errors carry no parent details. `test/child-origin.test.ts` uses real NATS, PostgreSQL
and OpenFGA, including permission outages, delayed reads, removal and unchanged state.
Fresh-install qualification is NOT RUN.

## Closed chat display (P4-6 PR 4b; Part of #88)

`chat/history.ts` handles HTTP history and supplies socket display rows. HTTP loads
join facts and encrypted rows before checking current access once with `requireMember`.
It decrypts only after that check. Join changes refuse the loaded page. No conversation
stream enters an authority fence. Socket access polling remains independent of loading.
The conversations reader returns up to 100 visible rows, scanning past late execution,
approval and publication rows and later duplicate closes. Socket delivery advances
through a completely scanned page, including hidden rows, so an idle closed chat
does not keep rereading its last page.
Human row positions and current history bounds stay unchanged. The list reads the stored
`conversations.closed` flag, which late terminal reports cannot reverse.
Shared-child read acknowledgements use participant access, including inherited parent
access streams for the write check, rather than private-session ownership.

`test/chat-access-regression.test.ts` covers both members, current and legacy closes,
more than 100 hidden reports, human posts, read acknowledgements, saved first-close
position, list status, socket delivery, restart/rebuild and independent parent/child close.
It also checks removal during HTTP loading and unrelated turn/file activity.
`test/member-guard-http.test.ts` keeps missing organisation setup at HTTP 503 and
checks that unexpected read failure details stay out of replies and logs.
Raw late rows remain in the event log and read table. There is no unread-count API
in this backend; hidden completed messages are absent from the displayed history.

PARTIAL: conversation-list paging beyond its existing 100-candidate limit remains
for the next part. Public close, cleanup and screens are not included.
Fresh-install qualification: NOT RUN.

## Close-safe turn acknowledgements (P4-6 PR 4, first part; Part of #88)

A stored `conversation.closed` on either `conversation-<id>` or legacy
`participation-<id>` refuses delayed starts with an ordinary `ack.refused`.
No token, expiry, model or context is returned. A never-admitted turn records one
failed `computer.turn_closed`. Already admitted work remains for PR 5 cleanup;
refusing a pass is not evidence that execution stopped. Exact replays and new
report sequences receive the same refusal. The shared connection stays open.

For a shared child whose admission was refused, `agent.turn_failed` may use the
saved failed `computer.turn_closed` instead of a start. The server reads that
close at the position held by the computer summary. It requires a server-written
close, no saved admission, and matching computer, assistant, conversation, turn,
requester, thread and shared-only class. Normal report sequence and digest checks
still apply. The failure records no new lifecycle event and returns no credentials.
Other output, completion and output-lost reports still require an admitted start.
The real computer channel tests cover both close streams, failure acknowledgement,
exact replay and another conversation continuing on the same connection.

`ChatFacts.turnEnded` tracks turn completion and budget stops separately from
`conversationClosed`. The turn-ended refusal remains `Turn is closed`.
Credential delivery reads incremental chat facts before context, after context
and after signing, with membership checked before release. These reads add no
conversation stream or close position to `authorityFence`.

The chat summary keeps its content append position separate from a later legacy
close. Late reports retain their digest, duplicate and sequence checks. The approval
watcher checks both conversation and participation positions before leaving a pending
approval unchanged. Closure cancels that approval through the existing reader.
History and read acknowledgements use the same close-position and message-author check.
After close, only human `message.posted` rows remain visible and can be marked read.

Public close and execution cleanup remain later work. Display reads are covered
below. Fresh-install qualification: NOT RUN.

Member directory GETs return `permissions.invite: true` after current Owner/Admin
checks. Detail GETs return `changeRole` and `remove: true` for active non-owner
targets, including the caller. Owner targets keep both false. Member headers keep
literal false flags. These reads append nothing.

`test/approvals.test.ts` covers saved drift and a failed catalogue check followed by
renewal while an approval is unread. The existing approval reader saves cancellation;
a late Approve cannot send a call. An unchanged check alone preserves approval.
Gateway restart is covered; no watch worker is added by #48 PR 3's first part.

## Shared child output admission

Every new child output report must name the thread from its first server-owned
`computer.turn_started`. That saved start must have `sharingClass: shared_only`
and `executionMode: restricted`, and match the computer, assistant, conversation,
turn and message author. Missing, private, closed or substituted turns are refused
before encryption and append. The report class still belongs only on start reports.
The saved start supplies the class for later output.

Reports use the computer summary with a separate ten-second history deadline.
They add no conversation stream to an access check. Exact saved report retries
keep their digest check and can be acknowledged after the computer turn closes.
`test/shared-child-reports.test.ts` covers these refusals and closure retries.

## Computer credential delivery

The bridge connection caller and lifecycle worker share `SandboxClient.credentials`.
Delivery now uses root-only Pod exec and standard input, without token arguments.
Both callers include the issuer's public P-256 JWK as `verifier`. The computer
checks the signature and saves the key, signed identity and local Pod UID beside
the token hash and expiry. The server then presents the
actual token to `/bridge`. Public HTTP replacement is removed. Deploy the new
computer image first; old images refuse delivery because the installer is absent.
See the [computer contract](../computer/README.robot.md#bridge-credential-delivery).

## Conversation preferences (P4-6 PR 3; Part of #88)

`POST /api/conversations/:conversationId/state` accepts `chatStateCommandSchema`:
`{id, action: archive, archived, expectedArchivePosition, joinEventId}` or
`{id, action: read, throughPosition, throughEventId, joinEventId}`. Only the caller's
currently readable conversations qualify, including closed chats. Writes require
the member guard and configured Origin. They need no spending permission.
Each command appends once to `chat-state-<memberId>`. Archive commands reject a
stale opposite choice. Read commands verify the submitted event against the saved
log and available history; the existing projection keeps the maximum across devices.
Commands load incremental summaries before the two-second access check. Only member,
participation and relevant assistant/team streams enter that check. A changed member
preference stream allows at most three append attempts, each with fresh access checks.

Retries verify the stored identity, data and original input hash, including archive
expectations. Event ids are hashes of silo/member/command ids; `correlation.request`
holds the input hash. Neither contains content. Changed same-id inputs return 409.
`GET /api/conversations/:conversationId/changes/:commandId` checks the caller's
preference stream before the shared feed, point-reads the saved event and returns
`projection.content: applying|current` separately. Missing results remain unknown.
Old joins and other people's choices are unavailable. List rows include `joinEventId`,
`archived`, `archivePosition`, `throughPosition` and optional `throughEventId`.
Invalid bodies return 400, denied access 403, conflicts 409 and unavailable writes 503.
All replies use no-store. Reads, archive and read markers start no turns or computer
activity and reserve no money. Screens and fresh-install qualification: NOT RUN.

`test/direct-chat-http.test.ts` covers lost replies, changed and concurrent retries,
stale opposite choices, unrelated stream changes, read verification and maximum,
rebuild, re-addition, two server instances and closed personal sessions.

## Welcome survey HTTP (P4-18 row 4; Part of #101)

`GET /api/onboarding` reads exact personal-stream history through an incremental
summary. It returns `state: not_started|survey|review`, survey generation,
position, nextStep (null after step 4), authorised decrypted steps and up to 20
recent receipts. It does not depend on a lagging read table. Each saved answer
is checked with the event catalogue's ciphertext digest before decryption.

`POST /api/onboarding/survey` accepts strict `commandId`, `generation`,
`expectedPosition` and `operation: save_step|restart`. Save also takes typed
`answers` including `step: 1|2|3|4`. Only a confirmed preceding step allows
advancement. Editing drops later current answers. Restart appends the next
survey generation; it never rewrites earlier events. Step 2 groups require
current membership in each selected group. Content loads before the two-second
write check, which watches member and selected group streams only. Each command
makes one conditional append. Replies are checked against the saved event,
including when NATS returns another device's same-id acknowledgement.

`GET /api/personal/changes/:commandId` point-reads the original saved survey event.
Missing commands remain unknown. GET never repeats a write. Replies use no-store
and the shared member guard; writes require the configured Origin. Invalid fields
return 422, stale or changed input 409, access refusal 401/403/425 and service
failure 503. An uncertain append returns 503 with `status: unknown`.
The server needs `PERSONAL_KEY_DIRECTORY`, pointing to the private directory used
by the membership key reaction. It has no default and does not use conversation
keys. These routes work without chat or computer configuration. Keys use existing
`personal:<memberId>` custody; routes never prepare keys.
No model call, computer wake or spending path is used.

`test/survey-http.test.ts` covers real NATS/PostgreSQL/OpenFGA requests, reload,
replay, edited progress, strict fields, lost replies, same-id races, two-device
restart, slow history, unrelated activity, missing keys and removal during reads.
Run it with the supplied `PG_TEST_URL`, `nice -n 10` and one Vitest worker.
Persona approval events are not on main yet: active-approval preservation remains
NOT RUN until row 6. The survey append retains all earlier personal events.
Survey steps 1 and 2 use intercepted replies in `apps/web`. Screens for steps 3
and 4, and fresh-install qualification are NOT RUN. The server survey journeys
have not been run as part of this screen change.

## Shared member guard

`src/members/guard.ts` supplies `requireMember`, `MemberRefusal`, `idSchema` and
`sameOrigin`. Chat, approval, file and personal tool-instance routes use it. Other member routes,
screenshots, live view and integrations still use their existing checks; their
migration is the remaining part of #121.

The guard returns the verified session, member id, configured options and chat
access result. It checks the issuer-bound cookie, configured organisation and silo,
exact identity exceptions, Origin for writes, current event-log membership,
OpenFGA membership and conversation access. Refusals carry HTTP 401, 403, 425 or
503 and their response status. Missing organisation setup returns 503. Each guarded
reply uses `Cache-Control: no-store`, including refusals. File parser refusals do too.
The identity exceptions already worked in these routes before this change.

The guard calls the existing read access check. It never opens a write check or
reads a whole conversation history. Commands still load their history before
starting the two-second write check. File and approval ids keep their existing
word-character restrictions; chat ids keep the wider event-catalogue format.

`test/member-guard-http.test.ts` checks all 16 migrated HTTP operations for missing
organisation setup, an unlisted identity and a cookie from another issuer. It also
checks a silo/binding mismatch with otherwise-valid membership and separate Origin
refusals for POST messages and participants. Each write succeeds from the website
with the same cookie and body. Removing the silo comparison or write Origin check
makes these cases fail with HTTP 200 instead of 403. The
organisation audit follows calls to `requireMember` and requires the guard to call
`isOrganisationSession`. Removing either call still fails the audit. The
first test commit fails 22 cases before the guard is added: 16 setup statuses and
six missing cache headers. Existing route tests cover allowed requests, removals,
conversation access, Origin and slow histories. The required changed-route checks
run with `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres` under
`nice -n 10`. Full root tests and a fresh-install journey are NOT RUN for this part.

## Personal tool-instance HTTP routes

`GET /api/my/tools/:serverId/profiles/:profileId/instance?instanceId=…` returns
the current owner's safe status. Its `/stop` and `/wake` POST routes take only
`changeRef` and `expectedSequence`. The server derives the run; extra identity,
generation or action fields are invalid. Wake always refuses with
`profile_or_admission_unavailable`. Stop records intent only; no worker runs it yet.
`GET /api/my/tools/changes/:changeRef?instanceId=…&profileId=…&serverId=…` reads
the owner's original receipt, including after a later run starts.
The exact instance reference identifies saved history. It grants no access.
These query fields are needed until usable personal profile lookup is available.

`requireMember` checks the session, organisation, silo and mapped member.
Its `sameOrigin` check protects writes. All ids use `idSchema` with the event
contract's restrictions. The library loads instance history before its final
membership check or short write check. No conversation stream is read or watched.
Replies use `Cache-Control: no-store`, including malformed or oversized POST bodies.
Missing or foreign instances return 404 with `status: unknown`; a missing change
on an owned instance returns 200 with `status: unknown`. Neither is terminal proof.
Invalid input returns 400, changed retries and stale revisions return 409,
and unavailable dependencies return 503 without internal response details.

`POST /api/org/integrations/:serverId/instances/:instanceId/stop` takes only
`profileId`, `changeRef` and `expectedSequence`. The server supplies the silo,
actor and current run. `GET` on the same path with `/changes/:changeRef?profileId=…`
returns only that admin's original stops. It never changes an instance.
Owners and admins can use these routes for another member's instance. A plain member
is refused before that instance's history is read. Writes check the admin role again
after history and before the conditional append. Membership and ownership histories
load with a ten-second limit before the two-second write check starts. That check
watches the actor's member stream; a caller using the Owner role also watches the
silo's ownership stream. Another person's ownership change cannot refuse an Admin's
stop, while an acting admin's demotion still refuses it. Responses contain only status,
change reference, sequence, run generation and reason. Both routes use the same
4,096-byte POST limit, strict ids, `no-store` and safe error replies as member routes.

There is no workload start, wake, credential release, callable instance or new installer.
Every MCP still installs through the shared hosted path.

### Authenticated worker observations

`registerMcpInstanceWorkerRoutes(app, store, silo)` returns a trusted in-process
`register` function. It checks an exact saved identity, start, run, workload digest,
known Pod UID and expected sequence. It issues a random bearer for at most 30 seconds.
The trusted caller receives the bearer once; the server retains only its SHA-256 digest
as the lease lookup key and hashes incoming credentials before lookup. A timer removes
each expired lease. Replacing a registration retires the earlier pass for that instance,
cancels pending append backoff and prevents further publish attempts. Append also uses
the pass's remaining lifetime as its deadline. Closing the server cancels all timers
and passes. There is no HTTP registration route.

`POST /internal/mcp/instances/:instanceId/observations` takes `changeRef`,
`expectedSequence`, `state` and optional safe `reason`. It requires that worker pass;
member and admin cookies grant no observation permission. Each new report checks
saved history again and makes one conditional append. Changed retries conflict.
The pass supplies all instance, user, profile, server, run and Pod fields.
Replies and parser errors use no-store and hide internal errors.

The normal server registers the route when instance dependencies are configured.
No process registers a live workload worker yet. Pod creation and confirmation against
Kubernetes remain design row 3. Reports cannot wake, release material or claim callable
readiness.

### Worker credential correction checks, 12 October 2026

Runtime changes: `ff0c8e45` and `9d4575a9`. Rebased onto
`2f56a09fb11c8128e366d17c9ab0f13393411ad2`; the rebase completed and that base
is an ancestor of this branch. Test commit `417d2241` preceded implementation.
Its five new cases failed: expiry and replacement each allowed another publish,
and the lease map retained the bearer and expired entry. The NATS failure injection
now lives in the event-store test helpers, without adding dependencies.

PASS: two final focused runs, 15 files and 566 tests each, in 226.06 s and 192.81 s.
Both ran under `nice -n 10`, with one worker and
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
The batch covers all event-store tests, worker and member instance routes, model
instance commands, instance event contracts, event security rules and both unchanged
authority test files. Tests use disposable NATS/OpenFGA and private test databases.
The new retry cases assert no further publish, no later event and unchanged instance
state. The storage case checks retained lease entries and automatic expiry cleanup.

PASS: full lint, workspace typecheck, event catalogue (129 types), standalone Knip,
dependency rules and changelog checks. Lint reports 16 existing warnings and no errors.
Logs: `/tmp/p3-10-pr2c-fix-final-{2,3}.log`,
`/tmp/p3-10-pr2c-fix-{typecheck,events,knip,changelog}-final.log` and
`/tmp/p3-10-pr2c-fix-deps.log` and `/tmp/p3-10-pr2c-fix-lint-complete.log`.
NOT RUN: full root suite, live Kubernetes and fresh-install qualification.
Admin commands and live workload registration remain unfinished.

### Worker observation source checks, 12 October 2026

Source `144ddd5c`; base `326eaeae`. Linux worktree, disposable NATS/OpenFGA and
private PostgreSQL test databases; not a fresh silo. The pinned gateway was fetched
before the final runs. PASS: `npm ci` and the requested NATS/Lychee links.
Tests-first commits: `20454674`, `20d4aff1`, `2bfed203`. Failing checks covered missing
worker behaviour, stale observation revisions, member cookies and retired workers.
PASS: two seven-file batches, 467 tests each, in 84.17 s and 72.08 s. Both used
`nice -n 10`, one worker and `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
Both authority test files are unchanged. PASS: lint, workspace typecheck, check:events
(127 types), standalone Knip and lint:changelog. Lint has 15 existing warnings.
Logs: `/tmp/p3-10-pr2c-tests-final-{1,2}.log` and
`/tmp/p3-10-pr2c-{lint,typecheck,events,knip,changelog}.log`.
PARTIAL: design row 2; admin commands and their refusal cases remain next.
NOT RUN: full root suite, live Kubernetes and fresh-install qualification.

### Source checks, 12 October 2026

Runtime source: `ab3fade6`, based on main `f46d7721`. Linux worktree after `npm ci`;
NATS and Lychee use the requested local tool links. HTTP uses Fastify request injection
with real disposable NATS, OpenFGA and PostgreSQL databases. This was not a fresh silo.
Test-first commits: `a1fce8bf` failed all ten initial HTTP cases; `40b777bf` failed
three cases requiring server-derived runs; `4114ac8d` records the parser-cache refusal
after that case failed. The fixes keep every refusal and original-receipt assertion.
PASS: two focused batches, 497 tests each in 27.14 s and 29.63 s, one worker,
`nice -n 10` and `PG_TEST_URL`. Earlier checks used the supplied port 55432;
final batches used a throwaway PostgreSQL container, removed with its volume afterwards.
PASS: workspace typecheck, event catalogue (125 types), standalone Knip and changelog checks.
PASS: full lint. Logs: `/tmp/p3-10-pr2b-lint.log`.
Both authority test files are unchanged. No full root suite ran.
PARTIAL: design row 2. Observation/admin commands and worker registration remain unbuilt.
NOT RUN: their refusal tests, live Kubernetes and fresh-install qualification.
Logs: `/tmp/p3-10-pr2b-tests-final-{1,2}.log`, `/tmp/p3-10-pr2b-typecheck-final.log`,
`/tmp/p3-10-pr2b-events.log`, `/tmp/p3-10-pr2b-knip.log`, `/tmp/p3-10-pr2b-changelog.log`.

## Dated MCP catalogue evidence

Tool lists carry check and expiry dates; undated lists cannot authorise calls.
Unchanged checks preserve the approval rule revision while advancing the write position.
The [projection contract](../../libs/projections/README.robot.md#dated-mcp-catalogue-evidence)
records snapshot and expiry rules for #48 PR 1.

Discovery uses the shared catalogue hash format from `@opencrane/events/mcp-catalogue`.
Append and policy replay check those hashes against the saved definitions. Catalogue
checks renew only the exact server and silo; incomplete older lists stay unavailable.

The private-turn preview tests use dated recall definitions and their calculated hashes.
They still check empty previews, permitted facts, omissions, access changes and the
16 KiB and 32-reference limits. An undated legacy catalogue cannot authorise preview reads.

The memory fairness cases start fresh service fixtures. They do not reuse history or
unfinished recovery records from earlier tests. Their 13-request completion check,
1,500 ms deadlines, private refusal and database connection limits are unchanged.

The nightly binding cases run before fairness cases replace the shared service fixtures.
This keeps their event store alive for consent, retry and replay checks. Their assertions
and time limits are unchanged.

The MCP recovery cases also start fresh service fixtures. This keeps earlier grant
and catalogue histories out of each timed write. Each case must receive HTTP 200
and reach the simulated append failure once before checking its recovery records.
The following cases also use fresh services because NATS stops when a test finishes.
Memory passes still last at most two seconds.

## Memory scope and search reads

`GET /api/memory/scopes?assistantId=...&groupId=...` returns the requester's own
scope and permitted selected scopes, their audiences, separate operation rights and limits.
`GET /api/memory/:scopeId/facts?q=...&cursor=...` returns current, unexpired facts.
Session identity uses the existing member binding. Roles and labels grant no memory access.
Notes require their current assistant audience, `actsFor`, and an explicit `memory_read`
grant checked as OpenFGA `resource#use`. Missing grants deny. Only unapplied grants for the caller, their groups or the selected
assistant return 503. Grant kinds stay separate even when their ids match. Applied checks
and group checks are reused within one request and are checked again on the next request.
Reads check permission once, without a write fence or conversation history.

Queries allow 256 UTF-8 bytes after NFC normalisation and eight Unicode words.
Words contain Unicode letters, combining marks and numbers. Stored search text uses NFC too. TypeScript builds
literal full-text terms and prefixes. PostgreSQL ranks pins, exact matches, prefix rank,
then memory id. Pages contain up to 20 whole facts and 16 KiB, with no totals or sources.
A fact that cannot fit alone is replaced by `{memoryId, revision, reason: "page_limit"}`.
Destroyed and quarantined content is excluded. Expiry is compared using `Date` instants.
Signed cursors use the existing cookie secret with a separate signing prefix. They bind
requester, silo, scope, normalised query, order, scope position and projection generation.
The signed cursor also keeps the first page time, so expiry cannot shift later pages.
Changes reset paging with 409. Memory or setup-table lag and a concurrent rebuild return 503.
Scope lookup uses the same setup-table path with or without stored facts and skips old id formats.
Unknown, foreign and forbidden scopes return the same 404. Invalid input returns 422.
All responses use `Cache-Control: no-store`. Startup uses the existing database,
NATS and OpenFGA settings. Set `MEMORY_KEY_DIRECTORY` on the server and memory worker.
Without it, the server returns `{status: "unavailable", reason: "memory_unavailable"}`
with HTTP 503. The worker needs the existing directory; it never creates missing custody.
The [worker instructions](../ops/README.robot.md#run-the-live-memory-worker) cover setup.

`test/memory.test.ts` runs HTTP reads with real NATS, PostgreSQL and OpenFGA.
Set `PG_TEST_URL` to a PostgreSQL service that permits disposable databases.
`GET /api/memory/:scopeId/facts/:memoryId` returns one authorised, unexpired fact
and separately checked source statuses within 16 KiB. Unknown, foreign and forbidden
fact ids use the same 404. Expired facts also return 404. Destroyed and quarantined facts
return HTTP 200 with `{status: "unavailable", scopeId, memoryId, revision, reason}`.
The reason is `destroyed` or `quarantined`; this result contains no fact text or sources.
Older quarantined rows can have `revision: null`. Detail reads only their identity,
expiry and content status, so missing text metadata cannot turn this into a service error.
Projection lag or a changed generation still returns 503.

Source checks use existing conversation permissions before looking up content. An indexed
lookup finds one message id within the caller's latest participation period after the
conversation worker has caught up, then confirms one
event at that position in NATS. No source check replays a whole conversation.
A denied or missing source returns only `{status: "refused"}`. A service failure returns
only `{status: "unavailable"}` while the readable fact remains available. Neither result
contains a reference or preview. Member statements return the neutral label "a member's
statement", without memberId or commandId, including after the author has left.
Source checks need the server's existing chat settings and conversation read table.
No source preview is stored or returned.
Oversized authorised detail returns 503. The fresh empty runner and HTTP read test
passes with real services.
Full fresh-install memory journeys and native turns remain NOT RUN.

`POST /api/memory/:scopeId/facts` accepts commandId, text, kind, pinned, expiresAt,
sources and dependsOn. It accepts human writers only and checks Origin. Person ownership
and group membership grant write access. Notes require `memory_write` from saved grants
and OpenFGA; a read grant never supplies it. Empty sources record the writer's statement.
Chat sources are allowed only in person scopes, with message access checked separately.
Current chats cannot prove durable whole-group visibility, so shared message sources are refused.
Preferences stay personal. Text allows tabs/newlines but refuses other C0 controls.
Commands and events have separate 16 KiB limits. Dependencies require a live same-scope revision.

Write permission is checked before inspecting scope history, dependencies or sources.
Chat access is checked before an indexed message lookup in the conversation read table.
The lookup checks that the worker has caught up, then checks one saved event in NATS.
These content checks finish before the final two-second access check. The final check
watches only member, assistant, team and write-grant streams. Member and scope permission
history, and OpenFGA checks, finish before taking a database connection or command lock.
The watched stream positions are checked before taking the lock and again before append.
Each command makes one conditional append at the scope position read from history.

Each process allows four active memory writes. Each member can have at most one
active write and one queued write across all their scopes and sign-in sessions.
The member identity includes the silo, so members in different silos stay separate.
A second queued write from the same member is refused immediately. Permission history
and OpenFGA checks finish before asking for a slot or reserving a database client.
Up to eight writes can wait for at most 100 ms. A released slot goes to the oldest
waiting write whose member is free to write. Requests for a member and scope already
active or waiting are also refused immediately.
A full queue or expired wait returns 503 `{status: "unavailable", reason: "memory_busy"}`
with `Retry-After: 1`. Waiting writes hold no database client. The permission stream
positions are checked again after waiting and before taking the command lock.
A slow append holds one shared connection for that member, leaving the default
10-connection pool room for other queries. Separate server processes each have their
own limit and pool.
A PostgreSQL advisory lock keeps attempts for the same command together across servers.
Memory commands wait at most 100 ms for this lock; a busy lock returns 503. Work inside the
lock holds one database client. It reads only scope events newer than the earlier history,
with a 100 ms deadline. Refusal checks use the same read limit and the remaining write
deadline. No conversation content or OpenFGA checks run inside the lock.

The full encrypted event size is checked before a revision key is created. Changed saved
inputs return 409. Lost replies return `outcome: "unknown"`; clients check
`GET /api/memory/:scopeId/changes/:commandId` instead of resending. Status returns only
this principal's original command, after projection catch-up, including for a notes writer
without a read grant. Receipts contain references and audience, never text. An unusable
consumed command keeps its accepted receipt and adds `contentStatus`: erased, superseded or invalid. It never
compares old text, provisions a replacement key or appends again. Missing custody returns 503.

The existing 0700 key directory also holds temporary command records. Their fingerprint
leaves text out. A resolved record is deleted. Each new record stores the expected scope
position used by its conditional append. A timeout alone cannot prove failure: NATS can
still accept a delayed publish. After the append window ends, status, retry and recovery
checks release an unknown key only when the scope has advanced beyond that expected
position without saving the command. That proves the delayed append cannot succeed.
An unchanged scope stays unknown and keeps its key. Older unknown records without the
expected position also keep their keys, even if the scope advances. Prepared records
can be removed because no append was issued. Failed commands keep only the destroyed-key
marker and cannot append again. An unseen command stays unknown.
Startup launches recovery in the background. Recovery reads directory entries gradually,
yields after every 16 records and limits each scope read to one second. It reads history
before taking a database connection, then checks that the record has not changed under
the command lock. A damaged record, busy lock or event-store outage leaves the record
for a later check and never stops startup.
Keep all servers for a silo on the same database and key directory.
Fresh-install memory journeys and native turns remain NOT RUN.

The Node service exposes sign-in routes, invitation acceptance, the organisation MCP
register, a health check and authenticated WebSocket routes. It does not serve static
files: `GET /` returns 404. The [web app](../web/README.md) is built and served separately;
during development Angular's server runs on port 4200 and
proxies `/api`, `/auth` and `/ws` here on port 8080. The membership command writes only to
the event store; projection writes belong to listeners in `libs/projections`.

## Entrypoint and operation

[main.ts](src/main.ts) starts Fastify and attaches `/ws`. From the repository root:

```sh
npm start -w apps/server
curl --fail http://localhost:8080/healthz
```

Provision OIDC settings first; startup rejects missing or invalid configuration.
Required: `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_REDIRECT_URI` and
`OIDC_COOKIE_SECRET` (at least 32 bytes, injected from the secret store).
Production also requires `OIDC_EXPECTED_ORG_ID` and refuses `OIDC_EXTRA_IDENTITIES`
whenever it is set, including empty values. Development and tests may use the latter
to name exact issuer/subject exceptions; it is empty by default.
The callback is `/auth/callback`.
See [auth configuration and defaults](../../libs/auth/src/config.ts), including
client-secret indirection, scopes, cookie settings and provider claim names.
`HOST` defaults to `0.0.0.0`, `PORT` to `8080`, `LOG_LEVEL` to `info`.
`WS_HEARTBEAT_INTERVAL_MS` sets the `/ws` heartbeat interval. The unchanged default
is 15000 ms. It must be a positive integer no larger than 2147483647. Embedded
servers can pass the same interval as the sixth `attachWebSocketServer` argument.
The heartbeat test uses 500 ms and still uses real sockets and timers: unanswered
pings close at the next tick, while answered pings keep the connection open. Other
realtime tests keep the production default, including the paused-consumer test.

`OTEL_EXPORTER_OTLP_ENDPOINT` enables optional trace export when set.
Disabling secure cookies or allowing insecure OIDC HTTP is only for local testing.

## File upload runtime licences

These packages support file inspection and upload handling in `apps/server`.
Their pinned versions and package metadata are recorded in the root lockfile.

| Component | Licence | Source or use |
| --- | --- | --- |
| ClamAV 1.5.2 | GPL-2.0 (OSI-approved) | [ClamAV COPYING](https://github.com/Cisco-Talos/clamav/blob/clamav-1.5.2/COPYING); virus scanner service |
| Copied OpenCrane 1 scanner | AGPL-3.0-or-later (OSI-approved) | `infra/clamav/upstream/LICENCE`; unmodified scanner source |
| MinIO JS client 8.0.7 | Apache-2.0 | installed package `LICENSE`; object storage client |
| file-type 21.3.4 | MIT | installed package `license`; checks file content signatures |
| yauzl 3.4.0 | MIT | installed package `LICENSE`; bounded Office ZIP inspection |
| cfb 1.2.2 | Apache-2.0 | installed package `LICENSE`; legacy Office stream inspection |
| fast-xml-parser 5.11.2 | MIT | installed package `LICENSE`; decoded Office metadata inspection |

MinIO's pinned server is AGPL-3.0. Uploads add no licence exceptions, provider SDK,
runtime data package or new computer-image package. MarkItDown is already in the
reviewed computer image.

The ClamAV service image and copied scanner have their own reviewed notices in
[`infra/clamav/LICENCES.md`](../../infra/clamav/LICENCES.md).

## Settings

The server, models and one-time bootstrap command read these environment variables.
“When needed” means a feature or connection is enabled. A process refuses to start if
one of its required settings is missing.

| Variable | Process | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `PORT` | Server | No | `8080` | HTTP port. |
| `HOST` | Server | No | `0.0.0.0` | Address for the HTTP listener. |
| `SHUTDOWN_GRACE_MS` | Server | No | `10000` | Maximum time allowed for a clean shutdown. |
| `NODE_ENV` | Server | No | None | Selects production sign-in rules and the development model-decision URL. |
| `OIDC_ISSUER_URL` | Server | Yes | None | Sign-in provider address. |
| `OIDC_CLIENT_ID` | Server | Yes | None | Client name registered with the sign-in provider. |
| `OIDC_REDIRECT_URI` | Server | Yes | None | Sign-in return address. |
| `OIDC_COOKIE_SECRET` | Server | Yes | None | Secret of at least 32 bytes for browser cookies. |
| `OIDC_CLIENT_SECRET_ENV_VAR` | Server | No | None | Name of the environment variable holding the provider secret. |
| `OIDC_POST_LOGOUT_REDIRECT_URI` | Server | No | None | Address to open after provider sign-out. |
| `OIDC_EXPECTED_ORG_ID` | Server | Production, or with NATS | None | Organisation allowed to sign in to this silo. |
| `OIDC_EXTRA_IDENTITIES` | Server | Development and tests only | Empty list | JSON list of exact issuer and subject exceptions. Production refuses any set value. |
| `OIDC_SCOPES` | Server | No | `openid profile email` | Sign-in details requested from the provider. |
| `OIDC_COOKIE_NAME` | Server | No | `oc_session` | Browser session cookie name. |
| `OIDC_FLOW_COOKIE_NAME` | Server | No | `oc_auth_flow` | Sign-in flow cookie name. |
| `OIDC_COOKIE_SECURE` | Server | No | `true` | Requires HTTPS for browser cookies. |
| `OIDC_SESSION_MAX_AGE_SECONDS` | Server | No | `43200` | Browser session lifetime. |
| `OIDC_ORG_CLAIM` | Server | No | `org_id` | Provider claim containing the organisation id. |
| `OIDC_ROLES_CLAIM` | Server | No | `roles` | Provider claim containing role names. |
| `OIDC_STEP_UP_MAX_AGE_SECONDS` | Server | No | `300` | Maximum age of a recent sign-in for sensitive actions. |
| `OIDC_ALLOW_INSECURE_REQUESTS` | Server | No | `false` | Allows plain HTTP to the provider for local use. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Server | No | Unset | Sends tracing data to this collector when set. |
| `NATS_URL` | Both | Models yes; server when events are enabled | None | NATS event-log address, without credentials. |
| `NATS_NKEY_SEED_FILE` | Both | Yes when using NATS | None | Path to the NATS client key file. |
| `NATS_CA_FILE` | Both | Yes when using NATS | None | Path to the NATS certificate authority file. |
| `NATS_CERT_FILE` | Both | Yes when using NATS | None | Path to the client's NATS certificate. |
| `NATS_KEY_FILE` | Both | Yes when using NATS | None | Path to the private key for the client certificate. |
| `NATS_INBOX_PREFIX` | Both | Yes when using NATS | None | Prefix for private NATS reply subjects. |
| `SILO_ID` | All three | Models yes; server with events; bootstrap command | None | Id of the silo whose events and projections are used. |
| `DATABASE_URL` | Both | Models yes; server when projections are enabled | None | PostgreSQL connection address. |
| `OPENFGA_API_URL` | Both | Models yes; server with projections | None | OpenFGA permission service address. |
| `OPENFGA_STORE_ID` | Both | Models yes; server with projections | None | OpenFGA store used by this silo. |
| `OPENFGA_MODEL_ID` | Both | Models yes; server with projections | None | OpenFGA permission model used by this silo. |
| `CONVERSATION_KEYS_DIR` | Both | No | Unset | Directory of keys for private conversation content. |
| `CONVERSATION_WRAP_KEY_FILE` | Both | No | Unset | Optional 32-byte Kubernetes Secret used to encrypt conversation keys stored in that directory. The chat server and model process must use the same file. |
| `MINIO_CREDENTIALS_FILE` | Server | No | Unset | Enables file storage with credentials read from this file. |
| `MINIO_URL` | Server | Required with MinIO credentials | None | MinIO object-storage address. |
| `CLAMD_HOST` | Server | No | `127.0.0.1` | Address of the file scanner. |
| `CLAMD_PORT` | Server | No | `43310` | Port of the file scanner. |
| `KUBECONFIG` | Server | Required for chat computers | None | Path to Kubernetes access settings. |
| `KUBE_NAMESPACE` | Server | Required for chat computers | None | Kubernetes namespace holding computers. |
| `TOKEN_SIGNING_KEY_FILE` | Server | Required with chat or budget checks | None | Path to the private token-signing key. |
| `TOKEN_ISSUER` | Both | Models yes; server with chat or budget checks | None | Name that appears as the token issuer. |
| `MODEL_DECISION_URL` | Server | No | Development URL in development; otherwise unset | Address of the models decision service. |
| `PROVIDER_SECRETS_DIR` | Both | Models after switch-on | Unset | Shared provider custody directory. Required by models after switch-on; startup does not read keys. |
| `MODEL_STATE_DIR` | Models | Yes | None | Directory for model gateway state and usage records. |
| `MODEL_JWKS_FILE` | Models | Yes | None | Path to the public keys used to check signed tokens. |
| `DEFAULT_PAYING_GROUP_ID` | Models | No | `installation-default` | Group charged for personal assistant use by default. |
| `MODEL_DECISION_PORT` | Models | Yes | None | Port for model budget decisions. |
| `MODEL_GATEWAY_PORT` | Models | Yes | None | Local port for the AI gateway. |
| `AGENTGATEWAY_BINARY` | Models | Yes | None | Path to the agentgateway program. |
| `MODEL_KEY_FILE` | Models | No; refused after switch-on | `.keys/.openai-key` in the repository root | Legacy gateway key file. Any configured value after switch-on stops startup. Managed mode never resolves the default path. |
| `MODEL_READINESS_PORT` | Models | Yes | None | Port used to check whether the AI gateway is ready. |
| `MODEL_UPSTREAM` | Models | No | Unset | Optional upstream address for the AI gateway. |
| `MODEL_GATEWAY_CONTROL_PORT` | Models | Yes | None | Private port for exact configuration replies; never forward it. |
| `BOOTSTRAP_TOKEN_FILE` | Bootstrap command | Yes | None | Private file where the one-time token hash and expiry are stored. |

Set `NATS_URL`, `SILO_ID` and `OIDC_EXPECTED_ORG_ID` to enable membership acceptance.
`SILO_ID` is the event silo; the OIDC setting pins the session organisation. Startup
refuses a NATS configuration missing either pin. Provision the silo's `EVENTS`
stream separately with the [event-store adapter](../../libs/event-store/README.md).
Without NATS configuration, authenticated membership requests return unavailable.
The process owns and closes its NATS connection. Set `NATS_NKEY_SEED_FILE`, `NATS_CA_FILE`, `NATS_CERT_FILE`
and `NATS_KEY_FILE` to mounted files for the command role, and set
`NATS_INBOX_PREFIX=_INBOX.command`; missing credentials fail startup. TLS and permissions use [ADR 0005](../../docs/adr/0005-nats-access.md).
Never put credentials in a URL or event. Fresh-silo qualification remains pending.

## Contract and verification

Session routes and `/ws` use `isOrganisationSession`. Routes that already report
503 without `OIDC_EXPECTED_ORG_ID` keep that response. Without that setting,
`/ws` and `/auth/logout` refuse valid sessions with 403, and `/auth/me` reports
`authenticated: false`. Development sign-in still works without the setting.
The first-owner claim uses the stricter installation-organisation check.

`test/organisation-check.test.ts` scans all server source files. It refuses calls
to `isIdentityAllowed` outside `auth/routes.ts` and requires an
`isOrganisationSession` call in each API route file. It reads TypeScript syntax,
so imports, comments and strings do not count as calls. The first-owner claim is
an explicit exception; `/healthz` is public and outside `/api`.

`GET /auth/login` redirects to the provider; `GET /auth/me` reports the session,
including the optional signed-in profile `user.name` for display.
`POST /auth/logout` requires the exact configured Origin and a valid session for
the pinned organisation. Refusals clear no cookies. Success clears the local cookie
and answers a top-level form POST with **303 See Other**. Its `Location` is the
provider end-session endpoint with `id_token_hint`, `client_id` and the configured
`post_logout_redirect_uri`; the response body is empty and marked `no-store`.
The ID token stays out of JSON, page JavaScript and logs. If provider logout is
unavailable (including older cookies without an ID token), a plain-text page says
only the OpenCrane session ended. `/auth/me` never returns the token.
Zitadel ends **all accounts in that browser**, returns without a chooser and
requires credentials on the next sign-in (which may first select a remembered
account); see the [live evidence](../../docs/process/signin-evidence.md).
Invalid callbacks return 400; `/ws` upgrades require a valid cookie and matching Origin.
The socket supports resumable members subscriptions, plus the existing hello and event-validation demos; it never appends events.
See [protocol schemas](../../libs/protocol/README.md) for real request examples.

`POST /members/join` requires the encrypted session cookie, JSON and an `Origin`
matching the OIDC redirect origin. Example JSON:

```json
{"memberId":"alice","invitationId":"invite-alice","commandId":"join-alice","displayName":"Alice"}
```

The [typed result](src/members/join.ts) is `joined` or `already_joined` (200, with
`memberId` and global `sequence`), `refused` (with a stable `reason`), or
`unavailable` (503). Missing/invalid/expired sessions return 401, an invalid Origin
or other session organisation returns 403, invalid command fields return 400,
and domain refusals return 409. Fastify rejects malformed JSON and oversized bodies
before command execution. Unknown fields, including client-supplied roles/silos,
are refused. Reuse the same command id and arguments after an ambiguous 503.
Acceptance reads member history and makes at most one conditional append to that
member's stream. It never writes PostgreSQL, OpenFGA or a command ledger. The
returned sequence lets a caller wait for a listener's projection checkpoint.
See the [invitation contract](../../docs/architecture/events.md#organisation-members-and-teams)
for identity/expiry requirements, retries and the missing bootstrap policy.

```sh
npm test -- apps/server
npm run typecheck -w apps/server
```

Set `PG_TEST_URL` to a disposable PostgreSQL 17 database for the acceptance-to-members
test; it is explicitly skipped otherwise. It uses an isolated schema and real NATS,
then restarts the database connection and rebuilds the projection. Other command
tests prove races, durable retries after NATS restart, refusals with no append and
real read/append outages. Tests also cover Node startup, OIDC, upgrades and redaction.
The [acceptance evidence](../../docs/process/member-joined-evidence.md) records gate counts and untested conditions.
A deployed fresh-install sign-in journey remains unqualified by these local tests.
The process needs a listening port and outbound access to its OIDC provider and optional
collector, NATS, PostgreSQL and OpenFGA. Restart discards connections; clients reconnect.
Cookies survive only while their signing/encryption configuration and expiry remain valid.
Business recovery and replay use the event-store and projection libraries.

Dependencies: Fastify, ws, and the [auth](../../libs/auth/README.md),
[events](../../libs/events/README.md), [observability](../../libs/observability/README.md)
and protocol packages, plus event-store and Zod (MIT, existing pin). PostgreSQL
(`pg`, MIT), projections and authz now serve realtime reads; no new external component
was introduced. See the [architecture and plan](../../plan.md).

## Members realtime and shutdown

Set `DATABASE_URL`, `OPENFGA_API_URL`, `OPENFGA_STORE_ID` and `OPENFGA_MODEL_ID`,
plus `SILO_ID` and `OIDC_EXPECTED_ORG_ID`, to enable the members topic. The server
needs read access to the members projection and a LISTEN connection. Provision
and run the existing projection runner and OpenFGA handler separately; the HTTP
server does not become another projection writer. Existing projections must be
stopped and rebuilt once to populate the new change history and identity bindings.
Without configuration or permission, subscriptions fail closed.

Send `{"type":"subscribe","topic":"members","since":0}` on the tab's existing
`/ws` connection. Only one subscription per connection is supported. The server
resolves the session's issuer/subject to a joined member through the projection,
then checks current Owner/Admin events and the silo's `admin` permission through OpenFGA.
Cookie roles are ignored.
Ambiguous or absent identity bindings are refused. Old unbound joins need a bound
invitation before they can subscribe. Permissions are checked on each drain and
independently every 250 ms. A 1.5-second watchdog stops hung checks. Delivery
requires an unexpired access check, even while content is slow. Event-based
demotion or removal sends `refused` and closes; dependency failures close with
1013 during polling. Session expiry is checked there too. Members use the narrow
colleague read, which has no emails.

Version 1 replies are `member`, `ready`, `resync` or `refused`; every reply has
`topic`, `version`, `generation` and a safe integer `position`. A `member` contains the full row
at that position. Positions are global event-log sequences filtered to this silo's
members changes, so numeric gaps are normal. Apply rows in order, remember the
last applied position and reconnect with it. `ready` marks initial catch-up.
Positions ahead of the projection are refused. A resumed cursor includes the
generation from its last reply. A repaired replay bumps the generation, sends
`resync` at position 0 and closes with 1013; reconnect from 0. The original demo messages remain
separate from this versioned subscription protocol.

PostgreSQL delivers `members_changed` NOTIFY only after the projection transaction
commits. Its payload is a wake-up, never data or permission: the server rereads
ordered changes in pages of 100. A failed LISTEN connection fails subscriptions
closed; restart the server to restore it. Reconnect always rereads durable history.
Changes have no pruning yet. An equal online rebuild keeps its generation,
so clients retaining positions can resume without reloading.
Multi-replica fan-out over NATS core is **not implemented**.

## Organisation integrations

`GET /api/org/integrations` requires the encrypted session cookie, the configured silo and
organisation, a joined issuer/subject binding in the members projection, and current
OpenFGA `admin` permission (which includes owners). Cookie roles are ignored. Missing or
unavailable authority fails closed. The response follows `integrationsResponseSchema`:
event-derived server/source/tool/status rows plus `loadedAt`. Discovery metadata supplies
the server name and version when present, and registration keeps optional catalogue origin
separate from the remote/hosted transport kind. Old events replay with derived labels and
explicit “Version not provided” / “Not provided” copy rather than invented facts.

`DATABASE_URL` and the existing OpenFGA settings enable this route as well as members
realtime. The `mcp catalogue` projection must run separately; the server remains a
read-only projection client. The real-service test creates disposable PostgreSQL 17
databases and uses real NATS and OpenFGA:

```sh
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres \
  npx vitest run apps/server/test/integrations.test.ts
```

That suite also drives Chromium through Angular's development proxy into this route.

Sockets allow 20 application messages per one-second window and 16 KiB inbound
frames. Ping/pong runs every 15 seconds; a missing pong terminates the peer at the
next tick. Above 64 KiB queued output, the server drops further live deltas,
sends `resync` and closes with 1013. The queue can also contain one row being sent.
The projection retains every state: resume from the last position actually applied
by the client, not the last position the server attempted to send.

`SHUTDOWN_GRACE_MS` defaults to **10000**, a positive integer up to 2147483647.
The first SIGTERM/SIGINT closes the listener, sends WebSocket close code 1001 and
lets HTTP requests use the full grace period. No part is reserved by cutting off
requests early. After HTTP and sockets close, NATS, the feed and telemetry close
once. A clean shutdown exits 0; cleanup failure or expiry exits 1. At expiry,
remaining sockets are destroyed and cleanup is invoked if it has not started;
the next event-loop turn exits 1 even if a closer is still hung. Thus a timeout
reports incomplete cleanup, never success. A second signal exits 1 immediately.

For real Zitadel sign-in on the tailnet URL, use the [dev stack](../../infra/dev-stack/README.md).
Browser callback refusals clear both cookies and redirect to `/signin/rejected` with
one fixed reason code. API clients still receive 400 JSON. Provider discovery
failure also reaches that screen. `/auth/me` refuses expired sessions and sessions
whose organisation no longer matches the configured pin or an exact configured identity.

## Conversation core

With `CONVERSATION_KEYS_DIR`, the server exposes `POST /api/conversations`
(`id`, `conversationId`, `assistantId`, `mode`), `POST /api/conversations/:conversationId/messages`
(`id`, `text`, optional `executionMode: "memory_free"`), and GET on those paths.
The caller supplies stable event ids for
retries. POST requires the session's exact Origin. Only live silo members acting
for their personal assistant can create; conversation participants can read/post.
Owner/admin roles do not bypass private conversation access. List/messages reads
come from the `conversations` projection; text is decrypted only after permission
checks. The messages response contains ordered event rows, a position, generation,
`computerState` (`ready`, `starting`, `recovering` or `not_applicable`),
`computerRecovered`, and the optional `computerLostAt` time. A lost computer stays
recovering until a new `computer.ready` event appears. A fresh ready computer sets
`computerRecovered`.

On `/ws`, subscribe with `{type: 'subscribe', topic: 'conversation', conversationId,
since, generation}`. Apply event rows by position; deltas append to their message
id, completed messages replace that message's text. `ready` marks catch-up;
`resync` requires restarting at position 0. Keep the last applied position and
generation when reconnecting. The server rechecks permissions throughout a stream.

The bridge runner also needs `KUBECONFIG`, `KUBE_NAMESPACE`,
`TOKEN_SIGNING_KEY_FILE` and `TOKEN_ISSUER`. The dev host uses a loopback Kubernetes
proxy with scoped Pod-proxy permission. Its separate `x-bridge-token` capability
never replaces Kubernetes authentication. Per-conversation AES-GCM keys live in
the private dev secret-store directory, outside events and projections. Preserve
those keys with event backups; deleting a key makes that conversation’s event/projection text unreadable.
[Qualification and limits](../../docs/process/bridge-evidence.md).

Creation defaults omitted `mode` to `agent_session` and records it immutably in
`conversation.created`. Direct creation binds exactly two active silo members and
no assistant. Unsupported modes return HTTP 400. The projection retains mode
on replay; older stored events without mode read as `agent_session`. New commands
always write mode. Changing creation arguments on a retry never changes the conversation.

Each conversation thread has an ordered report queue: at most 64 reports and
1 MiB, including the report being persisted; at most 64 queues per connection.
Exceeding either bound closes with 1013, “Report queue limit”. Threads acknowledge
independently. Reports retain global ids and per-conversation predecessor positions;
reconnect starts at the largest contiguous committed global position. Committed
payload digests are checked on both append and deduplication. Acknowledgements
name one report and never release another thread's pending start.

The start acknowledgement carries a fresh signed thread grant after a separate
server lifecycle command has acquired the computer-stream suspend fence. Each
command still makes one conditional append. Terminal reports trigger permanent
server closure, recovered by the watcher if the server stops between those commands.

## Tools offered with a chat turn

The bridge reads server ids from the MCP catalogue projection. It considers only
published rows, then reads each server's `mcp-<id>` stream once. It builds the current
policy and finds the latest discovery from those same saved events. It keeps a server
only when it is published, uses `accountMode: none`, and both the requester and
assistant have the `use` grant.
The tool list is sent only for a personal assistant's memory-free turn. Team turns,
private turns and turns without a binding get no list.

The bridge joins the saved discovery definitions to the current tool policy by name
and revision. It sends each tool's `allow` mode alongside its definition. It sends only reviewed
tools in Allow mode with `costCents: 0` and a
stored definition. Ask and Block tools, missing definitions and server discovery
results are left out. In particular, `discoverResult` is never sent because it may
contain instructions that nobody reviewed.

Each server is named `oc_` followed by the first ten hex digits of its SHA-256 id.
The bridge adds whole servers only. It skips ids that the computer would refuse,
server information over 200 characters, definitions over 32 KiB and duplicate keys.
The tool list is capped at 48 KiB and at 20 servers. It is also capped so the JSON
turn stays below 120 KiB, leaving room below the computer socket's 128 KiB limit.
The bridge counts the encoded turn, including its text and attachments, before
choosing tools. It logs how many servers did not fit.

The bridge saves the selected list beside that message's sent-turn record. A build
has a one-second limit. If the catalogue, event log or OpenFGA cannot answer, the
bridge logs one fixed reason, saves an empty list and sends the turn without `tools`.
One-second resends reuse that result, so a waiting turn does not repeat catalogue,
event-stream or OpenFGA reads. The list is an offer to Codex only. The gateway checks
every call again against current grants and tool rules, so a grant removal or a
change to Block still refuses a call after the turn starts.

A digest-matching start replay for an already closed turn is acknowledged without
new admission or a turn grant, including recovery after a terminal report but
before its lifecycle closure. Older journals without `previousSequence` replay
in global computer order and check continuity across conversations.

Permanent report refusals close with 1008 and a safe reason. The watcher logs the
computer id and reason, then stops reconnecting that computer for its lifetime;
other computers continue. Resolve the refused report before restarting the server.
Transient persistence failures still close with 1011 and retry from durable history.
Credential expiry closes with 4001 and reconnects with a fresh credential; only a
recorded report refusal stops automatic recovery.

### Chat UI reads and Stop

`GET /api/conversations` accepts `section=recent|archived` (default recent), `q`
(up to 100 characters), `limit` (default 20, maximum 50), and `cursor`.
It keeps the existing `rows` fields and adds `nextCursor`: null means exhausted.
Each request reads at most 100 candidates and checks access in batches of eight.
Reaching 100 returns 503 `list_incomplete`, with no rows or cursor. This fixed limit
also applies to lists with 100 or more allowed chats; retrying cannot finish such a list
until it fits within the limit. Complete scans choose pages only from allowed matches.
Empty successful pages always have a null cursor. Search matches a case-insensitive substring of the visible
first-message title, after access checks and decryption. No hidden totals are returned.
Saved archive choices apply only to the current join. Ordinary late joins start without
pre-join activity. Their `createdAt` is their current join time, including in personal
sessions. Personal-session rows keep the assistant and creator identifiers required
by the reply schema. Group replies omit `createdBy`, `groupId` and
`groupSnapshotPosition` from the original creation.
Initial and explicit shared-child participants keep their allowed creation details.
The list orders by each participant's visible activity position,
then their join position to break ties. Closed activity stays at the first close.
Signed cursors contain a hashed binding and two positions from the last visible match.
Denied rows never supply cursor positions or decide whether another page exists.
They use the cookie secret with the `conversation-list` signing purpose and bind silo,
requester, section, query, limit, projection generation and list revision.
Only authorised chats supply activity, participation and archive positions to the
revision. Its generation lookup reads one projection record; candidate reads use the
member activity index and a fixed limit. A second bounded read checks allowed positions
before release. Visible changes reset pages with 409 `list_changed`. Unrelated private
or denied activity leaves a complete scan's cursor unchanged. Read markers and token deltas do not reset pages.
Readers check access once per candidate; they never watch conversation content for access.
The website's conversations screen follows the cursor for Recent, Archived and title
search. Its workspace and direct rails show the first page and link to that screen for
older chats. Saved links search both sections within a fixed page limit.
Upgrades require the offline conversation replay before restarting readers and workers.

The [direct chat API](../../docs/api/direct-chats.md) supplies two-person creation,
messages, history, status and live updates. Direct messages never start assistant work.
Direct reads and posts return 425 `access_applying` when a recorded participant is
waiting for creation permissions. Current membership and recorded participants are
checked first. Applied permissions, missing chats and nonparticipants keep their
normal 403 refusal. Status reads keep their existing `allowApplying` behaviour.
History and status check access once before reading content. The list checks each
row's participants and OpenFGA permission once, with eight rows at a time.
Readers do not use an authority fence, the short check that detects access changes
before a write. Content reads can take longer than two seconds without an access timeout.
Socket polls run every 100 ms. Each socket keeps the conversation's creation facts.
Each poll checks the conversation feed position, projection generation and computer
record position with one small query. It reads chat rows and computer state only when
one of those values changes, then keeps the computer state for the next tick. This keeps
new messages and computer changes within the existing poll delay without repeating the
content queries on an idle page.
The server shares the OpenFGA client for each silo and permission model. It checks
access at subscription, then calls OpenFGA again only when a watched access record changes.
It watches member and participation stream positions and, for a team assistant, its team stream.
Personal sessions never watch conversation history for access. Initial participants are recorded
when a chat is created. Chat sockets watch later changes on the small participation
stream. Chat, live view, file and approval access check those saved changes before
OpenFGA catches up.
Each access poll has a 1.5-second limit and ends before reading content. Access
polling continues during a slow content read, so a member-stream removal still
closes the socket within two seconds without waiting for OpenFGA to apply it.
The first access check closes with 1013 if OpenFGA has not applied a change yet.
After a successful check, a later unapplied change keeps the socket open but pauses
message delivery while each poll checks again. If it stays unapplied for five seconds,
the server closes with 1013 so the browser reconnects. A member or team removal is
checked before this wait and still closes with 1008 within two seconds.
Reads use no authority fence. Writes read history with its own ten-second limit
before opening their short access check.

`GET /api/chat` returns the authenticated member id and their personal assistant
id (null while provisioning). It requires live silo membership and `acts_for`;
it does not expose the organisation computer register. Conversation list rows
include an event-derived title and status, computed only after per-conversation
read permission. No administrative bypass grants access to private sessions.

`POST /api/conversations/:conversationId/messages` also accepts
`{id, stopTurnId}`. Only the original message author can stop that turn. It appends
one `agent.turn_stop_requested` event; retries retain their event id. The bridge
skips an unstarted stopped turn or interrupts its active Codex turn. The browser
freezes displayed text at the stop event's position, including after reload;
late reports remain in durable history without replacing that displayed partial.

Owner/Admin budget configuration uses POST `/api/org/models`, forwarded to the
single-writer actor with a short-lived signed command. Set `MODEL_DECISION_URL`
and the existing `TOKEN_SIGNING_KEY_FILE`/`TOKEN_ISSUER`. In development, the URL
defaults to `http://127.0.0.1:43001`. On a fresh stream the model process records
`installation-default` as its explicit personal paying group; installation can
override that seed with `DEFAULT_PAYING_GROUP_ID`. Stored defaults always win.
See the [budget contract](../../libs/models/README.robot.md#monthly-budgets-p3-13).

### Permission-scoped audit (P3-19)

`GET /api/conversations/:conversationId/history` requires live membership,
conversation read permission and returns only that requester's actions.
`GET /api/org/history` requires live Owner/Admin membership and returns safe
organisation metadata. Neither route decrypts text or approval details, nor returns
credential references, bearer material, raw arguments or gateway diagnostics.
Both routes load a page before checking current event-backed membership and
OpenFGA once. `GET /api/org/history/:auditId` does the same for one page of
related records. A removed or demoted caller receives a fixed refusal, including
when their access changes during the load. PostgreSQL gives each query a
one-second limit.
The access check reads only member and ownership history; it never reads the
conversation event stream or rejects the result because ordinary chat activity
arrived during the read. A missing membership receipt or permission outage refuses
the request. No audit read scans global event history.

Conversation filters remain `requestId`, `turnId`, `decision` and `before`, with
50 anchors per page. Organisation history also accepts `from` and `to` UTC times,
`type` family, `actorId`, `outcome`, `reference` and `limit` (20 by default,
at most 50). Detail accepts `before` and `limit` (20 by default, at most 50).
Both cursors are exclusive event positions. List rows carry no more than 20
related records and mark further evidence; detail pages can read all of it.
Saved tool starts and observations use these same list and detail routes and metadata
fields. The [audit projection contract](../../libs/projections/README.robot.md) explains
their status meanings and the required replay for existing installations.
`test/audit-dispatch.test.ts` checks these reads with real NATS, PostgreSQL and OpenFGA.
Decision and observed outcome are separate. An allowed request
with a saved tool start but no saved dispatch outcome reads `unknown`, even if a
generic effect reports success. The outcome filter and rebuild preserve this result. The
[shared response contract](../../libs/protocol/src/audit.ts) is strict and permits
only fixed readable reasons. Run the `audit` ops worker alongside the existing
projections. API startup enables these reads with the existing event store,
database, member feed and OpenFGA settings; no conversation encryption key is needed.

Tests: `PG_TEST_URL=… npx vitest run apps/server/test/integrations.test.ts
apps/server/test/audit-browser.test.ts`. Browser evidence covers 1280/390px and
Loading/Empty/Unavailable/Outcome unknown with keyboard filters. Fresh-install
qualification is NOT RUN; this change does not alter or operate a dev stack.

The P3-2 approval endpoint is `GET|POST /api/conversations/:conversationId/approvals`.
GET restores safe decrypted cards and a session/conversation-bound CSRF token; POST
accepts only `approvalId` and `decision` (`approved` or `rejected`). It requires the
requester's authenticated session, current authority, exact Origin and `x-csrf-token`.
Missing and inaccessible approval ids both return HTTP 403 `{status: 'refused'}`.
Invalid decision input still returns 400; unavailable dependencies still return 503.
The approval privacy test uses the same authorised caller for missing ids, another
requester's approval and an approval from another conversation.
409 means the decision lost its conditional append; 428 requires step-up; uncertain
transport or persistence needs Check status, never an automatic repeat of an effect.
A required step-up uses `/auth/login?approval=<id>&returnTo=<local-path>`, OIDC
`prompt=login`, `max_age=0`, and verified `auth_time` within five minutes. The flow
binds the original cookie, requester and approval; missing, future or stale evidence
refuses. The resulting session authorises only that approval's step-up check.

Run the gateway/API tests with:

```sh
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npx vitest run apps/server/test/approvals.test.ts
```

After building the web app, set `APPROVAL_BROWSER=1` for the same command to include
Chromium at 1280/390px.
These fixtures create disposable NATS/OpenFGA instances and private Postgres databases.
They do not use the shared dev stack or a paid upstream.

The model process ignores `MODEL_MCP_ROUTES`. Dispatch uses saved publication records. Catalogue watching reads bounded remote
catalogue rows independently of the empty operator route list. `CONVERSATION_KEYS_DIR`
still names the server's private directory for encrypted approval reviews.

Read-only desktop sessions use `POST /api/conversations/:id/view` and
`/ws/conversations/:id/view` for the WebSocket. The POST requires the session, exact Origin and
`x-opencrane-view: 1`; redeem its ticket once as WebSocket subprotocols
`binary, <ticket>`, with the same session and Origin. Both conversation participation
and an explicit shared-desktop grant are required. The server uses `KUBECONFIG`
and `KUBE_NAMESPACE` for its private Pod stream. See the
[live-view contract and evidence](../../docs/process/live-view-evidence.md).

`ViewSessions` owns unused tickets, opening capacity, active session release callbacks
and pending stop audits. `open` returns its opening place in `finally`, including
failed upgrades. `ownSession` returns the release callback used by `stopSession`;
repeated release cannot free another session's place. Shutdown stops active sessions,
discards tickets and waits for their stop audits. `LiveViewSession` owns one session's access watch, expiry timer and single stop.
The existing named upgrade, start, desktop, bridge and stop functions remain in
`view.ts`; they pass the session explicitly.
Tickets can be redeemed for 15 seconds. A view lasts at most two minutes and never
outlives its sign-in. `ViewLease.watchAuthority` owns each in-flight check from its
increment through its `finally` decrement. `ViewDelivery` still gates every send.

Live-view access checks run every 250 ms with a 1,200 ms deadline. An explicit
`member.removed` result or conversation-read denial ends the check immediately,
without waiting for sibling reads. These denials close the viewer with 4003 and
`access_changed`. Remaining reads keep error handlers attached after the check ends.
An unavailable read or a timeout still grants no new lease. An existing lease
allows desktop bytes for at most 1,500 ms from its successful check's start.
Ten seconds without a valid lease closes the viewer with 4503.
The exact `Authority changed` error means a watched stream changed during a check;
it leaves access unconfirmed. The next check closes the viewer if access really ended.

The `live-view-activity`, `live-view-unavailable`, `live-view`, `live-view-delays`
and `view-lease` tests cover these decisions. They include a held desktop read
during member removal, continued frame delivery attempts, and a conversation denial
beside a slow unavailable desktop read. Fresh-install qualification is NOT RUN
for this change.

## Remote MCP registration (P3-3)

Owner/Admin `POST /api/org/integrations` accepts `{locator}` with the exact session
Origin. It conditionally appends one registration per normalised HTTPS source and
returns `{serverId, changeRef}` with HTTP 202. Repeating the same source, including
concurrent requests, returns the same reference. GET
`/api/org/integrations/:serverId/discovery` reads event-backed status and immutable
inventory. GET `/api/org/integrations/discovery?locator=<encoded-source>` reconciles
a lost registration reply without creating anything. Both require current admin
access. HTTP 400 refuses the source; 503 is an unknown outcome requiring status.

With the existing event store and catalogue configuration, `main.ts` starts the
install worker. Its expiring in-memory identity alone admits POST
`/internal/mcp/:serverId`, bound to that registered server and limited to
`server/discover` and `tools/list`. Computers have no such identity. This route
selects its endpoint from events, strips caller headers and never invokes tools.
Restart reconciles unfinished registrations; terminal evidence is never rediscovered
by this worker. PostgreSQL replay only rebuilds the register.

`isPublicAddress` and `remoteEndpoint` now live in `libs/models/src/address-policy.ts`.
Remote discovery and registration import them from `@opencrane/models`; the code
and remote discovery behaviour are unchanged.

The OC1 guarded transport source is commit `10abd0ef6182f36bec13d8f1358e43b15ead7cd5`.
Every HTTPS connection checks all DNS answers, pins its checked address and verifies
the original TLS hostname. IP URLs, credentials, queries/fragments, redirects,
private/reserved addresses and session/legacy MCP are refused. MCP 2026-07-28 and
complete discovery metadata are mandatory. Per-request fields use `params._meta`
with `io.modelcontextprotocol/protocolVersion` and `clientCapabilities`; server identity
comes from `result._meta['io.modelcontextprotocol/serverInfo']`. The full locator query
is redacted before authentication or validation. Limits: 1 MiB request, 4 MiB response,
30 seconds for the whole discovery including DNS, ten pages, 100 tools/page and
1,000 tools total. Definitions are at most 32 KiB each and 512 KiB together;
discovery metadata is at most 64 KiB and the inventory event payload 900 KiB.
Duplicate accepted tool names, duplicate JSON keys, malformed page envelopes and
repeated cursors reject the inventory. Individual malformed Tool declarations are
excluded; valid siblings remain available for review. This follows the explicit
per-tool rejection rule for `x-mcp-header` in the
[MCP tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#x-mcp-header)
and applies the same isolation to other invalid declared fields and schemas.
`rejectedTools` records only a safe name (when valid), the definition digest and a
fixed reason code; it never stores rejected definitions or upstream validation errors.

Input schemas require an object root. Output schemas may describe arrays, scalars
or unconstrained values (`{}`). Accepted definitions are stored as immutable JSON
strings, including output schemas and extension fields; the complete definition
contributes to its revision and the inventory digest. Ajv 8.20.0 (MIT, licence
checked locally) validates JSON Schema 2020-12 (default) and draft-07 without
fetching references. Unsupported dialects and unresolved references exclude the tool.
Header annotations require token names, no control characters, case-insensitive
uniqueness and only declared string/integer/boolean types. They may appear only
along a chain of `properties` keys from the input root. Integer argument range
checks belong to the later call path; discovery never invokes tools.

Discovery reads `_meta['io.opencrane/costCents']` and `_meta['io.opencrane/review']`
with the discovered-tool event validators. Cost must be exactly zero, including before
JSON number rounding. Review details use the existing strict action, consequence,
targetArgument, fields and stepUp schema. Discovery requires an explicit boolean stepUp;
only saved legacy events retain the false default. Missing declarations stay absent; hints and
admin choices never supply them. Malformed declarations exclude only that tool with
`invalid_tool_cost` or `invalid_tool_review`, without validation errors or rejected values.
The original lossless definition and digest include the declarations. Metadata changes
therefore invalidate review and hold the whole server through the existing catalogue fold.
Successful credential-free remote discovery saves `connectionId: installed-<serverId>`
and `accountMode: none`. Retries and worker restarts retain that saved reference.
HTTP 401/403 still records `connection_required`, with no personal or company account.
`test/tool-declarations.test.ts` covers parsing and policy. `test/integrations.test.ts`
covers register → discovery → tools GET → exact Allow/Ask review and projection rebuild
through product APIs, using the local TLS fixture and no seeded discovery for that server.
Fresh-install qualification remains NOT RUN.

Discovery leaves tools blocked and unpublished. Protected servers show Needs input
until P3-9; publication, grants and calls are outside this ticket. The local HTTPS,
DNS rebinding and browser fixtures use no external MCP endpoints. Run
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npx vitest run apps/server/test/inventory.test.ts apps/server/test/mcp-discovery.test.ts apps/server/test/integrations.test.ts --maxWorkers=2`.
See the [qualification receipt](../../docs/process/p3-3-mcp-discover.md).

## Conversation uploads

GET checks for `file.uploaded` events not yet covered by the `files` checkpoint.
`src/files/list.ts` reads both worker checkpoints and matching uploads from
`conversation_feed` in one database snapshot. It then reads the conversation event
stream only after the later of the `files` and `conversations` checkpoints. This
avoids replaying old messages when checking an empty or already available list.
Rejected uploads, delivery receipts and other chat activity do not hold up the list.
A missing or invalid checkpoint stays applying. Until the files worker covers an
upload, GET returns HTTP 425 with `{status: "applying"}` and `Cache-Control: no-store`.
It returns no partial list. POST still confirms the saved event with HTTP 201.
The route uses the existing read access check once, without a write authority fence.
The regressions in `test/file-upload-failures.test.ts` hold back the files worker
and check the immediate read before and after running it. They also keep old
content unavailable to prove that the list uses projected history. The unchanged
100,000-message tests check personal and child readers during unrelated turns.

`test/upload.test.ts` retries only HTTP 425 with `{status: "applying"}`, for up to
five seconds. It runs the files worker between attempts because the fixture has no
background worker. The saved-file assertions stay unchanged. The held scan stays
blocked through the list check, so that check still proves unscanned files are absent.

The [upload API](../../docs/architecture/upload-api.md) documents raw-byte POST
and replayable GET on `/api/conversations/:conversationId/files`. Enable it with
the chat configuration, `MINIO_URL` and `MINIO_CREDENTIALS_FILE` (a rotating,
bucket-scoped STS lease); `CLAMD_HOST` defaults to `127.0.0.1`, `CLAMD_PORT` to
`43310`. Provision private `quarantine` and `files` buckets and run the `files`
projection separately. The computer receives clean bytes through the server's
bridge and holds no object-store credentials. [Evidence and qualification](../../docs/process/upload-evidence.md)
cover real-service tests and the pending fresh-install journey.

## Authorised screenshots

`POST /api/conversations/:conversationId/screenshots` takes no body. Supply the
session cookie, exact configured Origin, `x-opencrane-view: 1` and a stable
`idempotency-key`. Current participation and the shared-desktop audience grant are
checked against events and OpenFGA, before capture and again before saving. The
existing namespace-scoped authenticated desktop proxy supplies one framebuffer;
there is no caller-selected URL, path or encoding. Dimensions are at most 4096
per axis and at most 4 MiB of raw pixels, with a ten-second framebuffer deadline
and at most four concurrent captures per server.

A clean scan stores a PNG using the existing 20 MiB file path and appends one
`file.uploaded` with capture metadata. Success is 201; input, access, scan and
capacity failures return 400/401/403/422/503, and append conflicts return 409. Retry
an uncertain command using the same key. Participants reopen screenshots through
the authenticated file-view endpoint; ordinary uploads retain creator-only access.
No Kasm credentials, public image URL or signed object-store URL reaches the browser.
Enable both existing desktop and upload configurations; no new dependency is added.

Run `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npx vitest run apps/server/test/screenshots.test.ts --maxWorkers=2`.
After the web build, `SCREENSHOT_BROWSER=1` with the same database runs
`apps/server/test/screenshot-browser.test.ts` against disposable real Kasm, scan
and storage fixtures. It requires the existing `ocn-upload-computer:test` image.
See the [P3-18 evidence](../../docs/process/p3-18-screenshots.md) for remaining qualification.
Owners and Admins can list and inspect monetary uncertainty with
`GET /api/org/effects` and `GET /api/org/effects/:permitId`, then submit attested
receipt evidence with `POST /api/org/effects/:permitId/resolve`.
Both GET routes read the saved spending records with their own ten-second limit,
then check current membership and OpenFGA once before returning them. A removal
during the read returns 403 even if the member table and OpenFGA are still behind.
POST reads budget and effect history with its own ten-second limit before starting
its two-second access checks. It rechecks both HTTP and event-backed membership
immediately before its unchanged conditional append. Removal during history refuses
the write even when the member table and OpenFGA have not caught up.
[The resolution contract](../../docs/process/p3-15-reconcile.md) specifies the
CSRF token, optimistic sequence and pending settlement state. No screen is added.
Flat group administration is available through the [groups HTTP interface](../../docs/api/groups.md).

Group list, group detail, group command status, ownership and ownership command
status GETs load their results before checking current event-backed membership
and OpenFGA access once. Event history loading has its own ten-second deadline.
These reads do not use `authorityFence`, compare stream positions or read wildcard
subjects. They keep the existing Owner/Admin rules and ownership step-down
status exception. All replies use `Cache-Control: no-store`.

`test/group-ownership-reads.test.ts` covers all five GET routes with more than two
seconds of simulated loading, removal during loading before OpenFGA catches up,
and unrelated chat activity. It also checks finite event-read deadlines and no
wildcard reads. The slow-read cases check that no stream-position checks run.
From the root, run the following command with `PG_TEST_URL` set:

```sh
nice -n 10 npx vitest run apps/server/test/group-ownership-reads.test.ts --maxWorkers=1
```

Fresh-install qualification is NOT RUN. This is the read-ordering part of #109;
the accepted design is [in the spending and overview note](../../docs/specs/phase-4/p4-26-spending-overview.md).

## First-owner bootstrap (#12)

A production install generates one random 256-bit token with a 24-hour expiry:

```sh
SILO_ID=acme BOOTSTRAP_TOKEN_FILE=/var/lib/opencrane/bootstrap/token.json \
  npm run bootstrap-token -w apps/server
```

Run under the server's Unix account. The command creates a private directory
(0700) and file (0600) outside the repository, writes only a SHA-256 hash, silo
and expiry, syncs it, then prints the token once to stdout. Run in a private
terminal with output capture disabled; never put the token in argv, a URL, logs
or events. An existing file is refused, so repeated installation cannot rotate
credentials silently. For an expired or lost token on an unclaimed silo, the
operator may remove that private file and rerun the command. Event history still
prevents a new claim after any membership history exists. Back up the event store;
losing this hash file after a successful claim does not reopen bootstrap.

Set the same `BOOTSTRAP_TOKEN_FILE` and `SILO_ID` on the server, along with its
existing NATS credentials and required `OIDC_EXPECTED_ORG_ID`. The server reads
this file only during an unclaimed installation, verifies private permissions
and ownership, and fails closed on missing or invalid material. It does not
write business state to the file or PostgreSQL. Open `/claim`, sign in through
Zitadel, enter a display name, contact email and token, then choose **Claim this
silo**. Email is contact data; the encrypted authenticated session supplies the
identity. The token input clears after submission and is never saved in browser
storage. A successful claim returns HTTP 201 and records one event; reactions
provision the personal assistant, owner/member OpenFGA tuples and model grants.
The model process seeds `installation-default` (or `DEFAULT_PAYING_GROUP_ID`)
as the default personal paying group using its existing budget events.

`POST /api/silo/claim` accepts only `{token, displayName, email}` with an exact
same-origin session. The token creates the first owner of a fresh silo: any
membership history, including pending invitations and removed members, disables
this path. An existing member cannot use it to gain ownership. This follows the
owner decision on #12; it is not a recovery or promotion command.

Identity bindings live on member streams. The same conditional append requires
expected sequence zero across `member-*`, including every identity's binding
stream, using NATS' native subject-filter expectation. A membership write between
the history read and append therefore refuses the claim without recording an
event or consuming the token. No projection freshness is needed for this check.

Refusals include `token_used`, `owner_exists`, `members_exist`,
`token_expired`, `wrong_token`, `wrong_organisation`, `concurrent_claim`,
`no_session`, `wrong_origin` and `invalid_request`. Five submissions per minute
share a process-wide installation budget across identities; HTTP 429 carries
`Retry-After: 60`. This bounds failed attempts and in-flight races. Deployments
with multiple server replicas must also apply a shared ingress rate limit.
HTTP 503 means the outcome is unknown; do not assume ownership or repeat effects.
A later submission consults event history and cannot create a second owner.
All claim replies use `Cache-Control: no-store`.

The existing dev stack retains its explicit invitation/join owner bootstrap
for `jente@elewa.ke`; see its [instructions](../../infra/dev-stack/README.robot.md#zitadel-sign-in).
This production token path never uses the dev external-identity exception.
Ownership transfer remains #24. The production install uses the token method alone.

```sh
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres \
  npx vitest run apps/server/test/bootstrap-token.test.ts apps/server/test/bootstrap-claim.test.ts apps/server/test/bootstrap-browser.test.ts --maxWorkers=2
```

Tests use disposable NATS, PostgreSQL and OpenFGA plus Chromium at 1280/390px.
[Evidence and remaining live qualification](../../docs/process/bootstrap-token-evidence.md).

## Idle polling

The chat watcher checks the global event position every 250 ms. It skips conversation
and computer history when that position is unchanged and the last pass found no
pending message or file. The conversation table must have processed that event
position before idle skipping starts. A failed read or pending work keeps retries enabled.

During a pass, sessions share their assistant's computer history. The watcher checks
that stream's latest position first and reuses the saved history when it has not
changed. The assistant's kind is saved after its first successful read because it
cannot change. A failed creation read is logged once for that assistant and never
allows delivery with an unknown kind. Only a waiting message keeps that chat pending.
An assistant without a computer waits for its computer stream to change before its
unchanged chats are read again. This does not keep the 250 ms polling loop busy.
Created and closed chats are read together through an index on the organisation and
event type, so each pass does not scan every reply row twice.

The watcher remembers each chat's last stream position. It skips
unchanged chats unless delivery is waiting for the computer to accept a turn,
uploads remain, the computer changes, or the connection closes. A failed read does
not save that chat's position, so retries still read it. Closed or unlisted chats are
removed from the cache. The cache stores connection numbers and releases closed sockets.
Each connection remembers the last turn sent for each chat and when it was sent.
An unaccepted turn is sent again at most once per second on that connection. Resends
stop when `computer.turn_started` records acceptance. New Stop requests still reach
an accepted turn. A new
connection sends pending turns again, including turns already accepted before the
connection closed. These are delivery checks; turn admission keeps its separate
access checks on the small streams that grant permission.
When a final report appears before its turn close, recovery checks the computer
history again before issuing another close command.

The first pass after restart always runs. Failed event-position or table reads are logged
and retried after 250 ms. An unexpected watcher failure logs a fatal error and exits
the server with status 1 so its supervisor can restart chat delivery.

The models process keeps one usage-file byte
offset for its 100 ms ticks. Each tick also checks NATS metadata so an idle
process still detects an outage and restarts after the existing 15-second limit.

## Private team turns

Team messages default to restricted execution. Only `executionMode: "memory_free"`
selects shared tools and persistent thread state. Personal turns stay memory-free.
Admission checks modes and private thread reuse before opening the existing four
small access streams. Context is rebuilt after admission with the ten-second chat
history budget. It contains only the requester's earlier completed exchanges,
up to 24 KiB, and time-only records of unfinished work. It is never stored.
The [HTTP contract](../../docs/api/shared-assistants.md#private-turns-and-memory-free-turns)
and [check record](../../docs/process/p4-14-private-turns-evidence.md) give the details.

## Shared child turns

After admission, the bridge checks that the saved creation and admitted
`sharingClass` agree. A mismatch closes the turn as failed with `Turn context
mismatch` and releases no token or context. Shared turns use `sharedContext`,
never the requester-private reader. History loads through `chatHistory` under its
ten-second deadline, outside the two-second access check, and reads no parent or
private session. A failed shared read closes the turn with `Shared context unavailable`.

The child creation class makes its human messages and admitted assistant replies
shared content. Only text or Markdown from completed exchanges is selected, across
senders. Stopped, failed, unfinished or lost exchanges retain time only. No sender
names, emails or profiles are added. Newest whole exchanges fit within 24 KiB of
JSON, with `omittedExchanges` counting older records. The first saved start report
sets the cutoff, so rebuilding and retrying cannot add later reports. Context is
sent only in the grant acknowledgement and is never saved as another event.
The first input remains the copied message named by `origin.firstInputId`.

`shared-assistant.test.ts`, `shared-child-reports.test.ts` and
`private-turn-channel.test.ts` cover delivery, class mismatch, selection, limits,
retry, parent/private canaries and computer wording. No model calls are needed.
Fresh-install qualification remains NOT RUN; creation and follow-up commands are
separate work.

The server derives `sharingClass: shared_only` from the saved child creation and
records it on the child start report and `computer.turn_started`, separately from
`executionMode: restricted`.
The start report must carry that class; a private conversation cannot claim it and
a child cannot start without it. The server signs the class into the turn pass, and
the models process checks it against the saved start. Shared turns cannot call MCP
or memory routes.

The bridge journal keeps the class with its start report. On restart, an unfinished
restricted start is failed and is not dispatched again. A new human message is
needed to start new work.

## Personal paying group summary

Personal turn admission uses the event-store `budget-payer` summary with `keep: 4`.
It parses each `budget.ceiling_set` with the existing `budgetDetails` schema. The
newest global ceiling event with a default paying group supplies the payer. Scoped
ceilings and global ceilings without a default do not replace it. No default still
raises the existing `ReportRejected` message. Each admission catches up first,
outside its access check. A warmed summary reads only new budget events.

`test/personal-payer.test.ts` covers changed defaults, skipped scoped ceilings,
missing defaults and at most two new budget rows after warming a 500-event stream.
`test/integrations.test.ts` covers resolution after a long history read and member
removal during that read, through the real HTTP route and disposable services.

## Chat summary and report writes

Report reads do not load participation history. Turn starts check the small participation
closure summary separately, before deciding whether to start or repeat a turn.
The report summary's position still belongs only to the conversation stream.

Browser commands, Stop polling, reports and turn commands share the server's `chat` summary, built on the event
store's stream summary. The server keeps up to 64 conversations per store connection and rebuilds a dropped summary from
the first event. Each call reads through the latest saved event before copying
its facts. History reads have their own ten-second limit and finish before turn
admission starts its access check.

The summary indexes every saved event id, including reports, and keeps its first
position. A command that reuses a report id is refused even after NATS forgets
its duplicate entry. Each compact report id and position counts as 64 bytes plus
twice the id length in the existing 32 MiB cache budget. Browser command ids
still count as at least 256 bytes each.
Stop and terminal rows use 512 bytes each. They contain no reply text. Stop polling
reads these rows and new events, without rescanning earlier reply pieces.
Command retries still verify the original saved event. New commands still use one
conditional append after fresh access checks.

Chat command facts and Stop polling share the report summary, but do not consume
memory context. A failed memory fold is retained in the summary and counted in
its size. `readChatFacts` still throws that failure before returning any facts;
ordinary commands and Stop can continue to read their compact event facts.

The summary keeps the first conversation creation, the first message's raw author
and execution mode for each event id, closed turn ids, and report positions by
computer and report sequence. It keeps no message or reply text. The newest stored
report supplies that computer's last report sequence; the first matching report
supplies the replay position. Callers parse the copied fields with the existing
schemas. Replies without `previousSequence` still use the whole-log
`reportPosition` check for old journals.

`recordReport` checks a repeated report by reading its saved position. A verified
repeat returns `duplicate` without calling `append`. A new report passes
`historyChecked: true` and the summary's sequence to the unchanged conditional
append. It checks the digest of the event at the returned position, including its
id, and keeps the existing refusal messages.

`turnCommand` uses the copied creation, requested message and closed status.
It also uses the shared auth `computer` summary for readiness, turn bindings,
start command keys and thread checks. It copies these facts and the position
in one `take`, before any access check. The conditional append names that position.
A repeat returns the first start binding without an append. A closed turn skips
its append. A start from another computer still writes its own start. A new write
checks the binding and id of the one event at the returned position; a missing or
different event gives `Turn binding conflict`.

PR #238 shipped the start-repeat skip and `turnCommand`'s `historyChecked` opt-in.
PR #246 moved that check onto `startCommandKeys` in the shared computer summary.
Model decisions now use that summary and their own chat summary too.

`test/chat-summary.test.ts` uses real NATS to check warmed 500-event chats,
report and turn repeats, old journals, changed payloads, user posts between reports,
closed turns and missing or different events at an append's returned position.

Before the retained-fact budget was added, a local memory measurement used Node with `--expose-gc --max-old-space-size=256`.
A synthetic reader supplied all 64 cached chats with 3,000 events each: one creation,
500 messages, 500 closed turns and 1,999 reply chunks. Message and chunk rows carried
32,000-character text. After collection, the summaries retained 13,240,040 bytes
(12.6 MiB); total JavaScript heap use was 27,932,112 bytes (26.6 MiB). This measures
summary storage, not the complete server running on a live silo.

## Computer state in chat replies

Chat feed reads use the `computers` projection for state, the last loss time and the
recovered marker. They never read lifecycle history. Existing installations need a
computers rebuild before serving these routes. Assistant kind is joined into the list
query. `test/chat-http.test.ts` checks the response fields, cold resume and lost list status.

The recovered marker describes the computer. The browser shows the lost-request notice
only if this chat's last agent turn is lost or failed and ended at or after the last
computer loss. A later completed turn removes that notice.

Report positions grow with every stored reply because repeats must find and check
their saved event. The chat summary now has a 32 MiB estimated memory budget as
well as the 64-chat count limit. Compact report positions count separately from
messages and closed turns. Larger active sets can still cause rebuilds (#256).
Issue #253 concerns the whole-log `reportPosition` read for old journals and
reconnection; it does not reduce this summary's storage.

## Turn admission read growth

`test/turn-admission-cost.test.ts` measures `recordReport` for the start,
`turnCommand`, `credentials.turn` and `BudgetActor.reserve` together. It uses real
NATS, one personal assistant, and 10, 100 and 500 earlier turns. It checks both
new chats and a chat seeded with 500 events. Fixture events use conditional
appends with `historyChecked`; warm-up and fixture reads are outside measurement.
Reports send `previousSequence`, so the old-journal whole-log read is excluded.
Each measured admission rejects whole-stream reads and checks that rows at 500
are no more than rows at 10 plus two. Times are logged, with no timing assertion.

`test/computer-turns.test.ts` covers warm starts, closes and repeats after 500
turns, unchanged refusal messages, first bindings, newest execution modes and
missing or different read-back events. It also injects suspension during admission
to prove the append still uses the position read with the facts.

## Tool call feed records

The strict report parser accepts `agent.tool_call_started` and
`agent.tool_call_finished`. Both require conversation id, turn id, call id,
server id and tool name. Finished reports require completed/failed status and
allow a non-negative integer `durationMs`. Unknown fields are refused. Each
report uses the existing conditional append and computer sequence digest; an
identical replay is a duplicate and changed bytes are refused. Reports grant
no access and carry no arguments, results or error text.

Tests: `test/tool-reports.test.ts` checks valid provider punctuation, repeated
reports, invalid fields and forged assistant/conversation/turn references. A
refused report leaves the event log unchanged. The approvals GET regression in
`test/chat-access-regression.test.ts` adds each tool event during its access
check. It expects 200 and returns 503 if that type leaves `outputReportTypes`.
`test/bridge-channel.test.ts` checks that the computer skips invalid tool fields
and keeps sending later reports through its open socket.

## Retained chat summary budget

The server chat kind keeps at most 64 chats and estimates up to 32 MiB across
them. Each message counts as 256 bytes, each closed turn id as 128, each computer
report tracker as 256 and each compact report position as 64. The counts are
updated as events arrive, so checking the budget does not scan old reports.
These allowances leave room above the UUID measurements below. The shared
computer kind has a separate 48 MiB estimate. Together they allow 80 MiB, leaving
176 MiB of the 256 MiB heap cap for other server work and active reads.

Older whole summaries are dropped and rebuilt on their next use. A summary larger
than the whole budget is dropped on its own, leaving other chats warm. Closed
turns, report repeats and thread ownership checks still use complete facts.
Reads in progress and caller copies are outside the retained-cache estimate.

`test/chat-summary-memory.test.ts` checks that 600 replies of 300 chunks each
stay warm. Recording and repeating the next report use only tail reads. It also
checks that an oversized map is dropped and still finds its first saved report
after rebuilding.

`test/chat-summary-memory.ts` measures the real summary with rows created on
demand. Ids are UUIDs and correlation fields contain request, conversation and
turn ids. Messages carry 32,000-character placeholders; reply chunks carry 128.
Node 22.23.3 runs with forced collection and a 256 MiB heap cap. Retained bytes
compare collected heap before and after releasing the store. Heap is sampled
every 100 positions and at the end of the build, before the final repeat read.
The sampled peak can miss shorter peaks and does not measure a live server.

| Shape | Retained cache bytes | Total heap bytes | Sampled peak heap bytes |
| --- | ---: | ---: | ---: |
| Two chats, 600 replies each, 300 chunks per reply | 15,073,288 | 30,393,552 | 47,563,336 |
| 64 chats, 500 turns each, three chunks and a close per turn | 12,993,752 | 28,571,056 | 49,147,824 |

The long-reply shape stays warm and uses about 41 bytes per kept fact. The
64-chat mix uses about 68 bytes per fact. Report positions keep the smaller
allowance because messages and closed turns have their own counts.

```sh
nice -n 10 npm run measure:chat:memory -w apps/server -- 2 600 300
```

The arguments are chats, turns per chat and reply chunks per turn.

Rebuild cost for larger active working sets is tracked in #256. The remaining
approval history and polling reads are tracked in #254 and #255. Fresh-install
governed-work qualification remains tracked in #63.

## Member reads

Bound invitation acceptance copies `personalAssistant: provision|none` into
`member.joined`; an older invitation without a choice records `provision`.
The strict join request cannot override it. The join receipt proves membership,
not assistant creation or computer readiness. The assistant reaction runs later.
`test/member-joined.test.ts` covers choice, repeats and lost replies on real NATS.
Email-only acceptance records the account issuer and subject in the join event.

Email create/renew and original-command status follow the
[member API](../../docs/api/members.md#create-and-renew-email-invitations).
`test/invitations.test.ts` uses disposable NATS, PostgreSQL and OpenFGA for
current access, strict input, renewal, repeats, lost replies and slow history.
Email invitations have no account binding until the join route accepts them.

The [API contract](../../docs/api/members.md) defines member header/directory access and limits.
`test/realtime.test.ts` covers real HTTP, privacy, paging, counts and delayed socket access.

The [invitation email API](../../docs/api/members.md#invitation-email) accepts an
Admin's email input after checking the signed-in session, Origin, organisation,
current membership events and OpenFGA. Its response makes no claim about the
invited person's account. Acceptance checks are described in the API contract.
`src/members/admission.ts` selects a member id from the silo, issuer, subject and
admission number. The member-history limit is 10,000 events. `test/groups.test.ts`
covers existing ids, removed admissions, conflicting identities, duplicate bindings
and both limits.

## Integration access reads (Part of #45)

Owner/Admin `GET /api/org/integrations/:serverId/access` checks membership once,
then reads at most 100 latest grant facts from the shared member inventory.
Each row includes its name, direct/group/assistant source, saved event id, date,
sequence, saved grant/revoke state and IAM receipt progress. `expectedSequence`
is the server-grant stream position for a later command. Revoked facts remain
visible. Each row also returns `membershipStatus`: `joined`, `invited`, `departed`
or `unknown` for a person, and null for a group or assistant. It describes the
person's membership separately from the saved grant state. Departed people cannot
use tools. These are grant facts, not counts of people who can use a tool.

`complete` means the content tables are current and all grant facts fit within
100 rows. Otherwise `grantTotal` is null. IAM progress is separate; a missing
receipt remains `applying`. Missing or lagging content also remains `applying`.
An unavailable read returns a sanitised 503, never an empty successful result.

`GET /api/org/integrations/:serverId/access/candidates` reuses model-access
choices and names. Its strict query requires `kind=member|team|assistant`, accepts
`after` and `limit=1..100` (default 50), and returns the next id or null.
Choices are ordered by id within one silo. Member choices exclude departed people.
Group counts describe joined members; assistant choices describe saved creations.
Both routes return `no-store`; unknown and foreign servers return 404. Content
loading has its own ten-second event-read deadline and no write access check.
Reads neither append events nor probe, publish, connect or call tools.

Tests: `test/integration-access-reads.test.ts` uses disposable NATS, PostgreSQL and
OpenFGA for paging, refusals, lag, overflow, slow reads and replay equality.
The departure case leaves Bob's grant in place and checks his separate departed
status before and after replay. Referenced events with the wrong silo, event type
or grantee return only 503 `unavailable`.
`libs/projections/test/tool-grant-references.test.ts` checks the database's 101-row
limit and silo selection through the exported reader with real PostgreSQL.
PARTIAL: `/facts`, the four-fact detail, actual Allowed for list UI and its consumers
remain deferred. Existing publication status and access/explanation stay separate;
installation, account connection, grants and assistant availability are not combined.
Fresh-install live qualification: NOT RUN. No web component or visual script is added.

## Model access reads

`GET /api/org/models/:modelId/access` and
`GET /api/org/models/:modelId/access/candidates` require a verified same-silo
Owner or Admin. Session role claims do not grant access. Both replies use
`cache-control: no-store`; denied reads contain no model or candidate data.

The access response uses the `modelAccessResponseSchema` from
`@opencrane/protocol`. It includes the model-grant stream position, current grant
facts, direct/group/assistant source labels and registry support. It returns at
most 100 grant rows and an exact `grantTotal`; the explanation section does not
repeat those rows. A personal assistant uses its owner's display name followed by
`personal assistant`. It reports
provider binding, enabled-model, key and verification facts as not available yet.
Configured assistant uses also remain not available yet until binding records
exist. It does not read provider secrets or conversation history.

Candidates require `kind=member|team|assistant`, accept `limit` from 1 to 100 and
use the last returned id as the optional `after` cursor. Member choices include
active members only. Group counts use current joined membership rows. Assistant
choices use assistant creation events and contain no private conversation data.
The response reports the oldest checkpoint among the member, group and model
access tables. A lagging table is marked applying instead of being presented as
current. Reads check authority once before loading their result; they do not keep
a change watcher open while the result is assembled.

## Bound invitation checks

`POST /members/join` uses the [member API contract](../../docs/api/members.md#bound-invitation-acceptance).
It requires the exact organisation, verified ASCII session email, a sign-in within
60 minutes and current inviter role for a fresh join. Saved-command receipts stay
readable while the admission has not been removed. Removed admissions return
403 `access_removed`. Unavailable replies may follow a stored append.
The join store supplies `readStream`, `head` and `append` so the shared
`authorityFence` can check member and ownership events before the write.

The API contract's [Zitadel deployment requirements](../../docs/api/members.md#zitadel-deployment-requirements)
are required for acceptance: self-registration off; no external identity providers
that assert verified emails; only trusted admins may mark an email verified; and
`idTokenUserinfoAssertion=true` on the app. Emails are not unique in Zitadel.
The contract records the accepted window between the last inviter check and the
append, which is conditional only on the joining member stream.

The sign-in callback limits the complete session cookie header to 3,800 bytes.
Larger sessions return a clear 400 error and clear both cookies. Browser requests
receive plain text for this error. Invalid session data, including an email longer
than 320 characters, also fails sign-in before a session cookie is written.

## Approval signals from computers

The bridge advertises `approvalWaiting: true` in `resume`. Older computers ignore
this extra field. A new computer can treat its absence as no approval-signal
support, so it never sends an unknown message to an older server.
The bridge accepts a strict `approval_waiting` message before parsing stored reports.
It has a lower-case 64-hex `approvalId`, plus `conversationId` and `turnId` of
1–200 characters. A socket keeps at most 64 waiting approvals. Repeated messages
reuse the existing entry. A valid new signal beyond the limit receives
`outcome_unknown` at once, so the computer can fail its call. Invalid messages
and mismatched saved bindings are ignored. An empty request stream removes the
entry and returns `outcome_unknown`; it cannot become a valid request by retrying.
The saved request must name the link's assistant, the supplied approval id,
conversation and turn before `readApproval` can expire or cancel it.

The bridge polls each waiting entry independently, with a ten-second read limit.
It checks entry positions only after the overall event position changes, when
an expiry is due, or when a failed read is ready to retry. A newly received entry
gets its first check even if no event has arrived. It reads the approval again
when its approval, conversation or tool policy stream moves, and when the saved
expiry time arrives. Each failed entry retries after one second, then doubles
its delay up to 30 seconds. A successful check clears that delay. An
`approval_settled` message returns `approved`, `denied`, `expired`, `cancelled` or
`outcome_unknown`, then removes the entry. Socket messages are never stored and
never grant permission to send a tool call. The decision service checks each call.
A reconnect starts with an empty map; the computer must announce its waits again.

The server and computer can be deployed in either order. The computer advertises
`x-opencrane-approval-waiting: true` in its WebSocket upgrade response. This server
checks it on every new connection before offering Ask tools with a review. An
older computer receives Allow tools only. A new computer sends `approval_waiting`
only after this server advertises its own support in `resume`. An older server
without that marker receives no approval signals.

Tests: `test/bridge-approvals.test.ts` uses real NATS and a real socket for the
message route. It covers request bindings, saved states, reconnects, duplicate
messages, changed conversations and policies, expiry, failed reads, back-off,
empty requests, visible capacity refusal and quiet polling.
`test/bridge-replay.test.ts` also sends signals through `watchBridges`. A decision
reaches only the waiting computer. A blocked approval read leaves another
conversation's reports and next turn free to continue.

Local guard checks on 8 October 2026: PASS. The inert handler failed all 17
initial tests before implementation. Sixteen separate mutations then failed
their owning tests: the four saved request bindings, approval-id format, duplicate
registration, duplicate reads, capacity, closed sockets, changed conversation and
approval positions, quiet-read caching, expiry, saved state, strict message fields
and the socket message route. Each mutation was restored before final checks.

Review fixes on 9 October 2026: the focused approval tests failed in six cases
before the implementation changed. The tests were committed first. Removing the
approval poll from `watchBridges` made its new socket test time out; the poll was
restored. [Check record](../../docs/process/approval-watcher-review-fixes.md).

## Model grant changes

Provider GET replies advertise `grantsAvailable: true` with `reason: "model_access_routes"`.
Provider list/detail, model grant and candidate GETs check current Owner/Admin access
once with `readActiveMember`. They do not start the two-second write check or watch
provider activity. Slow database reads and saved verification results cannot refuse
an already authorised read. Writes retain their existing access checks.

`POST /api/org/models/:modelId/access` accepts only `{commandId, expectedSequence,
action: "grant" | "revoke", granteeKind, granteeId}` in at most 2 KiB. It requires
an organisation session, exact Origin and current Owner/Admin events plus OpenFGA.
Targets for grants must exist in this silo; people must be active members. Revokes
can remove a departed person's grant. Grants require an active registry model;
retired models stay revocable and unknown model ids are refused. A grant changes
neither provider selection nor paying-group membership. The browser editor uses these routes for one-row grant and remove saves.

POST and status GET check current Owner/Admin access before reading grant history.
History has a ten-second limit before the two-second check on caller and ownership.
Person and assistant targets are checked for changes separately. Team grants read
only the creation event before the check and do not watch membership activity.
An empty team revoke reads assistant selections before that check, with a ten-second
limit, to find a selected starting grant that has not been saved yet.
One conditional append uses `historyChecked` and the original access deadline.
A saved `appended` receipt names the original command, event and position.
Identical repeats return it; changed payloads or stale positions give 409 `refused`
without a new event. Empty revokes return `no_effect`, except an unseeded starting
grant revoke, which is saved so the worker cannot restore it. The full rules and
409 target reasons are in the [model grant API](../../docs/api/providers.md#changing-model-grants).
Invalid or unauthorised requests give 400/401/403 `refused`.
503 `unavailable` means checks failed before append; 503 `unknown` means append
or its reply is uncertain. Recovery uses only
`GET /api/org/models/:modelId/access/changes/:commandId`, with current authority.
It returns the original receipt, currentSequence and separate content/IAM
`current` or `applying` states. 404 `unknown` does not prove absence while a POST
may still be running. Every reply uses `cache-control: no-store`.

## Remote tool grant changes

`POST /api/org/integrations/:serverId/access/changes` accepts the same strict 2 KiB
body as model grant changes: `{commandId, expectedSequence, action, granteeKind, granteeId}`.
Action is `grant` or `revoke`; kind is `member`, `team` or `assistant`.
It uses the existing model-access route dependencies and session/Origin checks.
Current Owner/Admin events and applied IAM receipts are required. It saves one typed
`grant.given` or `grant.revoked` on `grantStream('mcp_server', serverId)`.
No new event, IAM writer or projection worker is added.

Grant targets must exist in this silo. Removed people and disabled assistants cannot
receive grants. Groups have no inactive state. Unknown, foreign, rejected or unpublished
servers refuse new grants; registered drafts can receive grants without publishing tools.
Revokes remain possible for inactive targets and servers. They save a revocation even
when no earlier grant is recorded. Kindless historical revocations remain readable.
Server, target and grant histories load before the two-second write check. Groups read
only their creation event; changes to group membership cannot block a grant save.
Person, assistant and server positions are checked again before the single append.

The reply names the original serverId, commandId, changeId, operation and sequence.
Identical repeats recover that receipt; changed actors, payloads and expected positions
return 409. Append uncertainty returns 503 `unknown`; no automatic append retry occurs.
`GET /api/org/integrations/:serverId/access/changes/:commandId` checks admin access once
and returns that receipt, currentSequence and separate content/IAM `current` or `applying`.
Content means the members worker has recorded this event in its generic inventory;
the model-only checkpoint is never used. Failed reads return 503; missing history is
404 `unknown`, which never proves a retry safe. Replies use `cache-control: no-store`.

`test/integration-access.test.ts` uses disposable NATS, PostgreSQL and OpenFGA.
It checks admin access before grant history is read, after target preparation and on
repeated commands. Caller demotion during the final position checks saves no grant.
Separate receipt cases change only the silo, principal kind or principal id.
This is the first part of #45 row 7: HTTP commands, original receipts and inventory replay.
The real gateway intersection/revocation matrix remains NOT RUN for this part.
Bounded access/candidate reads and screens follow in row 8; #105 owns group editing.
Fresh-install qualification is NOT RUN.

## Invitation review fixes

New email invitations use caller-generated UUID v4 member ids. Renewals locate
candidates by email in the members projection and check each candidate's events.
The lookup stops at 100 candidates; each stream read stops at 10,000 events.
The route never scans `member-*`. The members projection is required for POST.
Stored data failures return 503, while invalid request bodies return 400.
A changed watched stream returns the caller's saved command result, an access
refusal if their admin access ended, or 409 `concurrent_change`.
The optional invitation clock sets session checks, event time and seven-day expiry.
Tests cover its exact expiry boundary and acceptance of a route-created invitation.
Acceptance refuses active identities itself, including joins after
the candidate read and delayed member projections.

Email-only acceptance requires the members projection through `DATABASE_URL`.
It reads up to 100 candidate ids by issuer and subject with their checkpoint in
one query. It includes member events after that checkpoint and verifies each
candidate from its own stream. It refuses incomplete reads, more than 10,000
unapplied events or more than 10,000 events in one candidate stream. Its event reads
have a ten-second deadline and finish before the two-second access check.
Older unrelated member history does not count towards these limits.
It keeps the invitation’s member id and records issuer and subject on `member.joined`.
After the account read, acceptance checks that the invitation stream still has
the position read at the start. This check finishes before the two-second access
check. A renewal returns 409 `unknown_invitation`; another unexplained change
returns 409 `concurrent_change`. No join uses the old role or assistant choice.
The final check confirms the member position has not moved, and the conditional
append uses that position across `member-*`. Concurrent accepts on different
invitations cannot admit the same account twice. Other member changes also require
a retry with the same command. The projection can rebuild the account binding.
Bound acceptance needs no database and retains its own member-stream append.
See the [email acceptance contract](../../docs/api/members.md#email-only-invitation-acceptance).
`test/invitations.test.ts` covers renewal before and after the account position
is read, during the access check and just before append. Each case checks the
saved events and the renewed role in PostgreSQL.
`test/email-admission.test.ts` checks invalid checkpoints, candidate and history
limits, conflicting account bindings, bounded reads and events after the saved
member position. `test/member-joined.test.ts` also checks saved invitation ids,
missing databases, expired append deadlines and rejected join identity projection.

## Waiting tool calls

Turn lists now include reviewed, zero-cost Ask tools only when discovery carries a review.
Allow tools still fail if policy changes to Ask mid-turn.

Human group events are now valid stored records. Chat reads, lists and
subscriptions check saved participation and the caller’s latest join position.
Creation and participant commands for that mode are not exposed yet.

Provider binding POSTs use the existing organisation, exact Origin and current Owner/Admin checks with a 4,096-byte limit. GET reads checked event histories, reports real default counts and marks routine history as absent or unsupported. Reader failure or changing history returns 503. See [the provider API](../../docs/api/providers.md).

Concurrent binding and configuration requests with the same command id return
one saved receipt and one 409 response. Both must finish their final access checks
before the test lets either append. `changes/:commandId` returns the saved operation
and its original event id. Configuration replies also read the saved event before
reporting success, so a binding cannot be mistaken for a saved model change.

## Conversation participation reads

Chat, approvals, files and desktop checks share the current audience and latest join
position from NATS. Removal refuses access before OpenFGA applies it; joins need their
applied receipt. Sockets watch member and participation streams, plus the actual team
for private team sessions. They keep polling during blocked content reads and drain
full pages before ready. History, titles and saved change status start at the latest join.
Legacy event positions come from `conversation_legacy_participation`, which contains
only old conversation-stream changes. The reader checks each saved record against NATS
once and retains the latest join or removal per person. Later reads fetch only newer
legacy references; modern participation never enters that query. Stop readers before
replay so retained facts cannot outlive replacement tables.
New `conversation.closed` events use `participation-<conversationId>`, alongside
participant changes. File and desktop checks read this small stream. They never
scan messages for a closing event. The closure summary retains a closed flag and
the last checked position for up to 256 conversations. A projected close is checked
against its exact NATS event before use. This also supports older closes recorded
on a conversation stream.

Upgrades stop old server writers and catch up the conversations worker before
starting the new server. `requireLegacyClosesProjected` compares the conversation
stream position with that worker's checkpoint once at startup. Startup refuses
when the worker is behind, so an older close cannot be missed. A fresh installation
with no conversations needs no checkpoint. This check is outside every desktop
lease. After startup, new closes are visible without waiting for the worker.
Restart readers after event-store restoration or table replacement. Retained
summaries must not survive either operation.

Approval decisions read history and the encrypted review before the two-second write
check. They carry the checked approval sequence and conversation position forward,
then check only later conversation changes and the current tool policy before append.
The approval append also uses the remaining write deadline. File commands load their history before checking participation.
The offline upgrade must finish with old workers stopped before readers restart.
Participant controls use separate commands. Real-service regression tests cover
removal, blocked delivery, re-joins, other access readers and 100,000 messages.
Conversation lists reuse checked member facts within the request and pass the checked
creation event to private-session checks. Each permission reply is followed by member and
participation position reads. A changed position reloads those facts before returning
content, so an old OpenFGA answer cannot hide a newly saved removal.
Fresh-install browser qualification remains NOT RUN.

Personal agent sessions retain screenshot capture for current participants who have a
desktop grant. A late participant can list and download screenshots saved after their
latest join. Older previews and downloads are refused, including after projection replay.
Private team sessions still refuse participant capture.

## Governed memory recall

`POST /mcp/memory/server` serves stateless 2026-07-28 discovery, listing and scoped recall.
Only recall is advertised. The personal remember handler is described below.
Recall selects the requester's person scope, the bound assistant's notes, or its
owner group's scope. Another assistant or membership cannot add a scope. Notes
and group reads require the live assistant audience, current group membership
where applicable, and recorded requester/assistant operation grants. A grant to
the assistant's owner group can supply requester read rights after membership checks.
Discovery requires MCP access without requiring a personal memory read grant.
Private remember calls are refused even with plausible shared source references.
Shared-only execution remains unavailable, and native turns receive no memory tools.

Memory calls need `TOKEN_SIGNING_KEY_FILE` and an explicit internal route.
The startup environment no longer supplies that route; production wiring is pending.
`MEMORY_MCP_GENERATION` on the memory backend must match this generation. It has no default;
missing configuration refuses calls. Use a unique value for each backend process and route
to that exact process, never a Service alias shared by different instances. Replacement
processes need a new generation and route configuration. The backend also refuses contexts
issued before it started, so restarting cannot restore a captured context.
The server uses its existing token issuer's public keys and `MEMORY_KEY_DIRECTORY` settings.
Deployment keeps the backend behind the gateway; unsigned direct requests are refused.

The [memory capability contract](../../libs/models/README.robot.md) explains signature,
scope, policy and current grant checks. Replies fit within 16 KiB.
`test/memory-mcp.test.ts` uses real agentgateway, NATS, PostgreSQL and OpenFGA.
Its shared fixture renews gateway credentials before each test on the same live turn.
The turn token still lasts two minutes. Long test runs must reach the intended memory
check rather than fail earlier because a previous test's token has expired.
The successful fixture records a `restricted` execution mode. A legacy start without
a mode is refused, as is `memory_free`. Both the requester and assistant need
recorded grants of the right identity kind and current OpenFGA permission.
The fixture warms service clients. Fresh-install journeys and backend network
isolation remain NOT RUN. Every memory request uses the shared one-use dispatch pass.
A Block or hold saved before admission refuses forwarding. The signed context binds that
pass, the backend generation and the reviewed catalogue; the backend refuses reuse.
Concurrent admission records do not change tool policy or refuse another memory call.
The startup regression expects three shared admissions: discovery, listing and recall.
Its former zero-admission expectation described the removed bypass.

## Repeating a provider-bound turn

Turn start/close records can retain `providerId`, `bindingSequence` and `model`.
`turnCommand` keeps the first start's choice on repeat and closure. The bridge
uses that saved model when issuing another pass. Legacy records keep task-table
selection. Admission does not yet select a saved assistant or default binding.

`test/bridge-replay.test.ts` checks a bound turn through real NATS, a WebSocket
connection and the signer. The start acknowledgement contains a signed pass with
the saved provider, binding position and model. Reconnecting and repeating the
report after another binding is saved returns the same choice. The test verifies
the signature and claims; it makes no paid call.

## Human group creation and sends

Members can review their own groups and create a chat with a fixed audience,
even without a personal assistant. The [group API](../../docs/api/group-chats.md)
owns the request shapes, limits, retry rules and refusal responses. Group sends
use the existing message route. Commands load an incremental history summary
before the two-second access check and point-read saved replies.
`test/direct-chat-http.test.ts` uses real NATS, PostgreSQL and OpenFGA for group
picker access, changed snapshots, lost replies and zero assistant activity.
It checks the same generic refusal for unknown, foreign and removed participant ids.
Separate cases check changed audiences, changed positions, departed members without
a group association, and group changes before and during the write check. Each
refusal leaves the conversation stream empty.
Participant controls use separate commands. Fresh-install qualification remains NOT RUN.

## Delivering the admitted model to computers

Start acknowledgements include `model` alongside the signed turn pass. Both use
one choice from the saved start, or the task table for legacy starts. Repeating a
start after a binding moves or pauses keeps its original model and provider claims.

`test/bridge-replay.test.ts` checks the server and computer bridge together through
real NATS and WebSocket connections. Both memory-free and restricted runners pass
`gpt-6-luna` to the Codex `turn/start` boundary when the saved start selects it.
Renewal after a recorded pause keeps that choice and does not start Codex again.
The test verifies signed claims. It uses a recording Codex driver, not a live Codex
process or paid provider.

This is the computer-delivery slice of P4-22 row 4. Migration commands and safe switch-on remain for a later change. Managed calls and retirement stay unavailable. Existing deployments
keep the deployment-key path; bound tokens still refuse before reserving money.

## Human group participant commands

The [group participant API](../../docs/api/direct-chats.md#group-participants) defines
reads, creator edits, self-leave, stale positions, limits and saved retries. Commands
load access, close and command histories before their two-second write check, then
conditionally append once to `participation-<id>`. Saved command positions use
`readStreamSummary`; retry payloads are checked with `readEvent`. Group creation,
participant controls and group sends use separate routes.
`test/chat-access-regression.test.ts` covers the commands with real NATS, PostgreSQL
and OpenFGA, alongside socket, history, file, desktop and approval refusals.
The test for the last participant slot holds two additions after their final access
checks, immediately before the real append. It checks one saved event, one HTTP 409,
exactly 97 current participants and no event from a later stale edit.
The removed-author test keeps OpenFGA permission unchanged after removal. It checks
that the request returns 403 and saves no message. A successful group send followed
by removal is NOT RUN until the group send routes are integrated.

The [participant command receipt](../../docs/process/p4-5-pr4-evidence.md) records checks
and the remaining live qualification.

## Changing member roles

Owners and admins can change member and admin roles. Each change checks current
access and records an appointment receipt. An owner stays an owner when another
person's role changes. An owner can step down only while another active owner remains.
See the [role contract](../../docs/api/members.md#change-a-member-or-admin-role).
Role status requires the competing appointment's confirmation receipt in either saved order.
The content checkpoint must also cover both changes. A role receipt alone cannot report
IAM as current while that appointment is still waiting to be applied.

New owners need `member.ownership_confirmed`: see the [ownership contract](../../docs/api/ownership.md).

Role changes and team turn starts load the caller’s membership history before
starting the two-second write check. The check compares the member and ownership
positions from that read, then checks current permissions. Role changes also
watch the target member; team turns watch their assistant and actual groups.
Neither operation reads or watches former successors’ member streams.

`test/ownership-access.test.ts` changes a former successor’s ordinary role during
each operation’s write check. It also makes ownership-history reads take longer
than two seconds and checks that each operation still saves its event.
`libs/models/test/ownership-confirmation.test.ts` records removal after the final
confirmation check but before append. The conditional append refuses confirmation.
It also refuses absent requests and mismatched successors or appointing owners.
Fresh-install qualification remains NOT RUN.

## Recorded tool failures and approval actions

The [approval API](../../docs/api/approvals.md) explains tool failure records and approval actions.
The approvals GET includes the saved `turnId` on each card. The browser uses it to
hide decisions for budget-stopped work, even if a delayed card still says requested.

The [member API](../../docs/api/members.md#invitation-command-status-and-refusal-history)
records saved invitation results and safe refusal history.

Invitation status routes require the original human caller. The legacy route keeps
its receipt shape and returns 404 for another admin's command. Audit routes set
`Cache-Control: no-store` before handling success, refusal and errors.

`test/invitations.test.ts` covers permission denial and outages, unapplied access
changes, removal during an audit read, reads without writes, refusal recovery
limits, daily join refusal limits and safe HTTP history after replay.
`test/member-refusals.test.ts` checks refusal fields, invalid history, the
10,000-record limit and real NATS read deadlines. Set `PG_TEST_URL` to a
PostgreSQL service that allows disposable databases for the route tests.

Refusal status reads compare a SHA-256 digest of the requested command id with
`originalCommandDigest`. Refusal events never store the raw id. Invitation events
and status replies retain their existing command ids. The event security checks
reject raw command-reference fields without adding a field-name exception.

Audit routes call `isOrganisationSession` with `extraIdentities: []`. Both history
routes require the configured organisation even when development sign-in allows
a named outsider. The source guard continues to cover `audit/routes.ts`.

Ownership refusal tests allow exactly one `member.command_refused` audit event.
They still require unchanged member and ownership stream positions, unchanged
effective roles and an unchanged membership outcome after projection. The pending
Owner-role invitation remains invited; the active owner remains an owner.

## Member access and departure reads

The Owner/Admin GETs `/api/members/:memberId/access` and `/api/members/:memberId/departure`
check events and OpenFGA once. They stop after ten seconds or 10,000 inventory records.
The members projection indexes the exact streams for groups, assistants, grants,
computers and unsupported routine/connection history. Grant and group inventory
loading reads exact streams. Category positions check index freshness and prevent new links
from being missed. Reviews include at most 100 recorded groups and 500 distinct
expanded people; overflow adds `inventory_limits` and keeps removal disabled.
Missing or behind index data adds `inventory_index`. Rebuild members on upgrade.
The existing 20/50 browsing and 100 candidate limits are unchanged.
Checked inventory event positions, computer rows, history totals and positions in
the target's retained rows form the review revision. Processing receipts show that
both table workers have processed the latest reviewed events on exact streams. The inventory
compares positions in the target's computer and history rows before and after the
SQL reads. Messages and table updates for another member do not change these positions.
The index also keeps the latest creation and participation changes for the target.
Their conversation-worker receipts are required even when the displayed history
is empty. No review reads the global tail. The index counts all saved stream names
and records the participation-category position. These small saved values are
compared with NATS metadata to detect history not yet indexed. Known streams can
keep receiving messages and read receipts without changing these values.

Outside the write access check, one new unindexed conversation may be checked by
reading its latest event and its first event only. Creation requires an empty
conversation stream. If the first event excludes the target, that single new
stream cannot add their history. More unindexed streams, an unknown stream of
another kind, or pending participation changes make the review incomplete.
The final removal check disables this extra read. It checks only saved metadata,
category positions, target rows and indexed receipts within the access deadline.
Behind tables and unsupported ownership, routines or connections block completion.
The latest grant changes include revocations for each member, group or assistant.
The latest group removals are kept even when no access rows remain. Both reads
stay incomplete until OpenFGA receipts confirm these changes were applied.
Shared-assistant selection checks the group membership and its receipt independently
of resource grants, as well as the assistant creation receipt. A missing membership
receipt reports unavailable selection rather than denied access.
Failed reads return 503. Only counts and dates leave conversation tables.
Tool, publication and connection readiness stay unavailable. A complete departure
review enables removal for an active non-owner.
`test/member-inventory.test.ts` uses real services. Fresh-install qualification: NOT RUN.

## Governed personal remember (P4-12 PR 3c)

`remember` uses the human command path with an agent principal bound to the requester.
Its command id is separate from human command ids. Retries return the original receipt;
changed input conflicts. Recovery checks the recorded principal kind, including after a
saved append loses its reply. The event links the conversation, turn and decision request.

A recall page includes `recallProof`, a signed list of returned fact ids and revisions.
It binds the silo, requester, assistant, computer generation, conversation, turn, thread,
content class, selected scope and saved `inputGeneration`. It contains no fact text
and needs no saved permit table.
Proof bytes count towards the 16 KiB reply limit. Page-limit placeholders are excluded.
Remember requires this proof, non-empty same-scope `dependsOn`, and empty `sources`.
The proof's references must belong to `dependsOn`. The dependencies must equal the whole
saved loaded set, in any order, with no duplicates. Earlier recall pages remain required.
The command checks current key status, expiry and all historical dependencies before using text.
The backend accepts complete person-scope lineage. Any loaded group or assistant-notes
reference refuses the write, for personal and team assistants. Remember stays omitted
from discovery, and native admission stays disabled.
`test/memory-recall-proof.test.ts` checks signatures, identity and input generation.
The MCP tests check complete lineage, stale facts, terminal evidence, races and replay.
Proof errors stay internal; the endpoint response does not include them. The MCP fixture renews
its two-minute turn token before each test so slow runs do not use expired credentials.
An agent cannot claim a human statement. This proof checks references, not whether the
model's wording follows logically from them.

The final append rechecks the original capability deadline, live turn and watched grants.
Every agent write to group or assistant-notes scope returns `agent_person_scope_only`,
even with valid shared recall references and write grants. The command also refuses
another person's scope. Claimed `shared_only` contexts remain refused. Server-recorded
shared-only execution, its input isolation and shared agent writes are deferred to a later PR
after #94. Native turns still
receive no memory tools. Fresh-install qualification and backend network isolation are NOT RUN.

Source evidence for the 10 October 2026 rework is recorded in the
[rework receipt](../../docs/process/p4-12-pr3c-rework.md). The seven-file memory set
passed 271 tests twice with `PG_TEST_URL` set. After the lint corrections, the final
changed memory files passed 99 tests twice. Web tests passed 589 tests, and the existing
chat fixture produced 24 captures. The receipt records source checks, initial failures
and the remaining live qualification. No full root suite ran.

## Shared child records

The participation reader recognises shared-child initial joins and returns a separate
`historyPosition` from child creation. `joinPosition` and `joinEventId` remain authority facts.
Effective inherited access and participant commands are described below.
Inherited access checks the saved parent joins. Internal child creation is available;
public child commands remain later work.
`test/shared-child.test.ts` checks real NATS/PostgreSQL/OpenFGA replay and delayed creation.

## Private turn memory preview

`GET /api/memory/turns/:conversationId/:turnId` returns a bounded preview for a saved private turn. It does not issue a token, record loaded facts or send text to a computer. It returns at most 32 references and 16,384 UTF-8 bytes. Each category reads at most 33 candidates. The shared `memoryReferences` check validates each fact and all its supporting facts before decryption and again before release. Expired, erased, superseded or unchecked references are omitted. The server checks access again without reading chat history. Denied scopes have no ids, counts or omission flags. Missing turn ownership returns 404; service, permission, content or projection uncertainty returns 503. All responses use `Cache-Control: no-store`. Fresh-install qualification is NOT RUN.

## Immediate access invalidation

Desktop, queued computer work and personal turn checks use `chatMembership`.
It starts inactive, activates only on join or owner bootstrap, and ends membership
on removal. An invitation or role change after removal does not activate it.
The reader checks the silo and member id and retains current membership and its
checked position. Computer-register reads use `readActiveMember` with the admin
role. They also require the current member event and its applied permission receipt.

A first personal start and every repeated start check the requester before the
lifecycle append or returned binding. Repeated starts use `requireTurnMember` and
check only the requester's member stream after reading conversation history.
They keep the saved payer, provider and model without selecting them again.
Shared admission retains its member and group
checks. The bridge reads private history outside the two-second access check, then
checks membership before minting the turn token and confirms the member position
again before releasing the token or history. Queued message/tool frames check
membership after building the tool list and before sending. File delivery checks
`ownConversation` before sending bytes; `fileCommand` checks again before saving
the acknowledgement. Terminal reports can still record the outcome of earlier work.

Desktop freshness subjects are the member, `participation-<conversationId>` and
shared-desktop grant streams. Team grants also check the member and team streams.
No conversation stream is watched or scanned during the 1,200 ms access check.
Chat activity does not invalidate a lease. A confirmed refusal stops the check
while other reads are still waiting.

The [entry-point record](../../docs/process/p4-3-row7-access.md) lists the routes,
event checks, failing-first results and remaining live qualification.
This change adds no member removal route or dependency.

## Reviewed member removal

The [removal contract](../../docs/api/members.md#reviewed-member-removal) covers
review conflicts, receipts and delayed table and permission updates.
The status GET adds cleanup from the member audit stream before checking current
admin access. The read has its own two-second deadline and 10,000-row limit.
Without a completion, reviewed removals stay applying for 15 minutes from the saved
removal time, then become unknown. Legacy removals and failed or unsafe reads are
unknown. The first valid matching completion supplies its own time and sections,
even after that bound. POST receipts and exact retries stay unchanged.
Refusal history validates every row's silo and subject, counts all audit types and
parses only refusals. Refusal appends use the last sequence across all audit types.
The removal and refusal tests cover time bounds, failed audit reads, current access,
duplicate completions, separate admissions and unchanged status after member replay.
Removal compares the reviewed revision, then checks the inventory category positions
again before append. These checks remain separate from the small member and ownership
streams that decide access. The conditional append checks the target member position;
ordinary removal does not use the event store's migration-only global condition.
The inventory check and target append are separate operations. Only changes on the
target member stream are ordered atomically against removal.
`test/member-removal.test.ts` covers refusals, lost replies, ownership races and replay.
It also projects another member's message between the computer and history SQL reads.
Removal succeeds with the same reviewed revision. A target computer or history change
between those reads refuses removal, including when the target's history is still
waiting to be projected. The final check reads only events saved after the inventory
finished. It refuses a new target history event even before that event is projected.
The tests also refuse a late target role change and a changed inventory category.
The socket and desktop tests remove through HTTP with slow content reads.
`test/removal-gateway.test.ts` covers gateway refusal with existing and fresh credentials
while IAM is delayed.
Fresh-install qualification and browser canvas clearing remain NOT RUN.

## Hosted startup credential review

The install worker checks optional hosted registration `credentialContract` data
before creating any discovery identity. It records `mcp.server_rejected` for lasting,
environment-only or raw-bearer requirements (`lasting_startup_secret_required`),
or missing or incompatible evidence (`startup_contract_unverified`). The status read
makes the same check before offering Needs input. It never suggests Connect for
these refusals. Compatible contracts show `pending_review` without a process,
credential release, discovery request or normal call. Hosted per-call contracts
remain for the separate hosted installer. Existing reviewed per-call connections,
including memory records without startup evidence, keep their inventory and calls.
Older hosted registrations without evidence are still refused before discovery.
New credential-free installation requests follow the checking rule documented below.

The [accepted design](../../docs/specs/phase-3/p3-10-startup-mcps.md) defines the later
qualification, delivery and lifecycle work. Contract fields are review inputs, not
proof that expiry, renewal or persistence checks passed. No qualification is claimed.
`test/startup-mcp.test.ts` uses real NATS for saved refusals and forged publication
claims. The projection test checks startup and per-call policies through PostgreSQL updates
and catalogue replay. `test/memory-startup.test.ts` checks completed memory review
and a real gateway/backend recall with both older and declared per-call contracts,
alongside refusal of a lasting startup contract.
Existing remote discovery tests remain regressions. Fresh-install startup
qualification and framed refusal screens are NOT RUN.

## Provider choices at new-turn admission

After `provider.managed_calls_enabled`, a new turn selects the assistant's own
`chat_turn` binding or the silo default. An own pause takes precedence over the
default. Missing choices and pauses record a failed turn admission. Started turns
keep their original provider, binding position and model on replay and closure.
The bridge signs and returns that recorded model through its existing path.
Provider history is read with its own ten-second deadline before payer access is
checked. The final check refuses a mode change before saving a legacy start.
The personal payer and switch-on state come from one incremental budget summary.
The final mode check reuses it and reads only later rows. The existing 500-event
personal-payer test still requires at most two new rows after two budget changes.
There is no switch-on route in this slice. Safe migration must first stop new legacy
admissions and drain running legacy turns. Managed dispatch remains refused until
its gateway and provider checks are built.

## Provider drain routes

The drain GET and POST routes reuse provider session, Origin and error handling.
Their contract is in [the models details](../../libs/models/README.robot.md#recorded-draining-before-managed-calls).
Turn admission refuses an active drain before selecting a new turn's path and
checks it again before saving the start. Replayed starts and final reports keep the
saved turn. `test/provider-drain.test.ts` checks receipts, retry, cancellation,
replay, stale inputs and refused callers using real NATS, PostgreSQL and OpenFGA.
`test/provider-turn-admission.test.ts` checks admission and a drain saved during
the final budget check. This check shares the personal payer's incremental summary.
The models provider contract test checks repeated gateway calls and settlement
during drain. Production switch-on is still unavailable.

## Shared budget summary restack checks

Date: 10 October 2026. Source: `eac1150b`.
Rebased only this branch's nine commits from `238bf58e` onto the corrected
provider-admission branch at `b54308cf`. The rebase finished. The provider
summary keeps both the shared budget fold and the existing drain logic.
The race test names now describe the final budget check and separately prove
that the drain was saved during that check. The refused start remains refused.

Environment: Linux, Node 22.23.3, local worktree, disposable NATS and OpenFGA,
recording gateway and PostgreSQL at `127.0.0.1:55432`; not a fresh install.
PASS: one run of all three changed test files plus the unchanged personal-payer
regression, four files and 50 tests in 85.87 seconds. Tests set the documented
test-only `PG_TEST_URL`, use `nice -n 10` and one worker. PASS: root lint,
typecheck, check:events (107 types), Knip and changelog validation. Root lint
includes Knip and `npm run lint:changelog`; it reports 15 existing warnings
and no errors. Both authority files remain unchanged from main.

Logs: `/tmp/p4-22-pr4d-budget-tests.log`, `/tmp/p4-22-pr4d-budget-lint.log`,
`/tmp/p4-22-pr4d-budget-typecheck.log`, `/tmp/p4-22-pr4d-budget-events.log`
and `/tmp/p4-22-pr4d-budget-restack.diff`.
NOT RUN: full root suite, paid calls and fresh-install managed-provider qualification.
The switch-on command and managed gateway remain unfinished.

## Destination policy commands (P3-20 PR 1, first split)

The existing `modelAccess` service options supply the silo, session identity, event
store and permissions service for these routes. Owner/Admin access is required.
`POST /api/org/egress/destinations` accepts `commandId`, `expectedSequence`,
`action: allow|revoke`, `scope: silo|person|assistant`, `subjectId`, `host`, and optional
`port` (443). It saves one rule with one conditional append. Each change id belongs to its first
saved target and arguments across all destination rules in the silo. Writes read
`egress-*` and check its latest position in that append. The caller's
`expectedSequence` still checks the selected rule. A concurrent save on any rule
returns 409, so the caller must reload before retrying. This serialises policy
saves without adding another event or a separate receipt store. Reads of policy
and membership history finish before the two-second check of membership positions.
`GET /api/org/egress/destinations/changes/:commandId` takes the same scope/subject/
host/port in query parameters. It returns only the original caller's saved receipt.
Both routes use no-store; writes require the configured browser origin. Saved results
carry command/event ids, operation, time and sequence. Changed saved arguments or a
stale expected sequence return 409. A lost append reply or unseen status stays unknown;
status never resends. Saved retries work beyond NATS's duplicate window.
Networking stays disabled. Decision bindings, observation/audit detail, member policy
views, effective admission and fresh-install qualification remain for later work.

## Nightly memory bindings (P4-17 PR 1, first part)

`POST /api/memory/:scopeId/maintenance/binding` accepts `commandId`,
`expectedRevision` (zero before setup), `assistantId`, `payingGroupId`, `enabled`
and explicit `acceptedCapCents: 100`. The authenticated current member is the
consenting execution member. No caller-supplied member or admin impersonation is
accepted. Group scope requires its own group assistant. Notes require their own
assistant, its real audience, actsFor, and both current read and write permissions.
An enabled binding requires current payer membership and any assistant payer match.
Disabling still checks scope access, but can succeed after assistant or payer loss.

History is read before the two-second authority check. Only exact member,
assistant, audience, payer and grant streams decide access. Each command makes
one conditional append on the scope stream. Config revisions count binding changes;
content movement is a separate append conflict. An identical retry returns the
original receipt. Changed commands or stale revisions return 409. Lost append
replies return unknown; the original `/changes/:commandId` GET checks saved history.

`GET /api/memory/:scopeId/maintenance` checks scope read access once and requires
caught-up memory tables and an unchanged table generation. It returns the current
binding and `not_configured`, `disabled`, `clean` or `qualification_blocked`.
Dirty status includes `waitingCount` and the first 02:00 UTC after both now and
the binding save time. Clean status has `nextAt: null`. Dispatch is always disabled.
All responses use no-store. There is no run,
retry or scheduler endpoint. The nightly worker records blocked, missed and empty nights,
and the GET includes their bounded history as described below. No allowance is
allocated and nothing can spend. The cap records consent.

`test/memory.test.ts` covers HTTP consent, scope/assistant/payer refusal, retries,
conflicts, status privacy and equal binding tables after offline replay without
external ports. Fresh-install qualification and independent review: NOT RUN.

## Budget stop

Owner/Admin budget reads and commands include saved stop reasons and known turns.
Rebuild budget projections on upgrade. The integration test checks PostgreSQL
replay and member refusal; dispatch and cancellation follow later.

## Budget refusal at turn admission

A zero ceiling can refuse a chat turn before the model gateway receives a call.
The failed `computer.turn_closed` keeps `budgetStopId`. The bridge records a
`decision.recorded` model denial with reason `budget_exhausted` before sending the
refused acknowledgement. Each command appends to one stream. The decision uses a
stable id and its own stream so reconnects cannot create another refusal, even
after NATS deduplication expires. Failed saves close the connection without an
acknowledgement. Before sending `resume`, the bridge reads saved budget closes
from the computer summary and records their decisions with the same stable ids.
This also works after a restricted computer restarts and replaces its unfinished
start with a failed report, or has no reports left to replay. Recovery uses the
original stop id even after the ceiling rises. It never admits or reserves money
for that turn. History loads outside access checks. The existing conversation
projection supplies the budget notice.

`test/bridge-replay.test.ts` covers the refusal, no reservation, reconnects, a lost
save before or after append, and recovery after the ceiling rises.

`test/budget-refusal-restart.test.ts` restarts the real restricted computer channel
after a decision save fails before append. It checks one decision, the authenticated
member feed and reload, a second restart, no reservation and no revived turn.

## Control intent and HTTP status

`src/computers/takeover.ts` checks the latest accepted human request, its reviewed
id, the current generation and Pod, membership, participation, assistant rights
and applied desktop grants. `requestControl` records one `takeover.requested` with
one conditional append to the computer stream. A racing turn or intent cannot
both use the same checked position. Retries check current access and the original
request fields. Conflicting command ids return no saved success.

Chat history loads before the short write check. Later human messages and closure
are checked with a bounded tail read. Only small access streams enter that check.
Turn admission, new message delivery, credential issuance and decisions refuse pending
control. Explicit stops still reach the bridge. Reports and explicit approval denial
remain available. Viewer transport and its access leases are unchanged.
Upload delivery checks control before each object read, after the bytes are ready,
and after the sender reads delivery history, immediately before file transmission.
The watcher gets pending control from its existing computer snapshot. Every delivery
check reads the computer stream position again. An unchanged position reuses the
snapshot without reading any events. A changed position reloads history before
sending a new turn or file, including after tool preparation and delivery-history
reads. Direct bridge callers retain the shared control-summary check.
Intent saved during preparation holds that file and the remaining batch without
recording a delivery receipt. A file already being transmitted can finish.
`test/bridge-control.test.ts` covers stops, both slow reads and remaining batch files
with saved events and a real socket. The approved old-token test checks refusal
without an outstanding approval blocking the call. The Bob test has no prior intent
and requires the requester refusal.
Approval decisions use `approvalActivity` to check turn and control changes without
reading unrelated spending history. The tests keep the exact allowed-stream assertion,
refuse intent saved during permission checks and allow decisions when budget history
cannot be read. Model and memory decisions keep their provider-mode checks.

GET `/api/conversations/:conversationId/takeover` loads chat and computer facts
within ten seconds, then checks read access once. It returns status, controlPosition,
serverTime, reason, scope, eligibleActions and a session/chat-bound csrf value.
Statuses include none, requested, pausing, paused, failed and unverified.
Only the requester receives commandId and their own affectedTurnIds in this chat.
Direct and group chats return not_applicable. Reads save nothing and touch no computer.
Access helpers reuse the loaded creation event; later write checks read only new activity.

POST takes exactly commandId, requesterEventId and generation. Session, silo, Origin
and CSRF checks precede body validation and the request switch. Registration defaults
requestsEnabled to false; main.ts uses buildProductionServer, which forces it false. Tests enable it through
buildServer's takeoverRequestsEnabled option. Disabled requests return 503 because
saved intent would leave shared work paused until return and recovery are available.
CSRF tokens must be 64 lowercase hexadecimal characters. Their decoded bytes are
compared with timingSafeEqual before member lookup. Overlapping identical retries
keep the first saved event and position, including its original generated time.
Saved requests and identical retries return 202; changed requests return 409,
access refusals 403, malformed bodies 400 and unavailable dependencies 503.
All replies use no-store. No error mapping depends on message text.

Enabled POSTs that pass authentication, validation and chat access save requester-only
and control-conflict refusals on `view-<commandId>`. `takeover-refusals.ts` stores only
attemptId, actorId, conversationId, inputDigest and the fixed reason. The digest binds the silo,
authenticated actor and all four validated request fields. Identical retries read the
saved record without appending, including after a restart. Changed bindings return 409.
Reusing an accepted command id cannot create a refusal that replaces its saved result.
Before recording a refusal, writeChatAccess rechecks membership and participation.
The same check watches the assistant, relevant teams and payer, and desktop grant.
Append and readback retain that checked deadline, including after an intent conflict.
Both append paths check the other outcome inside the conditional append. The event
store requires the global position from before that check, so only one outcome
can commit. Changed retry bindings still return 409.
The conversation history route lists the refusal for its authenticated requester;
rebuilding the audit table preserves the same conversation and requester links. A lost reply can recover
the committed record; missing or unreadable evidence returns 503. No refusal writes to
the computer stream. Authentication, Origin, CSRF, malformed input, chat-access and
globally disabled refusals create no audit event. GET remains read-only.

Part of #58. PR 1c records refused attempts; chat and realtime control status remain
separate follow-up work. Writer, lease,
renewal, return and recovery routes remain unavailable. The accepted
[design](../../docs/specs/phase-3/p3-17-take-control.md) owns that scope.
`test/takeover-http.test.ts` covers HTTP guards, competing requests, private status,
retries, removal, restart and conversation reads outside access checks with real
NATS, PostgreSQL and OpenFGA. Fresh-install qualification: NOT RUN.

## Source check receipt — 10 October 2026

Source `4c8baa19`; Linux, Node 22.23.3 and disposable NATS, PostgreSQL, OpenFGA
and the pinned gateway. This was not a fresh silo.
PASS: clean `npm ci`, lint, workspace typecheck, check:events (107 types), Knip
and lint:changelog. Final server typecheck and focused lint also passed.
PASS: two five-file changed-test runs, each with 101 passes and one browser skip.
Both used `nice -n 10`, the supplied `PG_TEST_URL` and one Vitest worker.
The earlier nine-file run had 184 passes, one skip and one existing viewer timeout.
That viewer case passed in both clean runs. Its timeout and access limits were unchanged.
NOT RUN: optional 390px approval browser test, full root suite, independent review
and fresh-install control journey. Takeover remains an internal first split.

## Review fixes and source checks — 11 October 2026

Source: `935882c3`. Rebased onto `origin/main` at `5f75ec5b`; the rebase finished.
Kept main's provider, memory-preview and member-removal changes alongside control intent.
Environment: Linux, Node 22.23.3, disposable NATS and OpenFGA, PostgreSQL at
`127.0.0.1:55432`, a real bridge socket and the pinned gateway with a recording upstream.
This was not a fresh silo. No paid model calls were made.

Tests were committed first: `b4e39876` before the bridge fix in `530cd296`, and
`0720cbfd` before the approval fix in `935882c3`. All four bridge regressions failed
before the fix. The unchanged approval-stream assertion exposed unrelated budget reads
introduced by the rebase. That assertion and the new unavailable-budget test failed
before approval activity was separated from provider-mode checking.

PASS: two final runs of all six changed test files, each with 109 passes and one
optional browser skip. They took 396.10 s and 457.67 s. Both used `nice -n 10`,
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres` and one worker.
The files were `bridge-control`, `takeover`, `approvals`, `live-view-activity`,
`computer-summary` and `memory-rights`.
PASS: 25 provider/activity regressions and the existing stop/reconnect regression.
PASS: lint, workspace typecheck and check:events (109 types). Lint includes Knip
and lint:changelog; it reports 15 existing warnings and no errors.
The two authority test files remain unchanged.

Logs: `/tmp/p3-17-pr1-tests-final-1.log`, `/tmp/p3-17-pr1-tests-final-2.log`,
`/tmp/p3-17-pr1-provider-regressions.log`, `/tmp/p3-17-pr1-stop-reconnect.log`,
`/tmp/p3-17-pr1-lint-complete.log`, `/tmp/p3-17-pr1-typecheck-complete.log` and
`/tmp/p3-17-pr1-events-final.log`. Failing-first logs are
`/tmp/p3-17-pr1-red-final.log` and `/tmp/p3-17-pr1-approval-red.log`.

NOT RUN: optional approval browser test, full root suite and fresh-install control journey.
The orchestrator's narrow verification and hosted CI are still pending.
Remaining individual guard tests are recorded in issue #302.

## Final load checks — 11 October 2026

Fetched origin and rebased onto `origin/main` at `55336ff8`, which includes the
group and ownership read changes. The rebase finished. The tested branch source
is `717e64ad`. Conflict resolutions keep both destination rules and control
records in exports, audit fields and documentation.

The merge train reported that both concurrent approved requests returned HTTP 503.
That failure did not return in three isolated approvals runs on the branch or
one on main. Under the requested rerun rule, this was a load failure. No runtime
fix was needed. Access deadlines and all test assertions stay unchanged.

| Source | Isolated run | One-minute load before starting | Result | Seconds |
| --- | --- | --- | --- | --- |
| `717e64ad` | Branch 1 | 11.18 | 42 passed, 1 optional skip | 338.91 |
| `717e64ad` | Branch 2 | 15.67 | 42 passed, 1 optional skip | 277.29 |
| `717e64ad` | Branch 3 | 9.71 | 42 passed, 1 optional skip | 305.04 |
| `55336ff8` | Main | 11.02 | 38 passed, 1 optional skip | 286.86 |

PASS: all six changed test files twice, with 109 passes and one optional browser
skip each, in 494.26 s and 484.42 s. These runs include stop delivery after intent,
uploads held during preparation, approval and old-token refusals, viewer access
and memory rights. Both use the supplied `PG_TEST_URL`, `nice -n 10` and one worker.
The three protected files, `approvals.test.ts`, `authority.test.ts` and
`authority-volume.test.ts`, were not edited during this round.

PASS: full lint, workspace typecheck, event catalogue (111 types), Knip and
changelog validation. Lint reports 15 existing warnings and no errors.
Logs are in `/tmp/pr335-last-round/`: `approvals-head-{1,2,3}.log`,
`approvals-main.log`, `changed-tests-{1,2}.log`, `lint.log`, `typecheck.log`,
`check-events.log`, `lint-unused.log` and `lint-changelog.log`.

This used disposable NATS and OpenFGA, local PostgreSQL and a recording upstream.
NOT RUN: optional browser test, full root suite and fresh-install control journey.
The final PR comment records hosted CI after pushing this receipt. The merge train
owns landing; this round does not merge the PR or request another review.

## Computer history reuse checks — 11 October 2026

Runtime source: `c1f47186`, the rebase of `ed6c5b4b`. The branch contains main
`1327e7e9`, and the rebase finished. Later commits only correct Markdown spacing
and record these results. The watcher gets pending control from its existing
computer history and checks the stream position again before sending new work.
An unchanged position opens no new event read. A changed position reloads history.
The final file check shares this behaviour after ownership and delivery-history
reads. Direct bridge callers retain the shared control-summary check.

Before: both reported replay tests failed at exact head `7d4f0092` in 20.12 s.
The personal/private-team test counted computer reads on passes 2, 3 and 4.
The posted-turn test counted two computer reads where at most one is allowed.
After: both unchanged assertions passed together in 34.72 s. The focused control
and tool tests passed 19 tests in 51.30 s. Cached checks also hold intent saved
after the first snapshot, during chat and membership reads. Both direct and
cached checks keep saved stops available and hold late uploads.

PASS: two eight-file runs, each with 153 passed tests and one optional browser
skip. Run 1 took 724.16 s; run 2 took 561.26 s. The six PR files are
`approvals`, `bridge-control`, `live-view-activity`, `takeover`, `computer-summary`
and `memory-rights`. The set also includes all `bridge-replay` and
`bridge-turn-tools` tests. Both runs use the supplied `PG_TEST_URL`, `nice -n 10`
and one worker. An earlier batch was interrupted when another process rebased
the worktree. It is excluded from the evidence.

PASS: full lint, workspace typecheck, event catalogue (112 types), Knip and
changelog validation. Lint reports 15 warnings and no errors. The rebase dropped
blank lines before two README headings. They were restored, then lint passed.
No protected test was edited by this fix. The rebase retains main's membership
fixtures and participation-stream correction. No assertion or access, money or
memory check was weakened.

Logs are in `/tmp/pr335-computer-cache/`: `before-7d4f0092.log`,
`after-focused.log`, `control-focused.log`, `rebased-tests-{1,2}.log`,
`rebased-lint-final.log`, `rebased-typecheck.log`, `rebased-check-events.log`,
`rebased-knip.log` and `rebased-lint-changelog.log`.
Tests use disposable NATS and OpenFGA, local PostgreSQL and real bridge sockets.
NOT RUN: optional browser test, full root suite and fresh-install control journey.
The PR comment records hosted CI on the pushed head. The merge train owns landing.

## Memory input rebase checks

The [rebase receipt](../../docs/process/p4-13-pr1-rebase-repair.md) records the
branch repair, focused fairness comparisons, failed checks and subsequent runs.
It records the same fairness failure on main and the slow history reads under load.
It makes no live qualification claim.

## Exact tool review

`POST /api/org/integrations/:serverId/review` requires a same-organisation Owner/Admin
session and same-origin request. Input: `commandId`, `expectedSequence`, `policyRevision`,
`catalogueDigest`, `connectionId`, `accountMode`, and every tool’s `name`, `revision`,
`reviewDigest`, `mode`. The server supplies `reviewedBy`. Success is 200, stale or incomplete
evidence is 409, invalid input is 400, and unavailable services return 503.

Approval, bridge tool-offer and memory test fixtures save `mcp.server_reviewed`
before enabling tools. The review names the saved catalogue, connection, account
mode, cost and approval details. Fixtures publish after choosing a wider mode.
Memory Ask fixtures include complete review details. The bridge fixture includes
the saved `stepUp: false` field when calculating its review digest.

## Exact inventory source checks — 11 October 2026

The tests were committed before the fix. They first failed on wildcard reads,
501 expanded people and 101 groups. A second failing test required unknown routine
and connection history when overflow prevents a complete read.

PASS: the two changed test files ran twice with the supplied PostgreSQL URL,
`nice -n 10` and one worker. The three-file run passed 31 tests in 66.71 seconds,
including unchanged member-removal regressions. The second run passed all 18 tests
in the two changed files in 53.85 seconds. Both used real NATS, PostgreSQL and
OpenFGA. Online member replay rebuilt the index without changing permissions.
The two authority test files remain unchanged.

PASS: full lint, workspace typecheck, event catalogue (112 types), Knip and changelog checks.
Lint reports 15 existing warnings and no errors.
Logs are `/tmp/p4-23-pr3-tests-final-{7,8}.log`,
`/tmp/p4-23-pr3-typecheck-final.log`, `/tmp/p4-23-pr3-events.log`,
`/tmp/p4-23-pr3-knip.log`, `/tmp/p4-23-pr3-changelog.log` and
`/tmp/p4-23-pr3-lint-complete.log`.
NOT RUN: full root suite, independent review and fresh-install qualification.

## Inventory upgrade guard

A departure or access review requires `inventory_inputs_backfill.completed = true`
for version 1 before reporting complete. A category's latest position cannot
replace this check. Online member replay replaces the marker and index in the
same transaction. The final removal check reads member generation and small index
metadata; it does not aggregate category maxima again. Permission receipts remain
required. An interrupted first replay must be fully rebuilt before completion.

`test/member-inventory-volume.test.ts` pauses projection while saving 10,001 valid
unrelated read receipts. The departure route returns 200 within two seconds, with
a complete or explicitly incomplete review. It never reads global numbered events.
After projection, the empty review and its revision match the original. Existing
removal tests keep their target-history, receipt and concurrent-message assertions.

## Inventory fix checks, 11 October 2026

Tested source: `c90e7160b61f48a6b4710753a4ca9f48cc049144`, rebased on
`897e42d3591b4cfa0ab96e5427a7b01963d0a01c`. The rebase completed and the base is
an ancestor of this branch. Tests were committed before implementation. The volume
case reproduced HTTP 503; the upgrade case reproduced a falsely complete empty
review. Both now pass. Creation tests also refuse a second audience while preserving
normal and history-checked category retries.

PASS: two final runs under `nice -n 10`, with at most two workers per suite:

| Tests | Each run | First run | Second run |
| --- | --- | --- | --- |
| Four server files: member inventory, volume, inventory and member removal | 103 passed | 152.89 s | 109.19 s |
| Projection rebuild and runner | 11 passed | 34.19 s | 28.54 s |
| All event-store tests | 94 passed | 84.74 s | 79.51 s |

The server fixtures used the supplied `PG_TEST_URL`. Projection fixtures used a
throwaway PostgreSQL 17.6 container on a random port. NATS, PostgreSQL databases
and OpenFGA were disposable fixtures, not a fresh silo installation. The throwaway
container was removed with its volume after the tests. The volume case returns
HTTP 200 within two seconds without reading global numbered events. After projection,
its empty result and revision match the original. Existing removal tests pass,
including pending and projected target history, receipts and concurrent messages.
Both authority test files remain unchanged.

PASS: full lint, workspace typecheck, event catalogue (113 types), Knip and changelog
checks. Lint reports 15 existing warnings and no errors. Logs are
`/tmp/p4-23-pr3-{tests,projections,event-store}-latest{1,2}.log` and
`/tmp/p4-23-pr3-{lint,typecheck,events,changelog}-latest.log`.
NOT RUN: full root suite and fresh-install qualification.

## Final configured MCP sends

Explicit dispatch routes use `mcpDispatchRouteSchema`; the startup list is empty.
Routes without a generation and the reviewed atomic revision header remain unavailable.
All installed servers use this path, including Odoo; no adapter chooses a weaker rule.
The models process reuses its silo leadership lock. It checks that connection immediately
before forwarding, through a callback supplied to `startDecision`. A dead connection
refuses the send. A new process cannot accept the old process's permits.

The [library contract](../../libs/models/README.robot.md#per-tool-policy-p3-1)
describes the required backend preconditions. Hosted startup and image admission remain
unavailable; a configured route does not qualify either. The built-in memory backend
continues to check its signed context. No new budget gate or database business rule is added.

## Tool access explanations

The [API contract](../../docs/api/members.md#tool-access-explanations) describes
the own-member and admin read, safe fields, strict inputs and bounded member
availability extension. It reuses the landed exact inventory inputs from #344.
Publication acknowledgement and usable profile selection remain unfinished, so
availability stays closed. Company account metadata and screens are later work.

The tests were committed before implementation. They reproduced missing route
and overflow handling. Tests use disposable NATS, PostgreSQL and OpenFGA.

Tool explanation reads check current Owner/Admin access or the viewer's saved,
checked requester grant before loading tool rules. Inaccessible and unknown servers
and tools return the same 403 body. Permitted missing-grant replies omit all policy
fields. When incomplete inventory cannot prove grant absence, the read returns
503 rather than claiming a grant is missing. A failed permission check without
a server row also returns 503. Admin detail can still distinguish an IAM
outage when the recorded server grant row is available.

The regression tests reproduce private-server probing and grants applied in OpenFGA
while the members projection is paused. They also check unknown tools, permitted
member and admin detail, permission-only replies and failed visibility checks.

Grant absence uses a separate completeness result for the group, assistant and grant
inputs, including permission receipts and a final check of those stream positions.
Pending chat or computer tables do not turn a checked grant absence into a failed
read. The ordinary departure completeness checks stay in place.

## Nightly memory history

The existing maintenance GET now includes up to 20 payload-free run records,
newest first, capped at 16 KiB. The current binding member alone can read this
status; scope read permission remains required. Other members receive 404.
Checkpoint and generation checks reject stale or rebuilding tables. Reads still
check access once. The 100-cent cap is recorded only; dispatch stays disabled.

## Effective shared child reads (#90, PR 2)

All existing HTTP message, approval, file and change-status reads use the same
conversation access check. Shared children require active silo membership, a
current recorded child join and OpenFGA read permission with an applied join receipt.
Inherited joins also require the reader's and creator's exact original parent joins
and the creator's current silo membership. Checks repeat these saved dependencies
after OpenFGA replies. A removed or replaced parent join never restores inheritance.
A valid explicit child join does not depend on parent or creator membership.
Retained shared history starts at child creation; access still uses the current join.
File reads keep their separate file restrictions and do not grant parent file access.
Child approval reads omit other requesters before loading or decrypting their reviews.
They use checked approval event positions from the audit projection and read the
short unprojected tail from the event log. This keeps long chat history out of the approval
request scan while retaining new requests that have not reached PostgreSQL yet.

Sockets watch member and child participation streams. Inherited sockets also watch
parent participation and creator membership. Their existing independent 100 ms poll
checks removals while content is blocked and closes denied sockets within two seconds.
Reads never open a write check. Writes include these small dependencies in their
existing two-second check. Creation reads stop after the first event; no access check
reads conversation history or watches conversation activity.

Feed replies select display fields before decrypting text. Shared child creation and
list rows omit origin and parent join references. Unrecognised feed event types
return 503 without rows until they have a safe display contract. Lists retain the bounded scan,
visible activity, title search and join-time rules from #352. Child invitations use
the participant routes described below. Child creation, origin and summary APIs remain planned.

`test/chat-access-regression.test.ts` covers stale IAM parent removal, creator parent
and silo departure, removal/rejoin, explicit child history, blocked socket delivery,
HTTP/approval/file/status refusal, list filtering and 100,000-message activity. The
large-child case also reads approvals and change status and keeps a child socket open.
Checks and fresh-install qualification are recorded in the draft PR. Fresh-install
qualification: NOT RUN. This is backend access support, not a complete child journey.

## Saved turn memory accounting (P4-15 PR 2, first part)

`readChatFacts` now returns an internal `memoryContext` rebuilt from trusted
`agent.memory_context_recorded` events. It keeps up to 32 unique scope/id/revision
references, one initial load and four recall replies totalling at most 64 KiB.
Empty recalls count. Each reply is at most 16 KiB. Initial input may contain
32 references; each recall may add at most 20. References are never evicted.
The summary binds requester, assistant, computer, computer generation, conversation,
turn, thread, input generation and projection generation. Scope positions cannot go
backwards. Call and dispatch digests cannot be reused. Repeated identical event ids
are harmless; conflicting data is refused. Invalidated and ended contexts retain
references. Closing the turn also ends its context. Replay creates no execution permission.
The summary also reads conversation closes saved on the participation stream.
It reports the context as ended and keeps its references on both a fresh read and a cached read.
A participation-stream close can arrive during a conditional conversation append.
The summary still checks and retains late preparation and recall records as accounting.
Closure stays separate from those records, so a cached read cannot stop later replay.
Every returned context stays ended. Initial loads after closure, loads after a turn
completion, and invalid or repeated evidence still fail their existing checks.
The history read has its own time limit; access checks keep their small stream set.
The summary copies its result and counts retained evidence against its existing RAM cap.

The first test commit failed 25 tests before implementation. The focused tests cover
schema refusals, mixed-scope accounting, generation changes, recall/reference bounds,
terminal expiry metadata, concurrent summary reads and real NATS conditional append
races with a discarded reply.

The next part connects governed MCP recall to these same events. It appends prepared
once, then loaded before returning each complete reply, including its proof. Each append
uses the checked conversation position. A conflict or uncertain result returns 403 with
no text or proof; there is no automatic retry or resend. Saved references remain loaded
even if the response is withheld or lost. The existing one-use dispatch digest and a
hash of callId prevent replay. Empty replies count towards the four-recall limit.
The writer checks current page references, supporting keys, expiry, scope position,
projection generation and current access before saving and again before release.
It reads chat and scope history before the final short access checks.
The production route tests close the conversation before preparation, between preparation
and loading, and after loading. Each returns only a refusal, then reads the ended
accounting through both the cached summary and cold replay. A later recall is also refused.

Recall chooses `inputGeneration` before sizing or signing its reply and uses that same
value in the prepared record. The proof remains part of the exact saved reply byte count.
Agent remember reads the existing `readChatFacts` evidence before final access checks.
It refuses absent, prepared-only, empty, invalidated or ended evidence. Immediately before
append it reads only conversation rows after the saved sequence, including participation
closes, and refuses new evidence or closure for that turn. The command validates all
loaded references, including expiry, corrections, tombstones and supporting keys.
After that tail read it checks rights again under the original deadline. The write keeps
its original access snapshot, so revoking and restoring a grant cannot revive that check.
The production MCP route tests change the assistant's write grant during this read,
with and without restoring it. Both require HTTP 403 and an unchanged memory stream.
The store now receives that original `decisionAuthorityFence` as `checkAccess`.
It samples the log position, checks the small access streams and uses the existing
NATS conditional publish to require both that log position and the memory scope position.
A saved change after the check therefore refuses the append too. This does not read or
watch conversation history. The original two-second deadline still applies.
The route tests also revoke the write grant and disable the assistant immediately before
calling the real store append. Both require HTTP 403 and an unchanged memory stream.
A definite conflict returns HTTP 403 after checking for an earlier saved command.
A changed access stream also returns HTTP 403 and keeps the command recovery record.
Lost replies and failed access reads keep the existing unknown result and receipt recovery.

Row 2 still needs complete loaded-set checks before model/tool dispatch and turn grant
renewal, after #396 and p4-11-pr2c. Correction target proofs remain deferred; agents cannot
correct or forget. Storage with no loaded memory remains row 6. Native memory stays off.
Public feed responses remain unchanged.
Fresh-install qualification and real model/tool calls: NOT RUN.

## Renewal after budget stops (P3-14 PR 3; Part of #55)

`turnCommand` checks the saved turn and immutable payer before returning a renewal.
`turnBudgetStop` shares the models budget fold and compares the original queued message
position with applicable stops, including recovered limits. It reads the
budget history before the two-second membership check and only new rows afterwards.
Membership is checked before reporting a spending refusal, including after the final
budget read. Closed turns and conflicting thread requesters keep their access refusals.
A refusal closes the turn through the existing lifecycle command. No pass is returned.
Other payers remain usable. New personal-payer admission keeps its existing summary
and at most two new budget rows in its volume test.

The memory integration test checks the real shared sender and memory HTTP backend:
a stopped pass reaches neither the backend nor a new budget admission, and a
renewed pass cannot reopen the stopped turn. Native execution remains disabled.

## Provider switch-on (P4-22 PR 4e; Part of #104)

The provider route table exposes the [switch-on command](../../docs/api/providers.md#switching-on-managed-calls).
It uses the existing session, organisation, Origin and error handling. Changes GET
also finds the saved marker on the silo budget stream and checks provider management
permission and its creation receipt. Missing results remain unknown, never proof of failure.
The command tests also cover duplicate usage and settlement delivery, zero-cost
release, completion races and restart/replay (PR 4f). The saved marker does not let
a POST retry bypass an unresolved hold or send. A retry with late unknown settlement
returns 403; the status GET still returns the original historical receipt. This does
not undo switch-on. A hold reopened during the retry's history reads returns 409.
An accepted zero-cent resolution with non-dispatch evidence releases a reopened hold
once when no final amount conflicts. Tests check successful retry, redelivery,
server and actor restart, and projection replay. Conflicting usage keeps the full
hold and refuses retries through the same recovery steps. Sends without a reservation have no completion writer yet and
remain refused. The fixture records zero provider requests and custody reads during
replay. Models startup, dev-stack wiring, switch-off, retirement and UI are outside
this part. Fresh-install qualification and paid calls are NOT RUN.

## Dispatch catalogue capture (#48 PR 3b, first split)

`models-main.ts` runs `remoteCatalogueWatch` under the budget leader. It polls at most
32 discovered remote catalogue rows in this silo, ordered by server id. It waits at most
one second before polling again. Short catalogue TTLs bring the next poll forward.
Registrations without discovery wait for the installer. Missing and overflow rows refuse calls.
The whole membership read has a one-second deadline. Failed or timed-out reads hold calls,
and a late result cannot restore membership. Membership polls
continue while captures run; a stalled worker cannot extend saved catalogue expiry.

The same event history supplies the saved locator and credential-free connection.
The watch folds those rows once rather than reading them again during capture. `remoteRequest`
and `discoverInventory` check public DNS, pin addresses and verify hostname TLS. Production
injects no resolver or CA. The shared watch keeps its 30-second attempt, inventory bounds,
one capture per server and shortest discovery/page TTL, capped at 300000 ms.
Checks start after one quarter of short TTLs, with the existing 30-second margin for longer TTLs.
A timer starts the next poll even when the main models loop is busy. Zero TTL still refuses.
Unchanged, continuously fresh checks preserve policyRevision and waiting approvals.
The watch compares the latest discovery's `io.opencrane/expectedRevision` declaration too.
A withdrawn or changed declaration holds dispatch before the event append and saves the new
discovery through `mcp.tools_changed`, even when the tool hashes are identical.
Dispatch therefore cannot keep using a declaration the server has withdrawn.

Removing a row aborts capture. Unfinished captures and unresolved drift holds retain their
bounded slot. Restart, outages and leadership loss close calls; recovery invalidates old
approvals before recapture and cannot clear drift or invent an acknowledgement.
Zero-TTL per-use proof, discovery credentials, hosted lifecycle wiring and fresh Stage B
qualification remain outside this source part.

## Publication preparation (P3-4 PR 2a; Part of #45)

`POST /api/org/integrations/:serverId/publication` uses the review route’s session,
organisation, admin and Origin checks. Input is commandId, expectedSequence and reviewRevision.
Success returns status and the original saved sequence. Changed retry input conflicts.
The server computes fragmentDigest, saves one MCP event and writes no grants or approvals.
Only credential-free, current reviewed catalogues qualify. A drift hold does not prevent
preparing an exact reviewed replacement; it still prevents calls until the matching
live gateway receipt and a fresh watch capture. An outdated review cannot prepare a
replacement. No preparation worker is connected.

## Internal child requests (P4-8 PR 6 and PR 6b)

`chat/child-requests.ts` exports review, intent, creation and first-input commands. The parent
history loads with a ten-second deadline before the two-second access check. Each write
checks membership, current parent joins, assistant permission and owner/payer membership.
The source must be the requester's own human message in an open group. The default
upper bound is 1,000 cents. Request retries compare the frozen choices; another request
id for the same source returns the original intent. Stage ids hash silo, parent and source.
Creation copies the saved joins, including people later removed; inherited access still
checks the original joins. It never replaces them with new people. Parent closure blocks
creation at admission; closing immediately afterwards is not an atomic cross-stream check.
`addChildFirstInput` takes the same input as creation, with `keys` in its options.
It reads parent and child history with separate ten-second deadlines, then checks
current requester access within one two-second write check. It watches only member,
participation, assistant and team streams. The child must already exist and match the
saved intent, including `origin.firstInputId`. Its creation must have an OpenFGA receipt;
otherwise the command throws `ParticipationApplying` and appends nothing.

The command decrypts only the source and encrypts its exact text under the child's key.
It appends one `message.posted`, with the requester as human author and principal, the
original content type and no execution mode. The intent's first-input id is both event
and command id. The expected sequence is the creation's position. Saved retries compare
decrypted text and the other command fields, returning the original row and ciphertext.
A different saved record throws `ChatConflict`, including after NATS deduplication expires.
`test/child-first-input.test.ts` uses real NATS, PostgreSQL and OpenFGA to check these rules,
concurrent calls, neighbouring parent messages staying private and rebuilds saving no events.
The reviewed child start route now calls these functions. It starts no turn or spending.
Live qualification: NOT RUN.

## Hosted registration — first part of P3-6 PR 4

`POST /api/org/integrations` accepts a strict hosted body: kind `hosted`, locator,
platform (`linux/amd64` or `linux/arm64`), upstream `{ host, port }` and commandId.
The upstream uses egressDestinationSchema; omitted port means 443. Tags, including
tags alongside a digest, are refused. Only SHA-256 image locators are accepted.
Success is 202 with status appended, serverId and `chg_<commandId>` as changeRef.
Changed input or another admin reusing the command returns 409.
`GET /api/org/integrations/changes/:commandId` returns applied with the original
sequence and registeredAt, or unknown. Both routes require current admin access.
The GET checks access once without starting a two-second write deadline.
New credential-free installation requests remain checking; the worker saves no
rejection and performs no discovery or network request. Older hosted records and
built-in memory retain their existing rules.

Dated receipts and the admission GET are implemented below. Recheck commands and
evidence storage remain for part c. Image fetch, scans, deployment and evidence bytes are outside this part.
Fresh-install qualification: NOT RUN.

Own checks, 14 October 2026: PASS — 39 selected tests twice across
`hosted-registration.test.ts`, `startup-mcp.test.ts` and `memory-startup.test.ts`.
The event security suite also passed. Tests used disposable NATS, PostgreSQL,
OpenFGA and gateway fixtures. Catalogue replay used the apps/ops command.
The first memory run lacked the gateway binary; both complete runs passed after
the pinned fixture tool was installed. No full root suite or live journey ran.
After the final route and test-helper cleanup, all 14 hosted registration tests
passed twice again. Full workspace typechecking and the final server typecheck passed.
PASS — full lint (including Knip and changelog validation) and check:events.
Typed lint reported existing function-length warnings only.

## Queued admission after a spending stop

New turn admission passes the saved human message position and the payer selection
into the existing provider/budget summary. Personal work uses the default selected
before that message was saved. Admission checks once before starting the computer
append and again after it returns, reading only new budget events within the short
write check. Renewal keeps the message position, including a start saved after
a stop and a limit increase. Tests pause that append and verify the recording gateway
issues no send permission before the asynchronous handler runs. The check after
append confirms spending and membership. Provider switch-on retains its existing
gateway refusal for a legacy start that was already being saved.
A saved budget turn stop also closes that turn in the chat summary. Legacy member
stops retain their previous fold. Read and viewer authority checks are unchanged.
The bridge sends saved budget Stops before that chat's uploads or turn frames.
It excludes every budget-stopped message from turn delivery, including after a
limit increase or reconnect. It keeps the first saved stopId and sends only type,
turnId, conversationId, reason and stopId. Member Stop frames keep their old shape.

Per-socket timestamps space budget Stop retries at least one second apart. A new
socket sends Stop on its first conversation pass after the resume handshake.
A saved terminal report or computer turn close ends retries. The bridge never
appends a Stop. Pending Stops use the existing polling retry path and the same
chat history read as an unaccepted turn; they add no budget read or access check.
After connection opening and each delivery preparation wait, the bridge checks the
conversation position and reads only new rows. It sends newly saved Stops before
releasing files or turns, and drops a selected turn if a new Stop ended it.
Immediately before a turn frame, it reads new rows directly from the last saved
position even if the earlier position reply reported no change. This catches a
Stop saved while that reply was waiting. The socket regression pauses the final
position reply on reconnect, saves a Stop, and requires Stop without a turn frame
in that same pass.
These reads have their own ten-second deadline and do not use an authority fence.

Approval polling remains independent of conversation processing. After checking the
saved approval belongs to this assistant and turn, it reads the conversation again
before sending a settlement. It sends that turn's saved budget Stop first. Both
paths share the socket's Stop timestamps, so a concurrent poll does not duplicate
the frame or shorten its retry interval. A failed Stop read keeps the approval
waiting for the existing retry. The real watcher tests cover computer-history and
approval-history delays of zero and 300 ms in all four combinations.

P3-14 PR 4b tests use real NATS, PostgreSQL and OpenFGA, plus the real computer
channel for different saved payers on one team computer.

P3-14 PR 4c keeps one conversation delivery pass running while the main watcher
continues polling every 250 ms. During an unfinished pass it reads saved Stops
separately, using the same per-socket retry timestamps. Each chat has at most one
unfinished Stop check. Polling starts checks without waiting for other chats, and a
failed check retries on a later poll. Approval checks continue too.
An ordinary delivery pass skips a chat while its Stop check is unfinished and
retries it on a later poll. Other chats continue even after a file receipt arrives.
It reuses the chat list until events or projection catch-up change it, and leaves
unchanged finished chats unread.
The existing transfer queue still sends one file at a time and records its receipt
before delivering that chat's turn. Shutdown closes sockets before awaiting the pass
and every unfinished Stop check.
The signed bridge gate still precedes resume on every connection.

`test/bridge-budget-watcher.test.ts` uses real NATS, PostgreSQL and OpenFGA with a
personal assistant and a scripted socket. It holds file receipts and checks Stop
arrival within two seconds in another chat, in the same chat and after reconnect.
Four more global polls must leave the file sent once and turns waiting for the receipt.
Holding that chat's next history read still lets another chat's Stop arrive within two
seconds and lets approval polling reply. A failed chat read alongside another held
read must leave just one unfinished read after repeated polls. Shutdown waits until
that read finishes and closes the socket without a test-supplied receipt.
Releasing a file receipt during another chat's held Stop read leaves exactly one
active read. A third chat can receive a new turn before that read is released,
and the saved Stop arrives after release.
It also checks recovery of Stop-only work after computer or assistant history fails,
without saving a new event. Temporarily narrowing each guard to waiting messages makes
its test fail. Fresh-install qualification is NOT RUN. Computer grant removal,
status APIs, screens and member Stop changes remain outside this part.

## Reviewed child participant commands (#91, first part)

The [child invitation contract](../../docs/api/group-chats.md#child-only-invitations)
defines acknowledgement, saved retries and removals. The command reuses group
participant handling and the existing explicit-child event, projection and IAM shapes.
Its final write check includes `inheritedChildSubjects` alongside caller, target
and child participation streams. `test/child-participants.test.ts` uses real NATS,
PostgreSQL and OpenFGA to check invitations, refusals, replay, saved retries and
socket removal. The fixture follows `childSession` in the access regression tests.
The tests declare the existing OpenFGA SDK 0.9.7, licensed Apache-2.0, as a development dependency.
Origin, summaries, child creation and fresh-install qualification remain NOT RUN.

Saved child self-removal retries are checked before conversation participation. Only the
active silo member who saved the removal can recover it. Matching input returns the
original sequence; changed child review positions return 409. Recovery appends nothing
and grants no conversation access. HTTP tests also check refusal of another caller,
messages, participants, files, approvals and a new socket subscription after recovery.
The guard tests cover direct/private routes, a non-creator with OpenFGA management
permission, absent removal targets, and changed saved subjects and principals.

## Memory forget HTTP

`POST /api/memory/:scopeId/facts/:memoryId/forget` accepts only `commandId` and
`expectedRevision`. An active person can forget their own person-scope fact. Group
forget requires current event-backed membership, OpenFGA team membership and applied
`memory_read` and `memory_write` grants. Assistant notes require the current personal
owner or owner-group membership, an active assistant, `actsFor` and both notes grants.
Read-only and write-only callers cannot forget or recover an original forget receipt.
Shared chat sources remain refused, as for shared remember commands. A member statement
does not restrict a group fact to its original author. Agent shared writes remain disabled.
The server checks saved metadata, including historical dependencies, without opening keys.
It reads scope history before the two-second `authorityFence`. That check watches only
member, assistant, relevant team and grant streams, and runs again before append.
Reads check current rights once, with no write deadline or conversation watch.
The command uses remember's command reference and lock, then makes one conditional append.
Its durable attempt record prevents a second append after a lost reply, including after restart.
Unknown attempts stay unknown; startup must never use them to recover or destroy a key.

An accepted receipt contains operation, outcome, changeId, memoryId, revision, scopeId,
audience, acceptedAt, hidden and cleanupStatus. The changes GET reads tombstones and matching
cleanup events directly, without custody or projection catch-up. Completion is final and adds
forgottenAt; unavailable cleanup keeps hidden true. No receipt includes fact text or key references.
The HTTP tests run accepted shared forget requests through the queued cleanup worker.
They check revision and candidate key destruction, forgotten status, exhausted cleanup,
and facts staying hidden during projection rebuild.
Scopes and detail advertise canForget from these current rights. Forgotten detail
returns HTTP 200 with status unavailable and reason forgotten. The memory MCP has no forget.
Fresh-install qualification remains NOT RUN; no screens, model calls or dev stack are included.

## Hosted image admission receipts

`GET /api/org/integrations/:serverId/admission` requires a current admin and uses
readActiveMember, with no two-second write deadline. It returns the models fold,
including queuedAt and per-check reasonCodes. Unknown or foreign-silo servers return
404. POST has no route. No HTTP route writes check results. All-pass admission still
starts no discovery and leaves the hosted dispatch refusal in place.
Rechecks and evidence storage belong to part c. Fresh-install qualification: NOT RUN.

## Saved chat budget stops (P3-14 PR 7a; Part of #55)

`GET /api/conversations/:conversationId/budget-stops?turnId=…` reads saved history
within ten seconds, then calls `requireMember` once with `write: false`.
The turn must be a visible human message. Roles grant no extra chat access.
The strict protocol reply gives matching scope, period, cause, reset and remedy;
only the message author receives `limitCents`. Work includes this chat's visible
recorded turns only. A terminal report, computer close or loss proves execution ended.
`positions.stop` is the budget stop position; `turn` is its chat stop record position
or null. The other positions are the last conversation, computer and budget rows read.
Loading failures still pass through that read-access check before any reply.
Callers without access receive the same 403 refusal as for an unknown turn.
Authorised readers receive 503 for missing stop details, unfinished handler work,
and failed or timed-out reads.
Tests use real dependencies and a fresh store connection. No read appends or sends work.
The reply includes `calls` in saved event order for this conversation and turn only.
Reservations use their id as `reference`; unreserved dispatches use their call id.
A dispatch joined to a reservation appears once. An unknown settlement means
`possibly_sent`; confirmed non-dispatch means `released`; other settlements mean
`charged`. Without settlement, admission means `possibly_sent`, even after expiry.
Expiry without dispatch means `released`; otherwise the reservation is `held`.
A zero-cent charge remains `charged`.
Only the requester receives `heldCents` for held or possibly sent calls, or
`chargedCents` for charged calls. Participants receive references and statuses.
Tests compare all four statuses after server restart and on a second store connection,
with unchanged stream positions, computer lifecycle and recording upstream counts.
Row 7 is implemented; row 8 consumes these statuses. Live qualification is NOT RUN.
Root stops remain with #90.

## Reviewed child answers

Final and interim text publication follow the [HTTP contract](../../docs/api/group-chats.md#reviewed-child-publication).
`test/child-publication.test.ts` covers real NATS, PostgreSQL and OpenFGA,
retries, access refusals, closure, HTTP/socket display and projection replay.
Turn lifecycle events share the conversation stream; there is no separate result stream.
Publication samples the global log position before reading new child and parent events.
The parent append requires both that global position and the loaded parent position.
NATS checks these together when it saves the entry. Loss or terminal failure for the
selected turn therefore returns 409 `review_stale`, including after the last read or
immediately before append, with the parent stream unchanged.

A definite conflict restarts the incremental reads and validates the selected result
and current access again. Harmless child messages and another turn's loss or failure
still allow publication. Retries share a ten-second limit; sustained log traffic can
return 503 `unavailable`. An uncertain append is never retried by this loop. This uses
the existing atomic log check without moving old turn events or adding a second write.
A separate per-turn stream would reduce contention if publication traffic needs it.

All history reads precede each two-second access check. Only member and participation
streams enter `authorityFence`; neither conversation does. The tests save loss and
failure after complete history, after the incremental read and immediately before
append. The event-store test also saves a change inside the NATS publish call.
Saved publication retries keep their existing receipt and current-access checks.
Interim reviews accept a visible saved reply from an open shared-only turn, or human
text without a result reference. A completed turn cannot be labelled interim. Signed
reviews bind kind and optional result id, position and turn alongside the existing
text digest, publisher, child, parent, audience position and expiry. Human updates carry
no result fields. Partial result references are refused by the event schema.
Tests cover both kinds through all three result-change windows, human updates without
agent output, lost replies, changed-id conflicts, late access loss and signature purpose.
Files and screens remain deferred. Fresh-install qualification is NOT RUN.

## Gateway configuration worker

The budget leader starts one configuration worker with the gateway child. It reads
only `gateway-config-<silo>`, delivers the latest current request and probes it on
later ticks without rewriting it. The worker receives the root PostgreSQL `Db`
for the shared per-silo preparation and replacement lock; it must not use the
connection already holding the budget leadership lock. Restart creates a new process reference and
requires another delivery and probe. Dispatch receives an empty operator route list; the catalogue watch reads remote rows; `MODEL_MCP_ROUTES` is ignored. No call is enabled by this worker.
The worker's synchronous `acknowledged()` read is passed into dispatch options.
It is empty before live confirmation and after the child exits or the worker closes.
Authorisation and dispatch compare its generation and exact gateway stream position.
Published remote calls use their saved destination through the guarded HTTPS transport.

## Signed bridge gate delivery (P3-17 PR 2d; Part of #58)

`bridge-control.ts` sends one signed `bridge_gate` per connection after saved
`takeover.requested` intent. `readComputerControl` must return a verified phase, never
`unverified`. The ready computer, generation and Pod UID must match. The sender
checks the requester's membership again with `requireTurnMember`. Missing signing
support, changed identity, removed membership or more than 64 affected turns sends
no gate and logs only `Bridge gate unavailable`. The normal `resume` frame still follows.
A separate watcher checks known assistants every 250 ms and retries lost
connections. It reuses the conversation list from the main poll and shares computer
reads with that poll. Each assistant has one check in progress. This watcher does
not wait for conversation reads or uploads. It does not reconnect refused computers or wake
suspended computers for saved control intent.

During connection setup, `bridge-resume.ts` checks each link for a gate every 250 ms
while the server reads saved reports. The timer and direct checks share one signing
attempt. A computer stream change during signing causes a fresh request, identity
and membership check
before another signing attempt. Connection setup waits for this retry before sending
`resume`, and checks again after report replay in case intent arrived during replay.
Finishing setup or closing the socket stops that link's timer. The independent
watcher continues to check for saved intent afterwards.

Every new connection sends a qualifying gate before `resume`. Receipt parsing runs before
report parsing. The computer sends `bridge_gated` before report resume on the socket
that received the gate, and repeats acceptance after reconnect. Root stop can start
while report replay waits and active work has acknowledged interruption without ending.
Only strict `bridge_gated`, `bridge_quiet` and `bridge_unavailable` replies matching
that connection's takeover id, generation and sorted affected turns are accepted.
The first accepted epoch cannot change. Quiet requires empty preparation, running,
loaded-thread and held-approval lists, interrupted turns within the affected list,
and both executor and browser proofs exactly `unavailable`. A bad reply clears the
in-memory receipt and closes with 1008 and `Invalid bridge receipt`. A computer's
1008 close before any receipt prevents reconnecting. No signed gate enters logs,
events or API replies. After bridge acceptance, root Pod exec calls the fixed local
supervisor socket. The server caps output at 16 KiB, ignores stderr and stops the
transport after fifteen seconds. Strict receipt checks require the exact Pod,
generation, takeover and affected turns, an epoch, an empty execution inventory,
executor exit, desktop inventory, a complete or unavailable quiet proof and disabled control.

One conditional append saves `takeover.pausing` at the position read before `/stop`.
A computer-stream change refuses that append. The next check reads current facts
again. The command id is derived from the takeover and transition; saved history
prevents a duplicate after a lost reply or restart. The gate remains closed when
stop or append fails. Reconnection delivers the gate for pausing too. Replay only
rebuilds the phase and makes no outside call. No conversation history enters a
short access check. Receipts and affected turns remain internal.

Tests use real NATS, signing keys, sockets and the real computer bridge with a saved
signing identity. PostgreSQL supplies the watcher's conversation list. Tests hold chat
reads for 2,300 ms and require a verified gate within two seconds, for both idle and
connected computers. They hold report replay, close a turn during signing and hold
signing across replay completion. Each requires the gate before resume. Scripted
replies cover forged receipts. Fresh-install qualification
is NOT RUN. PR 2g adds strict paused/failure records and commands. Paused requires
saved pausing, a current connection's empty bridge proof and a fresh complete root
receipt with the saved supervisor epoch. Invalid or missing proof saves no pause.
Both outcomes use the pausing command's deterministic id and read-back pattern;
both block work. Failed is allowed only from requested or pausing, with reason
`pause_timeout`. `bridge-deadline.ts` runs independently of connection, stop and
proof waits, including when there is no ready computer. It uses the saved request
time plus thirty seconds, capped by thirty seconds from the server's first
monotonic observation. Polls and reconnects share that observation. Clock changes
can shorten an observed limit but cannot extend it. A fresh store or server loses
that monotonic observation. It reads the original saved time and fails immediately
if the wall clock says the request has expired. If that clock moved backwards before
the new server's first observation, it can allow up to thirty more seconds. This is
a first-observation cap, not a guarantee across restarts with clock rollback. The worker reuses saved control facts
until the computer stream changes, but checks the deadline on every poll. Shutdown
stops the deadline checks. Only requested or pausing control starts a deadline task.
Each assistant has at most one such task. Removing a chat from discovery keeps its
active task until the request ends. Completion removes the task and its saved clock
observation. Assistants without pending control use only ordinary snapshot polling.

The proof path checks the same limit before root stop and after its reply. Pausing
and paused appends carry that limit into the event store's publish attempts and
retry waits. A queued append released at expiry cannot publish, even if the failure
append has not run yet. Conditional writes prevent a delayed proof from replacing
a saved failure. The store cannot withdraw a publish already sent to NATS. An append outage
keeps work denied and retries only the original deterministic failure transition.
Read-back and current saved status prevent duplicate failures after lost replies.
A deadline task logs `Takeover deadline check unavailable; work remains blocked`
once if reading or saving fails. It includes no request, receipt or upstream error
contents. Further attempts in that task do not repeat the warning.
Tests hold connections and proofs, move both clocks, race conditional writes, and
restart after an append outage or lost reply beyond the NATS duplicate window.
They also check unchanged terminal records and work/renewal refusal.
Approval cancellation, zero release of unadmitted reservations and row 1c refusal
auditing remain the next part. Native execution and writer requests stay off.
Writer access, leases and full recovery remain later work. The access
checks are unchanged. `bridge-gate.test.ts` also covers refusal and lost append replies;
`supervisor-stop.test.ts` checks real executor children and restart denial.

## Reviewed child starts (P4-8 PR 7a, first part)

The [child request API](../../docs/api/group-chats.md#reviewed-child-requests) signs
reviewed choices and completes intent, creation and first input through separate commands.
Retried POSTs and the background worker recover missing creation and first input.
Saved failure events remain unbuilt. The bridge point-reads the parent intent before delivery or admission.
A saved intent holds all child work; an unavailable read also releases no work.
`test/child-summon.test.ts` checks real NATS/PostgreSQL/OpenFGA recovery, expiry,
refused reviews, private status, replay and the delivery/admission hold. Live qualification: NOT RUN.

## Publication status reads (Part of #45)

GET `/api/org/integrations/:serverId/publication` reads the catalogue projection.
GET `/api/org/integrations/changes/:commandId` first preserves the existing typed
hosted-registration recovery. Otherwise it resolves the original publication or
withdrawal event and reads that server's current publication. A replacement returns
its current changeRef; it does not acknowledge the superseded command.
Both routes check current admin membership with `readActiveMember` and send `no-store`.
Reads perform no append, probe, delivery or retry. Missing projection access returns
Unknown. Rebuild the MCP catalogue before serving these reads on an existing installation.

## Models startup after recorded switch-on

After budget replay, `models-main.ts` reads `managedProviderCallsEnabled` within ten
seconds. An unreadable mode stops startup. Managed startup requires
`PROVIDER_SECRETS_DIR` and refuses any configured `MODEL_KEY_FILE`. It reads no
provider key until a checked call. Gateway configuration reloads keep managed mode.
A legacy process checks switch-on each loop and exits non-zero when it appears;
its decision service already refuses legacy admission after that event.
`test/models-managed.test.ts` covers the spawned process with real dependencies.
Its unreadable-mode test uses the operating system’s `mkfifo` utility to pause
startup at signing-file loading, after budget replay. It uses no timed sleep.
Dev stacks still set `MODEL_KEY_FILE`, so switch-on stops their models process
until custody wiring is supplied. Fresh-install qualification: NOT RUN.

## Original budget change receipts (P4-26 PR 1; Part of #108)

`GET /api/org/models/changes/:commandId` reads the existing silo budget stream.
It returns `status: appended` with `receipt` containing the original command/event
ids, sequence, time, complete ceiling payload and recorded stop status. Full receipts
require current Owner/Admin access. An active original caller who lost that role gets
only `{status: appended, commandId}`. Other members, removed callers and foreign
sessions are refused. History loads before the final read access check, without a
write fence. All replies use no-store. Missing or unavailable history stays unknown.
The route appends nothing and makes no model or provider call.

The stop status is `stopping` with `stopId`, or `not_recorded`. It never reports
termination completion. Existing stop policy remains unchanged; current main does
not record reductions above spent-plus-held money as stops.

`test/integrations.test.ts` covers lost HTTP replies, later edits/reservations,
concurrent edits, replay, restricted receipts, slow history, role loss, unrelated
chat activity and unavailable or lagging history. Fresh-install qualification: NOT RUN.

## Child recovery before activation (P4-8 PR 7b)

`chat/child-recovery.ts` starts with the configured chat service and stops before its
connections close. The conversations worker builds `childRequests`; the server reads it
with a read-only PostgreSQL account. It scans at most 32 candidates per pass
in saved order, with a one-second pause (backing off to 30 seconds on uncertain outcomes). The next pass continues after the last position;
a shorter page restarts the scan. Proven refusals save one deterministic failure and
stop recovery. Unknown outcomes and applying access remain queued with backoff.
It rereads the exact parent event and derives all command values from it. Existing
commands verify the child, copied text, original joins and current access. Conversation
history stays outside the short access check. Errors use fixed log messages without
source text. The bridge hold remains unchanged.

The durable handler host is in apps/ops; the checked commands and conversation keys are
in apps/server. Durable job integration,
public retry, activation, root allocation
and dispatch remain later work. No second event dispatcher or execution path is added.
`test/child-recovery.test.ts` covers crashes, competing workers, changed index records,
replay and access refusals with disposable NATS, PostgreSQL and OpenFGA.
`test/child-summon.test.ts` checks the bridge hold after background recovery.
Fresh-install qualification: NOT RUN.

## Shared memory reference fold

Chat summaries and recall delivery import `foldMemoryContext` from `@opencrane/models`.
The models decision service uses that same fold before model, tool and recall dispatch.
The [dispatch contract](../../libs/models/README.robot.md#loaded-memory-before-dispatch-p4-15-pr-2d-part-of-97)
describes incremental scope checks and event-only revision validation.
`chat/turn-credentials.ts` calls the same check before signing and before releasing a
turn pass, including repeated `agent.turn_started` reports. It loads chat, computer
and scope history before starting one two-second authority check. Later confirmations
read only new rows and reject memory additions or ended context during signing.
Only access streams enter the authority fence. It always watches the requester and
assistant, including on turns without memory. Missing IAM configuration refuses
loaded references; turns without references still read no scope stream.
A memory refusal returns only `memory_context_unavailable`, with no token or context.
It appends no memory evidence and does not close the computer turn or stop its process.

`test/memory-dispatch.test.ts` covers renewal after correction, forgetting, requester
and assistant read/MCP revocation, changes during signing, expiry at release, valid
renewal, no-reference renewal, access removal during the final activity check and
cold replay with a forgotten dependency. Barriers also revoke assistant memory-read
access and requester MCP access during the last scope-position read of a repeated
turn-start report, even when that position stays unchanged. Both return only the fixed refusal, with no token or context.
Further tests cover terminal evidence during signing, the original deadline across
signing and errors during memory preparation. Accounting tests cover duplicate
references, equal ids in different scopes, scope positions and limits, initial input
arriving twice or after recall, reused dispatches, late loads and reference limits.
Changing a returned value must also leave the saved accounting unchanged.
Remaining row 2 work: correction target proofs and agent correct/forget contracts.
Output invalidation and process interruption belong to row 3. Native memory admission
remains disabled. Fresh-install qualification: NOT RUN.

## Saved budget stop socket notifications (P3-14 PR 7b, first part; Part of #55)

After projecting a saved budget `agent.turn_stop_requested`, `/ws` sends the
ordinary event and a typed `budget_stop` notification at the same position.
It checks the original human message's visibility before sending either frame.
The notification contains only the conversation and original turn references,
position and projection generation. GET remains the authoritative stop reader.
The existing access poll checks membership during slow row loading and again
before delivery. Each page's content reads share a ten-second limit, including
the initial position read and the original human message lookup. Expiry closes
the socket with code 1013 so the client can recover through GET. Late query
results send no frames. These reads finish before the final access check starts.
No bridge delivery, authority helper or business event changes here.

`test/budget-stop-socket.test.ts` uses real NATS, PostgreSQL, OpenFGA, sockets and
a recording gateway upstream. It checks requester/participant delivery, hidden
history, removal during loading, slow reads, unrelated activity, reconnect,
duplicate handler delivery, projection rebuild and unavailable data. It also holds
the original-turn lookup past ten seconds and checks that no late frames arrive.
Further tests check non-human authors, missing turn ids, unnecessary lookups
and invalid outbound frames. GET and replay leave the event log unchanged and
send no upstream requests.
The protocol contract is in [the shared library](../../libs/protocol/README.robot.md#saved-budget-stop-notifications).
Call-status references are included in the saved GET reply described above.
Fresh-install qualification is NOT RUN. These socket tests do not prove browser
behaviour; they prove that a held server read sends no late frame.

## Saved approval dates and cancellation reasons

The [approval API](../../docs/api/approvals.md) defines the optional UTC fields,
first-use retention and dated permit list. Dates come from approval event envelopes,
not read tables or the read clock. `approval.cancelled` has its own strict schema
with an optional `cancelReason`; old events still parse without one. Expiry uses
`approval.expired` and has no cancellation reason. Reads preserve unknown outcomes.

`apps/server/test/approvals.test.ts` checks restart, audit rebuild, delayed reads,
recorded causes, old cancellations, retry history and identical hidden-id refusals.
The reader recognises direct requester/assistant tool-grant revocations only.
Other access refusals do not invent cancellation evidence. A missing turn and
clock-only catalogue expiry still cancel without a reason. UI, native consent,
retry delivery and fresh-install qualification remain outside this change.

## Hosted image check requests (P3-6 PR 4c; Part of #47)

`POST /api/org/integrations/:serverId/checks` requires same-origin session access,
current Owner/Admin membership and applied OpenFGA admin permission. The strict input
contains commandId, expectedSequence, registrationRevision, attemptId, imageDigest
and platform. registrationRevision is the original registration event position;
expectedSequence is the latest position in that server stream. Registration queues
attempt 1. The first explicit request therefore names attempt 2 after a failed or
expired result. Later requests advance by exactly one. Pending, unavailable and
unknown evidence cannot be bypassed, including a failure mixed with an unavailable check.

A successful reply is HTTP 202 with status appended, serverId, changeRef, attemptId
and sequence. It confirms only a saved request. Repeating the same command and payload
with current access returns that original receipt, including after a lost reply or
later result. Changed payloads or actors conflict (409). Unknown, remote and foreign
servers return 404. Invalid inputs return 400; lost acknowledgements return 503 and
can be recovered by repeating the exact request. History has its own ten-second
read deadline before the short access check. Conditional append rejects a replaced
registration or moved sequence; membership changes are checked again before append.

Storage, short-lived leases and authorised hash-checked evidence GET remain for 4d.
No fetch, scan, image execution, discovery or dispatch is enabled. Fresh-install
qualification: NOT RUN.

## Personal memory correction HTTP

`POST /api/memory/:scopeId/facts/:memoryId/correct` takes `commandId`, `expectedRevision`,
`text`, `kind`, `pinned` and `expiresAt`. All fields are required. Only the active person's
own person-scope facts can be corrected. Saved sources and dependencies stay unchanged.
Group and notes correction, screens and MCP correction remain unavailable.
Scopes expose `canCorrect`; detail checks the current revision, expiry, saved dependencies
and their keys through `memoryReferences.current`, as POST does. These content reads have
their own ten-second deadline and run outside the write authority check. Each accepted correction
records one `memory.corrected` event and requests the existing old-key and dependent cleanup.
The changes GET returns the accepted revision, audience and time, current `contentStatus`,
plus `cleanupStatus`: pending, unavailable or completed. Completion adds `completedAt`.
Receipts have no text, ciphertext or key reference. Every HTTP reply uses no-store.
Full history loads before the two-second authority check. The command lock and a short
fact lock protect revision preparation. Text-free command and fact reservations survive
restart. An uncertain reservation blocks a new candidate until history disproves its append;
recovery never resends. A refused candidate key stays reusable by a new checked command.
Failed command records prevent the original command from being sent again.
Recovery and a later checked correction remove an unpublished temporary key only for
that revision, under the fact lock. They leave published keys and destruction markers alone.
Recovery scans fact reservations even if their command record is gone. Saved commands
and proven failures release the reservation; uncertain appends keep it. An accepted or
recovered forget removes its fact reservation under the same fact lock.
The interrupted-provisioning tests use a filesystem stub for every key of the tested fact.
They cover recovery and a later command, and require the corrected fact to remain readable.
`test/memory.test.ts` covers HTTP, competing changes, restart and candidate custody with real
NATS, PostgreSQL and OpenFGA. Existing ops tests cover cleanup and replay.
Fresh-install qualification: NOT RUN.

## Spending choice validation

The existing POST `/api/org/models` sends its signed command to `configureBudget`.
New commands now validate saved groups, shared assistants and the chosen default
payer before checking current caller access. The budget integration tests use the
production startup payer, `installation-default`, without creating a team for it.
Other valid group and shared-assistant cases seed their actual records.
Personal-assistant caps are refused. Exact saved retries retain their original receipts.

Spending choice refusals pass from the models process through POST `/api/org/models`
as HTTP 422 with `{"status":"refused","reason":"spending_choice_unavailable"}`.
No budget event is appended. Lost Owner/Admin access still returns 403.
The Chromium integration check sends an unknown default payer, checks the fixed
refusal and retained ceiling, corrects the payer and saves the same typed ceiling.

### Named spending choices

`GET /api/org/models/scope-choices?kind=paying_group|assistant&after=…&limit=…`
uses the existing integration options. It reads 20 candidates by default, at most 50,
plus one candidate to decide whether another page exists. `next` is the last examined
opaque id; pass it as `after`. Filtering can leave a short or empty page with a continuation.
No total is returned. Only existing groups and active, non-retired shared assistants appear.
The installation payer is not invented as a group. Personal choices remain unavailable.

Each row has `id`, `displayName`, the resource stream's `sequence`, and `cap`.
A cap is `set` with safe integer `ceilingCents`, `not_configured`, or `unavailable`.
Zero remains a set cap. Budget failures or stale budget state yield unavailable caps.
Missing or lagging directory checkpoints return `status: applying`, never a complete empty list.
The route uses the same resource eligibility reader as spending saves. It reads compact
summaries of the group, assistant and computer streams within a ten-second deadline.
Cold reads catch up incrementally; later reads start after the last saved position.
Each summary kind retains at most 64 streams and 2 MiB. A partial cold read keeps its
progress for a later request. Ordinary turn and membership history has no event-count cap.
No wildcard stream is scanned. Each PostgreSQL read gets a statement timeout for the
remaining request time; waiting for a pooled connection also observes that deadline.
After loading, it checks event-log Owner/Admin membership and OpenFGA once.
Reads have no authority fence, append no events, use fixed refusals and always send `no-store`.

`test/budget-choices.test.ts` covers real NATS/PostgreSQL/OpenFGA paging, resource revisions,
caps, lag, access refusal, IAM outage and changes during a blocked load. It also checks
an assistant with 1,001 computer events, stored colon ids, 201-character group names,
continuation, and locked candidate, checkpoint and budget tables. A timed-out read still
checks caller access. Save-command id validation stays unchanged; older stored ids can
be displayed and paged even when the command API cannot accept them.
Screens, accounting indexes and fresh-install qualification remain outside this change.

## Shared remote transport

`integrations/remote.ts` keeps its discovery/list-only `remoteRequest` signature.
It uses `libs/models/src/remote-https.ts` for DNS checks and pinned TLS, with its existing
4 MiB discovery reply bound. Published tool calls use the same exchange with the
[models contract](../../libs/models/README.robot.md#published-remote-https-calls-part-of-45).

## Saved child start refusals (P4-8 PR 7c, part of #90)

A saved failure stops recovery and repeated starts until a retry is accepted. It is checked before
any new child write. Failed status is requester-only and absent from feeds and history.
Participation reads establish the join receipt before interpreting a permission denial.
If access was not yet applied at that point, recovery retries without saving a failure.
Member and parent removal checks still run after permission replies. The barrier test in
`test/child-recovery.test.ts` pauses a denied permission reply while child creation is
applied, then checks that recovery saves the first input once and no failure.
Unchanged joins need only one receipt read. That file
also checks unavailable append/key reads, hidden failed status, the exact indexed attempt
and deletion of completed rows.
The [retry API](../../docs/api/group-chats.md#reviewed-child-requests) permits three attempts.
`test/child-retry.test.ts` checks saved receipts, concurrent retry ids, lost replies beyond
deduplication expiry, current access, later failures, missing input and index rebuild.
Failure recording checks the worker's original attempt before saving, so an old worker
cannot fail a later retry. The conversations worker rebuilds `child-requests-v3`.
Closure found in the parent history is reported only after current requester access
and source visibility pass. A removed requester receives the same status and body
for a closed parent as for an unknown request. Authorised callers still get 409.
The retry tests delay each complete parent history read by more than two seconds,
then require a successful write. Each history has its own ten-second limit; neither
uses the two-second authority deadline.
`test/child-failure.test.ts` checks saved failure and retry identities and validates
the saved schemas again. The projection, event and protocol packages test their own
retry validation. Tests also cover receipt recovery after a later failure and reject
changed source, audience and spending fields in retry input.
Activation, root allocation and bridge release are not built. Fresh-install qualification: NOT RUN.

## Models relay startup (Part of #61)

Inside the budget leader lock, `models-main.ts` calls `startEgress` once and passes its
registry to `startDecision`. The library owns the private evidence directory, retained
receipt checks and bounded shutdown. The process still supplies no `egressDecisionUrl`:
normal startup leaves gateway CONNECT and command-worker networking off. No setting
is added. The [models contract](../../libs/models/README.robot.md#relay-startup-and-revocation-checks-part-of-61)
records the closure checks and the remaining outage-watchdog and crash-recovery work.

## Streamed reply batches

The bridge combines only adjacent queued `agent.message_delta` reports with identical
turn, chat, assistant, requester, thread, message and execution details. It keeps the
64-report, 1 MiB and 64-chat queue limits, and limits combined text to 128,000 characters.
There is no timer waiting for a batch. Starts, completions, tools and legacy reports
stay separate. One conditional append saves encrypted combined text and each original
sequence and digest. Only then does the bridge acknowledge every included report.
Replay checks original digests even when it arrives in different groups. After an
append, the server checks every original against saved receipts before acknowledging
it. A concurrent writer can save the same final report with different earlier text;
that mismatch is refused. Receipts saved across separate events remain valid.
A definite
append conflict reloads history within ten seconds; uncertain writes are not resubmitted.
Stop waits only for report appends already running, then holds new report appends
until its history and access checks and single conditional append finish. This
priority is local to the server process; conditional appends still decide conflicts.
The separate Stop poll sends manual requests as well as spending Stops, without
waiting for ordinary turn or file delivery.
Access, turn admission, reservations and memory checks keep their existing paths.
`bridge-throughput.test.ts` drives 2,700 reports through a real socket and NATS,
checks a competing Stop append, replay identity and recovered text.

## Published tool access qualification

`test/integration-access-gateway.test.ts` uses disposable NATS, PostgreSQL and
OpenFGA, pinned agentgateway 1.5.0 and a recording local HTTPS server. It reviews
and publishes the saved catalogue, then waits for the configuration worker's
live acknowledgement. Grant and group commands use the product HTTP routes.
Their original content and IAM receipts must be current before the control call.

The matrix checks person-only, assistant-only and team-only refusal, then exactly
one unchanged call with both grant sides. A team supplies the person's side only.
It pauses IAM application after person, assistant or team grant revocation and
after team membership removal. Both fresh calls and calls held after their saved
start must refuse within two seconds without another upstream connection or byte.
Leaving and rejoining a team cannot restore its revoked grant. A separately given
direct grant survives applied team membership removal. A revoked grant given again
stays refused while its original IAM receipt is Applying. It permits exactly one
call through the generated gateway route once both original receipts are current.

The tests distinguish the saved admission decision, dispatch start and checked
remote reply. They also check an unchanged catalogue refresh, unrelated chat
output, stale catalogue refusal and an IAM outage after a saved start. Every
Allow-mode refusal fixture first sends a successful control through the same published
route. The Ask-mode case approves a call, pauses IAM after its saved start and checks
that the refusal opens no connection and sends no bytes. After IAM recovers, the
requester can enable one retry. A second retry command conflicts, two competing
calls send exactly once, a later call refuses, and no money reservation is saved.
No model calls or dev stack are used. Fresh-install qualification remains NOT RUN.

Initial branch checks, 22 October 2026: PASS — the 11-case matrix twice; the combined
470-test run with integration-access, remote-catalogue-dispatch and the unchanged
event security suite; typecheck; event catalogue; Knip; changelog check. All ran
under `nice -n 10` with disposable services and a supplied `PG_TEST_URL`.
The test-first baseline passed ten matrix cases and failed the final-send IAM
outage case with 200 instead of 403. FAIL — the extra selected MCP dispatch run
passed 33 cases but `lost_start` exceeded its existing ten-second cleanup limit.
That failure was not rerun or treated as an approved flake. No assertion or timeout
in that existing suite was changed. The disposable database was removed with its volume.

### Approval recovery and restored grants: own checks

22 October 2026, source `dac6cfce5`, following failing-test commit `811248b0e`.
These were local test fixtures, not a fresh installation. They used the supplied
`PG_TEST_URL`, disposable NATS and OpenFGA, the pinned gateway and local HTTPS.
Every test command used `nice -n 10` and one worker.

- Expected FAIL: the first regression reproduced missing non-dispatch evidence and
  `canRetry: false` after IAM recovered. The event schema rejected the new evidence.
- PASS: the complete 13-case gateway matrix and both event-schema cases in two
  isolated runs. The second run also passed all 438 unchanged event security tests:
  15 tests in the first run and 453 in the second.
- PASS: the changed MCP refusal case in the broad run and again in the isolated
  six-case run. The latter also passed both lost-start cases and all three stopped-turn
  recovery cases, with no changed assertion or timeout.
- FAIL: the broad MCP run passed 172 of 173 tests. The unchanged stopped-turn recovery
  case for a refused MCP pass exceeded 30 seconds. It passed in 6.8 seconds in the
  later isolated run; the earlier full-file result remains FAIL.
- FAIL, then fixed: the first matrix run exposed a receipt helper that accepted
  Vitest's polling argument as its expected state. Binding the expected boolean
  before polling fixed that helper. An overlapping typecheck found the same mistake.
- FAIL: the next concurrent matrix run had two successful-control calls return 403
  and an IAM refusal take 2.43 seconds against the two-second assertion. Lint was
  paused and the stale typecheck was stopped before the isolated runs above.
- NOT RUN: the full root suite and fresh-install journeys.

The isolated commands selected `integration-access-gateway.test.ts` and
`remote-dispatch.test.ts`; the second also selected `security-rules.test.ts`.
The broader command selected all of `mcp-dispatch.test.ts`. Its isolated follow-up
selected `watch_final`, `lost_start` and `keeps a stopped free turn from model sends
after recovery`. Local logs use `/tmp/tools-access-gateway-fix-`: `red-approval.log`,
`isolated-1.log`, `isolated-2.log`, `dispatch-1.log` and `dispatch-isolated.log`.

The mechanical follow-up `37d586f15` splits refusal recording into named helpers
and gives the test's saved events an explicit type. This fixes the two complexity
errors from the first full lint and the event-array error from typecheck.
PASS: the 15 gateway/schema tests again on this source, then all 12 selected MCP
start-refusal and lost-start checks. Logs are `final-regressions.log` and
`final-dispatch.log` under the same prefix. The helper extraction changes no check,
assertion or deadline.

PASS on `37d586f15`: full `npm run lint` (including Knip and changelog validation),
full `npm run typecheck`, and `npm run check:events` (149 matching types).
Lint used `NODE_OPTIONS=--max-old-space-size=8192` and reported zero errors with
24 existing length warnings. All commands used `nice -n 10`. Logs are
`lint-final.log`, `typecheck-clean.log` and `events-final.log` under the same prefix.

The shared `origin/main` advanced to `2dc248199` during validation. The final
rebase completed without conflicts. Comparing the full feature patch before and
after rebase with `cmp` confirmed identical bytes. That main commit changes only
frontend code, its browser journey and related documentation; the backend code
used by the tests above is unchanged.
PASS after rebase: ESLint on the changed frontend files, all web typechecks,
dependency checks, Knip, documentation and links, fixture boundaries, licence
checks, changelog validation and the event catalogue. The upstream browser journey
script retains its existing ESLint exclusion. Logs use
`/tmp/tools-access-gateway-rebase-`: `lint-code.log`, `web-typecheck.log` and `gates.log`.

## Shared test ports

The nine former `freePort` copies now use `@opencrane/event-store/testing`.
Each Vitest worker uses 200 ports, starting at `20000 + VITEST_POOL_ID * 200`.
Workers 0 to 24 are supported. The helper skips `EADDRINUSE` and stops after
200 attempts. This keeps ports below 25000, away from the secondary dev stacks
at 25100 and 25200 and the Linux outgoing range starting at 32768.
Separate test runs can share worker ids, so listeners are checked before use.

Provider tests retry gateway startup at most twice after a port conflict. Each
retry updates the provider check URL to use the replacement gateway port.

## Server guide text retained during the documentation update

The server reads file lists from saved read tables before checking newer events.
Old messages do not need replay just to find out whether uploads are ready.
File lists return a waiting response while their table catches up with a saved
upload. The website checks again before showing the upload as ready. Other chat
activity does not hold up the list.

Remote tool grant reads show a person's membership separately from their saved
grant. A departed person keeps their grant history and cannot use tools.

When a chat closes, the back end ends waiting requests and asks the computer to
stop work already under way. It keeps checking saved events after a restart and
can repair a missing record that says a computer turn ended. Other chats on the
same computer continue. This also works for older closes saved with chat
participation. If a shared computer reports a start after cleanup ended the
request, the server records a refusal tied to that turn and accepts its failure.

The server sends spending changes to the models process. It checks each chosen
group and shared assistant before saving. Personal assistants cannot receive a
new cap. The saved installation payer needs no group record. An unavailable
choice asks the admin to correct the editor; lost admin access still clears the
page. Owners and admins can read small pages of named groups and active shared
assistants. Each choice includes its saved revision and whether a cap is set,
absent or unavailable. The server checks current access after loading the page.

The back end reads unfinished child requests from a table kept by the
conversations worker. It checks each saved request and current access before
continuing the child. A proven refusal is saved and stops recovery. Only the
requester can read its status. Temporary access outages remain queued. Failed
requests cannot be retried yet.

Closed chats keep displayed output as it stood when the chat closed. Later
assistant reports, decisions, tool dispatches, child publications and agent or
system posts remain saved, but do not appear in history or live updates. Human
posts remain visible. Saved human posts remain readable. The list keeps showing
closed. History checks current participation after loading, before opening the
saved text.

Record a budget refusal before telling the computer that a chat turn cannot
start. The member sees the saved spending notice even when no model call was
made. Reconnecting recovers the notice from the saved refusal if the computer
restarted before the notice was saved.

The models process follows the recorded switch-on when choosing how to call a
provider. After switch-on it uses the checked call's saved provider key. A
leftover fallback key setting stops startup. Configuration reloads keep the
same mode.

The server asks the root supervisor to stop executors after the computer accepts
a signed work gate. It saves pausing after checking both receipts, then saves
paused only when the current bridge and root supervisor both prove quiet. This
grants no control.

Personal memory writes refuse access withdrawn before the fact is saved,
including a removed write grant or a disabled assistant. They keep the original
access time limit.

When a closed shared chat refuses a delayed turn, the server accepts the
computer's matching failure report. The turn stays closed and other chats keep
their connection. Reports containing output still need a saved, admitted turn.

Members can review a saved child answer and publish its text to the parent chat.
They can also publish a saved reply from a running turn or write an interim
update. The entry credits the person who publishes it. Files are unavailable.
Publication refuses an answer if its turn fails or its output is lost before the
parent entry is saved. Unrelated child messages still allow publication.

Owners and admins receive a member directory and current management flags for
active people. An ordinary member receives only a small header for one person.

The provider list reports when model access routes are available. Those routes
let admins read and change grants for people, groups and assistants. Provider
requests report when saved membership or ownership is still being applied. A
caller can wait briefly and repeat the same command id after that reply.

The chat connection notifies authorised readers when a spending stop is saved
for an original request they can see. A status read supplies the saved reason
and work state, including after reconnect. The notice carries no spending
amounts. If loading an update takes more than ten seconds, the connection
closes so the client can reconnect and read the saved status.

The bridge sends a saved spending stop before files, new work or approval
replies for that turn. It checks for new stops after waiting for a connection or
preparing work, then reads again immediately before sending a turn. It repeats
an unfinished stop after a lost message or reconnection. Work stopped by a
spending limit stays stopped when that limit rises. Other turns on the same
computer can continue. While a chat's stop check is unfinished, delivery waits
for that chat and keeps other chats moving. Receiving a file receipt does not
start the same check again.

Owners and admins can request publication of an exact reviewed tool list. The
request alone does not enable calls. Tool access explanations show why a person
and their assistant have access. Members can read their own explanation for
servers they can access. Owners and admins can read others. Guessed private
servers and tools receive the same refusal. Missing-grant replies contain
permission reasons only. Missing account support and unavailable permission
checks have separate reasons. These reads explain saved access. They do not
approve or start a tool call.

Member access and departure reviews use indexed stream names to read saved
grants, groups and assistants. Removed access stays incomplete until permission
receipts arrive. Reviews stop above 100 groups or 500 distinct people. After an
upgrade, reviews stay incomplete until the inventory index has been rebuilt.
Reviews use indexed history changes and report incomplete results when new
streams have not been checked. Unrelated read receipts do not require reading
the event log.

## Takeover timeout checks, 23 October 2026

These are local checks with disposable NATS, OpenFGA and PostgreSQL 17.6 fixtures,
not a fresh installation. Test commands use `nice -n 10`, one worker and
`PG_TEST_URL=postgres://postgres:test-only@127.0.0.1:55799/postgres`.

- Expected FAIL: releasing the queued pause append first at thirty seconds saved
  paused instead of failed. The test was committed before the append fix.
- Expected FAIL: forgotten assistants kept polling after completion; timeout append
  outages produced no warning; an observation could remain after a request ended
  before its watcher started. Each regression was committed before its fix.
- PASS: nine separate guard removals caused assertion failures. These covered the
  first-observation cap, invalid dates, cached history, shutdown after a read,
  polling sleep, observation removal, terminal phases, single-watcher registration
  and expiry before root stop. Each guard was restored after its check.
- PASS: 640 tests across bridge-control, bridge-gate, bridge-deadline, bridge-pausing,
  bridge-replay and the unchanged event security tests, before the final observation
  cleanup.
- PASS: all 126 tests in the three changed test files twice on `ca1c12f47`.
  Both runs used one worker. The later cleanup edit only names the map before
  deleting its entry; it changes no condition or deadline. All ten deadline tests
  and targeted lint passed again after that readability edit.
- PASS: repository typecheck, the repeated server typecheck after correcting the
  shared test helper, and the event catalogue check with 149 matching types.
- PASS: full lint, including Knip, dependency checks, Markdown, links, fixture and
  licence checks, and changelog validation. ESLint reported zero errors and 24
  existing warnings about long functions.
- PASS: the completed rebase onto `58d781331`. Comparing the feature patch before
  and after the second rebase found identical bytes. Main's manual Stop test and
  `suspendComputer` import are preserved.
- FAIL, then corrected: the first focused guard run had two fixture errors. The
  first lint found three test-helper errors. The first server typecheck after that
  helper change needed a check that the recorded context was a Map. Assertions and
  production checks were not relaxed.
- NOT RUN: the full root suite and fresh-install qualification.

The tests with adjusted clocks simulate append outages. They do not establish shutdown
bounds during a real read outage or already blocked connection work.
Local logs use `/tmp/p3-17-pr2h-`: `red-race.log`, `red-retire.log`, `red-log.log`,
`red-finished.log`, `mutations.log`, `tests-1.log`, `typecheck.log`,
`typecheck-server-corrected.log`, `events.log`, `lint-final.log`, `tests-2.log`
`tests-3.log`, `deadline-last.log` and `lint-last.log`.
The disposable PostgreSQL container and its volume were removed after the checks.

## Exact clock values in timeout tests, 23 October 2026

The test clock starts at an integer millisecond value. This keeps subtraction
exact for the strict thirty-second boundary checks. Production code is unchanged.
A temporary fractional start of `2768.001` reproduced the failure with
`30000.000000000004` instead of `30000`; the temporary change was removed.

Own checks after rebasing onto `9a885e7f9`:

- PASS: the future-time and clock-rollback test passed 50 consecutive separate runs.
  Its exact assertions still require 30,000 ms, 1 ms and 0 ms at the same boundaries.
- PASS: all 126 tests in `bridge-control`, `bridge-gate` and `bridge-deadline`
  passed twice with one worker and the requested local PostgreSQL URL.
- PASS: typecheck, event catalogue, Knip and changelog checks.
- FAIL then fixed: full lint found a missing blank line between retained notes
  after the rebase. Code, dependency and unused-code checks had passed.
- PASS: documentation, local links, fixtures, package licences and changelog lint
  after the blank-line fix. All stages of the lint command have now passed.

Every check used `nice -n 10`. Logs use `/tmp/p3-17-pr2h-clock-fix`, including
`repeat-1.log` through `repeat-50.log` in the directory of that name.
Full root suite and fresh-install qualification: NOT RUN. The PR remains a draft.

## Checked child activation, first part

`chat/child-activation.ts` exports `activateRequestedChild(options, memberId, input, attempt)`.
The input uses the existing child-request shape and must match the original request id.
It reuses `checkedChildInput` for history, saved creation/input and current access checks.
Both histories load before the two-second write check. A final incremental parent read
refuses a newly saved failure, retry or legacy close; small access streams detect removal
and modern closure. The append retains the original deadline and expects the child's
last position. The source-derived activation id is stable across attempts and replicas.
Retries verify the full saved binding and return its original row, beyond broker deduplication.

This is admission-time ordering across streams, not an atomic parent/child transaction.
A parent change after the final check can still precede the child append. Later root
allocation and first start must check authority, attempt and closure again. IAM and storage
uncertainty throw without saving a failure or claiming activation. No route or recovery
worker calls this command yet. `childRequestHeld` and production start gates remain intact.
Root allocation, first-start recovery and fresh-install qualification: NOT RUN / remaining.

## Bounded call spending

`GET /api/org/spending` accepts only `limit` (default 20, range 1–50),
`continuation`, `payingGroupId` and `assistantId`. Both filters compose.
It uses the existing `integrations.modelDb` projection connection and
`readSpendingCalls`. The data read shares a two-second deadline, selects at most
`limit + 1` call rows, and reads no budget JSON or event history. The budget
stream's latest position must be covered by the projection checkpoint.

After loading, including a failed load, the route checks current Owner/Admin
membership events and OpenFGA once. It uses no write authority fence. Responses
always use `Cache-Control: no-store`. Missing sessions receive 401; invalid
queries 400; denied access 403; missing, old, lagging or timed-out data and IAM
failures 503. Errors contain only fixed status values.

The strict reply contains `rows`, `sequence`, `generation` and nullable `next`.
Each row has reservation/permit references, original position, payer/assistant
references, `reservedAt`, original UTC `day` and `month`, `heldCents`, nullable
`settledCents` and `evidence`. Zero settlement is recorded zero; null means no
settlement. Unknown evidence can retain a hold alongside recorded charges.
There are no page totals, private titles, ancestry or resource links. Opening a
referenced resource still requires its own access check.

Pass `next` as `continuation`. Its signature binds the silo, filters, projection
generation and last position. A changed filter, invalid continuation or replaced
generation returns 409 `{status: "restart"}`; restart without the continuation.
The generation is checked again after the row read to catch a concurrent rebuild.
Ordinary settlements may update later pages; this is not an immutable snapshot.
GET appends no event and makes no model/tool call or budget change.

`test/spending.test.ts` uses real NATS, PostgreSQL and OpenFGA for paging,
access races, SQL timeout, continuation restart and replayed accounting evidence.
Root/routine joins, month filtering, impact previews and screens remain later work.
Fresh-install qualification: NOT RUN.
