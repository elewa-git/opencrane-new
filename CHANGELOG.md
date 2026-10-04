# Changelog

<!-- markdownlint-disable MD024 -->

## Unreleased

- Fleet Codex work, Angular dev-server builds and repository checks run at lower CPU priority; repeated live-view receipts capture host pressure and server scheduling delay.

### What you can do now

- Owners and admins can create flat groups and manage membership; group-derived spending and desktop access respect revocation, and removed members cannot read private approval cards. The designed screen and fresh-install qualification remain pending.
- Members with desktop access can take a screenshot from a conversation's viewer, open it from chat or the session panel, and find it again after reload.
- The first authenticated member can claim a fresh silo as owner with an installation token that expires after 24 hours. Reuse and claims after membership exists are refused (#12).

### Fixed or improved

- Added comments and names for the existing gateway accounting and audit rules; behaviour and
  budget limits are unchanged.
- Owners and admins can read populated monetary-effect lists through one bounded replay. The P3-15 backend records evidence-backed resolutions, retains uncertain reservations and preserves larger late usage charges; its designed screen and fresh-install qualification remain pending.

- Live viewers keep a valid permission lease when an older authority check is late, including during connection setup; revocation deadlines stay unchanged ([#77 evidence](docs/process/i77-live-view.md)).
- Work is under way to publish reviewed MCP tools, let an owner take over a computer, control computer egress, and use a bootstrap token for the first owner.

### Known limits

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
