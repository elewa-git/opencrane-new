# Phase 3 — Governed work tickets

<!-- markdownlint-disable MD024 -->

Repeated subheadings are intentional: each ticket is a future issue body, following
issues #26–#32. The orchestrator adds the published spec as Parent and resolves P3 ids to
issue links. **Do not publish these drafts automatically.**

All tickets inherit the [spec](spec.md), [decision defaults](decisions.md) and the
Phase 2 fresh-journey PASS start gate. Each is one complete feature PR; estimates
below include tests/docs and exclude generated files. Keep each near or below
1,500 changed lines, reuse existing seams and trim breadth before adding a framework.
If a measured implementation exceeds the bound, split a complete user outcome
before building; never leave a backend-only or screen-only half as a finished ticket.

Every ticket updates its event catalogue, typed schemas and owning documentation
together; commands make one conditional append, projections replay without effects,
and tests include a real refusal. Required root lint/typecheck/test/check:events and
separate web build/tests are landing gates. Each PR reports source readiness and
remaining live qualification, without claiming a skipped check passed.

**Main path:** P3-1 → P3-2 → P3-3 → P3-4 → P3-5 → P3-8 → P3-9 → P3-12 → P3-22.
Hosted installation P3-6 and Odoo fixture P3-11 also gate Odoo. Drift P3-7 and
startup-only fallback P3-10 join at the journey. **Parallel frontiers:** scoped
budgets P3-13, live view P3-16, audit P3-19, egress P3-20 and the Odoo fixture
P3-11 can start after the shared Phase 2 gate. Ticket order is topological, not an
instruction to delay independent work. At most two stacked PRs; merge completed
features before extending a long dependency chain.

## P3-1 — Set and enforce per-tool Allow / Ask / Block

### What to build

An admin edits tool modes in an installed integration and sees their effect through
the gateway. Extend the existing register and decision service; use a reviewed MCP
fixture until the installer lands. Budget: 1,100–1,400 lines. Decisions D01–D03.

### Acceptance criteria

- [ ] Allow automatically, Ask and Block are saved through events per installed connection/tool revision and survive replay; new/unreviewed tools are Block. Reviewed hints suggest defaults without granting access.
- [ ] A real gateway call in Allow runs, including a first permitted write; Ask returns approval required without forwarding; Block never forwards. Unknown tool names and prototype-like names fail closed using map lookup.
- [ ] Decisions read the full applicable IAM context and query live OpenFGA for requester ∩ assistant on model and MCP routes; the egress route later uses the same check. No credential/memory scope is fabricated for fixtures. Cross-user/silo/thread, inactive entities, missing context and revocation within two seconds are tested.
- [ ] Each allow/ask/deny records requester, assistant, request id, outcome/reason and context digest before any allowed dispatch. Schema/catalogue additions are compatible with the parallel audit work.
- [ ] The tools screen works at desktop and 390px, with keyboard-operable controls, glyph plus words, pending/error/access-changed states and no enabled save for non-admins.

### Blocked by

None (can start after the shared Phase 2 gate).

## P3-2 — Decide one bound approval from the 8g card

### What to build

The requester reviews an Ask call, approves or denies it, and a gateway retry can
consume that exact approval once. Deliver the event/API/card path against the real
gateway fixture. Budget: 1,250–1,500 lines. Decisions D04–D08.

### Acceptance criteria

- [ ] `tool.approval_requested` carries complete safe, durable review details and expiry. The 8g card shows exact action, target, data sent, destination, account/profile and consequence; missing consequential details prevents approval.
- [ ] Bind silo, requester, conversation, logical turn, assistant, server/tool/schema revision, connection/profile and lossless argument digest. No mutation endpoint accepts browser-supplied authority or replacement arguments.
- [ ] Canonical JSON vectors cover reordered keys, nested/escaped duplicate keys, `__proto__`, `constructor`, large integers, exponent/fraction text, negative zero, invalid Unicode and hidden arguments. The forwarded body agrees with the approved bytes.
- [ ] Conditional decision/consumption appends handle duplicate requests, two tabs, two simultaneous retries and lost acknowledgement; at most one retry reaches upstream. Denial, expiry, cancellation, used approval, changed binding and revoked rights refuse without creating reusable authority.
- [ ] Show requested, submitting, approved/denied, expired, cancelled, failed-safe-to-retry and outcome-unknown states. Pending cards restore above the composer; terminal cards collapse and never reopen after reload.
- [ ] Requester-only decision uses session/CSRF protection. Conditional step-up verifies recent OIDC `auth_time`; no invented €5,000 threshold. Show “Sign in again” only when required.
- [ ] Desktop and 390px comparisons match 8g with wrapped details, full-width primary mobile action, 44px targets, focus restoration, live announcements and reduced motion. Participant/admin substitution is refused.

