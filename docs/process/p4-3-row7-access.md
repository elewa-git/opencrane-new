# Immediate access invalidation: entry points and evidence

Recorded on 10 October 2026 for #85, P4-3 row 7 and draft PR #318.
The branch rebased successfully onto `origin/main` at `bd4ec1a4` before these fixes.
This records source checks and disposable-service tests. Fresh-install departure
qualification remains NOT RUN. No public member removal route is added.

## How membership is checked

A browser cookie identifies a session. It does not prove current membership.
Member events decide whether the person still belongs to the silo.
A stream is the saved event history for one thing, such as one member or chat. An invitation
or role change after removal does not join them again. OpenFGA supplies the other
permissions and can still contain old answers while its worker catches up.

`chatMembership` reads member events directly. `readActiveMember`, `activeMember`
and `currentMembership` also require the applied permission receipt for the
current member event. `currentAuthority` requires those receipts before gateway
permissions can allow a call. Writes and turn starts check the positions of their
small access streams again within two seconds. Content reads happen before that
short check. A normal HTTP read checks access once; open feeds and desktop views
repeat checks independently of content delivery.

The tables list methods as well as paths. Paths in the first two tables are in
`apps/server`. The coverage column names the test files, without `.test.ts`.
Existing coverage is listed separately from the runs recorded below.
Fastify also registers HEAD for each browser GET route. It uses the same handler
and returns no response body. Those methods share the checks listed here.

## Browser HTTP entry points

| Methods and paths | Event membership check and other rules | Coverage |
| --- | --- | --- |
| GET `/api/members`, `/api/members/:memberId` | `currentMembership` / `readActiveMember`; directory needs Owner/Admin, headers need membership. | `realtime`, `realtime-guards` |
| POST `/api/invitations`; GET `/api/invitations/:memberId/changes/:commandId` | Invitation routes use current member/owner events and admin permission. Writes use `activeMember`. | `invitations` |
| GET/POST `/api/groups`, `/api/groups/:groupId`; GET `/api/groups/:groupId/changes/:commandId` | Group commands and reads use `activeMember` / `currentMembership`, then group and admin permissions. | `groups` |
| GET/POST `/api/ownership`; GET `/api/ownership/changes/:commandId` | Current member and ownership events, then owner permission; writes confirm positions. | `ownership`, `ownership-ordering` |
| GET/POST `/api/assistants`; GET `/api/assistants/:assistantId`, `/api/assistants/:assistantId/changes/:commandId` | Reads use `readActiveMember`; writes use `createSharedAssistant → activeMember`, plus admin, tools and paying group checks. | `shared-assistant`: all four routes after removal and invitation, with old SQL/IAM |
| GET/POST `/api/org/providers`; GET `/api/org/providers/:providerId`; GET/POST `/api/org/providers/:providerId/bindings`; GET `/api/org/providers/:providerId/changes/:commandId`; POST `/api/org/providers/:providerId/key`; GET/POST `/api/org/providers/:providerId/verify` | `providerAuthority → activeMember`; current admin and provider authority before reads, writes, secret storage or verification. | `providers`, `provider-bindings`, `provider-binding-guards` |
| GET/POST `/api/org/integrations`, `/api/org/models`, `/api/org/integrations/:serverId/tools`; GET `/api/org/integrations/:serverId/discovery`, `/api/org/integrations/discovery` | With the production event store, `activeMember` checks admin authority before register reads or changes. | `integrations` |
| GET `/api/org/models/:modelId/access`, `/api/org/models/:modelId/access/candidates`, `/api/org/models/:modelId/access/changes/:commandId`; POST `/api/org/models/:modelId/access` | `providerAuthority → activeMember`, via `readActiveMember` for reads. | `model-access`: all four routes after removal and invitation, with old SQL/IAM |
| GET `/api/org/computers` | `readActiveMember(..., 'admin')` before returning computer records. SQL identity lookup alone cannot allow the read. | `integrations`: removed admin, later invitation and old SQL/IAM |
| GET `/api/chat`, `/api/chat/colleagues`, `/api/chat/groups`, `/api/chat/groups/:groupId` | `chatAccess → activeChatMember → chatMembership`; group choices also check actual group membership. | `chat-access-regression`, `direct-chat-http` |
| GET/POST `/api/conversations`; GET/POST `/api/conversations/:conversationId/messages`; GET `/api/conversations/:conversationId/changes/:commandId` | `chatAccess` / `writeChatAccess`, then `conversationParticipationReader → chatMembership`. Personal assistant choice also needs `actsFor`; shared choice uses `sharedAssistantAuthority`. Private sessions check the actual team. | `chat-access-regression`, `direct-chat-http`, `shared-assistant` |
| GET/POST `/api/conversations/:conversationId/approvals` | `chatAccess` / `writeChatAccess`; decisions also use `currentAuthority` and tool/approval rules. | `approvals` |
| GET/POST `/api/conversations/:conversationId/files`; GET `/api/conversations/:conversationId/files/view` | `conversationParticipationReader → chatMembership`, private session, closure and latest join; commands use `ownConversation → verifyCurrentMember → chatMembership` before retry or append. | `file-upload-failures`, `file-command-refusals`, `upload` |
| POST `/api/conversations/:conversationId/view` | `viewAccess → chatMembership`, participation and desktop permission before minting a ticket. | `live-view-activity`, `live-view-admission` |
| POST `/api/conversations/:conversationId/screenshots` | `viewAccess` before opening and during capture; saving uses the guarded file command. | `screenshots`, `screenshot-browser` |
| GET `/api/memory/scopes`, `/api/memory/:scopeId/facts`, `/api/memory/:scopeId/facts/:memoryId`, `/api/memory/:scopeId/changes/:commandId`; POST `/api/memory/:scopeId/facts` | `readActiveMember` before scope permissions; group notes also use `groupMembership`; writes confirm access positions. | `memory`, `memory-write-admission`, `memory-admission` |
| GET `/api/org/history`, `/api/conversations/:conversationId/history` | `currentMembership` checks current member/owner facts before protected audit records. | `audit-browser` |
| GET `/api/org/effects`, `/api/org/effects/:permitId`; POST `/api/org/effects/:permitId/resolve` | `currentMembership`; resolution reads history before checking current write access. | `libs/models/effects-read`, `decision-cost` |

