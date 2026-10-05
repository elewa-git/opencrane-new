# Private team turns check record

Date: 5 October 2026. Branch: `work/p4-14-private-turns`.
Draft pull request: [#197](https://github.com/elewa-git/opencrane-new/pull/197).
Checked base: `8b3ad76`, including direct member chats. Main has since advanced.
The first two full runs used `667d1e4`, before that update landed.
These checks use disposable NATS, PostgreSQL, OpenFGA and computer fixtures.
No paid model call or owner stack is used. The live probe has its own namespace,
`p414-private`, and removes it afterwards.

## Result and limits

The capability remains **PARTIAL** and memory admission is **DISABLED**.
F1 fails on this developer box: `/swapfile` is active. The bridge heap, the
supervisor's stream buffers and RAM volume pages can all be swapped.
F2 fails on the host: `core_pattern` sends crash dumps to apport. Guest limits
are checked separately by the probe. No host setting is changed.
F3 depends on every live check in [the probe output](evidence/p4-14/private-turns.json).
A source test or an instruction to the model does not qualify disk isolation.

All private turns share UID 1003. The kernel does not separate concurrent
members' processes or homes. UID 1003 can read the workspace and reach loopback
ports 8080, 8081 and 6901. It can write `/tmp` on node disk, `/dev/shm`, and any
world-writable directory left by memory-free work. Codex uses its RAM `TMPDIR`,
but that does not forbid writing elsewhere. The probe checks writable paths and
searches files while replies are held and after turns end.

The PVC deliberately keeps memory-free content. Private report outlines keep
ids and types there, without text or command hashes. Their number exposes reply
size and timing, and their ids come from the client. Every UID 1000 process,
including memory-free Codex and its connectors, can reach `private.sock`.

## Behaviour checked

Team messages default to private execution. Each turn starts a new ephemeral
thread in a new process. A memory-free request continues only earlier memory-free
work and gets no private context. Personal work keeps its existing thread,
execution marker and prepared-turn recovery. Both configs switch prompt files
and skill instructions off; this also changes personal and memory-free work.

Admission checks execution mode and private thread reuse before opening the
existing small access streams. Context is read only after the admitted append.
It includes earlier requester messages and completed replies, even when those
replies arrived after the next message. It excludes deltas, reasoning, tools,
files, approvals and decisions. Unfinished exchanges have no request text.

Every started unfinished private turn fails after a bridge restart or replacement.
None repeats. Private reply text remains in bridge memory until acknowledged or
covered by the reconnect position. A replay without text sends `agent.output_lost`.
A stored text report stays stored when such a replay covers its sequence.

## Checks

| Check | Result | Evidence |
| --- | --- | --- |
| New pure and computer tests before implementation | FAIL as expected | Missing modules; then 49 channel failures and 2 passes |
| Added real-service tests before implementation | FAIL as expected | 9 failures; the 17 existing cases passed |
| Context, Codex config/connection and private channel | PASS | 65 tests in the three new files |
| Typecheck | PASS | All workspaces |
| Event catalogue | PASS | 96 types agree |
| Lint | PASS | Code, dependencies, unused exports, docs, links and fixtures |
| Focused suites, earlier complete run | PASS | All 11 requested files; 124 tests passed |
| Focused suites, final shared-database run | FAIL | 97 passed, 3 failed, 26 skipped; PostgreSQL rejected excess connections |
| Focused suites after rebase | FAIL | 163 passed, 2 failed in 14 files; the two long-session cases failed |
| Full root suite after rebase | FAIL | 1,883 passed, 11 failed, 15 skipped; 124 files; started at integer load 8 |
| Full root suite, first run | FAIL | 1,845 passed, 3 failed, 15 skipped; 119 files |
| Full root suite, complete rerun | FAIL | 1,846 passed, 2 failed, 15 skipped; 119 files |
| Image filesystem checks | PASS | Built source and protected files matched this checkout at the check |
| Image notices and licences | PASS | 384 of 384 packages accepted; 91 notice files checked |
| Pinned private config and ephemeral read-only thread | PASS | Local Docker, including private core limit 0; no model call |
| Pinned private turn and offered tools | PASS | Local Responses fixture completed; the request offered no tools |
| Authority performance check repeated separately | PASS | Existing 100,000-event test; 46-second run after host load fell |
| build.sh image publication and gVisor checks | PARTIAL | Registry push reset the connection; all three gVisor scripts NOT RUN |
| Probe journeys and measurements | NOT RUN | J1–J7 and Pod measurements could not use the new image |
| Acknowledged prepared restart on checked main | FAIL as expected | One failure, 53 skipped; required terminal report absent |
| Long-context and dispatch recheck | FAIL | Both dispatch cases passed; the long-context socket closed |
| Local Responses provider fixture | PASS | Plain, reasoning, compaction, held release and four tool attempts |

Commands run under `nice -n 10`. The focused suites are private-context,
private-codex, private-turn-channel, shared-assistant, bridge-channel, bridge-replay,
bridge-suspend, shared-runtime, chat, chat-http and upload. Service suites use
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres` and `--maxWorkers=2`.
Safe command logs are on the builder host under `/tmp/p414-*.log`.
The provider is a local Responses fixture, never a paid provider.

All three full runs started below integer host load 12. The rebased run checked that no live-view qualification process was active. The first run failed the
long-context setup, an existing bridge replay case and an existing authority
performance case. The setup now seeds its encrypted fixture message through the existing fixture
helper, without the command adapter searching the long stream for retries. All requested focused suites subsequently passed.

The complete rerun failed two different existing cases: assistant selection
returned 503 during another member's pending IAM change, and a gateway audit
case exceeded its forty-second test limit. The code and assertions of these
cases are unchanged. The full-suite gate remains FAIL, so this change is not
source ready. No production timing limit is raised and no host setting is changed.
The existing gateway audit case subsequently passed on its own.

A later focused run used the shared PostgreSQL test server while other builds were
running. PostgreSQL returned "too many clients already" to bridge replay and chat.
Upload timed out and the shared-assistant fixture timed out before its tests ran.
Those failures remain recorded. The three private suites passed all 65 tests.
The earlier complete rerun predates the active-thread collision guard; its two new
channel cases were observed failing before that guard and passing afterwards.

The four affected service files were repeated with disposable PostgreSQL fixtures.
Bridge replay, chat and upload passed. Shared-assistant passed 25 cases; its long
fixture message append was unavailable before admission was tested. That fixture
now uses the existing seed helper; the real admission append and its access
assertions are unchanged.

The rebased focused run also includes direct-chat, direct-chat-http and
chat-access-regression. Twelve files passed. Shared-assistant passed 25 of 26
cases; its long private acknowledgement closed before context arrived. The
unchanged direct-chat long-session send returned 503. No production read or
access budget is raised. Lint, typecheck and all 96 catalogue types pass on
the checked base.

The final root run used the rebased source and final five-second process cleanup.
It passed 1,883 tests, failed eleven and skipped fifteen. The failures cover
upload responsiveness, two approval calls, two chat access checks, the long private
context acknowledgement, personal dispatch, live view, bridge replay, a long
personal chat and the audit browser build. Host load rose after the run began.
The log records timeouts, 503 responses and socket closures; these failures are
not excused or marked as passes.

The restart fixture was strengthened after implementation. The original prepared
case had not acknowledged its start. The replacement waits for the acknowledgement,
holds the grant before the execution marker, then restarts the channel. The current
code passes both prepared and executing cases. The acknowledged prepared case
fails on the checked main source because it does not produce the required failed
report. This late correction is recorded separately from the initial red tests.
The final three private suites pass all 65 tests with the stronger fixture.

The long-context case was also measured on its own. Its initial history read
returned 906 rows in 10,003 ms, then raised `TimeoutError`. Admission and the
context build were not reached. Both personal and team dispatch cases passed in
the preceding isolated run. The temporary timing wrapper is removed. The ten-second
history budget and two-second access budget stay unchanged.

## Findings about the supplied plan

The critique file says fourteen required amendments but contains only R1–R10.
All ten present are applied. The named schema file is absent in this worktree.
The refused item list was instead extracted from the pinned image's generated
v2 `ThreadItem` schema. The fixture records all nineteen item types.
The existing chat suite also had two team-start fixtures without a mode. Their
mode fields are updated without changing any assertion. Refusing mode-less team
starts remains mandatory. The allowed-edit list did not name those fixtures.
The worktree started at `667d1e4`, rather than the older supplied base.
Main advanced to `8b3ad76` during testing. The change is rebased onto it and keeps
the direct-chat checks and the private execution rules together.
The old server's strict report schema rejects the new image's `executionMode`
field. A new image with an old server cannot keep working as the plan claimed.
Both lanes report their mode as required; server and image deploy together.
The bridge also indexes running turns by thread id. A reused id could replace an
active private turn before the server rejected it. Both lanes now refuse that
collision without replacing the existing turn.

No config fallback was used. Pinned Codex 0.159.2 accepted the exact configuration,
environment file and ephemeral read-only thread in local Docker. This does not
prove gVisor behaviour. The tracked image digest remains the previous image;
the new image must be published and qualified before that digest can change.
Optional changes applied: session-specific notification routing, stored-mode
checks, refusal of private threads in the persistent lane, rollout instructions,
same-UID bridge termination in the probe, safe malformed-output assertions, and
outline metadata limits. The shared-prompt change has its own changelog line.
Separate slot UIDs are skipped because this build fixes UID 1003 and the limitations
are explicit. A separate size approval is skipped because the owner instructed
this build to include every listed check and report any excess.

## Changed lines

Counts include added and removed lines. The required tests, process handling and
complete canary probe exceed the target. None of the listed checks was removed.

| Area | Added | Removed | Total |
| --- | ---: | ---: | ---: |
| Product | 922 | 202 | 1,124 |
| Tests | 1,131 | 6 | 1,137 |
| Probe and provider | 745 | 0 | 745 |
| Docs and recorded evidence | 667 | 29 | 696 |

## Rollout and remaining work

Deploy the server and computer image together. Old computer images report no mode
and are refused for default team messages. Existing silos must rebuild their
admission policy from the updated template before creating the new Pods.
The policy file and its fixed RAM-volume rule are unchanged.

Chat screens, memory injection, per-Pod report sequences, replacement-Pod turn
closure and managed-node qualification are outside this change. P4-15 stays blocked
until swap, host crash dumps and the complete live proof pass on a qualified node.