### Blocked by

- P3-1.

## P3-3 — Register and discover a remote MCP safely

### What to build

An admin enters a remote URL and receives a bounded, reviewable tool inventory or
a clear rejection. Nothing becomes callable from a computer yet. Budget:
1,100–1,450 lines, mainly adapted remote transport. Decisions D09–D10.

### Acceptance criteria

- [ ] Registration appends an event and returns a stable change reference; validation/discovery reactions update the register. Reload offers Check status and never creates a duplicate registration.
- [ ] Reused SSRF controls reject non-HTTPS, embedded credentials, redirects, invalid TLS, private/loopback/link-local/metadata/reserved IPv4/IPv6, mixed DNS and rebinding. The guarded remote upstream adapter pins the connected address with original TLS hostname and accepts only server-selected endpoints from the gateway/install worker.
- [ ] Only the install worker's scoped identity reaches the quarantine route, limited to `server/discover` and `tools/list`; ordinary computers cannot use it, and it cannot invoke tools.
- [ ] Require 2026-07-28, `_meta` version/capabilities, method headers and a full DiscoverResult including resultType, supportedVersions, capabilities, serverInfo, ttlMs and cacheScope. Legacy/session-only servers are rejected.
- [ ] Follow bounded pagination, reject duplicate tool names/invalid schemas and store reviewable immutable tool definitions plus per-tool and inventory digests. Enforce request/response/time/tool-count limits and safe errors.
- [ ] Admin source/review states follow frames 4a–4b at desktop and 390px. Protected discovery shows Needs input for a scoped validation connection until P3-9; never claim an undiscovered server is Ready.

### Blocked by

- P3-2 (stable review and approval binding contract).

## P3-4 — Publish reviewed routes and grant tool access

### What to build

An admin reviews a discovered server, publishes it, grants people/teams/assistants
access and can revoke or remove it. A permitted gateway call proves the whole
path. Budget: 1,200–1,500 lines. Decisions D02, D11.

### Acceptance criteria

- [ ] Generate the route, CEL coarse allowlist, ext_authz binding and route-specific header allowlist from the same reviewed revision. Apply as one configuration generation; Ready requires acknowledgement of its digest.
- [ ] ext_authz refuses unreviewed, unpublished, stale-generation or quarantined servers even while an old route exists. Failed/unknown publication is reconciled by change reference, never blind retry.
- [ ] Forward only `server/discover`, `tools/list`, `tools/call`; reject batches, duplicate keys, forbidden keys, case variants, resources/unknown methods, missing metadata/version, method/tool header mismatch, GET/session/handshake and oversized bodies without truncation.
- [ ] Recording upstream proves computer/turn bearer tokens and arbitrary client headers are absent; credentials are overwritten on every route. No credentials appear in gateway logs or generated files. Actual post-publication calls still use the guarded remote transport; a DNS change after review cannot reach a private address.
- [ ] `grant.given`/`grant.revoked` project people, team and assistant access into OpenFGA. Both requester and assistant must have current permission; revocation is effective within two seconds even with projection lag. Team fixtures do not add group-management UX.
- [ ] Frames 4c–4g show separate Installed, Connected, Allowed for and Available to the assistant facts, review summary, affected users and removal consequences at desktop and 390px. Uninstall does not delete the upstream account.

### Blocked by

- P3-3.

## P3-5 — Use governed MCP tools from a live chat turn

### What to build

A real Codex turn discovers and calls a published fixture through its private proxy,
pauses for the 8g approval and continues after the requester's decision. Budget:
1,000–1,400 lines. Decisions D02, D04, D09.

