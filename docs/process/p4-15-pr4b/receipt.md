# Restricted personal recall tool list

Date: 26 October 2026. Part of #97. Rebased base: `9e470b61e`.
Binding test commits: `a821d8f4c`, `0606923c1`, `ec4aaddf2`.

This change prepares the server tool list. Production memory remains disabled.
The assembler now requires a saved private turn, its matching requester and grant,
and a live registered caller. The old definition selector is private to this path.
Native launch, forwarding and live delivery remain separate work.

## Binding checks

The assembler accepts only an open, server-recorded restricted chat turn without
shared context. The requester, assistant and silo must match that record. Its grant
must also match the recorded requester, assistant, computer, conversation, turn and
thread, and must not have expired.

The caller checks from #731 (`419553ae6`) moved unchanged from the computer to
`libs/models`. The server and computer use the same implementation. It checks a live
registration, the caller's turn, its bound thread, computer generation and input
generation. Assembly repeats these checks after waiting for catalogue and access
reads, so closure during either read leaves no tool entry.

Tests cover no registration, caller or grant; another live caller; a grant for
another requester, turn, conversation, thread, computer or generation; changed
requester and scope together; changed requester, scope and grant together; changed
assistant or silo; missing, closed, ordinary, shared or untrusted turns; expired
grants; and caller closure before or during assembly. Existing definition, scope,
policy, access and frame-limit assertions remain in place.

## Own checks

- PASS: fetched origin, rebased onto `9e470b61e`, confirmed it is an ancestor and
  confirmed no rebase remains in progress.
- FAIL, expected: 23 new binding refusal cases returned a recall entry against the
  old helper; 39 existing cases passed. The ordinary-turn fixture was corrected to
  change the saved event, and the same failing result was confirmed before the fix.
- PASS: final assembly tests, 63/63 twice, using the supplied `PG_TEST_URL`.
- PASS: unchanged event-security tests, 438/438 once.
- PASS: event catalogue check, 154 event types.
- FAIL: first selected regression run, 1,093/1,098 tests and 33/35 files passed.
  The recorded assistant memory-grant case reached its 120-second test timeout;
  binding replay reached its 30-second timeout. HTTP correction and fair writing
  returned 503, and lost-write status returned `memory_unavailable`.
- PASS: every failed case passed a focused rerun without code or assertion changes.
  The first filtered replay attempt omitted its preceding setup cases and returned
  404. Repeating the four binding cases together passed all four. This setup mistake
  is not treated as product evidence.
- FAIL: second selected regression run, 1,096/1,098 tests and 34/35 files passed.
  The saved-block and saved-generation dispatch cases could not restart their
  gateway fixture: its readiness port was already in use. All five first-run
  failures passed during this complete second run.
- PASS: both gateway cases passed a serial focused rerun, with 92 unrelated
  cases skipped. No code, fixture or assertion was changed between runs.
- PASS: workspace and infrastructure typecheck. The first run found a plain-record
  adapter mismatch; the adapter was corrected before the successful full run.
- PASS: full lint, including Knip, documentation, links, fixtures, licences and
  `lint:changelog`. ESLint reports 26 warnings and zero errors. The first run
  stopped at the privacy check because the file move was not staged; the full
  run passed after staging the unchanged registry at its new path.

All lint, typecheck and test commands use `nice -n 10`. Focused tests and the first
regression run use one worker; the second regression run uses two. The first run
overlapped lint and typecheck. The second started after those checks finished.
The first selected regression command is:

```sh
nice -n 10 npm test -- turn-tools personal-recall-tools private-proxy mcp-proxy memory --maxWorkers=1
```

The repeat uses the same selectors with `--maxWorkers=2 --reporter=verbose`.
Both regression runs and the event-security run used base `5557c51ba`. The final
rebase added the backup change in `9e470b61e` without conflicts. None of this fix's
source or test files changed during that rebase. The assembly tests, lint and
typecheck were repeated afterwards.

This includes the memory projection tests, so it uses the required throwaway
`postgres:17.6-alpine` container, `pgtest-p4-15-pr4b-fix`, with a dynamic loopback port
and `PG_TEST_URL` set to that container. Its database was ready before tests began.
The container and its volume were removed after the last focused rerun.
The service fixtures start their own NATS, OpenFGA, gateway and disposable databases.
No full root suite, owner service, secondary development stack or paid call is used.

## Contracts kept

Only the exact built-in recall definition and matching saved revisions are accepted.
Publication, a credential-free connection, saved review, zero-cent Allow and both
MCP use grants remain required. Ask, Block and other scopes remain refused. The
48 KiB tool limit and 120 KiB combined-frame limit are unchanged.

No event or public API field is added. The event-security file and both protected
authority test files are unchanged. The assembler reads no conversation history,
loads no fact text and appends no event. Access streams and deadlines are unchanged.
No dependency, logging path or secret handling is added. Computer source changes
only to import the unchanged shared caller registry; no image pin changes.

## Remaining work

PARTIAL: server assembly only. The internal caller must supply trusted saved turn
and grant records and the real private caller registry. This is not an HTTP entry
point, does not register a live private process and does not authorise recall calls.
The ordinary builder, live bridge gate and memory admission remain disabled for
private memory tools, without an environment bypass.

NOT RUN: pinned-Codex discovery and recall through a private process, original
capability expiry, forged headers and backend bypass, native thread/generation
mismatches, stale native grants, evidence before native result delivery, native
zero-result/four-call/64 KiB/32-reference limits, lost native replies, correction
or forgetting during native calls, late native output and filesystem isolation.
Local handler and proxy fixtures do not qualify these native conditions.

NOT RUN: computer image build, check or promotion, fresh installation, gVisor and
disk inspection. CI is left to run after the push; it is not awaited here.
