# Shared assistant backend check record

Date: 5 October 2026. Branch: `work/p4-7-shared-assistant`.
Rebased onto `origin/main` at `38345bc`, which includes `12644d6`.
Checked that main was an ancestor of the rebased branch and that the rebase had
finished. No owner or secondary development stack was touched. Checks use
ordinary disposable NATS, PostgreSQL, OpenFGA, upload and gateway test services.
No paid model calls ran.

## Result and limits

Report **PARTIAL** for the full capability. The backend creates a group assistant
with selected grants, an admin-chosen paying group and one managed computer.
Members get their own chat transcripts and execution threads. Their turn tokens
stay separate. Commands append once to one stream. Replay rebuilds stored tables and
OpenFGA access. The existing budget actor handles integer euro cents.

Do not land this revision yet. The full root test gate has not passed. Keep the
pull request as a draft. Record isolated passes separately from full-run failures.

All members' turns share one disk and one browser profile. Tools can read work
files written by another member. File and browser isolation between members is
**absent**. Uploads and attachments into team-kind sessions are refused until each
member has their own workspace. Credentials for individual members must never be
written to that disk or profile. The bridge also excludes old team uploads from
file delivery and new turn attachments.

MCP currently requires `accountMode: none`, meaning no account credentials. This
change does not select, issue, inject or revoke personal credentials. Recording
gateway tests check distinct live tokens and swapped-token refusal. Two real
requester profiles at an MCP upstream are **NOT RUN**. Pinned Codex/gVisor execution,
admin and member screens, and a fresh-install journey are **NOT RUN**. Memory
remains disabled. These gaps keep the capability **PARTIAL**.

The creator check covers chat transcripts and their live sockets. File reads
also require the creator and current owner-group membership. Approvals, audit
and live view retain their existing participant checks. Do not add participants
to private team sessions. A desktop grant shows the shared browser activity.