### Acceptance criteria

- [ ] Pin the existing Codex version, enable `mcp_2026_07_28` and pin `protocol_version`. Real traffic has no legacy initialise/session/GET path; a regression test catches feature-flag drift.
- [ ] Extend the existing private proxy to derive the live thread from MCP `_meta`, cross-check signed context, and forward the unaltered validated request with computer/turn tokens. Missing/foreign/ended thread is refused; tools cannot authenticate to this proxy.
- [ ] Keep the application turn waiting across approval while rotating short-lived grants after current checks. Do not transfer an approval to a new turn; denial/cancellation ends that pending action.
- [ ] Approval notification, wake, retry and result survive reconnect without duplicate effect. A pending approval on one thread never blocks another thread's reports or execution.
- [ ] Remove the channel's blanket native-approval override, retain on-request harness behaviour and handle its requests explicitly. Native Codex consent cannot grant gateway permission or bypass Ask; unsupported native requests fail visibly.
- [ ] Tool/approval/refusal lines and continuation work on desktop and 390px. Lost Pod or an uncertain dispatched call shows Check status and is never automatically resubmitted.

### Blocked by

- P3-4.

## P3-6 — Install a signed and scanned hosted MCP image

### What to build

An admin chooses a pinned image and completes the same discover/review/publish
flow, with isolated deployment and verifiable image admission. Budget:
1,100–1,450 lines. Decision D12.

### Acceptance criteria

- [ ] Admit only immutable image digests with trusted publisher signature, dated vulnerability/malware scan evidence and reviewed licence/SBOM results. Reject tampered/unsigned images, forbidden/unknown licences, Critical/High findings, malware and unavailable/stale scanners.
- [ ] Reuse the existing image licence gate and small ClamAV adapter; record OC1 source commit in copied code. Signature and vulnerability checks are separate from ClamAV; every added runtime tool has an OSI licence.
- [ ] Run under a least-privilege identity in `<silo>-mcp`, outside gateway/computer, with limits and NetworkPolicy admitting only gateway traffic and the declared upstream. Discovery initially uses quarantine; scanner success alone cannot publish.
- [ ] A pinned hosted fixture completes discovery/review/publication and a granted gateway call; ungranted and arbitrary egress calls fail in the real cluster.
- [ ] Package install, applying, rejected and unknown-outcome states work at desktop and 390px; removal cleans up only the owned workload after access is disabled. Replay cannot create duplicate deployments or rerun scans as business authority.

### Blocked by

- P3-4.

## P3-7 — Hold changed MCP tools for re-review

### What to build

An admin sees exactly what changed and restores service by reviewing the new
revision; changed servers cannot keep serving under old approvals. Budget:
750–1,100 lines. Decision D13.

### Acceptance criteria

- [ ] A bounded watch obeys discovery TTL and the five-minute maximum; record fresh checked evidence. Expired evidence or a failed check stops calls until a successful check.
- [ ] Added/removed tools or schema changes emit `mcp.tools_changed` and immediately quarantine the server in ext_authz and generated configuration. Old grants do not bypass quarantine.
- [ ] Tool-level comparison preserves old evidence, flags changes and defaults new tools to Block. Re-review and acknowledged publication are required; old approvals are invalid even if the tool name is unchanged.
- [ ] Tests change a live fixture during a pending approval and during config reload; neither call reaches the changed tool with old authority. Failed watch/config reactions survive restart and replay without silently restoring Ready.
- [ ] Frame 4f comparison, unavailable and restored states work at desktop and 390px. Clearly explain that the server is paused for review.

### Blocked by

- P3-4.

## P3-8 — Connect a personal bearer profile and release it per call

### What to build

A person connects, rotates or revokes a bearer account, then uses it from chat.
The gateway releases only that requester's selected profile; an admin can explicitly
configure a company account. Budget: 1,200–1,500 lines. Decisions D08, D14–D16.

### Acceptance criteria

