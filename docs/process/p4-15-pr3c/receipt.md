# Clear private replies when Stop arrives

Part of #97. First split: computer reply removal through the existing bridge Stop.
Date: 26 October 2026. Local worktree, Node 22.23.3; not a fresh installation.
Base and PR 3b merge: `955cfedca6466d27b14f07b82be46d4ebf3a7523` (#715).
Failing-first test commit: `68054c698`.

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
`libs/events/test/security-rules.test.ts` was checked. That file and both authority
test files are unchanged. No authority deadline, watched stream, credential route,
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
- PASS: full workspace and infrastructure typecheck.
- PASS: final changed-file lint, with one function-length warning in the journal.
  Its first attempt caught an unbound fixture method; binding it fixed that error.
- PASS: 24 private Stop and terminal-reason tests twice after separating the
  notification check into a named function. The final six changed tests then
  passed twice after the fixture binding correction.
- Full lint, including Knip, is still in progress.

All tests and static checks use `nice -n 10`. Tests use the existing computer socket,
proxy and recording-upstream fixtures; no native model is called. Commands set
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres` where requested.
No root suite, fleet batch or secondary development stack was started.

## Remaining qualification

- PARTIAL: row-3 invalidation. Only the computer Stop output boundary is changed.
- NOT RUN: loaded-fact correction/forget/dependency/expiry and access-change races
  through automatic invalidation, including lost notifications and evidence writes.
- NOT RUN: requester-only server/browser buffer clearance or fresh-install journeys.
- NOT RUN: native recall and all four governed tools, Pod replacement and live
  process cleanup. Local journal replay is not a live replacement proof.

Local logs use `/tmp/p4-15-pr3c-` followed by `red.log`, `green-1.log`,
`affected-1.log`, `affected-2.log`, `affected-3.log`, `security.log`,
`web-tests.log`, `web-build.log`, `events.log`, `changelog.log`, `lint.log`
and `typecheck.log`. The two passing six-file runs are `affected-2` and `affected-3`.
Final focused logs are `final-1.log`, `final-2.log`, `final-changed-1.log`,
`final-changed-2.log`, `focused-lint.log` and `focused-lint-2.log`.