The integration options permit a store-free test setup. That setup has no event
membership check and is not the production server configuration. Computer routes
now require the event store whenever they are registered.

## Browser sockets

| Entry point | Event membership check and delivery rule | Coverage |
| --- | --- | --- |
| `/ws` upgrade, hello and client event validation | Organisation session only. These frames disclose no protected content. Topic subscription performs membership checks below. | `websocket`, `realtime-guards` |
| `/ws`, member topic | `readActiveMember(..., 'admin')` before delivery and on independent polls. A 1,500 ms watchdog stops a hung check. | `realtime` |
| `/ws`, personal, direct and group conversation topics | `conversationParticipationReader → chatMembership`, current participation and OpenFGA receipts. Private team sessions also use `groupMembership`. Access polling continues while a content read waits. | `chat-access-regression` |
| `/ws/conversations/:conversationId/view`, including old ticket redemption and renewals | `viewAccess → chatMembership`; participation and desktop grants. Team grants check the team. Watches only member, participation and grant streams. | `live-view-activity`, `live-view-unavailable`, `view-lease` |

## Gateway and models-process entry points

| Entry point | Event membership check and other rules | Coverage |
| --- | --- | --- |
| Gateway POST `/v1/responses`; decision POST `/authorize` | `currentAuthority` requires member-state receipts, then person/assistant resource permissions and current turn/computer binding. Confirms access positions before admission. | `libs/models/gateway`, `decision-fence`, `decision-activity` |
| Gateway POST `/mcp/:serverId/:connectionId`; decision POST `/authorize/mcp/:serverId/:connectionId` | Same current member authority; also tool revision, policy, mode and approval. A refusal sends nothing upstream. | `libs/models/gateway`, `decision-fence` |
| Gateway POST `/mcp/memory/server`; decision POST `/authorize/mcp/memory/server`; server POST `/mcp/memory/server` | `prepareMemoryContext → currentAuthority` checks model and memory permissions. The server verifies the signed memory pass and checks current scope authority. Recorded private turn and current computer must match. | `memory-mcp`, `libs/models/memory-context` |
| Gateway GET `/providers/openai/reachability`, `/providers/anthropic/reachability`; POST `/providers/openai/test`; corresponding decision `/authorize/providers/...`; decision POST `/providers/verify` | Signed provider capability, then `providerAuthority → activeMember` before provider dispatch or key release. | `providers`, provider verification tests in `libs/models` |
| Decision POST `/budgets` | `configureBudget → activeMember`, admin permission and signed command. | `integrations` |
| Decision GET `/jwks.json`; gateway readiness port | Public verification keys and readiness only; no human membership or private content. | `libs/models/gateway-start` |
| Decision POST `/settle`, `/computer-lost` | Internal calls check saved event references and recorded work. No new human work, credential or protected content is authorised; no member check is required to finish accounting. | `libs/models/decision-cost` |

