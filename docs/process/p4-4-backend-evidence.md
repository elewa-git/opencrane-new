# P4-4 direct chat backend evidence

5 October 2026. Branch `work/p4-4-direct-chats`, rebased onto main
`cfbf50aa4293af78e90883cce2e848d51fb5a263`. Backend source for
[#86](https://github.com/elewa-git/opencrane-new/issues/86) and the
[direct-chat API contract](../api/direct-chats.md). Linux, Node 22.23.3;
normal disposable NATS, PostgreSQL, OpenFGA, gateway and Docker test fixtures.
No third-party dependency was added. The browser protocol reuses the event
creation schema and its two-person rule through an internal package dependency.

The rebase completed, and main is an ancestor of this branch. Membership keeps
main's fence parameter and ownership reads through `currentMembership`.
Chat access reads only through creation, retains exact person-subject OpenFGA
checks, and watches audience/member-state changes. The socket reads heads each
tick and checks access again only when one moves. Commands keep their own read
budget and check current access immediately before their conditional append.

Regression seams: authenticated HTTP, position-based WebSocket, chat commands,
conversation replay, OpenFGA replay and bridge admission. The three supplied
probes were copied into `apps/server/test/chat-access-regression.test.ts` before
fixing the code. Their initial run was **FAIL**: HTTP turn start returned 403,
WebSocket turn completion sent `refused`, and history/list on 1,502 events
returned 503. The same three probes passed after the fixes. The long-session
regression now also bounds socket readiness, history and list latency at 1.5 s.

The revoked-list-row and departed-recipient-post regressions were **FAIL** before
their fixes and **PASS** after: the list retains authorised rows without leaking
the revoked title; new posts require both people still in the silo. Persisted
creation retries retain their original sequence after the colleague leaves.
Tests also cover closed-chat reads, outsider sockets, guessed-id status codes,
turn/file/closure/ownership activity, and retryable changed/expired fences.

All lint, typecheck and test commands use `nice -n 10`. The root suite uses
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres` and
`--maxWorkers=2`, starting only after integer load is below 16. Results below
record the builder's own checks.

| Check | Result | Evidence |
| --- | --- | --- |
| Chat regressions and direct/legacy chat | PASS | All 46 cases across seven files passed in the final root run; supplied probes and both colleague races included |
| Members, authority, gateway and live-view tests | PASS | Focused failures passed in isolation, then every enabled case passed in the final root run |
| Lint | PASS | Full chain plus final changed-file checks; no new chat warnings |
| All-workspace typecheck | PASS | All workspaces and final server check |
| Event catalogue | PASS | 89 types agree |
| Full root suite | PASS | 107 files / 1,644 tests passed; four files / 15 tests skipped; 1,308.89 s; start load 7; no live-view qualification batch active |
| Fresh-install live qualification and designed desktop/390px screens | NOT RUN | Backend source scope |

The final long-session focused run measured history at **198 ms**, list at
**113 ms** and socket readiness at **199 ms**, below each 1.5-second bound.
A role-change regression initially used invalid fixture fields; it was corrected
and passed with the catalogue's `previousRole` / `newRole` payload.
The first chat focused run was **FAIL** only because its new role-change fixture
used invalid fields. After correction, the next chat run was **FAIL**: 44 passed
and paging failed during fixture preparation. The broader focused run was **FAIL**:
gateway budget-boundary calls timed out and
one suite reported a missed JetStream heartbeat. Both failed cases passed on an
isolated rerun that started at integer load 14. Paging fixture preparation also
hit its existing 120-second bound under load. It now seeds valid encrypted events
through the existing fixture connection instead of repeatedly replaying the growing
stream through commands. Its HTTP paging and unavailable-IAM checks passed in
15 seconds, with the same assertions and deadline.

The earlier complete root run on the pre-rebase implementation was **FAIL**:
1,534 passed / 15 skipped / four failed. It does not establish the current gate.
The final root gate is **PASS**, including the repaired paging fixture, both
colleague races, pending ownership, command-budget and long-session regressions.
No assertion or production deadline is relaxed. The PR remains draft; source
checks do not establish fresh-install capability qualification.

No owner stack, Docker daemon settings or secondary dev stack was changed.
This receipt makes no completed-capability or recipient-read/delivery claim.
