# Changelog

<!-- markdownlint-disable MD024 -->

## Unreleased

- Conversation feeds now carry tool start and finish records and tool access decisions, without tool arguments or results. Tool activity keeps approval reads and concurrent access checks working. Delivered uploads still load with their saved outcomes. Invalid tool names and call ids are skipped without stopping later reports.
- Model and tool calls keep working in long chats and on busy assistants.

- Organisation admins can create a shared assistant for a group, choose its grants and
  fixed paying group, and check or safely repeat a create whose reply was lost.
- Members can choose a shared assistant for a private conversation and see the fixed
  paying group id before opening it.
- Team chats are marked private. A lost computer pauses sending and explains recovery. Replies with lost output never show Done. A memory-free turn is a visible, separate choice that resets after sending.
- Operators: after updating an existing installation, stop the services and run `npm run replay -- computers` once before serving chat again. The new computer state is not filled from older events otherwise. Fresh installations need nothing.
- Starting a turn no longer slows down as an assistant's history grows.

- Streamed replies no longer slow down as a chat gets longer. Repeated turn starts are handled without saving them again.

- Starting a turn on a personal assistant no longer slows down as the silo's spending history grows. Resolving a spending hold reads history before starting its access check.

- Docker test fixtures remove their anonymous volumes when they remove containers.
- Spending reads only budget and call records, so long chats no longer make it fail. Unknown holds stay listed. Browser budget checks restore their test limits after a failed step.
- Model budget writes no longer slow down as the silo's spending history grows.

- A waiting assistant reply no longer makes the server reread finished chats. A turn the computer has not yet started is sent again until it starts.
- A message waits quietly when its assistant has no computer, and each chat poll reads created and closed chats together.
- Open chat pages repeat permission checks only when access records change. Idle pages no longer call the permissions service every 100 ms, and member removal still closes their connection within two seconds.
- Idle chat sockets check the conversation feed position and keep computer state between ticks, so they read chat content only after the feed changes.

- Group members' private chats with a shared assistant now use a temporary Codex process with tools off and files in a memory volume. Swap can still write private text to disk. Isolation is not yet proven on a live computer; memory features stay off until it is.
- Shared prompt files and skill instructions are now off in personal and memory-free Codex turns as well as private turns.
- Model and tool calls keep working when another chat, a file upload or someone else's access changes during the access check. Revocations, turn stops and approval invalidation still refuse calls, and unsent spending holds release at zero cents.

- Owners and admins can search the integration register and open a detail page with separate installed, connected, access and assistant-availability facts.
- Owners and admins can add a remote MCP server, follow discovery and set a mode for each reviewed tool. Saves are checked with reads and are never sent again after an uncertain reply.
- Rewrote the access, AI and shared-library READMEs for new engineers, and kept their detailed contracts in README.robot.md.

- The four app READMEs now explain their place in the system and what people can do with them.
- The event libraries now have plain guides for people, with detailed contracts kept in README.robot.md.
- Design folders and early experiments now have short guides for people, with the detailed records kept beside them.
- Infrastructure and developer-tool guides now explain in plain words what each folder does, with exact setup detail kept in companion files.
- Expired spending holds release at zero cents when a call was never allowed or sent. A failed final access check releases an unsent hold. A later unknown result restores the full hold for an allowed call. Provider retries leave live checks running and finish old interrupted checks as unknown without sending them again.
- The root README now explains in plain words what each part of OpenCrane does, with one system diagram and an honest status. A new glossary explains the shared words, and the planned customer installation now lives in docs/architecture/target.md.
- The live view of an assistant's computer stays up while the assistant works: a check that sees new chat, file or grant activity waits for the next check instead of closing the view. Real revocations still close it within 2 seconds. Live qualification of #77 is still pending.

- Fleet Codex work, Angular dev-server builds and repository checks run at lower CPU priority; repeated live-view receipts capture host pressure and server scheduling delay.

### What you can do now

