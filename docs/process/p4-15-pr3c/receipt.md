# Clear private replies when Stop arrives

Part of #97. First split: computer reply removal through the existing bridge Stop.
Date: 26 October 2026. Local worktree, Node 22.23.3; not a fresh installation.
Base and PR 3b merge: `955cfedca6466d27b14f07b82be46d4ebf3a7523` (#715).
Failing-first test commit: `68054c698`.
Implementation source: `a0f8ef72c6d46aa1cdc8cf46199095286634fa7d`.

The first regression showed private text arriving after Stop and returning on
reconnect while access removal was still waiting. Stop now clears the matching
private journal entries before asynchronous cleanup. Queued reports share those
entries and therefore send the existing unavailable status. Later private content
is ignored, while terminal notifications still finish the turn. This also clears
unacknowledged replies from completed turns. It preserves text-free metadata,
another requester's private reply and ordinary memory-free partial replies.

The full requested change needs automatic invalidation, saved evidence and delivery
work beyond this bounded computer change. The preceding PR deliberately provides
only unavailable output. This part adds no private delivery path or new capability.
Automatic checks of changed references and access, conditional invalidation evidence,
requester-only server/browser buffers and browser clearance remain pending. Native
admission stays disabled. Existing dispatch and renewal guards are unchanged.

No event or API field was added. The exact `RISKY_FIELD_NAME` expression in
`libs/events/test/security-rules.test.ts` was checked. At that stage, that file and both authority
test files were unchanged. The later fixture changes are recorded below. No authority deadline, watched stream, credential route,
models index, dependency or SQL rule changed. No model or owner-stack call was made.

## Own checks

- PASS: `npm ci` and both requested `.tools/` symlinks.
- FAIL, expected before implementation: the new bridge regression sent late text
  and replayed the stopped reply instead of three unavailable reports.
- PASS: that first regression after implementation.
- FAIL: the first six-file run passed 55/56 tests. The new content guard hid an
  existing restricted-tool refusal reason. Moving it after that refusal check
  restored the reason without permitting later text.
- PASS: the same six files twice after that correction, 56/56 each time, in
  38.42 and 37.95 seconds. These cover private Stop, proxy Stop, saved terminal
  reasons, report pressure, bridge gates and server/browser Stop recovery.
- PASS: all 438 unchanged event-security tests, once.
- PASS: all 28 existing web transcript tests and the production web build.
  The build reported existing size and CommonJS warnings.
- PASS: `check:events`, with 154 event types, and `npm run lint:changelog`.
- PASS: full workspace and infrastructure typecheck, followed by the computer
  package typecheck after the final notification-helper change.
- PASS: final changed-file lint, with one function-length warning in the journal.
  Its first attempt caught an unbound fixture method; binding it fixed that error.
- PASS: separate Knip and documentation checks.
- FAIL: the first full lint run read the earlier implementation and reported
  excessive notification-handler complexity and the unbound fixture method.
  The named notification helper and bound method fix both; the final focused
  lint run has no errors.
- PASS: 24 private Stop and terminal-reason tests twice after separating the
  notification check into a named function. The final six changed tests then
  passed twice after the fixture binding correction.
- PASS: final full lint, including dependency checks, Knip, documentation, links,
  fixture rules, package licences and changelog validation. Code lint reports
  zero errors and 26 function-length warnings, including the journal warning above.

All tests and static checks use `nice -n 10`. Tests use the existing computer socket,
proxy and recording-upstream fixtures; no native model is called. Commands set
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres` where requested.
No root suite, fleet batch or secondary development stack was started.

The six-file command was:

```sh
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres nice -n 10 npx vitest run \
  apps/computer/test/private-stop.test.ts apps/computer/test/turn-stop.test.ts \
  apps/computer/test/turn-model.test.ts apps/computer/test/report-pressure.test.ts \
  apps/computer/test/bridge-gate.test.ts apps/server/test/recovery-stop.test.ts --maxWorkers=1
```

Web checks used `nice -n 10 npm run test -w apps/web -- --watch=false
--include=src/app/chat/chat-state.spec.ts` and `nice -n 10 npm run build -w apps/web`.

## Remaining qualification

- PARTIAL: row-3 invalidation. Only the computer Stop output boundary is changed.
- NOT RUN: loaded-fact correction/forget/dependency/expiry and access-change races
  through automatic invalidation, including lost notifications and evidence writes.
- NOT RUN: requester-only server/browser buffer clearance or fresh-install journeys.
- NOT RUN: confirmed memory-mutation receipt delivery and lost mutation replies.
- NOT RUN: native recall and all four governed tools, Pod replacement and live
  process cleanup. Local journal replay is not a live replacement proof.

Local logs use `/tmp/p4-15-pr3c-` followed by `red.log`, `green-1.log`,
`affected-1.log`, `affected-2.log`, `affected-3.log`, `security.log`,
`web-tests.log`, `web-build.log`, `events.log`, `changelog.log`, `lint.log`, `lint-final.log`
and `typecheck.log`. The two passing six-file runs are `affected-2` and `affected-3`.
Separate check logs are `knip.log`, `docs.log` and `computer-typecheck.log`.
Final focused logs are `final-1.log`, `final-2.log`, `final-changed-1.log`,
`final-changed-2.log`, `focused-lint.log` and `focused-lint-2.log`.

## Termination and connection fixes, 26 October 2026

Implementation source: `bf11466a6cc1c920e56e186408b2d4fc6c33b330`.
Regression source: `2d70f1f44`. Local worktree and disposable service fixtures;
not a fresh installation. Rebased onto `origin/main` at
`599d4261d67362938df73cea7efdac36d3fc40f7` and confirmed the rebase finished.

Failed terminal notifications, `thread/closed`, private-session EOF and a rejected
`turn/start` now cancel the private turn and clear its reply before cleanup starts.
Tool refusal also cancels the turn, clears its text and starts access removal before
waiting for a terminal report. It keeps the existing refusal reason.

Connection loss clears private reply buffers, including completed replies, and
cancels preparing and running private turns. Replacing a socket clears the old
connection before the new one resumes. The old socket's later close cannot cancel
new work. Server shutdown closes sockets before waiting for unfinished reads.
Ordinary memory-free work and its reply recovery remain available.

The failure tests hold access removal open. They check queued delivery, later
message and reasoning text, replay before acknowledgement and cold journal reads.
Disconnect tests include a completed private reply and preparation held across
reconnect. The shutdown case uses real NATS, PostgreSQL and computer WebSockets,
with a server read held open while checking grant removal and replay.

The gate-authority fixture now keeps its existing exact assertions on two ordinary
turns. All fifteen rejected gate cases also run with a private turn and an ordinary
turn. They require refusal, private cancellation, retained ordinary access and no
gate receipt. No signature, access, money or memory assertion was relaxed.
The Stop tests also cover different turn ids in one conversation and late
memory-free text arriving before completion.

### Own failing-first evidence

- Expected FAIL: `38bcc6d25` added five termination cases. Four delivered queued
  private text after failure; tool refusal also retained its grant and accepted
  later text. All five passed after `a90d06395`.
- Expected FAIL: disconnect regressions in `d17d034bc` retained private work or
  completed reply text. They passed after `98cad690a`.
- Expected FAIL: shutdown regression in `a5c8daa30` kept the private grant while
  a server read waited. It passed after `bf11466a6`.
- Initial broad run: 428 tests passed. Thirteen memory-report cases could not run
  because the pinned gateway executable was absent. The normal `npm run pretest`
  script installed it and verified its checksum. Thirty gate-authority cases
  exposed the old fixture's assumption that private work survives reconnect;
  the expanded matrix above preserves all existing authority assertions.

### Own final checks

- PASS: the selected 29 test files twice, 486/486 tests in each pass, in
  273.17 and 245.39 seconds. These include all requested runner, bridge, socket,
  memory-report and replay checks.
- PASS: all 438 unchanged event-security tests, once.
- PASS: full workspace and infrastructure typecheck, then the computer typecheck
  after the final test-only edits.
- PASS: full lint, including Knip, dependency rules, documentation, links, fixtures,
  package licences and changelog validation. Code lint reported 26 warnings and
  zero errors. Final focused lint also passed after typing socket close values.
- PASS: `check:events`, with 154 matching event types. The event-security source
  file and production authority code are unchanged.

### Environment and remaining qualification

All tests, lint and typechecks used `nice -n 10`. Targeted computer runs used the
supplied `PG_TEST_URL` at port 55432. Projection and server runs used a new
`postgres:17.6-alpine` container, `pgtest-p4-15-pr3c-fix`, published on local port
40602 after `pg_isready` passed. The container and its volume were removed after the checks.
The test services used local fixture replies.
No model provider, owner stack, second Docker daemon or development stack was used.

PARTIAL: automatic memory invalidation and requester-only delivery remain pending.
NOT RUN: full root suite, fresh-install journeys, native recall and the four
memory tools in a live installation. Native memory admission remains disabled.

Fix logs use `/tmp/p4-15-pr3c-fix-` followed by `red-termination.log`,
`red-disconnect.log`, `red-shutdown.log`, `green-termination.log`,
`green-disconnect.log`, `green-shutdown.log`, `tests-initial.log`,
`authority-fixture.log`, `fixture-setup.log`, `tests-1.log`, `tests-2.log`,
`security.log`, `lint.log`, `typecheck.log`, `events.log` and `docs-final.log`.
The complete selected test command is `/tmp/p4-15-pr3c-fix-tests.sh`.