- [ ] Credentials enter only the secret store; events/projections carry ids and safe metadata. Adapt exact generation/UID/version custody checks. Secret staging before the single append is reconciled; orphan cleanup cannot delete a referenced current generation.
- [ ] A stateless fixture receives a request-bound lease/injected credential after live identity, grant, mode/approval and budget checks. Every release is recorded with user, profile, computer, tool and request before forwarding; audit/secret-store failure denies.
- [ ] Leases expire within 30 seconds, are unusable for a second/foreign request and leave no lasting material in gateway, computer, event, log or browser storage. Client credential headers are overwritten.
- [ ] Concurrent Alice/Bob turns on one assistant use their own accounts. Identity arguments and a missing profile cannot select someone else's credential or fall back to the assistant owner/company account.
- [ ] Company account use requires admin opt-in and explicit connection selection; both setup and approval name whose upstream account acts. Personal revocation/rotation and admin disable stop old releases within two seconds.
- [ ] My tools connection/rotation/revocation and company setup work at desktop and 390px, show scopes/account model, clear secret inputs on acceptance and recover unknown outcomes by change reference.

### Blocked by

- P3-5.

## P3-9 — Complete OAuth consent, refresh and reconnection

### What to build

A person consents to an integration, makes a governed call and sees clear recovery
when consent or refresh expires. Protected discovery can use a separately scoped
validation connection. Budget: 950–1,350 lines. Decision D17.

### Acceptance criteria

- [ ] Authorisation-code/PKCE flow binds state to signed-in user, profile, server, exact redirect and issuer. Forged/replayed state, wrong user/silo/provider, bad code and stale consent fail without connecting an account.
- [ ] Show required scopes before consent; disabled tools do not expand them. Validate OAuth discovery/token destinations through the SSRF guard; no arbitrary callback or token endpoint.
- [ ] Store access/refresh material only in the secret store, rotate refresh generations safely, and release access material only through P3-8. Concurrent refreshes converge; invalid grant marks Needs input with no silent bearer/company fallback.
- [ ] A real disposable OAuth provider demonstrates consent → call → expiry → refresh → revoke. Secret-store failure, lost callback/append response and refresh races have durable recoverable outcomes and no token logs.
- [ ] Credential-required quarantine discovery uses an explicit admin-owned validation profile and discovery-only lease, audited like every release. It gives no user tool grant or normal route access.
- [ ] Consent, connected, expired, revoked and reconnect states work at desktop and 390px; reloading during completion checks the original change instead of starting a second connection.

### Blocked by

- P3-8.

## P3-10 — Run startup-only MCPs in isolated personal instances

### What to build

A person can use a reviewed integration that accepts short-lived startup credentials,
with an isolated instance that wakes on demand and stops when idle. Budget:
800–1,200 lines. Decision D16.

### Acceptance criteria

- [ ] One instance per silo/user/profile runs in `<silo>-mcp`; neither shared gateway nor user computer hosts it. Route binding derives from checked identity, never a caller-selected Pod/URL.
- [ ] A startup-only fixture accepts renewable short-lived secret material, serves a governed call, scales to zero after five idle minutes and restarts with fresh material. A dependency requiring a lasting startup secret is rejected explicitly.
- [ ] Revoke/rotate terminates or fences the old instance before a new release. Old generation routes, other users and expired material cannot call it; every material release is audited.
- [ ] Real cluster tests prove cross-user isolation, upstream-only egress, no persisted credentials and restart without repeating a write. Show waking, unavailable and reconnect status at desktop and 390px.

### Blocked by

- P3-6.
- P3-8.

## P3-11 — Provide a reproducible Odoo Community test instance

### What to build

An operator starts a fresh local Odoo Community environment with synthetic orders
and two ordinary test users whose rights differ. This is a verifiable dev feature,
not a production ERP deployment. Budget: 500–850 lines. Decisions D18–D19.

### Acceptance criteria

- [ ] Pin Community 19 source/image and database versions, record LGPL-3 and the complete runtime licence review, and provide start/reset/stop instructions on the existing dev box. No Enterprise addon or production dataset.
- [ ] Seed a readable draft order and a restricted record; one user can update a draft note, the other cannot. Direct authenticated JSON-2 checks prove the expected ACL/record-rule outcomes and write attribution before MCP is introduced.
- [ ] Test keys are created through secure setup and referenced by id/path, never committed, printed, seeded as literal event values or returned to an agent. Restrict service access to the operator and named MCP upstream path.
- [ ] Fresh reset reproduces the same business fixtures and retains safe version/readiness/rights evidence. Failure to start or missing rights is FAIL/NOT RUN, not permission to substitute an administrator.

