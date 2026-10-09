# Event catalogue: which event triggers which logic

This file is the **contract** between the parts of OpenCrane 2. Every state change is an event. Every piece of logic is either:

- a **projection**, which turns events into content in PostgreSQL; or
- a **reaction**, which does something and may emit new events.

If it isn't in this catalogue, it doesn't happen. CI checks two things:

- every event type in code appears here, with at least one consumer or the label "audit only";
- every handler in code subscribes only to events listed here.

## Principles

1. **The event store is the only source of truth.** Commands validate and then do **one conditional append** to one stream. They write nowhere else.
2. **PostgreSQL holds content, not truth:** who owns what, installed MCP servers, conversations, budgets and so on. Every table is a **projection** with a checkpoint, and can be dropped and **rebuilt by replay**.
3. **Order is guaranteed within a stream, never across streams.** Each stream is handled by one writer at a time, so projections need no locks. Handlers recheck current state when they depend on another stream.
4. **Projections and reactions are separate.** A replay rebuilds projections only. Reactions (waking a computer, pushing gateway config, sending mail) keep their own checkpoints, are idempotent, and are switched off during a rebuild.
5. **No secrets and no plaintext history in events.** Events carry secret *references*. Message and memory text is encrypted with a per-conversation or per-scope key, so "forget" deletes the key (crypto-shredding) and appends a tombstone event.
6. **An event never grants anything.** Permissions come from the OpenFGA projection, which is rebuilt from events like any other.
7. **Idempotency is by event id, not by the event store's duplicate window.** Every projection and reaction records the event ids it has applied (in the same Postgres transaction as its checkpoint), and commands use expected-sequence appends. JetStream's `Nats-Msg-Id` de-duplication only lasts for its duplicate window, is lost on backup/restore, and is **stream-wide** (an id first used on another subject makes the append report a duplicate and store nothing), so it is an optimisation, never the guarantee (found in spike S0.7).
   - A retried **command** is recognised from the stream itself: the envelope carries `commandId` (a non-empty string; optional for older events), and the command checks the entity history it already loads before appending. There is no separate command ledger: a ledger written after the publish leaves a gap, and a ledger restored to a different point than the stream re-runs commands.
   - New command appends require `commandId` and a principal (including system commands). Command ids are scoped to the principal and the entity's subject; a client-supplied idempotency key never becomes a global id.
   - An append whose acknowledgement says `duplicate` is accepted only if it points at the expected subject.
8. **Brief write pauses are normal.** When the JetStream stream leader fails, writes pause for roughly 5–8 seconds while a new leader is elected (measured in S0.7). Commands retry with backoff, and the UI shows the message as "saving" rather than failing.
9. **Money is integer euro cents.** Every amount in an event is a whole, non-negative number of euro cents, in a field whose name ends in `Cents` (`costCents`, `ceilingCents`), never a float in euros, so sums stay exact.

## How events are delivered (NATS JetStream)

- **Layout:** one JetStream stream per silo (`EVENTS`), replicated R3, with unlimited retention and regular backups. **Each entity stream is a subject:** `ev.<stream-type>.<id>`, for example `ev.conversation.123` or `ev.budget.acme`.
- **Conditional append:** a command publishes with `Nats-Expected-Last-Subject-Sequence` set to the sequence it read. If another write got there first, JetStream rejects the publish; the handler reloads and retries. Every message also carries `Nats-Msg-Id` (the event id) for deduplication.
- **Order:** within a subject, messages are strictly ordered. The stream as a whole has one sequence, which gives a global position.
- **Projections:** one **ordered consumer** per projection, filtered by subject (e.g. `ev.member.>`). The projection row and the consumer's last sequence are written **in the same Postgres transaction**, so a restart resumes exactly where it stopped.
- **Reactions:** one durable consumer per silo feeds the dispatcher, which enqueues each event into pg-boss `key_strict_fifo`, keyed by subject and deduplicated by event id. That gives order per stream, parallelism across streams, retries and dead-letter.
- **Reading one entity's history** (to validate a command): fetch the subject's messages, or better, read the entity's projection plus its last sequence and use that sequence as the expected value.

## How a command works

```text
 API / gateway decision / computer report
        │
        ▼
 command handler ── reads projections + OpenFGA (may be milliseconds stale)
        │
        ▼
 conditional append to ONE stream (expected version) ──▶ event store
        │                                                    │
        │ returns the new stream position                    ├─▶ projections (ordered per stream) ─▶ PostgreSQL content
        ▼                                                    ├─▶ OpenFGA projection
 UI waits until its projection reaches that position         └─▶ reactions (ordered per stream, retry, dead-letter) ─▶ new events
```

If a stale read slips past validation, the expected-version check rejects the append, and the handler reloads and tries again.

## Streams

