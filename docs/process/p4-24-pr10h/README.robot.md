# Routine start confirmation contract

For people, read [README.md](README.md) first.

Part of #106, P4-24 PR 10h, first part. Accepted design sections 2/3/6, rows 8–11,
and [the routine specification](../../specs/phase-4/p4-24-routines.md).
Prerequisite #886 merged at `1fb47042bbe12200eff9e3e728808aa756ebd9ed`.
Base: `0d70d25e302f1d8e9b81fdb31c78e1da05e9af29`; includes #887 (`6217c8718`).

## Contract

The composition passes the trusted worker's optional cancellation signal to the sender.
The existing `enabled`/`replay` switch is unchanged and stays off by default.
`bindRoutineStart` keeps a bounded completion promise beside the original one-use
start check. The ten-second wait begins immediately before sending, after wake and
preparation. It does not borrow the scan's nine-second next-candidate budget.

The bridge confirms only a new start that consumed that check, was saved through
existing report and computer commands, and completed the existing credential
acknowledgement path without refusal. It must still have an open socket.
The sender checks current worker ownership once more before returning `sent`.
This is local hand-off confirmation, not proof that the peer received the acknowledgement,
that a model ran, or that the routine finished. A later transport failure can leave
execution uncertain. Saved admission still forbids another send.

Refusal, ten-second expiry, cancellation or socket loss resolves the wait as unknown.
The binding and its timer are removed. Duplicate or late reports cannot resolve another
attempt. The existing bridge queue continues draining accepted reports; cancellation
of this wait does not create a second report handler or bypass its checks.
The dispatch caller refuses unknown delivery without returning completed progress.

History, small access checks, one-stream appends, fixed payer and integer cents are
unchanged. The existing Stop event gains source `delivery`, with its activation
admission as cause and reason `start_unconfirmed`. There is no new event type,
wire field, dependency, setting, public route,
production callback, tick or worker registration. `routine-start.ts` holds the pending
connection state so `bridge.ts` stays within the existing file-size limit.

## Own checks

Failing-first commit: `0b8a83c71`. The held-start test observed dispatch completing early.
The acknowledgement case timed out because the early return released leadership.
After implementation, both cases passed through the production completion path.
The test adapter no longer waits for native execution or calls `link.settled()`.

Own checks on 6 November 2026, under `nice -n 10`:

- PASS: lint (zero errors, 37 existing warnings), full typecheck, event catalogue,
  Knip and changelog validation. No new dependencies or event fields.
- PASS: the first 31 hand-off cases, followed by all 460 unchanged security-rule cases.
- PARTIAL: the first broad run passed 605/609. The skip fixture sent a pause to a
  permission handler that does not subscribe to it; that fixture is corrected.
  The transport-loss test expected execution after a synchronous send error; it now
  checks that the unused binding is removed and another send remains refused.
- PASS: focused checks after both corrections. The unsaved-input recovery and busy
  sender success cases also passed isolated rechecks. Their first failures returned
  unknown; their causes remain unconfirmed. No deadline was relaxed.

Logs: `/tmp/p4-24-pr10h-{red,green,handoff-1,tests-1,recovery,rechecks,skip-green}.log`.
The draft PR records the final test repetitions and CI for its pushed commit.
Fixtures use disposable PostgreSQL, NATS and OpenFGA with a scripted native peer.
No owner stack or model call is used. Full root suite and live qualification: NOT RUN.

## Remaining blockers

Company profile selection and forwarding, owner-only Ask and expiry, lifecycle Stop
and verified finish, and fresh-install qualification still block production registration
and enablement. This change does not qualify those paths or complete the feature.

## Cancellation before credential release

The bridge captures the original pending delivery before report handling waits.
It checks the PostgreSQL lease immediately before sending, then checks the same
pending attempt, signal, original ten-second deadline and socket without yielding.
Sending consumes the attempt before the socket write. Cancellation consumes it too,
so whichever happens first prevents the other from acting. A delayed cancelled
handler returns only a fixed refusal, with no token, model or private context.

The sender records an unconfirmed delivery as Stop intent linked to its exact saved
activation admission. It keeps the occurrence occupied and does not claim native
termination. Existing Stop readers verify that cause before budget or bridge cleanup.
If saving is unavailable or conflicts, delivery remains unknown and saved admission
still forbids resend. General restart recovery and verified finish remain unqualified.

Failing-first commits: `400c40bae` reproduced credentials after shutdown, PostgreSQL
lease loss and timeout while handling was held. `2cccf65c6` required saved Stop intent
without a finished run. Logs are `/tmp/p4-24-pr10h-fix-{red,green,record-red,record-green}.log`.
Own checks on 6 November 2026. Final source code:
`3695e47d31b0202aad44a85ed0fe6f9e53a87add`.
The receipt-only commit follows it. The environment is this worktree on the shared
host, with disposable test databases, NATS, OpenFGA and a scripted native peer.
It is not a fresh installation. Every test, lint and typecheck command uses `nice -n 10`.
Tests use `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres` and one worker.

- PASS: full lint after extraction, with zero errors and 37 existing warnings.
- PASS: full workspace typecheck, followed by server/models typechecks after the
  function extraction; event catalogue, Knip and changelog validation.
- PASS: twelve focused checks after extraction, including held acknowledgement,
  cancellation during the final ownership check, strict deadline comparison without
  timer notification, successful delivery, duplicate reports and refused Stop evidence.
- PASS: the second complete six-file run passed 696/696 on the final source code.
  Every changed test file was run twice. The final run took 896.91 seconds.
- PARTIAL: the first six-file run started before the final function extraction and passed 694/696. The composition test for another
  thread returned unknown. The admin Stop case failed in fixture preparation before
  its test body. Both passed isolated retries without changing their assertions or
  deadlines. The original causes remain unconfirmed.
- NOT RUN: full root suite, development stack and fresh-install live qualification.
  Execution remains disabled.

The six test files are routine-handoff, routine-sender and routine-composition in
`apps/server/test`, routines and security-rules in `libs/events/test`, and
root-stop-evidence in `libs/models/test`. The unchanged security rules passed all 460 cases.
Logs: `/tmp/p4-24-pr10h-fix-tests-1.log`,
`/tmp/p4-24-pr10h-fix-{composition,admin}-recheck.log`,
`/tmp/p4-24-pr10h-fix-refactor-tests.log`,
`/tmp/p4-24-pr10h-fix-typecheck{,-refactor}.log` and
`/tmp/p4-24-pr10h-fix-knip.log`, `/tmp/p4-24-pr10h-fix-lint-final.log` and
`/tmp/p4-24-pr10h-fix-tests-2.log`.
The first full lint found three size limits. The extracted functions pass focused
lint; no rule or assertion was weakened.
