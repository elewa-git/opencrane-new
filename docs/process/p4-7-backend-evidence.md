# Shared assistant backend check record

Date: 5 October 2026. Branch: `work/p4-7-shared-assistant`.
Root sources: first `372bdf1f2e6ea3878bd890bb01624ae30758a801`,
then `221323c7c7da85ebcc66ac30d5e864e2332a08ff`.
The branch was rebased onto `origin/main` at `de4edb4`; the rebase finished and
main was checked as an ancestor. The later change restores the history helper's
three arguments, names the replay refusal condition and keeps live view waiting
for every group change. Shared chat checks only the member's own changes.
These are local source checks with disposable NATS, PostgreSQL, OpenFGA, upload,
desktop and recording gateway fixtures. This was not a fresh installation.
No owner or secondary development stack was touched. No paid model calls ran.

## Result and limits

The capability remains **PARTIAL**. Admins can create an assistant with selected
tools and a fixed payer. Members have private transcripts and separate threads.
Every member still shares one disk and browser profile. Uploads and screenshots
into team sessions are refused. Individual credentials must never be written to
the shared disk or browser profile.

Personal posts and turn admission have no new access deadline. Chat history has
its own ten-second read budget. Team writes and new team turn admission check
access after reading history. Stop does not need payer membership. A final payer
or membership refusal fails that turn; other members keep using the same bridge.
Session lists check each assistant once per request. Live sockets keep creation
events and reread access when the relevant stream heads move.

The creator check covers chat transcripts, live transcript sockets and file reads.
Approvals, audit and live view keep their existing participant checks. An invalid
report can still stop a whole computer bridge. Simultaneous-admission reconnect
work remains in [#164](https://github.com/elewa-git/opencrane-new/issues/164).

## Checks

The supplied personal-history, follow-up, payer-removal, session-list and screenshot
probes were adapted into retained tests. The table reports our own command runs.
Logs are on the builder host under `/tmp/p4-7-*.log`.

| Check | Result | Evidence |
| --- | --- | --- |
| Personal history before the fix | FAIL as expected | 1,500 events caused an admission timeout |
| Personal follow-up before the fix | FAIL as expected | Admission threw `Authority changed` |
| Payer removal before the fix | FAIL as expected | The shared bridge closed during admission |
| Team list before the fix | FAIL as expected | 60 rows took 6.8 seconds |
| Idle socket before the fix | FAIL as expected | 18 history reads in half a second |
| Team screenshot before the fix | FAIL as expected | 503 after opening the shared desktop |
| Team model call before the fix | FAIL as expected | A missing assistant payer was accepted |
| `nice -n 10 npm run lint` | PASS | Seven warnings, no errors |
| `nice -n 10 npm run typecheck` | PASS | All workspaces |
| `nice -n 10 npm run check:events` | PASS | 95 event types agree |
| Requested suites and added regressions | PASS | All requested files and retained regressions passed in both root runs |
| First root run, source `372bdf1` | FAIL | 1,746 passed, 3 failed, 15 skipped; gateway continuation timeout, Chromium status polling and live-view pause notice |
| Final root run, source `221323c` | FAIL | 1,747 passed, 2 failed, 15 skipped; Chromium polling and a live-view removal reply of 4503 instead of 4003 |
| Initial requested batch | FAIL | 215 passed, 8 failed, 2 skipped; replay and fixture failures were corrected |
| Affected rerun before final fixes | FAIL | 36 passed, 3 failed; incomplete IAM fixture and history/list timing failures |
| Final shared-assistant file | PASS | 17 tests, including the list, payer removal, Stop and the shared bridge |
| Final cleanup checks | PASS | 37 tests across chat reads, chat, bridge replay and both shared server files |
| Gateway and live-view failing cases, rerun alone | PARTIAL | Gateway passed; live-view pause still failed, then was fixed and passed in the final checks and second root run |
| Compatibility trial | FAIL | 68 passed, 3 failed; a whole-group check also blocked shared chat creation |
| Final compatibility checks | PASS | 71 tests: live-view activity, shared assistant, model requests and groups |
| Member-removal case on main | PASS | One selected case; 34 excluded by the filter |
| Member-removal case on this branch | PASS | One selected case; 34 excluded by the filter; the root reply mismatch remains a failed gate |
| Two real requester profiles at an MCP upstream | NOT RUN | Only connections without account credentials are supported |
| Pinned Codex/gVisor, screens and fresh-install journey | NOT RUN | These checks remain pending |

All suites use `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`,
`nice -n 10 npm test --` and `--maxWorkers=2`. The requested batch includes
shared-assistant, shared-runtime, chat-read-regressions, chat-http, chat, realtime,
bridge-replay, bridge-channel, approvals, upload, groups, authority, gateway,
screenshots and integrations. The root command has no file filter.
The root runs started at integer host loads 10 and 3, below 12. No live-view
qualification batch was running at either start.

The unrelated Chromium polling change was removed from this branch. It is checked
on the separate `fix/mcp-discovery-poll-wait` branch. [Draft #191](https://github.com/elewa-git/opencrane-new/pull/191)
has passing lint, typecheck, catalogue and selected browser checks.
Personal sessions with older journal entries start a fresh Codex context when the
requester id is absent. Historical team assistants without a payer keep readable
history but cannot start sessions, post work or spend through old sessions.

The full root gate remains **FAIL**. The pull request stays a draft and is not
ready to land. See the [HTTP interface](../api/shared-assistants.md)
for access and retry rules and the [ledger](ledger.md) for the result index.
