# Direct chat backend source checks

5 October 2026. Branch `work/p4-4-direct-chats` was rebased onto main
`667d1e47dce3b5b0f4c60f93e5a3a669f3dd28ea`. The rebase completed and that
commit is an ancestor of the branch. The chat browser fixture keeps main's
scenarios and the direct-chat branch's creation data. `node --check` passed.
This receipt records the builder's own checks for
[#86](https://github.com/elewa-git/opencrane-new/issues/86) and
[draft PR #159](https://github.com/elewa-git/opencrane-new/pull/159).
The [API contract](../api/direct-chats.md) describes the HTTP and socket replies.

## Changes checked

History, status and colleague reads check access once before loading content.
The list checks membership once, then each row's recorded participants and
OpenFGA permission. It checks up to eight rows at a time. Reads do not keep
an authority fence, the short check used to detect access changes before a write.
A slow content read and ordinary chat activity do not refuse a reader.

Socket polls check access before reading content. Only the access check has the
1.5-second deadline. The server keeps checking access while content is waiting,
so a member removal can still close the socket within two seconds. The existing
revocation test checks the close and the refusal without relying on frame order.

Direct writes keep the same order: read command history with its own ten-second
limit, then check current access before the conditional append. Retries report
the original saved result. The checks still use the exact messages
`Authority changed` and `Active silo membership required`.

Main's shared-assistant rules remain in place. Each member's session stays
private even if another member receives a participant grant. Creation and retries
require the assistant's fixed paying group. Losing spending permission still
allows a member to read and stop their work.

## Failing-first checks

The tests use the public HTTP, command and WebSocket interfaces with disposable
NATS, PostgreSQL and OpenFGA services. The streaming test reuses the supplied
probe's 30 caller sessions, 120 other sessions and three replies every 20 ms.
It asserts four successful lists containing only the caller's 30 sessions.

| Regression | Before fix | After fix |
| --- | --- | --- |
| History content takes more than two seconds | FAIL: 503 | PASS: 200 with the saved text |
| Three caller sessions stream replies every 20 ms | FAIL: 503 | PASS: four lists return 200 with 30 rows each |
| Socket content takes more than two seconds during turn completion | FAIL: socket closes before ready | PASS: ready arrives and the socket stays open |
| Socket removal while content waits | FAIL: removal times out when polling waits for content | PASS: closes with 1008 and a refusal within two seconds |
| Unknown assistant creation after rebase | FAIL: 503 | PASS: 403 before reading assistant settings |
| Direct-chat file request after rebase | FAIL: 500 when reading a missing assistant id | PASS: 403 before reading assistant settings |

The tests that expected 503 after a read's access changed now expect the result
allowed by the check before the content read. A later request checks access again.
Tests retain unavailable-permission refusals, long conversations, replay,
immutable participants, departed recipients and refusal of assistant work in
direct chats. Colleague removal is tested through the HTTP route while OpenFGA
still holds the old permission.

## Required checks

Lint, typecheck and tests run under `nice -n 10`. Tests use
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres` and at most two
workers. The root suite starts only when integer load is below 12 and no live-view
qualification batch is running. The fixtures use the existing Docker daemon.
No owner stack, daemon settings or secondary dev stack is changed.
No third-party dependency is added.

| Check | Result | Observed result |
| --- | --- | --- |
| Read regressions | PASS | Delayed reads, access changes, streaming and removal during a blocked read |
| Requested chat, membership, authority and live-view activity tests | PASS | All ran in the final root suite; membership coverage includes member-joined and authz projection tests |
| Lint | PASS | Code, imports, unused code, docs, links and fixture checks |
| All-workspace typecheck | PASS | All workspaces after the final changes and rebase |
| Event catalogue | PASS | 95 event types agree |
| Full root suite | PASS | 117 files and 1,818 tests passed; four files and 15 tests skipped; no failures |
| Fresh-install journey and desktop/390px screens | NOT RUN | Outside this backend source task |

The first focused run exposed old list assertions and tests tied to the removed
read checks. Those now test the check before content is read through HTTP.
It also exposed two shared-assistant retry assertions after the rebase;
the assistant's paying-group check is retained before retry validation.
A further failing-first test confirms that unknown assistants remain refused with
403. Permission is checked before reading the assistant settings.
The earlier completed root run passed 1,789 tests and failed four. It found an old
socket test that expected the server to reuse an earlier permission check.
The socket now checks access before every poll. The test asserts that it stays open
and delivers turn completion. The upload test found that direct conversations
must be refused before looking for an assistant. Direct conversations have none.
The other two failures were a shared-session creation timeout and a refused
MCP call in the authority volume test. Both passed unchanged in the final run.
The focused run during host load above 20 was stopped after timing failures.
It is PARTIAL, not a successful check. The final root run started at load 11.77
and completed on the final source without further code or test changes.
The first lint and typecheck attempts found missing type narrowing in the
rebased bridge and a test fixture edit. Both were corrected.

Logs are under `/tmp/p4-4-` on the builder host. The failing-first logs are
`red-history.log`, `red-list.log` and `red-socket.log`; successful read checks are
in `green-reads.log`. The earlier completed root run is in `root-complete.log`.
The interrupted run during high load is in `focused-final.log`.
The checks after updating main use `lint-complete.log`, `typecheck-complete.log`
and `events-complete.log`, with that prefix. The final root result is in
`root-latest.log`; its start load is in `root-latest-start-load.txt`.
The PR stays a draft. Source checks do not establish a fresh-install journey.