| Stream | One per | Examples |
| --- | --- | --- |
| `org-<silo>` | silo | settings |
| `member-<user>` | person | invited, joined, role changed, removed |
| `ownership-<silo>` | ownership | current owners; appointment and separate step-down |
| `team-<team>` | team | created, members |
| `assistant-<id>` | personal or team assistant | created, settings |
| `computer-<assistant>` | assistant's computer | claimed, ready, suspended, lost, takeover |
| `toolset-<profile>` | computer profile (an image plus Codex built-in tool settings) | changed |
| `conversation-<id>` | conversation | participants, messages, agent activity |
| `approval-<id>` | approval request | requested, decided, used, expired, cancelled |
| `decision-<request>` | gateway admission attempt | allow, ask or deny before dispatch |
| `effect-<permit>` | gateway-observed external call | observed, uncertain, resolved |
| `mcp-<server>` | MCP server in the catalogue | registered, discovered, tool modes, published, tools changed |
| `credential-<lease>` | request-bound credential release | released |
| `egress-<request>` | observed egress | observed |
| `gateway-<request>` | safe gateway evidence | observation recorded |
| `provider-<providerId>` | company model provider | configuration and verification |
| `connection-<user>-<server>-<profile>` | credential connection | created, refreshed, revoked |
| `view-<session>` | bounded desktop view | started, stopped |
| `grant-<resource>` | shared resource (type and id) | given, revoked |
| `budget-<silo>` | silo budget (all ceilings) | ceiling set, reserved, settled, period started |
| `scope-<id>` | brain permission scope | memory written, corrected, forgotten, consolidated, promoted |
| `routine-<id>` | scheduled routine | created, due, paused, retired |
| `delegation-<id>` | delegated child task | started, completed |
| `security-<silo>` | silo | alerts |

## Catalogue

### Gateway decisions

| Event | Producer | Projections | Reactions |
| --- | --- | --- | --- |
| `credential.released` | credential broker (P3-8; fixture contract) | audit lease metadata only | none; never release on replay |
| `egress.observed` | egress observer (P3-18; fixture contract) | audit | none; never dispatch on replay |
| `gateway.observation_recorded` | safe gateway log ingest | audit, including unverified JWT failures | none; no asserted requester identity |
| `decision.recorded` | ext_authz | audit; MCP decisions feed conversations with turn id, outcome, reason, request id and optional call id and approval id; model budget refusals keep only turn id and reason | none; admission is not an observed effect |

Each admission attempt records `requestId`, `route`, `outcome` (allow/ask/deny),
`reason` and `contextDigest`. Verified callers also carry `requesterId`,
`assistantId`, `conversationId` and `turnId`; model allows include `permitId`.
Approval decisions include `correlation.approval`; consumed approvals also include
the server-issued request id as `permitId`, matching `approval.used`.
Unverified identities are omitted. A failed append denies dispatch. Gateway JWT
refusals before ext_authz have no decision event; observation reconciliation belongs
to P3-19. No raw arguments, tokens or credential values appear in this event.

### Organisation, members and teams

Product groups reuse team ids and exact `team-<id>` subjects. Creation and additions
may include `membershipSource` (`local` or `identity_provider`); old events mean
local. Group names cannot contain a NUL character, so accepted events can replay
into PostgreSQL text. Supplied identity-provider membership is read-only to local commands.
Group membership grants neither conversation participation nor personal-memory
access. Each group id is also its paying-group id; shared work never falls back to
the personal default.

| Event | Emitted by | Projections (content) | Reactions (logic) |
| --- | --- | --- | --- |
| `org.created` | install | org | create the budget stream with defaults; generate gateway config |
| `member.invited` | admin command | invitations, members (pending) | send the invitation |
| `silo.owner_bootstrapped` | authenticated installation-token claim | members, identities | OpenFGA owner/member; seed ownership; emit `assistant.created` (personal); seed model `grant.given` |
| `member.joined` | invitation accepted | members | OpenFGA `member`; emit `assistant.created` (personal); seed model `grant.given` |
| `member.role_changed` | non-owner role command | members | OpenFGA role tuples |
| `member.removed` | non-owner removal command | members | OpenFGA delete; emit `connection.revoked` for each connection; suspend the person's computer; audit |
| `ownership.seeded` | fenced installation migration or bootstrap reaction | current owner set | OpenFGA seed receipt after existing owner tuples converge |
| `ownership.transferred` | Owner command | successor role and owner set; payload-free change evidence | OpenFGA owner tuple and atomic receipt; previous owner remains |
| `ownership.stepped_down` | current Owner command | actor becomes Admin; owner set retains at least one owner | OpenFGA delete owner role, retain member/add Admin and atomic receipt |
| `team.created` / `team.member_added` / `team.member_removed` | Owner/Admin command, or supplied identity-provider membership | flat group names, membership and grant-source views | OpenFGA `team#member` tuples and atomic receipts |

Ownership edits use only `ownership-<silo>`. Migration seeds the current active
owners from legacy member events once; the seed append also conditionally checks
the captured global sequence. New writes cannot use a stale seed. Fresh claims
seed through the durable `seed-ownership` reaction. No owner edit is enabled until
seeding succeeds. Acceptance of an Owner-role invitation and rejoining an active
member are refused. Recording an invitation grants no authority; the members
projection preserves an active member's identity and role when they are invited
again. Other member-stream events cannot change seeded owners or introduce an
owner; member and IAM projections reject these legacy bypasses. Non-owner member commands remain
P4-3 work. Ownership adds no conversation, memory, group or resource grant.
The [ownership interface](../api/ownership.md) exposes the original event receipt,
recorded actor/target/time and both projection statuses, without a second ledger.