- In a conversation, the person who asked can read a tool approval in full and approve or deny it; others see that it is waiting. Used, denied, expired and cancelled approvals fold to one line, and a lost decision is checked, never resent. Tool lines open a sanitised details panel. Live tool calls, retries and confirmed results are not available yet.
- Owners and admins can see flat groups, create one, open it, and remove a member after reviewing what they lose; adding members waits for a member list.
- Organisation settings now has the v2 navigation and phone menu; Integrations keeps the register, Spending owns budgets, and other unfinished areas say Not available yet.
- Screenshots now show one saving state, a captioned card with capture facts, a full preview with download, and plain failed, rejected, access-check and revoked states. Repeating an unanswered request returns the same file.
- Organisation settings now has the v2 navigation and phone menu; Integrations keeps the register, Spending owns budgets, and unfinished areas say Not available yet.
- Owners can appoint an active successor while retaining ownership, then separately step down to Admin; the last owner is protected, and lost responses can be checked by their original change reference. P4-2 screens and fresh-install qualification remain pending.
- Personal settings now opens from Account with workspace navigation, shows the current identity name, and marks unsupported profile and personal tool data unavailable.
- Owners and admins can save and rotate provider keys, reconcile lost replies, select registry models and inspect separate reachability and budgeted model-test evidence through the new backend interface; screens and model access remain pending.
- Phone file cards show full names. Your own uploads and screenshots can be downloaded in an
  open conversation. The spending-limit message says an Owner or Admin can help, or the limit
  resets each month. On phones, the message field sits above full-width, borderless attach and
  send buttons. The session panel leaves out placeholder Decisions and People sections.