### Blocked by

None (can start after the shared Phase 2 gate).

## P3-12 — Read and approve a write in Odoo with the requester's rights

### What to build

Ship the narrow OSI-licensed Odoo MCP, install it through the real hosted pipeline,
connect a personal profile and perform one bounded read and approved draft-note
write from chat. Budget: 850–1,250 lines. Decisions D18–D19.

### Acceptance criteria

- [ ] Two reviewed tools, `read_draft_order` and `update_draft_order_note`, speak only 2026-07-28 with full discovery. Record the adapter's AGPL-3.0-or-later licence and pinned image scan/signature evidence; reuse existing HTTP/schema code with no generic ORM executor.
- [ ] The MCP accepts gateway-injected per-call credentials only, has no personal credential registry/cache, ignores caller identity arguments and reaches only the configured Odoo instance. No `sudo`, admin fallback or arbitrary upstream/model/method parameters.
- [ ] A requester reads their allowed order, receives the 8g Ask card, approves and observes exactly one note change. Odoo's `write_uid`/readback and OpenCrane audit identify the same requester.
- [ ] A second user's restricted read/write fails under their own Odoo rights even if OpenCrane grants or approval exist. Concurrent team-assistant requests do not swap profiles; explicit company connection shows bot attribution when tested.
- [ ] Deny, expired approval, changed note/order, revoked profile, schema drift and a lost write reply do not cause another write. Reconcile unknown outcomes by Odoo readback; no automatic retry and no exactly-once claim after ambiguous transport failure.
- [ ] Desktop and 390px chat shows readable tool result, approval, refusal and unknown-outcome states. Record a live Odoo receipt, not a mock-only PASS.

### Blocked by

- P3-6.
- P3-9.
- P3-11.

## P3-13 — Enforce monthly budgets for the paying group and assistant

### What to build

An admin sets EUR ceilings and sees one charge attributed to the global budget,
the selected paying group and optional assistant ceiling. Extend the existing
actor and model screen. Budget: 950–1,350 lines. Decision D20.

### Acceptance criteria

- [ ] Keep the existing pinned price table/routing and daily safety cap. All limits, reservations and charges are safe integer euro cents; reject fractions/overflow and unknown tariffs/costs.
- [ ] Bind paying group once at work admission; retries/descendants inherit it. Check all applicable ceilings in the existing single-writer actor and append one reservation, with one charge rather than three charges.
- [ ] Reserve a trustworthy prompt bound plus positive integer output bound times `n`, rounding up. Keep multiplicity fixed at one; absent, fractional, negative/zero, conflicting or unsupported bounds/multiplicity refuse before dispatch. Provider tools with unknown price stay disabled; reviewed non-metered Odoo calls are explicitly priced at zero.
- [ ] Concurrency at each ceiling, actor failover/fencing, restart/replay and UTC month/day rollover preserve outstanding reservations and original tariff/period attribution. No price editing or live FX subsystem.
- [ ] Admin budget display/configuration and user refusal message work at desktop and 390px. Seeded paying-group fixtures exercise rules without building Phase 4 group administration.

### Blocked by

None (can start after the shared Phase 2 gate).

## P3-14 — Stop affected work immediately at budget exhaustion

### What to build

When a hard ceiling is hit, affected work stops and the requester sees why. Old
reservations and delayed approvals cannot keep dispatching. Budget: 700–1,050
lines. Decision D21.

### Acceptance criteria

- [ ] `budget.exhausted` fences new model/provider/MCP dispatch for the affected scope, including calls under existing reservations, approved-but-unsent work and inherited child work. Global exhaustion affects all work; group/assistant exhaustion affects its scope only.
- [ ] The bridge receives cancellation/interruption and removes live turn grants. Tests prove a queued call and delayed approval never reach upstream after exhaustion; record the race boundary for already-dispatched calls.
- [ ] Keep collecting real usage for dispatched calls and retain uncertain reservations. Repeated notifications do not double-cancel, double-settle or erase the recorded result.
- [ ] Month rollover or an authorised ceiling change permits newly admitted work after current checks; it never automatically repeats an interrupted effect.
- [ ] Desktop and 390px show a persistent, accessible stop reason and the relevant limit/reset or admin remedy. Stop/cancellation races and event replay are verified with real dependencies.