`member.invited` pre-allocates `memberId`; invitation and acceptance share
`member-<memberId>` so one conditional append settles concurrent acceptance.
New invitations for the server acceptance path carry `invitedIdentity` (OIDC
`issuer` and `sub`) and `expiresAt` (an ISO timestamp with offset). These fields
are optional only for replay of older events; the command refuses invitations
without either field. Email is contact data, never proof of identity. The server
also checks the session organisation against its configured organisation and
every event's silo against its configured silo. It accepts only the latest,
still-pending invitation, before its expiry, using its email and role.
Fresh acceptance also requires a verified session email equal to the invitation
email after trimming and ignoring case. The inviter must still be an active
Owner or Admin. A removed stream or earlier different identity cannot be reused.
The final access check watches the joining member, inviter and ownership streams.
General sign-in exceptions do not bypass the exact organisation check here.

`member.joined` from this command always carries `invitationId`. The command id
is scoped to the accepting principal and member subject. An exact retry returns
the earlier sequence without appending, even after invitation expiry or later
removal; it reports the earlier command's success and does not restore membership.
Changed invitation/display-name arguments with the same key are refused. A race
with another command reloads history and returns a refusal without a second
append; the caller can retry after reconsidering the result. Invitation creation
and identity binding are separate work.

Owner decision, 2 October 2026: production installation prints a one-time token
with a 24-hour expiry. Only its hash and expiry live in a private local file.
`POST /api/silo/claim` requires a same-origin authenticated session from the
configured Zitadel organisation. The token creates the first owner of a fresh
silo. Any membership history disables bootstrap, including pending invitations
and removed members; an existing member cannot claim ownership with the token.
One conditional append at expected sequence zero across `member-*` records
`silo.owner_bootstrapped` on `member-bootstrap-owner`, including that OIDC
identity and owner role. Identity bindings live on member streams, so this same
append checks that the claimant's binding stream and all other member streams
are still empty. Concurrent claims or membership writes cause a conflict without
an event or token consumption. Historical owner refusals retain `owner_exists`
or `token_used`; other membership history returns `members_exist`.
Ownership transfer belongs to #24. Neither the token nor its
hash is event data. Projection/reactions treat this event as a joined owner,
including identity binding, personal assistant and initial model grants. The
model process seeds the installation's default paying group as for every owner.
The dev stack retains its explicit invitation/join bootstrap for `jente@elewa.ke`.

### Assistants and computers

| Event | Emitted by | Projections | Reactions |
| --- | --- | --- | --- |
| `assistant.created` | reaction or admin | assistants (owner, kind, scope, fixed team payer) | OpenFGA `acts_for`; claim one computer; personal model defaults or explicit team resource `grant.given` |
| `assistant.settings_changed` | owner or admin | assistants (model, persona, tools) | update the computer's configuration on next wake |
| `computer.claimed` | server (claim intent) | computers (generation, token id) | reconciler creates the claim and delivers the committed credential |
| `computer.ready` | reconciler (Pod ready, credential delivered) | computers (Sandbox and Pod UIDs) | deliver queued messages and decisions |
| `computer.turn_started` / `computer.turn_closed` | server turn command | admission and idle-suspend fence on the computer stream | started binds the requested message, thread and `executionMode`; closed is permanent |
| `computer.suspended` / `computer.resumed` | server (intent) | computers (resume has the rotated token id) | reconciler applies operating mode; resume delivers refreshed credentials |
| `computer.lost` | server (Pod gone) | computers | mark in-flight effects of this computer `effect.uncertain`; re-claim when needed |
| `computer.retired` | server | computers | delete snapshots after retention |
| `computer.view_refused` | authenticated proxy | audit | Safe refusal metadata on `view-<attemptId>`; no connection or lifecycle effect. The additive reason `unavailable` means access checks did not answer within the 5 s retry window, or the member lookup was unavailable. |
| `computer.view_started` / `computer.view_stopped` | authenticated proxy | audit | Audit on `view-<sessionId>`; no lifecycle effect or replayed connection. Start records a maximum two-minute ticket and stop records its reason. The additive reason `unavailable` means there was no confirmed access for 10 s, either before the first valid lease or after a lease lapsed. |
| `takeover.started` / `takeover.ended` | live-view proxy | computers, audit | pause / resume the agent |
| `toolset.changed` | admin command (publishes a computer profile) | toolsets | notify admins for review; computers adopt it at their next claim or resume |