- Admins can create a group assistant with selected grants, a fixed paying group and one computer. Members get their own chat transcripts and threads. Screens, personal credentials and fresh-install checks remain pending (#89).
- Two active silo members can create and use private direct chats through the backend, reload and reconnect to recorded messages, and check original command outcomes. Human messages start no assistant work; designed screens and fresh-install qualification remain pending.

- Group-derived spending and desktop access respect revocation, and removed members cannot read private approval cards. Fresh-install qualification remains pending.
- Owners and admins can see held model spend on Spending, check its recorded evidence, and settle or release it with a receipt or non-dispatch reference. Requester and work details, and Odoo readback, are not shown yet.

- Owners and admins can create flat groups and manage membership; group-derived spending and desktop access respect revocation, and removed members cannot read private approval cards. The designed screen and fresh-install qualification remain pending.
- File previews and computer/session panels now share accessible drawers and sheets; the mobile workspace menu traps focus, supports arrow keys and respects reduced motion.
- Reuse the v2 paper tokens, state vocabulary and reduced-motion loaders across the organisation and workspace screens.
- Members with desktop access can take a screenshot from a conversation's viewer, open it from chat or the session panel, and find it again after reload.
- The first authenticated member can claim a fresh silo as owner with an installation token that expires after 24 hours. Reuse and claims after membership exists are refused (#12).

### Fixed or improved

- Permission checks reuse their OpenFGA connection. The dev-stack journey can run
  again after its audit member has joined.
- Chat lists handle 60 sessions, and transcript reads and live sockets keep working
  while turns start and end. Team writes and new team turns check access after
  reading history with its own ten-second budget. Personal posts and turn admission
  keep their existing behaviour.
- Open chat pages check access again when silo or team membership changes. Idle pages
  do not call OpenFGA every 100 ms. Removals close within two seconds, and a change
  that takes more than five seconds to apply makes the page reconnect. The people in a
  chat are fixed when it is created; chat sockets do not watch participant changes yet.
- A payer or membership refusal fails only that shared turn. The bridge stays open
  for other members. Stop remains available after payer removal.
- Team screenshots return 403 before capturing the shared desktop. Assistant lists
  mark whether the caller can start work. Team spending requires the assistant's payer.
- Group routes return 503 while access changes are still being applied, so clients
  can retry shortly.
- Existing personal sessions start a fresh Codex context on their next turn when
  their old journal entries have no requester id. Their chat history is retained.
- Idle installations stop rereading chat and usage history, repeating computer mode patches
  and recording the same budget timeout. New messages, computer wakes and usage still use
  the existing polling intervals.

- PDF upload turns no longer hang when the model stream is cut: the models service rides out
  short event-store hiccups, restarts itself after 15 seconds of real outage instead of
  sitting idle, and upstream aborts reach Codex promptly (#113).
- Live view pauses and hides the picture while access can't be confirmed and resumes by itself, instead of closing; explicit revocation still closes within 2 seconds (#77).
- Live view retries access checks that do not answer for up to 5 seconds, and says it couldn't confirm access instead of Access changed or Not available when they time out (#77).
- Gateway startup failures now include the gateway's stderr error line and exit status; test
  fixtures clean up spawned services after timeouts and worker shutdown.
- Added comments and names for the existing gateway accounting and audit rules; behaviour and
  budget limits are unchanged.
- Live-view diagnostics now correlate admission, desktop startup, first-frame forwarding and every permission check without logging credentials or pixels ([#77 diagnosis](docs/process/i77-live-view.md#post-admission-diagnosis--4-october-2026)); the loaded live batch still fails qualification.
- Authority reads recover from brief event-store outages and event-loop stalls through bounded retries. Late live-view check failures count as missed checks and cannot revoke a valid 1,500 ms lease; timely denials still close the viewer. Gateway and approval deadlines stay unchanged (#136).

- Owners and admins can read populated monetary-effect lists through one bounded replay. The P3-15 backend records evidence-backed resolutions, retains uncertain reservations and preserves larger late usage charges; its designed screen and fresh-install qualification remain pending.

- Live viewers keep a valid permission lease when an older authority check is late, including during connection setup; revocation deadlines stay unchanged ([#77 evidence](docs/process/i77-live-view.md)).
- Oversize file uploads return HTTP 413 with a clear size limit, and chat shows “File too large” ([#117](https://github.com/elewa-git/opencrane-new/issues/117)).
- Work is under way to publish reviewed MCP tools, let an owner take over a computer, control computer egress, and use a bootstrap token for the first owner.
- The computer bridge separates report journalling, turn running and socket message handling; behaviour is unchanged (#126).

### Known limits

- All members' turns on a group assistant share one disk and one browser profile.
  Uploads and attachments are refused until each member has their own workspace.
  Credentials for individual members must never be written to that disk or profile.
  Work files and browser activity are shared even when chat transcripts are private.

- Screenshots passed the retained secondary journey at 1280px and 390px, but fresh capture and complete startup journeys still hit live-view failures ([#77](https://github.com/elewa-git/opencrane-new/issues/77)). See the [screenshot receipt](docs/process/p3-18-screenshots.md#final-rebase-and-secondary-stack-qualification--4-october-2026) and [qualification ledger's NOT RUN list](docs/process/ledger.md#still-not-run) for the qualification limits.

Technical note: in-flight work has no merged PR number yet.

## Phase 3: Governed work (in progress)

### What you can do now

- Owners can set each tool to Allow, Ask or Block; the gateway enforces the choice.
- Members can approve or refuse a specific tool action after seeing what it will do.
- Owners and admins can register a remote MCP server and review its discovered tools; new tools remain blocked until reviewed.
- Developers can try company access with real user rights in a disposable Odoo test system.
- Owners can set monthly budgets for paying groups and assistants.
- Members can watch an assistant's computer read-only from a conversation. Access ends when its grant is revoked.
- Members can see what happened to their requests. Owners and admins can review safe organisation change history.

### Fixed or improved

- Chat reserves against a request-sized estimate instead of the full model context, so ordinary requests can fit under small daily and group limits. The rendering margin is a planning allowance; live provider tokenisation is NOT RUN (#76).
- Uploaded files are scanned before storage or delivery, and edits survive reconnects and computer restarts.
- An assistant's computer cannot use the upload store's credentials.

### Known limits

- Publishing MCP tools for computer use, computer takeover and controlled computer egress are still in flight. Authority reads and fresh-install qualification remain open in [#70](https://github.com/elewa-git/opencrane-new/issues/70); complete MCP startup and live-view journeys remain unreliable in [#77](https://github.com/elewa-git/opencrane-new/issues/77).
- Uploads passed hosted CI and two real-model PDF checks after two failed paid turns (four turns, 13 cents combined). The latest local full suite failed before the hosted CI pass; the latest fresh main-stack handback failed in the no-grant live viewer (#77). The paid checks preceded the final budget/MCP rebase, and Office previews are NOT RUN. See the [ledger](docs/process/ledger.md#still-not-run) for these and other NOT RUN items, including live provider tokenisation against the budget allowance.

Technical note: merged PRs #68, #72, #78, #65, #71, #73, #74 and #76. Uploads (#79) are listed under Phase 2.

## Phase 2: Talk to your computer

### What you can do now

- Each member gets a private computer that can sleep, wake and keep its files when a computer Pod is replaced.
- The owner can sign in to the dev silo with their own account; members can sign in and out with Zitadel.
- Members can chat with an assistant and see its reply arrive as it is written, including after reconnects and computer restarts.
- Members can attach a file in chat, preview supported files, and ask the assistant about a PDF.
- Members can start a chat with a sleeping computer and receive its reply after it wakes.

### Fixed or improved

- A sleeping computer reaches its first reply in about 9 seconds in the stub measurement, down from about 11.5 seconds.
- Chat replies survive reconnects, sleep and loss of the computer Pod.
- Files are scanned before use, and an assistant's computer does not receive storage credentials.

### Known limits

- Real-provider wake latency is NOT RUN. Physical-device sign-in across Safari and Firefox is NOT RUN. Office previews are NOT RUN, and the completed upload handback journey failed. See the [qualification ledger](docs/process/ledger.md#still-not-run) for the full list; upload follow-up is tracked in [#79](https://github.com/elewa-git/opencrane-new/pull/79).

Technical note: merged PRs #34, #35, #36, #37, #38, #39, #64, #66 and #79.

## Infrastructure

### What you can do now

- Developers can create a fresh local silo and repeat its core journeys on the dev stack.
- Developers can run two extra isolated stacks alongside the stable owner stack.
- Owners and admins can see organisation settings and the registered MCP server list; ordinary members are refused (#20).
- The owner can use a personal account to sign in to the dev silo.

### Fixed or improved

- Projection data can be rebuilt from the event history, and the dev stack checks fresh, reused and restored journeys.
- Zitadel sign-in and parallel secondary journeys have development evidence. Owner membership and account admission were checked in #37; the owner’s own interactive browser sign-in was NOT RUN there, and #69 did not rerun it after restoring the owner app.

### Known limits

- Managed-cluster high availability, failover and disaster recovery are NOT RUN. Complete MCP startup journeys failed in the live-view steps; see [#77](https://github.com/elewa-git/opencrane-new/issues/77) and the [ledger](docs/process/ledger.md#still-not-run).

Technical note: merged PRs #20, #22, #23, #35, #37, #69 and #78.

## Phase 1: Foundation

### What you can do now

- An invited person can join an organisation, and members see the live member list update.
- The browser reconnects to the member list without missing or repeating changes.
- Each service has its own NATS access, with encrypted connections and limited rights.

### Fixed or improved

- Member invitations are accepted once, including when requests are retried or arrive at the same time.
- A slow browser can reconnect and catch up; the server shuts down within its configured grace period.
- Projection state can be rebuilt from events, which remain the source for changes.

### Known limits

- A product first-owner bootstrap path is still in flight; the dev stack has a dev-only owner bootstrap. The Phase 1 core journeys passed on a fresh dev stack (#23); managed-cluster qualification remains NOT RUN; see the [qualification ledger](docs/process/ledger.md#still-not-run).

Technical note: merged PRs #4, #5, #6, #16, #17, #21, #22 and #23.

<!-- markdownlint-enable MD024 -->