## Computer entry points

| Entry point | Event membership check and delivery rule | Coverage |
| --- | --- | --- |
| Server sends queued turn text and tool catalogue over computer `/bridge` | `sendWaitingTurn → chatMembership` after building the list, before sending. Tool selection also requires person/assistant `auth.use`. | `bridge-turn-tools`, `bridge-replay` |
| Computer `/bridge` sends first `agent.turn_started` | `turnCommand`: personal admission uses `requireTurnMember → chatMembership`; shared admission uses `activeMember` and actual/paying group membership. Confirms member positions before append. | `computer-turns`, `shared-assistant` |
| Computer repeats `agent.turn_started`, including reconnect/token renewal | `requireTurnMember` checks every repeated start. After private history loads, the bridge checks membership again before minting a token and confirms the position before releasing token/context. | `shared-assistant`: personal/shared, first/repeated, old SQL/IAM, removal during history; `computer-turns` |
| Server sends file metadata and bytes over `/bridge` | `ownConversation → chatMembership` before `sendFile`; participation, private session and closure checks still apply. `fileCommand` checks again before saving the receipt. | `bridge-file-access`: removed uploader, later invitation, zero bytes and unchanged history; `upload` |
| Computer `/bridge` report, completion, failure, tool progress and file acknowledgement frames | Current computer credential and saved conversation/turn/report binding. Terminal reports finish earlier work without new human admission. File acknowledgement uses the membership check above. | `bridge-replay`, `computer-turns`, `upload` |
| Server `/bridge` resume, acknowledgement, stop and approval notifications | Bound computer/turn and saved approval rules. These control earlier work; start acknowledgements that release token/context use the repeated check above. | `bridge-replay`, `bridge-turn-tools`, `approvals` |
| Computer POST `/credentials`; GET `/health`; `/bridge` WebSocket upgrade | Isolated runtime control network, current computer credential and expiry. These do not prove human membership. Protected work is checked by the server and gateway above. | `apps/computer/test/run.mjs`, `apps/server/bridge-proxy` |
| Computer local POST `/grant`, `/drop`, `/catalogue`, `/catalogue/ready`, `/catalogue/drop` on `/run/codex/control.sock` | File permissions restrict the control socket. Turn credentials come from guarded server admission; these local controls do not read human events. | `apps/computer/test/run.mjs`, `mcp-proxy` |
| Computer local POST `/v1/responses`, `/mcp/:loadKey/:serverKey` | Local caller and current thread pass, then the gateway event membership checks above. | `apps/computer/test/run.mjs`, `mcp-proxy`; `libs/models/gateway` |
| Computer local Codex `/run/codex/app.sock`, executor `/run/executor/private.sock`, private executor connections, and desktop TCP service | Process/file permissions and isolated network. No direct human member reader. Browser desktop bytes pass `viewAccess`; execution uses the admitted turn. | `apps/computer/test/private-capabilities.mjs`, `live-view-proxy` |

Computer credentials in `libs/auth` prove the current computer grant and turn
binding. They do not prove human membership. Every path releasing a human turn
credential now performs the event membership checks recorded above.

## Entry points that establish identity

GET `/healthz` returns readiness only. GET `/auth/login`, `/auth/callback`,
`/auth/me` and POST `/auth/logout` manage or describe the caller's own session;
they do not grant silo membership. Tests: `auth-flow`, `auth-logging` and `websocket-auth`.
POST `/api/silo/claim` checks the one-time bootstrap claim and a fresh signed-in
identity on an unclaimed installation. POST `/members/join` checks an invitation,
verified identity and the inviter's current event authority. The prospective
member cannot already be required to have joined. Tests: `bootstrap-claim`,
`bootstrap-browser`, `member-joined` and `invitations`.

## Closing events without message scans

New `conversation.closed` events use `participation-<conversationId>`, alongside
participant changes. No event type was added. New writes to the old conversation
subject are refused; old records still parse and replay. Chat histories, summaries,
approval reads and gateway activity checks include both forms.

Desktop and file readers confirm an indexed older close by its exact event id
and position. Otherwise they read only the participation stream. They never scan
message history during an access check. Cold and warm desktop tests keep the
worker behind conversation creation and refuse any attempt to read later messages.