Computer credentials are short-lived signed tokens. `computer.claimed` and
`computer.resumed` store only the active token id; the signing key is deployment
configuration referenced by file path, and no token value is event data. The
Sandbox UID is the durable Kubernetes identity: native suspension and Pod
replacement keep it and the computer's PVC while `generation` advances after loss.
Commands decide from one stream snapshot and conditionally append before any
Kubernetes effect. A duplicate or conflict returns committed state and token id.
The reconciler retries committed intent after restart. `computer.ready` records
its owned Pod UID; readiness changes alone never emit loss. Pod absence or UID
replacement emits `computer.lost`. Old event shapes remain readable; new readiness
observations include both UIDs. Suspension revokes access immediately at the gateway;
turn tokens bind to the committed computer token id and cannot survive rotation.

There are two kinds of tools, so two events. `mcp.tools_changed` is for a registered MCP server's tools. `toolset.changed` is for the computer's own tools: a new computer image (CLI programs, runtimes, local stdio MCP such as Playwright) or Codex built-in tool settings (`shell`, `apply_patch`, `web_search`, `view_image`, `spawn_agent`). It goes on the profile's own stream rather than on each computer's, because one admin command changes every computer that uses the profile and a command appends to one stream only. Hosted built-ins such as `web_search` are allowed or stripped by the gateway on the model request.

Ready and resumed events carry the claimed `computerId` and `generation`.
Generation is optional in the schema so older events remain readable. Model
authorisation requires the signed generation to match the current claim and an
explicit matching Ready event. A historical resume grant inherits its claim
generation; it still requires its rotated token id and a newly observed Ready event.

### Conversations and agent activity