### Blocked by

- P3-5.
- P3-13.

## P3-15 — Reconcile uncertain effects and settle actual usage

### What to build

An authorised operator checks an unknown effect and records evidence to settle or
release its reservation. The existing streamed settlement remains the normal path.
Budget: 850–1,200 lines. Decision D21.

### Acceptance criteria

- [ ] Final SSE usage or native gateway LLM fields settles the original tariff/reservation once, including cached input/write rates. Never parse a streamed reply as one JSON body.
- [ ] Missing final usage, transport failure, unknown tariff and lost computer keep a full reservation and show Outcome unknown. Duplicate/late/conflicting observations cannot double-charge or erase larger real charges.
- [ ] Gateway timestamp regression vectors cover dropped leading fractional zeros, month boundaries and malformed values; ambiguous timestamps never determine charging period or causal order. Reservation event time owns attribution.
- [ ] Owner/Admin can append `effect.resolved` with evidence and a validated integer amount or proof of non-dispatch; extend today's underspecified resolution payload. Check status reads evidence, never sends the external action again. Conflicting or insufficient evidence stays held.
- [ ] Resolution is idempotent under two operators and restart/replay; business decisions stay out of SQL. The safe resolution view works at desktop and 390px without disclosing private conversation details or credentials.

### Blocked by

- P3-13.

## P3-16 — View the computer through an authenticated proxy

### What to build

Current participants can open a read-only live desktop from the conversation.
Promote S0.5's proxy and bounded viewer, with product identity and permission checks.
Budget: 1,000–1,450 lines. Decision D22.

### Acceptance criteria

- [ ] Session/Origin/CSRF and current OpenFGA conversation plus shared-computer audience checks govern the proxy. Wrong silo, guessed computer, nonparticipant and revoked participant cannot obtain pixels; revocation closes existing sessions within two seconds.
- [ ] Browser talks only to the authenticated proxy; Kasm has no public endpoint. Ephemeral upstream credentials are injected privately and never sent to the browser. Check any viewer dependency's OSI licence; do not ship the excluded stock artwork/UI.
- [ ] Server-side read-only Kasm permission and proxy byte-stream parsing reject key/pointer, binary clipboard, file transfer and unknown/oversized messages, including fragmented/coalesced attacks, before forwarding their bytes.
- [ ] A stalled viewer hits the bounded buffer limit without affecting other viewers or restarting Kasm. Token expiry, wrong Origin and direct network access are tested in gVisor.
- [ ] Desktop and 390px viewer has fit/zoom, clear Connecting/Viewing/Disconnected/Access changed states, keyboard access and no misleading control affordance. Record real framebuffer proof and audited session identity.

### Blocked by

None (can start after the shared Phase 2 gate; S0.5 evidence is the prerequisite reference).

## P3-17 — Take control only after every agent thread is paused

### What to build

The current requester takes exclusive control, then explicitly returns the computer
to the assistant. Takeover is a durable computer-wide transition. Budget:
1,100–1,450 lines. Decision D22.

### Acceptance criteria

- [ ] Requester-only takeover conditionally records intent and fences new starts/calls across every thread on the computer. Participants, admins without requester status and a second simultaneous controller are refused.
- [ ] Interrupt all active Codex turns and confirm local commands/browser automation are quiescent before recording `takeover.started` and granting the writer. Pause timeout/failure yields no writer and leaves the agent paused; external effects already dispatched remain observed/uncertain.
- [ ] Control is bound to current computer generation, requester, conversation and expiring lease. A reconnect cannot recover an old writer lease; revocation, expiry, disconnect, Pod/proxy crash closes writer access and durably records the reason.
- [ ] On explicit release, close all writer tunnels before `takeover.ended` and new checked turns/tokens. No silent resubmission of pending approvals or external writes. Recovery after event-append failure starts paused.
- [ ] Real tests include two active conversations on one computer, a running local tool, two controllers, delayed upstream writer connection and crashes between each transition. No concurrent agent/human input reaches the desktop.
- [ ] Desktop and 390px show Taking control/You are in control/Agent paused/Returning control, clear failure recovery and 44px controls. Audit identifies who, computer, affected turns, start/end and reason.