Upgrades stop old server writers, catch up the conversations worker, then start
the new server. Startup refuses if the conversation checkpoint is behind the
conversation stream. This one-time check prevents an unindexed older close from
being missed. Fresh installs with no conversations need no checkpoint. New closing
events do not need the worker to catch up after startup. Stop readers for table
replacement or event-store restoration, then restart them to clear summaries.

## Failing-first changes

Each new failing test was committed before its production fix.

| Test commit | Failure before the fix |
| --- | --- |
| `3ae0cbba` | Removed admin got HTTP 200 from the computer register instead of 403. |
| `3e136225` | Removed requesters could start personal turns and receive repeated personal/shared tokens and private context. |
| `87c0c8df` | Cold desktop access scanned message history; current participation-stream closes were rejected by append. |
| `1a85d5f7` | A queued file delivered 19 bytes after removal even though its receipt was refused. |
| `849aca73` | The startup upgrade check was absent; route tests cover all assistant and model-access paths after removal and invitation. |
| `f62325cc` | Queued turn text/tools were sent after removal and invitation. |
| `8528df83` | A close arriving during the final approval check still allowed the decision to append. Fixed in `92640da4`. |

Existing desktop and file failing-first tests also remain in the branch. They
assert byte cut-off, closure within two seconds, refusal of new/old tickets and
no file append with SQL and OpenFGA deliberately left old.

## Verification and remaining qualification

Production code: `92640da4`. All 24 changed root Vitest files passed twice after
fixes and complete-file retries. Each run set
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres` and used
`nice -n 10 npx vitest run ... --maxWorkers=1`.

| Check | Result |
| --- | --- |
| Full lint, including dependency rules, Knip, Markdown, links, fixtures and changelog | PASS on the final source. Fifteen existing warnings; no errors. |
| Final root typecheck, plus server and models checks after their edits | PASS. Includes web application, spec and browser-fixture typechecks. |
| Event catalogue | PASS: 99 types agree. The closing event changes stream ownership. |
| Changed root tests, twice | PASS after repairs and full-file retries. Two optional cases remain NOT RUN: paid model calls and the approval browser journey. |
| Full chat/access file, twice | PASS: 42 tests each, including 100,000 messages, cold/warm desktop checks with delayed tables, and the older-close upgrade guard. |
| Full shared-assistant repeat | PASS: 33 tests, in addition to its successful second batch run. |
| Full approval file after the closing check fix, twice | PASS: 30 tests each; its optional browser case is skipped. |
| Connector and budget migration fixtures, twice | PASS: 23 tests each across two files. |
| Membership guard tests, twice | PASS: five tests each. |
| Event schemas and membership guards | PASS: 664 tests across 13 files. |
| Full provider and memory files | PASS: 153 tests across two files. |
| Approval callers after the final fix | PASS: nine selected gateway/captured Codex cases; 89 other cases skipped in that focused run. |
| Web typecheck and build | PASS. Existing CSS budget and CommonJS build warnings remain. |
| Full web tests; changed web files again with `PG_TEST_URL` set | PASS: 588 tests across 40 files, then 62 tests across two files. |
| `nice -n 10 npm run visual:chat` | PASS: Chromium fixture checks and captures at 1280/390 widths. |

The two broad root batches covered 22 and 21 files. Nineteen other test files
passed in both. The first batch also hit a NATS timeout while seeding the large
chat and a shared-assistant setup timeout while the host was busy. Both complete
files subsequently passed twice without increasing any deadline. Both batches
found the approval closing-check bug. After fixing it, that complete file passed
twice. These failed runs are not reported as successful batches.

An exploratory name-filtered route run was stopped because some provider and
memory tests need earlier tests to prepare their shared fixtures. Both files
then passed in full. The web runs also found inherited read-only dialog mocks;
the corrected full suite and changed-file repeat passed.

The batches and complete-file repeats cover the 24 changed paths returned by:

```sh
git diff --name-only bd4ec1a4...HEAD -- '*test.ts'
```

The first large batch also included the unchanged participation projection tests.
It did not yet include the later membership and connector fixture files; those
have separate complete repeats above. The second large batch ran chat/access
separately so the 100,000-message seed could complete without the earlier load.
Approval, shared-assistant and chat/access complete-file retries replaced their
failed or skipped results. No paid model call was made.

Captures are saved locally at `/tmp/p4-3-row7-captures-pjsrq1gx/comparison`.
Existing checked-in images were restored after capture because no browser
production code changed. These images show the scripted browser fixtures.
Round 1 review was FIX THEN LAND. A second independent review is NOT RUN by this
fix task. Fresh-install removal, real desktop canvas timing on a newly installed
silo, live identity/provider checks and the combined departure/cleanup journey
remain NOT RUN. Local captures are browser fixture checks, not fresh-install
qualification. The full root suite is NOT RUN, as requested. #85 stays open.

## Rebase repair after the merge train

The repair rebased only this branch's 19 commits onto `origin/main` at
`93f2f3de` and confirmed that the rebase finished. Test changes were committed
in `e5dd8e89` before the production repair in `093f4a5d`.

The earlier rebase combined the bridge changes with #305, which sends the
computer the model saved for its turn, and dropped the check before file
transmission. The existing queued-file test reproduced the leak: 19 bytes arrived after removal and a later
invitation. The repair restores `ownConversation` before `sendFile`. The file
receipt still checks access separately. The existing helper extraction keeps
the original turn context, membership checks and main's admitted model.

The participant tests from #303 still used the earlier closing history. A new
close now belongs to the participation stream. Older closes must be projected
before starting new writers, and startup checks that requirement. The updated
fixture tests both cases. It keeps the HTTP 409 assertion for new edits after
closure and the successful saved retry. The case for older closes also checks that
the upgrade requirement has been met.

The slow closing-history test used to delay a scan of conversation messages.
The repair delays the indexed older-close lookup instead, which is the read
production now uses. The delay remains 2,200 ms. The test still requires a
successful edit after that slow read, and refusal if the target leaves during
admission. No access, money or memory check or failing assertion was relaxed.

The train also reported a 1,502-event timing failure, a timeout while preparing
101 grants, and an applying projection in the following test. Final repeat
results are recorded below. These tests retain their original time and
projection requirements.

The first Vitest repeat passed all 24 files: 545 tests passed and two optional
cases were skipped. Its temporary shell wrapper then failed with exit 127.
The reporter flag had been added while the shell was still reading that script,
so it tried to execute that flag as a separate command after Vitest passed.
This was a local runner mistake, not a test failure. The second repeat used the
corrected command. An earlier three-file exploratory run was stopped and is
not counted as a passing repeat.

Both root Vitest repeats passed all 24 changed files, including every file
named by the train. Each had 545 passing tests and two skipped optional cases:
paid OpenAI calls and the approval browser journey. The second runner exited
successfully. Both runs set
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres` and used
`nice -n 10 npx vitest run ... --maxWorkers=1`. Each process used one worker;
the second repeat began while the first was still running.