| Event | Emitted by | Projections | Reactions |
| --- | --- | --- | --- |
| `conversation.created` | command | conversations (immutable `mode`: `agent_session` binds one assistant; `direct` records exactly two distinct `participantIds`, including `createdBy`, with no assistant; group admission is deferred; missing mode in older assistant events reads as `agent_session`) | OpenFGA participants |
| `participant.added` / `participant.removed` | command | conversations | OpenFGA participants; chat sockets do not watch these changes yet (#216) |
| `message.posted` | person, or the system for routines | messages | browser delivery (WebSocket) in every mode; only `agent_session` dispatches to its assistant's computer and wakes it if suspended |
| `agent.turn_started` / `agent.turn_completed` / `agent.turn_failed` | bridge (reported) | activity (`executionMode` on starts; `restricted_tool_refused` on failures) | browser (WebSocket); notify on failure |
| `agent.turn_stop_requested` | member command | activity; freeze partial text at this position | bridge interrupts an active turn; queued turns do not start; browser keeps partial text on replay |
| `agent.message_delta` | bridge (reported) | messages | encrypted text deltas; browser replay with positions and generations |
| `agent.message_completed` | bridge (reported) | messages | browser (WebSocket). Encrypted deltas are retained for gap-free replay |
| `agent.output_lost` | bridge (reported) | activity | browser (WebSocket); never replayed into context |
| `agent.reasoning_summarised` | bridge (reported) | activity | browser (WebSocket) |
| `agent.command_ran` / `agent.file_changed` | bridge (reported) | activity | browser (WebSocket) |
| `agent.tool_call_started` | bridge (reported) | call id, server id and tool name; no arguments | conversation feed; browser (WebSocket) |
| `agent.tool_call_finished` | bridge (reported) | call id, server id, tool name, completed/failed status and optional duration; no result or error text | conversation feed; browser (WebSocket) |
| `file.uploaded` | upload or explicit screenshot command after a clean scan and promotion | conversation files, conversations | deliver bytes over the bridge; wake a suspended computer |
| `file.rejected` | upload or screenshot command after an infected verdict | conversations | refuse the upload clearly; no bytes stored |
| `file.delivered` | command after the computer acknowledges verified bytes | conversation files, conversations | browser may show the workspace path and delivery outcome (`saved` or `kept_existing`); reconnects skip acknowledged files |
| `conversation.closed` | command | conversations | tell the computer to stop work for it |

Screenshot files use the same `file.uploaded` / `file.rejected` contract. Their
optional `screenshot` metadata records `computerId`, positive `generation`, UTC
`capturedAt`, `width` and `height`; the existing fields retain conversation,
author (`uploadedBy`), PNG MIME type, size, object key and SHA-256. Ordinary uploads
omit this metadata. Only the authenticated capture path supplies it. Capture uses
one bounded framebuffer request on an explicit member command; replay never captures
pixels or scans bytes again. Screenshot reads require current conversation participation
and membership, independently of the original capture's desktop grant.

Bridge reports describe activity and grant no authority. The separate server turn
command binds the requested message to its Codex thread, requester, task and
execution mode on the computer stream. A terminal server event is permanent.
The same stream prevents idle suspend while an admitted turn remains open.

Private team turns use a fresh process and ephemeral thread. After a bridge
restart or Pod replacement, every unfinished private turn fails, including one
that was prepared but never executed. It never runs again without a new message.
Memory-free turns keep their persistent Codex thread: prepared turns retry with
a fresh grant, while turns with an execution marker fail and never repeat.

The private journal on the computer's disk holds only report sequence, type and
ids, marked `memoryOnly: true`. Reply text remains in bridge memory until an
acknowledgement or a reconnect position confirms storage. A replay whose text is
gone becomes `agent.output_lost`. Reports retain per-computer sequence numbers,
stable event ids and per-conversation predecessor checks. Reconnect uses the
largest contiguous committed position. A lost-output replay over an already
stored text report is a duplicate; it does not replace that saved text.

After admission, the server rebuilds context from conversation events with its
own ten-second read budget. Only the requester's earlier human messages start
exchanges. Completed replies may arrive after the next message was posted.
Whole newest exchanges fit within 24 KiB of JSON. Unfinished or lost-output
exchanges include only their time and `not_completed`, without request text.
Deltas, reasoning, tool results, files, approvals and decisions are excluded.
Context goes only in an admitted private start acknowledgement and is never
stored. Memory-free turns receive no earlier private context.

### Tools, approvals and effects

P3-2 approval requests include expiry, `lossless-json-v1`, server/tool/schema,
connection/profile and policy-sequence bindings, plus bounded encrypted review
content, key reference and review digest. Plaintext arguments are never events.
Requester decisions and consumption append conditionally to `approval-<id>`.
Expiry (24 hours) or a closed logical turn prevents use; a changed reviewed binding
cancels. Consumption is terminal even if its acknowledgement or forwarding fails.
Readers replay these streams; replay never forwards or releases credentials.

| Event | Emitted by | Projections | Reactions |
| --- | --- | --- | --- |
| `tool.approval_requested` | decision service (mode Ask) | approvals | notify the requester; approval card |
| `approval.decided` | requester | approvals | deliver the decision to the computer (wake it) |
| `approval.expired` | timer | approvals | tell the computer |
| `approval.cancelled` | decision service / approval reader | approvals | close the card when its logical turn or binding changes |
| `approval.used` | decision service (single use) | approvals | — |
| `effect.observed` | gateway log ingest | audit, usage | settle the actual cost; with no matching permit or a reservation overrun → `security.alert_raised` |
| `effect.uncertain` | settle timeout or `computer.lost` | audit, effects | notify for manual resolution |
| `effect.resolved` | Owner/Admin | audit, effects | evidence, reservation id and integer settledCents; settle or release through settle-budget |

### MCP catalogue, grants and connections

| Event | Emitted by | Projections | Reactions |
| --- | --- | --- | --- |
| `mcp.server_registered` | admin | catalogue (draft; transport kind and optional catalogue reference) | validate (SSRF / image scan) → `mcp.server_discovered` or `mcp.server_rejected` |
| `mcp.server_discovered` | reaction | catalogue (valid tools, schema digests, optional server identity and safe per-tool rejection reasons) | — |
| `mcp.server_rejected` | reaction (validation failed) | catalogue (rejected, with reason) | notify the admin |
| `mcp.tool_mode_set` | Owner/Admin | tool modes per installed connection and tool revision | next ext_authz call reads current policy |
| `mcp.server_published` / `mcp.server_unpublished` | admin | catalogue | regenerate gateway config |
| `mcp.tools_changed` | drift check | catalogue | quarantine the server in gateway config until re-reviewed |
| `grant.given` / `grant.revoked` | admin or owner; initial model grants from reaction or upgrade | grants | OpenFGA tuples |
| `connection.created` | person | connections (secret *reference* only) | — (the credential is written to the secret store inside the command, before the append; a clean-up job removes orphaned secrets) |
| `connection.refreshed` | reaction (OAuth refresh) | connections | — |
| `connection.revoked` | person, admin or reaction | connections | delete the secret |

### Budgets (single-writer actor per silo)

| Event | Emitted by | Projections | Reactions |
| --- | --- | --- | --- |
| `budget.ceiling_set` | admin | budgets | — |
| `budget.reserved` | budget actor (inside `ext_authz`) | budgets | — |
| `budget.settled` | budget actor (on `effect.observed` or admission rejected before dispatch) | budgets, usage | — |
| `budget.period_started` | timer (00:00 UTC on the 1st) | budgets | — |
| `budget.exhausted` | budget actor | budgets | notify admins; stop affected work (hard stop cascades) |

The Phase 2 model actor records the global monthly `ceilingCents` and
`dailyCeilingCents` together. Reservations include `modelCall`: model, pinned
price-table id, computer, assistant, requester, conversation, thread and turn,
and a digest of the checked IAM context. Gateway observations add integer
`inputTokens`, `outputTokens` and optional `cachedInputTokens` / `cacheWriteTokens`
under `usage`; settlement selects short/long context from total input and releases
the unused reservation. Prices are integer euro cents at the pinned planning FX,
rounded upwards once per call. The catalogue has no model configuration events:
the eleven allowed models, price table and explicit task routing are pinned source
configuration (owner decision, 2 October 2026). Nano and mini are refused; chat
turns use 6.1 Sol, demanding tasks Astra, and scoped automations Luna. The server
binds the task kind and routed model into the signed turn grant;
admission refuses a different request model before any reservation or provider
access. Historical reservations retain their recorded tariff id when replayed.
Retired nano and mini price rows settle pending usage at their original tariff;
unknown models or tariffs produce `effect.uncertain` with reason `unknown_tariff`,
retain the full reservation and allow later usage processing to continue.

The actor is elected with a PostgreSQL session advisory lease, used only for
process leadership. It reads the budget stream once and serialises commands in
memory. A `budget.period_started` append on leadership acquisition fences the
previous writer; a failed conditional append disables that actor. This event
never clears reservations. UTC day/month totals are derived from reservation
timestamps; outstanding reservations count against both caps even across a
period boundary. Observed provider rejections without usage produce
`effect.observed` with `outcome: error` and `costCents: 0`, releasing the unused
reservation. Ambiguous outcomes (including timeouts and lost connections) produce
`effect.uncertain` after three minutes and keep the full reservation.
If an allowed call reports uncertainty after a zero-cent release, the actor writes
`budget.settled` with `settledCents: 0` and `outcome: unknown` to hold the full
reserved amount again. Duplicate reports and replay preserve that hold.
If the audit or final authority fence rejects before a permit is returned, the
actor instead appends `budget.settled` with `settledCents: 0` and
`outcome: not_dispatched`. This releases the reservation without an effect;
expiry and replay preserve that settlement. Expiry also writes this settlement
when a hold has no matching allow decision, no provider dispatch record and no
effect or security record. A hold that may have been sent is never refunded by time.
`settle-budget` retries a recorded
observation or operator resolution through the decision process; duplicate settlement is a no-op.
It also records uncertainty for outstanding reservations of a lost computer.
`effect.resolved` binds `permitId`, `reservationId`, `resolvedBy`, `outcome`,
`settledCents` and evidence. Evidence is an opaque receipt reference and SHA-256
hash, with either a provider-receipt integer amount or a dispatch record proving
non-dispatch. The Owner/Admin attests the evidence; it is not an automatic provider
verification. No raw response, conversation content or credential is included.
Conflicting or insufficient evidence cannot resolve a hold. Distinct final
observations are retained; conflicting amounts keep the full reservation and the
largest recorded charge. The `budget.settled` outcome `unknown` records that hold;
replay never lowers its recorded amount. A status read sends no external action.
Native gateway fields are derived from the final streamed usage, including cache
reads/writes. Streamed replies are never parsed as one JSON document. Missing or
malformed usage and transport failures record uncertainty. Gateway log timestamps
are ignored: agentgateway 1.5 drops leading fractional zeros, so ambiguous or
malformed values determine neither budget periods nor ordering. Reservation event
time owns attribution, and stream sequence owns causal order.
The budget projection can be rebuilt with reactions disabled. Cap refusals append
`budget.exhausted` once per unchanged configuration and scope per UTC day, including across
actor recovery. P3-1 records every admission separately as `decision.recorded`.
Legacy model refusals used `security.alert_raised` with an optional `decision` record:
verified requester/assistant ids when available and a context digest, never tokens.

P3-13 extends `budget.ceiling_set` in the same stream: `scope: global`
holds the monthly `ceilingCents`, optional `dailyCeilingCents` and optional
`defaultPayingGroupId`; `paying_group` and `assistant` name `scopeId` and a
monthly `ceilingCents`. All amounts are safe integer EUR cents. A zero ceiling
blocks spending; an absent scoped ceiling adds no limit. Changing a ceiling
never erases usage or outstanding reservations. Global defaults remain 20,000
monthly and 2,000 daily cents. Installation explicitly configures its personal
paying group; there is no silo-id fallback.

`conversation.created` may hold an explicitly selected shared `payingGroupId`.
At work admission, the server binds that group, or the installation's configured
default for personal work, into `computer.turn_started.payingGroupId`. Retries
keep the admitted value; descendants must carry the inherited value. Missing
shared attribution refuses admission. Every model call reads the admitted turn,
never a client-supplied group. One `budget.reserved` checks global, paying-group
and optional assistant ceilings and counts the same charge against them all.
The outer reservation group also restores legacy nested calls during replay.
Late settlement retains the original reservation timestamp, group and tariff.

`budget.period_started.periodStart` is the first day of the UTC month at 00:00.
The elected actor records rollover on its existing timer and fences old leaders
on acquisition. Reads and reservations derive periods from UTC timestamps, so
reset is exact even while the timer is catching up. Unknown reservations count
against every applicable current ceiling until settled. `budget.exhausted`
names the refused scope and is deduplicated per unchanged configuration/scope/day.
Hard-stop cascades and manual uncertainty resolution belong to P3-14/P3-15.

`mcp.server_discovered.tools[].costCents` may be explicitly zero for a reviewed
non-metered tool such as the Odoo fixture. An allowed tool with absent cost is
refused as `unknown_cost`. Discovery hints alone never establish price or access;
hosted provider tools with unknown prices remain disabled.

### Memory

| Event | Emitted by | Projections | Reactions |
| --- | --- | --- | --- |
| `memory.written` | OpenCrane memory MCP (remember) | Postgres memory projection for that scope | mark that scope for nightly dreaming |
| `memory.corrected` / `memory.forgotten` | OpenCrane memory MCP (correct/forget); nightly per-scope dreaming job (corrected only) | Postgres memory projection for that scope | forget: delete the payload key, then tombstone |
| `memory.consolidated` | Reserved for later use; not emitted by MVP dreaming | Postgres memory projection for that scope | — |
| `scope.promotion_requested` / `scope.promoted` | person / approver | scopes | OpenFGA viewer tuples; copy to the target dataset |

For the MVP, `memory.*` events in NATS JetStream are the truth; the Postgres memory projection holds facts per scope and uses full-text search. Replay applies recorded changes without model calls. Scopes are person, assistant notes and flat group only, with no organisation or department memory. Any group member may write group memory without approval. Each member works in their own thread or sub-agent of the group assistant, with personal memory plus group memory; preferences stay personal and shared knowledge goes to the group.

Codex reaches the OpenCrane memory MCP through the local forwarding proxy and agentgateway. `ext_authz` passes allowed scopes from IAM context (assistant grants ∩ requester rights); per-thread turn tokens keep each member's personal memory out of other threads. Memory is never written to the shared computer's disk. Preferences and pinned facts enter the thread's instructions at turn start with a size cap; the rest is fetched with `recall`.

Nightly dreaming runs per scope in the handler runtime, using a cheap model through the gateway with a budget. It merges duplicates, flags contradictions and expires stale facts through `memory.corrected`; it never crosses scopes. `memory.consolidated` and the existing scope-promotion rows are retained for contract compatibility, with no MVP emitters or promotion reactions enabled. The stream table's older scope description includes these deferred operations. Sharing data across groups is a later design topic.

Cognee is deferred until after the MVP; it may become another projection fed by replaying the same memory events plus document ingestion, without changing the agent's tools.

### Routines and delegation

| Event | Emitted by | Projections | Reactions |
| --- | --- | --- | --- |
| `routine.created` / `routine.updated` / `routine.paused` / `routine.resumed` / `routine.retired` | person | routines | schedule the next firing |
| `routine.due` | scheduler | routines (last firing) | emit `message.posted` to the routine's assistant; one firing only |
| `delegation.started` / `delegation.completed` | parent or child computer | delegations | deliver the child's result to the parent |

### Security

| Event | Emitted by | Projections | Reactions |
| --- | --- | --- | --- |
| `security.alert_raised` | any reaction | alerts | notify admins |

### Company model providers

| Event | Trigger | Projection | Reaction |
| --- | --- | --- | --- |
| `provider.created` | Owner/Admin command | provider metadata and OpenFGA silo relation | No key, model call or grant. |
| `provider.key_saved` | Owner/Admin command after secret custody | provider metadata | Invalidate current reachability/model evidence; never a grant. |
| `provider.models_selected` | Owner/Admin command | provider metadata | Registry selection only; grants belong to P4-22. |
| `provider.verification_requested` | Owner/Admin command | provider metadata | Explicit live check only; no replay dispatch. |
| `provider.verification_dispatched` | authenticated gateway admission | provider metadata | Consume one check, with existing budget reservation for paid tests. |
| `provider.verification_recorded` | live verification reaction or explicit skip | provider metadata | Dated original-attempt outcome, including late results. No dispatch means unknown and zero-cost release; never raw responses or credentials. |

## Named handler subscriptions

These queue names and subscriptions are checked against `libs/events` by
`check:events`. A host enables a handler explicitly. `update-members` can
wrap the members projection; [authz](../../libs/authz/README.md) implements
`update-openfga` for provider, member, assistant, conversation, team and resource-grant
events. Desktop admission additionally requires an explicit member
`shared_desktop` grant. Scope promotion remains deferred.

| Handler | Subscribed events |
| --- | --- |
| `settle-budget` | `effect.observed`, `effect.resolved`, `computer.lost` |
| `update-members` | `member.invited`, `member.joined`, `silo.owner_bootstrapped`, `member.role_changed`, `member.removed`, `ownership.seeded`, `ownership.transferred`, `ownership.stepped_down` |
| `update-openfga` | `provider.created`, `member.joined`, `silo.owner_bootstrapped`, `member.role_changed`, `member.removed`, `ownership.seeded`, `ownership.transferred`, `ownership.stepped_down`, `team.created`, `team.member_added`, `team.member_removed`, `assistant.created`, `conversation.created`, `participant.added`, `participant.removed`, `grant.given`, `grant.revoked` |
| `seed-ownership` | `silo.owner_bootstrapped` |
| `seed-model-grants` | `member.joined`, `silo.owner_bootstrapped`, `assistant.created` |
| `create-assistant` | `member.joined`, `silo.owner_bootstrapped` |
| `claim-computer` | `assistant.created`, `computer.lost` |

## Rebuilding content

1. **Deploy the new projection code.** It writes to shadow tables with its own checkpoint.
2. **Replay from the beginning** in order per stream. Reactions stay off.
3. **When the shadow catches up to live, switch reads over** and drop the old tables.

The same procedure recovers from a corrupted projection, adds a new read model, or restores a silo from event-store backups. **Content tables never need their own backup to be correct**; they are backed up only to shorten restore time.

### P3-1 tool policy bindings

`mcp.server_discovered` may carry an installed `connectionId`, explicit `accountMode` (`none`, `personal`, `company`) and a bounded tool list with `name`, schema
`revision`, `reviewed` and optional `readOnly`/`destructive` hints. Legacy discovery
remains replayable but grants no execution. Duplicate names fail closed. Discovery
resets modes to Block; hints only suggest a choice. Drift/unpublish/rejection
quarantines execution. A new publication cannot restore a changed tool's old mode.

Discovery may also carry `rejectedTools`: up to 1,000 excluded declarations with
an optional safe `name`, a definition `revision` digest and a fixed `reason` code.
These entries carry no definition or policy and are excluded from `toolCount`
and `schemaDigest`. They remain available in event-backed discovery status for
review; legacy events without this field remain readable. See the
[discovery validation contract](../../apps/server/README.robot.md#remote-mcp-registration-p3-3).

`mcp.tool_mode_set` adds `connectionId` and `toolRevision`; both must match the
current reviewed tool for execution. Legacy name-only events remain readable but
do not grant execution. Commands check live Owner/Admin and event membership,
require the current stream sequence and conditionally append once to `mcp-<server>`.
The catalogue stores the same TypeScript-folded policy and rebuilds it by replay.

`assistant.settings_changed` accepts `active` and the `active` changed field.
An explicit inactive assistant cannot dispatch; later activation restores eligibility
only after all current checks pass. Existing events retain their meaning.

`computer.turn_started` and the nested `budget.reserved.modelCall` may carry
`payingGroupId`. Team work requires this explicit turn binding; personal work
uses the installation default. Group ceilings remain P3-13 work.

Grant commands use `grantStream(resourceType, resourceId)` from `libs/authz`: the
suffix is base64url of the UTF-8 JSON pair `[resourceType, resourceId]`. Every grant
and revocation for that resource uses the same stream, across all grantees. The
OpenFGA reaction rejects other subjects, so the existing per-stream worker order
prevents a delayed grant from overtaking revocation. Event receipts make later
redelivery harmless; chronological replay produces the same denied state.

### Permission-scoped audit (P3-19)

`decision.recorded` is admission, not an observed outcome. Model reservations carry
`modelCall.requestId`; the decision maps that request to its permit. Settlement and
observations join by permit. The optional envelope `correlation.request` lets
forthcoming approvals, credential releases, MCP publication/drift, egress and
computer takeover share the request/conversation/turn; approval lifecycle events
may instead join by `approvalId`. Computer-wide evidence may carry only the
conversation/turn pair: audit reads fetch that indexed pair and associate records
without another request/permit, refusing a mismatched requester. Owning feature tickets emit those records and add
integration assertions. P3-19's forthcoming-family records are typed fixtures only.

`gateway.observation_recorded` retains only a server-issued UUID, a bounded
outcome and a reason code. The decision returns its request id on authenticated
refusals; gateway evidence retains that id through ingestion and replay. JWT
failures receive a fresh gateway id per failure, ignoring caller correlation
headers. JWT failure before ext_authz asserts no requester,
conversation or turn. Safe JSONL evidence survives an event-store outage for later
ingest. No raw gateway log, timestamp, token, body or argument enters that file.
The gateway's fractional timestamp defect is ignored: ids join records and event
positions show append order, without claiming causal order between streams.

Confirmed `egress.observed` success or error determines the permitted egress
summary, just as `effect.observed` does for a model call. Missing observations
remain unknown.

The budget reaction raises one `security.alert_raised` for an unmatched model
observation, including a reservation without an allowing decision. Missing usage
keeps the reservation and outcome uncertain. Projection replay dispatches nothing,
releases no credential and settles no money. See the
[audit read contract](../../apps/server/README.robot.md#permission-scoped-audit-p3-19).

If the actual model cost exceeds its reservation, settlement retains the full
charge and raises one `security.alert_raised` per permit with reason
`budget_reservation_exceeded`. Its optional `overrun` record names `model`,
`reservedCents` and `settledCents`; envelope `correlation.permit` binds the alert.
The actual charge counts against every applicable ceiling on later admission,
including after actor recovery. Retrying settlement after an alert outage repairs
the alert without charging twice.

### Remote discovery evidence (P3-3)

Remote registration uses one source-derived server stream and stable `chg_` reference.
Its install reaction appends exactly one terminal discovery or rejection event;
projection replay never dispatches requests. Discovery stores the complete
`discoverResult` as immutable JSON text, immutable `tools[].definition` JSON text and SHA-256 `revision`
for each definition. Definitions use `lossless-json-v1` (sorted keys, preserved
number text). `schemaDigest` hashes the sorted name/revision inventory. The event
admits up to 1,000 tools; old events without definitions remain readable.
Every newly discovered tool is unreviewed and blocked. Discovery does not create
an installed connection, publish a route or grant access. Rejection reason
`connection_required` projects Needs input, awaiting P3-9's scoped validation
connection; other rejection reasons project Failed.