A rejected admission report stops every member's bridge traffic on that computer
until restart. Existing revocations can stop selected grants from being given;
the creation receipt does not confirm those grants. Granting the whole owner
group use of a resource can still allow a person whose individual grant was
revoked. The admin creation screen must explain this. Computer busy reads still
scan event history, but loss, retirement and replacement clear old open turns.
Bridge reconnect changes remain with [#164](https://github.com/elewa-git/opencrane-new/issues/164).

## Behaviour checked

- Return the same creation receipt on an unchanged retry. Refuse changed and
  racing commands. Keep the chosen paying group in the creation event.
- Require existing owner and payer groups. Refuse personal assistant ids, NUL
  names and MCP ids containing dots.
- Restore group access and selected grants on replay without claiming an extra
  computer. Keep assistant and group grants separate.
- List 60 personal sessions. Read transcripts and keep their live sockets open
  while turns start and end. Read only each session's creation event for its
  creator, assistant and payer; read paths do not use a write authority fence.
- Keep Alice's sessions available while another member's change awaits IAM.
  Return 503 and socket code 1013 for Alice's own unapplied membership change.
  Return a retryable list error instead of silently hiding her rows.
- Refuse cross-member transcript reads and resumption even with an accidental
  participant tuple. Refuse a thread bound to another requester or conversation.
- Refuse a different payer on a fresh session or retry. Continue reading old
  history after payer removal while refusing further posts.
- Require an OpenFGA binding for new team turn admission. Keep simultaneous
  members' tokens separate and refuse swapped tokens at the recording gateway.
- Refuse team uploads from both current and removed members before scanning or
  storage. Keep ordinary personal uploads working.

Old journal entries without requester ids start a fresh Codex context on their
next turn, including existing personal sessions. Their chat history is retained.
Historical team assistants without a payer cannot create new sessions.

## Checks

Run CPU-heavy commands under `nice -n 10`. Use two Vitest workers and the test
PostgreSQL URL shown below. Wait for integer host load below 12 before starting
the full root suite, and do not run it during a live-view qualification batch.

```sh
nice -n 10 npm run lint
nice -n 10 npm run typecheck
nice -n 10 npm run check:events
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres nice -n 10 npm test -- --maxWorkers=2 \
  apps/server/test/shared-assistant.test.ts apps/server/test/shared-runtime.test.ts \
  apps/server/test/chat-read-regressions.test.ts apps/server/test/chat-http.test.ts \
  apps/server/test/chat.test.ts apps/server/test/realtime.test.ts \
  apps/server/test/bridge-replay.test.ts apps/server/test/bridge-channel.test.ts \
  apps/server/test/groups.test.ts libs/models/test/authority.test.ts \
  libs/authz/test/projection.test.ts apps/server/test/approvals.test.ts \
  libs/models/test/gateway.test.ts libs/models/test/shared-assistant.test.ts \
  libs/protocol/test/realtime.test.ts apps/server/test/upload.test.ts \
  apps/server/test/file-command-refusals.test.ts apps/server/test/file-upload-failures.test.ts
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres nice -n 10 npm test -- --maxWorkers=2
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres nice -n 10 npm test -- --maxWorkers=2 \
  apps/server/test/bridge-replay.test.ts apps/server/test/upload.test.ts \
  apps/server/test/shared-assistant.test.ts apps/server/test/chat-read-regressions.test.ts
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres nice -n 10 npm test -- --maxWorkers=2 \
  apps/server/test/chat.test.ts
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres nice -n 10 npm test -- --maxWorkers=2 \
  apps/server/test/integrations.test.ts -t \
  'loads through the dev proxy and preserves the accessible refresh journey in Chromium' \
  --reporter=verbose
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres nice -n 10 npm test -- \
  --maxWorkers=2 --reporter=verbose
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres nice -n 10 npm test -- \
  --maxWorkers=2 --no-file-parallelism --reporter=verbose \
  libs/models/test/authority-volume.test.ts apps/server/test/bootstrap-browser.test.ts
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres nice -n 10 npm test -- \
  --maxWorkers=2 --no-file-parallelism --reporter=verbose
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres nice -n 10 npm test -- \
  --maxWorkers=2 --reporter=verbose libs/models/test/shared-assistant.test.ts
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres nice -n 10 npm test -- \
  --maxWorkers=2 --reporter=verbose apps/server/test/approvals.test.ts
```

| Check | Result | Evidence |
| --- | --- | --- |
| Read regressions against the old code | FAIL as expected | List and transcript returned 409; live socket closed |
| Team upload against the old code | FAIL as expected | Returned 201 instead of 403 |
| Missing team binding and personal-id creation against the old code | FAIL as expected | Admission and creation were accepted |
| Shared-assistant regressions | PASS | 15 tests, including fixed payer, IAM delay and required binding |
| Read regressions after fixes | PASS | 3 tests: list, transcript and live socket |
| Upload regression after fixes | PASS | Current and removed team members refused; personal uploads accepted |
| `npm run lint` | PASS | All stages; seven function-length warnings, no errors |
| `npm run typecheck` | PASS | All workspaces; initial type errors corrected |
| `npm run check:events` | PASS | 89 event types agree |
| Requested suites | PARTIAL | All have passing runs; the later full runs also found a team gateway timeout and an approval refusal; 38 affected tests passed after the initial fixes |
| Full root suite, first run | FAIL | 105 files passed, 4 skipped; 1,625 tests passed, 15 skipped; Chromium polling check failed |
| Chromium journey alone | PASS | Passed before and after correcting the polling wait |
| Full root suite, second run | FAIL | 104 files passed, 4 skipped; 1,624 tests passed, 15 skipped; authority-volume and bootstrap browser checks failed |
| Authority-volume and bootstrap browser alone | PASS | Both passed with files running one at a time; no code changes |
| Full root suite, files running one at a time | FAIL | 105 files passed, 4 skipped; 1,625 tests passed, 15 skipped; two-member gateway test exceeded 60 seconds |
| Two-member gateway file alone | PASS | Both tests passed; concurrent members completed in 5.5 seconds; no code changes |
| Full root suite, fourth run | FAIL | 105 files passed, 4 skipped; 1,625 tests passed, 15 skipped; approved gateway call returned 403 instead of 200 |
| Approvals file alone after the fourth run | PASS | 26 passed, 1 skipped; keep this separate from the full-root failure |
| Two real requester profiles at MCP upstream | NOT RUN | Only credential-free MCP admission exists |
| Pinned Codex/gVisor, screens and fresh-install journey | NOT RUN | Requires the remaining capability and screen checks |

The requested batch initially had three failures. The upload-reconnect fixture
had no assistant creation event. The team-admission fixture had no IAM binding.
Both now supply the real history or access they need. The archive-wake test caught
an extra conversation read in the bridge. The bridge now uses the creation event
already in its loaded transcript. Upload, bridge, chat-read and shared-assistant
reruns passed 31 tests; the chat rerun passed all 7 tests.

The first full run failed one Chromium check. The test clicked Check status and
looked for the completed message before Angular had applied the response. The
journey passed alone. The test now waits for the discovery response to say a
connection is required, then waits for the message on screen. Product code and
timeouts did not change. The second full run started at integer load 9.

The second full run failed two other checks. One MCP request in the authority-volume
test returned 403. The bootstrap browser test timed out waiting for the Display
name field. Both passed when run with files running one at a time. No product or
test code changed for those reruns. The third full run uses the same mode to reduce
competing fixture work and started at integer load 6.

The third run failed when the two-member gateway test exceeded 60 seconds.
Both tests in that file passed alone with no changes. The two-member test took
5.5 seconds. These reruns do not make a failed full run pass. The fourth full run
started at integer load 7 with the usual two-worker limit.

The fourth run failed the approval-session test. Alice approved the request,
but the following gateway call returned 403 instead of 200. Host load was 12.12
when the failure was checked. This does not establish the cause. Keep the full
root gate as FAIL even if the approvals file passes alone.

Keep this record and the [ledger](ledger.md) on the same results. See the
[HTTP interface](../api/shared-assistants.md) for access and retry rules.