The second repeat measured the 1,502-event case at 128 ms for history, 47 ms
for the list and 601 ms for socket readiness. The 101-grant test took 22.3
seconds, below its unchanged 30-second timeout. The next projection test
reached `current`. None of those three train failures recurred in either
complete-file repeat. Load is a likely explanation for the timing and timeout
failures, but their cause was not independently established. A timed-out test
can continue writing to this shared fixture while the following test runs.
That can leave its projection behind. No production or fixture change was
made for these three failures, and their assertions remain unchanged.

Main advanced with #316 and #317 while the tests ran. A final rebase onto
`490da26a` replayed this branch's 21 commits and finished. The browser dialog
fixture conflict keeps main's named helper and this branch's writable methods.
A comparison with the tested source confirmed that apps/server, apps/computer,
apps/ops, libs, package.json, package-lock.json, vitest.config.ts and
tsconfig.base.json were unchanged. The root repeats therefore cover the final
server and library source. Browser checks include navigation, model registry,
recipient picker and direct/group transcripts on the final main base.

| Final check | Result |
| --- | --- |
| Root changed files and train files, twice | PASS: 24 files, 545 tests passed and two optional cases skipped in each Vitest run. The first wrapper error is recorded above. |
| Final browser files, twice | PASS: 118 tests across four files in each run, with `PG_TEST_URL` set and `nice -n 10`. |
| Full lint on the final source | PASS: 15 existing warnings and no errors. Includes dependencies, Knip, Markdown, links, fixtures and changelog. |
| Typecheck on the final source | PASS: all workspaces, including browser application, spec and fixture checks. |
| Event catalogue | PASS: 103 event types agree. |
| Standalone Knip and changelog lint | PASS. |

The earlier browser repeats also passed 63 tests across the two PR files each.
After the browser-only main merges, navigation and model-registry tests were
repeated twice alongside recipient-picker and direct-chat tests. The complete
root suite was not started locally.

