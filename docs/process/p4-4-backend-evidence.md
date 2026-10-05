# Direct chat backend source checks

5 October 2026. Branch `work/p4-4-direct-chats`, based on main
`acaf4967905f6535dd8f1faf21e6199c03f8a1ff`. The rebase completed, and that
main commit is an ancestor of the branch. Tests cover rebased source
`2089421bccd10e327da14f022e529dc36c335273` plus the fixes in the commit
containing this receipt. This receipt records the builder's own checks for
[#86](https://github.com/elewa-git/opencrane-new/issues/86) and
[draft PR #159](https://github.com/elewa-git/opencrane-new/pull/159).
The [API contract](../api/direct-chats.md) describes the HTTP and socket replies.

The checks use Linux and Node 22.23.3. Tests start disposable NATS, PostgreSQL,
OpenFGA, gateway and Docker services. This is a source checkout, not a fresh
customer install. No third-party dependency was added. No owner stack, Docker
daemon settings or secondary dev stack was changed.

## Changes checked

The conversation list checks membership once. It skips direct chats whose
recorded participants do not include the caller. It checks OpenFGA permissions
for the remaining chats, eight at a time. It loads the titles, then checks that
access stayed the same before replying. A change during loading returns 503
without any titles; the client can retry.

Check status looks up the original event id in the conversation read table.
A missing row returns 404 while the table catches up. The client can poll or
retry the original POST with the same id and payload. The status check still
checks the caller's access and creation's OpenFGA progress separately.

Each command history read gets its own ten-second limit. A new message refused
because the other participant left returns 409. The caller can still read the
chat. A refusal of the caller's own access remains 403.

Colleague search uses the same membership rule as creation. A role change waiting
for OpenFGA does not hide a member who can still join a chat. Strict checks for
model and approval work keep their existing rules. Both strict and chat access
checks still throw exactly `Authority changed` when relevant events arrive.
The shared `isAuthorityChanged` helper owns the message check for chat callers.

## Failing-first checks

The tests use the existing public HTTP and command interfaces. Their service
setup and direct event publishing follow the supplied probes.

| Regression | Before fix | After fix |
| --- | --- | --- |
| List 160 chats, 130 belonging to other people | FAIL: 503 | PASS: 200, 30 rows, under 1.5 seconds |
| Check first and last send in a 1,500-message direct chat | FAIL: 503 | PASS: 200, each under 1.5 seconds |
| Send whose two history reads together exceed ten seconds | FAIL: 503 after commit | PASS: 200; same-id retry gives the same reply |
| New message after the other participant leaves | FAIL: 403 | PASS: 409; history remains readable |
| Colleague with a role change waiting for OpenFGA | FAIL: 503 after rebase | PASS: listed and accepted by creation |
| Internal creation with the caller as both participants | FAIL: plain Error | PASS: input validation error |

The 1,502-event agent-session test also checks history, list, socket readiness,
a new send, its same-id retry and Check status. Tests keep the existing access,
replay, immutable participant and bridge refusal cases.

The first root run was FAIL: 1,728 passed, 15 skipped and one Chromium
integration-page test timed out waiting for integration rows. An isolated run
of that browser case also exposed a status-poll race: it checked text before
the reply had rendered, then the next poll replaced that text with a loading
message. The test now waits for the expected reply before polling again.
Its ten-second overall limit is unchanged. The targeted browser case passed
after this fix. The second root run passed the browser case but reported 503 in the
1,502-event session case as load rose. It was stopped after that failure.
The session case then passed in isolation with the same limits: history
139 ms, list 48 ms, socket readiness 121 ms; send, retry and status passed too.
A third run was stopped after an existing gateway month-boundary case returned
403 where it expects 402. That case passed in the first complete run and then
passed unchanged in isolation. Its assertion now includes the response body
for any recurrence.

The final full run completed with FAIL: 1,727 passed, 15 skipped and two tests
failed across 113 files (107 passed, two failed, four skipped). It took
2,868.01 seconds and started at load 1.03. It used one file at a time and the
two-worker ceiling, with all test and production limits unchanged.
The approval-revocation case returned 503 while its decision expected 200.
The gateway grant-revocation case failed during fixture creation: applying the
initial member to OpenFGA timed out after 1,000 ms, before the test's request.
The gateway file also reported a NATS heartbeat error: it missed keep-alive replies.
Both failed cases passed unchanged in a targeted rerun: two tests, two files,
12.45 seconds, no suite error. This does not change the full-root FAIL result.

All requested enabled chat, members, authority and live-view files passed in
the final full run. The new regressions passed there too. On the 1,502-event
session, history took 124 ms, the list 80 ms and socket readiness 136 ms;
send, identical retry and Check status passed. The month-boundary case also passed.

Safe local logs are `/tmp/p4-4-*-red.log`, `/tmp/p4-4-*-green.log`,
`/tmp/p4-4-focused.log`, `/tmp/p4-4-lint-gate.log`,
`/tmp/p4-4-typecheck-gate.log`, `/tmp/p4-4-events-gate.log`, `/tmp/p4-4-root.log` and
`/tmp/p4-4-root-final.log`, `/tmp/p4-4-root-complete.log` and
`/tmp/p4-4-root-gate.log` on the builder host.
The final failed-case rerun is `/tmp/p4-4-gate-rerun.log`.
The isolated session log is `/tmp/p4-4-long-isolated.log`.
Authority rerun and exact-message logs are `/tmp/p4-4-authority-rerun.log`,
`/tmp/p4-4-authority-volume.log` and `/tmp/p4-4-exact-authority.log`.

## Required checks

Lint, typecheck and all tests run under `nice -n 10`. Tests use
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres` and at most
two workers. The full root run starts only when integer load is below 12 and
no live-view qualification batch is running.

| Check | Result | Observed result |
| --- | --- | --- |
| Focused chat, members, authority and live-view tests | PASS | All requested enabled files passed in the final full run; opt-in journeys remain skipped |
| Lint | PASS | Code, imports, unused code, docs, local links and fixture checks |
| All-workspace typecheck | PASS | All workspaces |
| Event catalogue | PASS | 95 event types agree |
| Full root suite | FAIL | 1,727 passed / 15 skipped / 2 failed; gateway also reported missing keep-alive replies; failed cases then passed unchanged in isolation |
| Fresh-install journey and designed desktop/390px screens | NOT RUN | Outside this backend source task |

The supplied exact-message probe passed for both strict and chat access checks.
The combined focused run failed on a gateway startup error in the authority-volume
fixture and a 503 in one model-authority request. Both files then passed unchanged
in isolated runs. No assertion or production deadline was relaxed.

The first lint run failed on an unused test helper left after the list change.
The helper was removed and the full lint run passed.

The first typecheck failed on colleague search after main changed its membership
function. Search now uses the chat membership check. The PR remains a draft.
Green source checks alone do not establish that the whole feature is done.