### Blocked by

- P3-16.

## P3-18 — Capture and reopen an authorised screenshot

### What to build

A participant captures the visible computer and gets a durable PNG file card in
the conversation. Reuse the existing file upload/storage/view path. Budget:
550–900 lines. Decision D23.

### Acceptance criteria

- [ ] Capture uses the authenticated desktop path with conversation and computer-audience checks, bounded dimensions/size, fixed PNG encoding and no arbitrary URL/path input. Assistant capture is subject to the same current authority.
- [ ] Store bytes through existing file handling/scanning and append metadata with capture time, computer/generation, conversation, author and SHA-256. Failure is not shown as a saved screenshot; duplicate commands create one file result.
- [ ] Authorised preview/download survives reload; nonparticipant, foreign silo, revoked user and stale signed link cannot read it. No direct/public object or Kasm URL bypasses access.
- [ ] Desktop and 390px capture, progress, thumbnail, expanded preview and error states are usable and keyboard accessible. Pixel evidence comes from the real desktop; no continuous recording or separate artefact service.

### Blocked by

- P3-16.
- Phase 2 upload/file-view capability (#31), covered by the shared start gate.

## P3-19 — Explain work through a permission-scoped audit trail

### What to build

A requester traces their action and an admin inspects safe organisation change
history, joining authoritative events with gateway observations. Budget:
950–1,350 lines. Decision D24.

### Acceptance criteria

- [ ] Join decisions/context digest, approval lifecycle, credential releases, reservations/settlement, MCP configuration/drift, egress, effects and takeover by request/permit/conversation/turn. Display decision versus observed outcome separately.
- [ ] Deliver a real existing model-call audit path first; fixture events cover forthcoming event families through typed contracts. Owning feature tickets emit their records and add integration assertions; this is not a final consolidation PR.
- [ ] Unmatched effects raise `security.alert_raised`; missing expected observations remain uncertain. Gateway JWT failures before ext_authz retain safe correlation without asserting unverified requester identity. Event-store outage denies dispatch and never appears as an audited success.
- [ ] Drop/rebuild audit projections and replay gateway observations without duplicate decisions, charges, secret releases or effects. Handle the gateway timestamp defect without inventing order; event/correlation ids own joins.
- [ ] Admin metadata access does not reveal private conversation text, approval details, bearer material or raw arguments. Cross-user/silo reads and secret canaries in every log/event/UI path are tested.
- [ ] Desktop and 390px action history/change-history views show Loading/Empty/Unavailable/Outcome unknown, filters and readable reasons with keyboard support. No SIEM/export/retention subsystem.

### Blocked by

None (can start after the shared Phase 2 gate).

## P3-20 — Give commands governed package and Git egress (#18)

### What to build

An exec-server command can install an allowed package and clone an allowed Git host
through the authenticated egress broker. This is the first whole-feature slice of
existing #18, not a competing broker. Budget: 1,100–1,500 lines. Decision D25.

### Acceptance criteria

- [ ] `npm install` via the permitted registry/mirror and HTTPS `git clone` succeed from an exec-server command in a real gVisor computer. Delegate these operations over inherited IPC to a separate-UID network worker; ordinary tools remain socket-denied and never run with Codex's UID. The worker sees only its operation workspace and gateway, with bounded time/output.
- [ ] Issue a separate short-lived operation capability bound to silo, person, computer/generation, thread/turn and allowed destination. A command cannot choose another turn or use Codex's tokens/private proxy. Preserve S0.1b tests.
- [ ] Gateway enforces per-silo/person/assistant destination and port allowlists with validated DNS and pinned connections for each HTTP/CONNECT request. Only destination-bound, expiring tunnels are allowed and closed on revocation; log tunnel open/close without claiming visibility inside TLS. Refuse metadata/internal/mixed/rebound addresses, redirects to disallowed destinations, unrestricted tunnels, direct sockets/DNS/UDP and foreign/expired capabilities.
- [ ] Every request/refusal is attributed to the turn/person and reconciled into audit without secrets. Revocation, ended turn, gateway/decision/audit outage and budget hard stop prevent new egress.
- [ ] A minimal admin destination policy and chat egress refusal/status work at desktop and 390px. Show one concrete successful install/clone and each negative receipt; credentials for private Git are out of this slice.

### Blocked by

None (can start after the shared Phase 2 gate; #18 already names completed S0.1b/#13).

## P3-21 — Browse allowed sites without sharing Codex authority (#18)

### What to build

Playwright and the live desktop browser use the same governed network boundary
with their own caller capabilities and an unambiguous active requester. Budget:
800–1,200 lines. Decision D25.

### Acceptance criteria

- [ ] Playwright browsing from a command and Chromium browsing from the desktop reach an allowed test site through the broker/gateway. The desktop UID cannot use Codex or command-private capabilities.
- [ ] Bind desktop network access to the current requester/turn or active takeover lease; multiple active threads cannot silently pick the latest person's token. Refuse ambiguous ownership or unavailable context.
- [ ] Enforce destination/redirect/subresource/WebSocket policy, SSRF/rebinding and DNS controls. No unsupported tunnel, QUIC/UDP, direct provider or local-metadata escape; TLS handling and reviewed exceptions are explicit.
- [ ] Each network request records requester/turn and, during human control, the takeover correlation. Release/expiry/revocation stops the old capability. Browser access cannot fetch the requester's MCP secret or impersonate a tool call.
- [ ] A real gVisor browser journey passes alongside S0.1b isolation and live-view controls. Desktop and 390px show allowed browsing, blocked destination and disconnected states clearly.

### Blocked by

- P3-20.
- P3-17 (human-control identity and lease).

## P3-22 — Qualify governed work twice on a fresh dev stack

### What to build

Extend the existing fresh-install journey and deploy ledger to prove Phase 3's
done-when. This PR adds qualification and operator instructions, not unfinished
feature integration. Budget: 850–1,250 lines. Decision D26.

### Acceptance criteria

- [ ] Start twice from fresh dev state on the existing box/cluster. Install a remote fixture and the signed/scanned hosted Odoo MCP, review, publish, grant and connect through the actual product flows.
- [ ] With the requester's own Odoo profile, read an allowed record, deny one write, approve one exact write and verify its Odoo attribution/readback. Show explicit automatic first-write policy, blocked tool and two simultaneous team requesters with distinct credentials.
- [ ] Exercise OAuth refresh/revoke, bearer rotation, startup-only scale-to-zero fallback, schema drift/re-review and uncertain-effect resolution. A source-only substitute is NOT RUN for its live claim.
- [ ] Capture/reopen a screenshot, view as a participant, refuse participant control and complete requester takeover/release with all threads paused and a complete audit trail. Verify command package/Git egress and browser egress through #18.
- [ ] Run **every refusal set in the spec matrix**, including malformed protocol/canonical numbers, every approval binding, current IAM/revocation, secret/release failure, unsafe installs/destinations, Odoo rights, takeover recovery and isolation. Assert upstream absence for pre-dispatch refusals and safe held state for uncertain dispatched effects.
- [ ] Exhaust global, group and assistant ceilings under races and outstanding work; verify hard-stop cancellation, no dispatch under old reservations, integer settlement from final streamed usage, period rollover and no double attribution.
- [ ] Drop/rebuild affected projections and restart services/replace a Pod; preserve approvals, audit and reservations without repeating effects. Re-run root gates and separate web checks, with Linux desktop/390px visual/accessibility evidence.
- [ ] Receipts record date, SHA/image digests, fresh environment, commands, expected/observed outcomes and safe artefacts with PASS/FAIL/PARTIAL/NOT RUN. Establish remaining balance before any live-provider spend within the shared 500-cent envelope; otherwise label that condition NOT RUN. Do not equate dev PASS with Helm/HA/managed-cluster qualification.

### Blocked by

- P3-7, P3-10, P3-12, P3-14, P3-15, P3-18, P3-19 and P3-21 (their transitive blockers cover every earlier ticket).