The full root suite, paid model calls, fresh-install removal and desktop
qualification, and the second independent review remain NOT RUN. This repair
makes no fresh-install capability claim.

## Repeated turn starts after the provider changes

The 11 October 2026 repair uses the existing worktree for PR #318. Fetching and
rebasing confirmed that `origin/main` at `5f75ec5b` is already an ancestor of
`b6b91bf9`. Neither rebase working directory remained.

Main does not contain the removed-member test. A detached worktree at `5f75ec5b`
ran the branch's unchanged `computer-turns.test.ts` against main's production code.
Both removal cases failed: first and repeated starts returned Alice's turn after
`member.removed` and `member.invited`. That invitation did not record a join.

On the rebased branch, the complete computer-turn file reproduced the train's
failure: 21 tests passed and the repeated-start removal case failed. The first
start case passed. The rebase had added `!facts.turn?.hasStart` around
`startAuthority`, skipping its existing repeated-start membership check.
The computer summary then returned the earlier binding without checking access.

The repair calls `startAuthority` for every start. A repeated start uses
`requireTurnMember`, reads only the member stream, and confirms its position
before returning the saved binding. Conversation history is read before this
two-second check. New starts keep their provider admission and payer checks.
Repeated starts keep their saved payer, provider, model and execution mode.
They do not select a new provider or run a new-turn drain check.

| Focused check | Result |
| --- | --- |
| Main with the unchanged branch removal cases | FAIL: both cases returned Alice's turn instead of rejecting. |
| Rebased branch before repair, complete computer-turn file | FAIL: one failed and 21 passed. Only repeated start after removal and invitation failed. |
| Repaired source, complete computer-turn file | PASS: all 22 tests, including both removal cases and saved provider replay. |
| Isolated live-view activity file | PASS: all 39 tests. The grant-revocation cleanup timeout did not recur. |

The protected tests and all assertions remain unchanged. The existing failing
computer-turn test supplies the before/after proof. The newly merged provider
admission fixture now records Alice's join before requesting work. Without it,
nine cases failed the existing first-start membership check before reaching
their provider assertions. No dependency was added. Logs and the repeat
selection are in `/tmp/pr318-membership/`. The main worktree has its own installed
dependencies. Two pre-existing uncommitted edits were saved in a named Git stash
before the rebase; they are also in `existing-edits.patch` beside the logs.

Main then advanced with #333. The final rebase onto `d1d9c8f2` finished, with
both the private-connection and closing-read documentation retained. Main is an
ancestor of the rebased branch and neither rebase working directory remains.
A comparison with the tested repair confirms that all existing server and library
code, test files, package files and test settings are unchanged. Main adds two
separate custody modules and their licence notice.

| Repeat on the repaired source | Result |
| --- | --- |
| First broad selection: 32 files | PARTIAL: 617 passed, 12 failed and two optional cases skipped. Nine failures were the missing join in the provider fixture. Two gateway cases and one chat case had startup or timeout failures. |
| Second broad selection: the same 32 files | PARTIAL: 628 passed, one failed and the same two optional cases skipped. The 147-cent gateway case received 403 instead of 200; it passed in the first run. |
| Final focused selection after rebase, twice | PASS: seven files and 51 tests in each run. Includes both turn-removal cases, all seven earlier regressions, provider admission, queued-file refusal and membership checks. |
| Four isolated follow-ups after rebase | PASS: the gateway continuation, daily safety cap, 147-cent reservation and chat activity cases. Their causes remain unconfirmed; no assertion or timeout changed. |
| Browser navigation after rebase, twice | PASS: three tests in each run. |

Every one of the 629 runnable cases in the broad selection has at least two
passing results after the fixture correction and follow-ups. Both broad runs
passed the row 7 access cases and all seven earlier regressions. The paid OpenAI
and optional approval browser cases remain skipped. All test invocations set
`PG_TEST_URL` and use `nice -n 10`. Root repeats use one worker and run sequentially.

The final focused runner completed both 51-test runs, then its temporary follow-up
script exited with a quoting error before starting Vitest. The corrected script
passed the four follow-ups and both navigation repeats. This runner error did not
change a test result. The first lint run found the duplicated closing-read section.
Its removal retains the identical section beside decision activity. A concurrent
lint retry was stopped to leave resources for the test repeats. Required checks
are repeated before pushing.

The full root suite, paid calls and fresh-install departure and desktop
qualification remain NOT RUN. The merge train owns landing after GitHub CI.
