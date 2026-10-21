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
5. **No secrets and no plaintext history in events.** Events carry secret *references*. Message text uses a per-conversation key. Memory text uses a separate key for each fact revision. Forget records a tombstone first, then deletes every revision key and the searchable text.
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
| `conversation-<id>` | conversation | creation, messages and agent activity; older closes remain readable |
| `participation-<id>` | participation | participant additions, removals and conversation closes |
| `personal-<memberId>` | admitted person | private account, survey, persona and welcome content |
| `chat-state-<memberId>` | chat-state | one person’s archive and read choices, tied to a join |
| `approval-<id>` | approval request | requested, decided, used, expired, cancelled |
| `decision-<request>` | gateway admission attempt | allow, ask or deny before dispatch |
| `effect-<permit>` | gateway-observed external call | observed, uncertain, resolved |
| `mcp-<server>` | MCP server in the catalogue | registered, discovered, tool modes, published, tools changed, dispatch admitted |
| `mcp-instance-<instanceId>` | private MCP instance | start requested, observed, stop requested |
| `credential-<lease>` | request-bound credential release | released |
| `egress-grant-<subjectDigest>-<destinationDigest>` | one silo, subject and HTTPS destination | destination allowed or revoked |
| `egress-<request>` | observed egress | observed |
| `gateway-config-<silo>` | reviewed gateway entries | configuration requested; delivery is not connected |
| `gateway-<request>` | safe gateway evidence | observation recorded |
| `provider-<providerId>` | company model provider | configuration and verification |
| `connection-<user>-<server>-<profile>` | credential connection | created, refreshed, revoked |
| `connection-control-<user>-<server>` | admin block for a member's personal profiles | disabled |
| `view-<session>` | bounded desktop view | started, stopped |
| `grant-<resource>` | shared resource (type and id) | given, revoked |
| `budget-<silo>` | silo budget (all ceilings) | ceiling set, reserved, settled, period started |
| `scope-<id>` | brain permission scope | memory written, corrected, forgotten, consolidated, promoted |
| `routine-<id>` | scheduled routine | created, due, paused, retired |
| `delegation-<id>` | delegated child task | started, completed |
| `security-<silo>` | silo | alerts |

## Catalogue

### Private survey progress

| Event | Emitted by | Projections (content) | Reactions (logic) |
| --- | --- | --- | --- |
| `onboarding.survey_step_saved` | internal contract; command not exposed yet | personal-settings: current encrypted steps and saved receipts | none |
| `onboarding.survey_restarted` | internal contract; command not exposed yet | personal-settings: new generation with empty current steps | none |

Both events require schema version 1, the member's exact personal subject, a command id,
a matching human principal and the server source. The whole event is at most 16 KiB.
Steps 1–4 store ciphertext, key references and `ciphertextDigest`: lower-case 64-hex
SHA-256 of the exact decoded ciphertext bytes. Parsing and projection recompute it
without keys and refuse missing, malformed or mismatched digests. Text fields are at most 4 KiB;
name/pronouns are at most 200/100 characters and task choices at most 16.
Editing an earlier step removes later answers from current progress. Restart advances
one generation. Historical encrypted answers stay in the event log. These wishes grant
no access and start no model work. Replay copies ciphertext without touching keys.

### Gateway decisions

| Event | Producer | Projections | Reactions |
| --- | --- | --- | --- |
| `credential.released` | credential broker (P3-8; fixture contract) | audit lease metadata only | none; never release on replay |
| `egress.destination_allowed` | Owner/Admin destination command | egress-policy, audit | none; networking stays off |
| `egress.destination_revoked` | Owner/Admin destination command | egress-policy, audit | none; networking stays off |
| `egress.observed` | relay close reaction or admission refusal after a saved dispatch (networking disabled) | audit | none; never dispatch on replay |
| `gateway.observation_recorded` | safe gateway log ingest | audit, including unverified JWT failures | none; no asserted requester identity |
| `decision.recorded` | ext_authz, including operation-bound egress; server bridge for budget admission refusals | audit; MCP decisions feed conversations with turn id, outcome, reason, request id and optional call id and approval id; model budget refusals keep only turn id and reason | egress allows register one private relay only after the final zero-cost spending check; replay opens none; admission is not an observed effect |

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
| `member.command_refused` | command | safe audit history and original-command status | — |
| `member.invited` | admin command | invitations, members (pending) | none; link only, no email delivery |
| `silo.owner_bootstrapped` | authenticated installation-token claim | members, identities | OpenFGA owner/member; seed ownership; emit `assistant.created` (personal); seed model `grant.given`; prepare private personal key |
| `member.joined` | invitation accepted | members | OpenFGA `member`; emit personal `assistant.created` unless `personalAssistant: none`; seed model `grant.given`; prepare private personal key |
| `member.role_changed` | non-owner role command | members | OpenFGA role tuples |
| `member.removed` | reviewed non-owner removal command; optional `reviewRevision` for old events | members | OpenFGA delete; deny access immediately from events; `cleanup-departure` removes groups and personal grants and deactivates personal assistants; suspends idle personal computers, then records completion after OpenFGA receipts |
| `member.departure_cleanup_completed` | departure reaction after saved cleanup and OpenFGA receipts | member audit history; memberId, removalId and sections with up to 100 event ids each for groups, grants, assistant and computer | — |
| `ownership.seeded` | fenced installation migration or bootstrap reaction | current owner set | OpenFGA seed receipt after existing owner tuples converge |
| `ownership.transferred` | Owner command | request only when `awaitingConfirmation: true`; older events add the owner | confirm active successor on their member stream; OpenFGA request receipt |
| `member.ownership_confirmed` | appointment reaction | successor role and owner set | OpenFGA owner tuple and receipt |
| `ownership.stepped_down` | current Owner command | actor becomes Admin; owner set retains at least one owner | OpenFGA delete owner role, retain member/add Admin and atomic receipt |
| `team.created` / `team.member_added` / `team.member_removed` | Owner/Admin command, supplied identity-provider membership, or departure removal reaction | flat group names, membership and grant-source views | OpenFGA `team#member` tuples and atomic receipts |

Ownership commands save requests on `ownership-<silo>`. New appointments count only
after `member.ownership_confirmed` is saved on the successor’s member stream.
Removal and role edits use that same stream, so their conditional appends settle
the order without a database lock. Pending appointments grant no authority. Migration seeds the current active
owners from legacy member events once; the seed append also conditionally checks
the captured global sequence. New writes cannot use a stale seed. Fresh claims
seed through the durable `seed-ownership` reaction. No owner edit is enabled until
seeding succeeds. Acceptance of an Owner-role invitation and rejoining an active
member are refused. Recording an invitation grants no authority; the members
projection preserves an active member's identity and role when they are invited
again. A Member/Admin role change saved while the target is an Owner records a receipt
without changing the owner role in either projection. OpenFGA role jobs wait for receipts
for earlier relevant ownership events. Appointment jobs wait for receipts for earlier
membership and role events for their target. Owner-role values and removal of
an Owner remain rejected. Non-owner role commands use the
[member role interface](../api/members.md#change-a-member-or-admin-role).
Step-down requires another owner whose member events show active membership. Ownership adds no conversation, memory, group or resource grant.
The [ownership interface](../api/ownership.md) exposes the original event receipt,
recorded actor/target/time and both projection statuses, without a second ledger.

`member.command_refused` uses `memberaudit-<memberId>`, never the membership stream.
It stores a SHA-256 digest of the original command id, safe member and invitation
ids, an operation, an input digest and a bounded reason. It never stores the raw
original command id, which may contain private details despite its id format.
Its command id includes the person, operation, target, reason and UTC day.
It grants no access and has no membership or OpenFGA subscription. Refused owner
invitations leave membership and ownership streams unchanged; their separate
audit event still advances the position of the whole event log.
The audit worker reads the whole log and includes it in organisation history.
A saved business event takes precedence over refusal evidence in command status.

`member.invited` pre-allocates `memberId`; invitation and acceptance share
`member-<memberId>` so one conditional append settles concurrent acceptance.
Bound invitations carry `invitedIdentity` (OIDC `issuer` and `sub`). Email-only
invitations omit it and record `identity: { issuer, sub }` in `member.joined` when
accepted. Both require `expiresAt` (an ISO timestamp with offset). The command
refuses invitations without an expiry. Email is contact data, never proof of identity. The server
also checks the session organisation against its configured organisation and
every event's silo against its configured silo. It accepts only the latest,
still-pending invitation, before its expiry, using its email and role.
Fresh acceptance also requires a verified session email equal to the invitation
email after trimming and ignoring case. The inviter must still be an active
Owner or Admin. A removed stream or earlier different identity cannot be reused.
The final access check watches the joining member, inviter and ownership streams.
General sign-in exceptions do not bypass the exact organisation check here.

Email create/renew records no `invitedIdentity`; `memberId` identifies the pending
email record. These events grant no access. Acceptance keeps that id, checks that
the account is not already active in the silo and binds its issuer and subject.
The [member API](../api/members.md#email-only-invitation-acceptance) owns the contract.

Invitations can record `personalAssistant: provision|none`. Acceptance copies
that choice into `member.joined`. A missing choice in an older invitation means
`provision`. The accepting person cannot supply or change it in the request.
The `create-assistant` reaction skips joins with `none`, so those joins create
no personal assistant or computer. Bootstrap and older joins without the field
keep their existing assistant creation. Repeated delivery keeps the same assistant id.

`member.joined` from this command always carries `invitationId`. The command id
is scoped to the accepting principal and member subject. An exact retry returns
the earlier sequence without appending, even after invitation expiry. A removed
stream refuses all joins, including repeats; no retry restores membership.
Changed invitation/display-name arguments with the same key are refused. A race
with another command reloads history and returns a refusal without a second
append; the caller can retry after reconsidering the result.

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
| `assistant.settings_changed` | owner, admin or departure deactivation reaction | assistants (model, persona, tools, active) | update the computer's configuration on next wake |
| `computer.claimed` | server (claim intent) | computers (generation, token id) | reconciler creates the claim and delivers the committed credential |
| `computer.ready` | reconciler (Pod ready, credential delivered) | computers (Sandbox and Pod UIDs) | deliver queued messages and decisions |
| `computer.turn_started` / `computer.turn_closed` | server turn command | chat admission and idle-suspend checks; native computer-root read indexes and internal admission limits | chat starts bind the message, thread and `executionMode`, with optional provider/model identity; native starts bind root and ancestry, copying `sharingClass` for shared-only roots without granting authority; closed is permanent; a chat budget refusal retains `budgetStopId` for reliable decision recording |
| `computer.suspended` / `computer.resumed` | server or idle/departure worker (suspend intent) | computers (resume has the rotated token id) | reconciler applies operating mode; resume delivers refreshed credentials |
| `computer.lost` | server (Pod gone) or departure worker (confirm an existing loss) | computers | mark in-flight effects of this computer `effect.uncertain`; re-claim only the current loss, unless its personal owner was removed; departure confirmation advances the computer stream to reject earlier pending claims before cleanup completes |
| `computer.retired` | server | computers | delete snapshots after retention |
| `computer.view_refused` | authenticated proxy | audit | Safe refusal metadata on `view-<attemptId>`; no connection or lifecycle effect. The additive reason `unavailable` means access checks did not answer within the 5 s retry window, or the member lookup was unavailable. |
| `computer.view_started` / `computer.view_stopped` | authenticated proxy | audit | Audit on `view-<sessionId>`; no lifecycle effect or replayed connection. Start records a maximum two-minute ticket and stop records its reason. The additive reason `unavailable` means there was no confirmed access for 10 s, either before the first valid lease or after a lease lapsed. |
| `takeover.requested` | internal requester command | computer control summary, server bridge reaction, audit | Record intent on the computer stream with a conditional append. Refuse new work, deliver the signed bridge gate and request the root supervisor stop. No writer is enabled. |
| `takeover.pausing` | server bridge reaction | computer control summary, audit | Save matching bridge acceptance and root executor exit on the computer stream with one conditional append. Keep work denied while waiting for complete quiet proof. |
| `takeover.paused` | server bridge reaction | computer control summary, audit | After saved pausing, save a current bridge quiet reply and complete root receipt with the saved supervisor epoch. One conditional append; work and writer access stay closed. |
| `takeover.failed` | server failure command; deadline caller deferred to PR 2h | computer control summary, audit | From requested or pausing, save the bound `pause_timeout` reason with one conditional append. Work and writer access stay closed. |
| `takeover.started` / `takeover.ended` | historical live-view records | computer control summary, audit | Read old shapes as unverified and paused. They cannot grant a writer or resume work. |
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
| `conversation.created` | command | conversations (immutable `mode`: `agent_session` binds one assistant; `direct` records exactly two distinct `participantIds`, including `createdBy`, with no assistant; `group` records 2–97 distinct people including the creator on new writes (older 100-person records remain readable) and optional paired group snapshot fields, with no assistant or payer; group creation commands are deferred; missing mode in older assistant events reads as `agent_session`; strict `contextKind: shared_child` binds a fixed payer, origin and 1–97 original parent joins including creator; internal creation checks the saved parent request) | OpenFGA explicit participants and group or shared-child creator; creation and participant jobs share the conversation id |
| `conversation.child_requested` | reviewed child start API | no feed row; a rebuildable reference index finds unfinished requests without text or audience; the event keeps frozen original parent joins and a 1–1,000 cent upper bound | the route and guarded recovery worker create the child and first input; retried POSTs complete missing stages; bridge delivery stays held |
| `conversation.child_start_failed` | opencrane-server, system principal; may record after parent close | no feed row; child-requests-v2 marks the request failed with attempt 1–3, create/first_input stage and access_refused/conversation_closed/record_changed reason | recovery stops; requester-only status shows the saved failure; outages and applying access save nothing |
| `conversation.child_result_published` | reviewed human publication command on the immediate parent | one encrypted text entry; credits `publishedBy`; stores child, final/interim kind and review digest; sourced entries retain result id/position and turn; human interim text needs no result; HTTP and sockets show only text, author, kind and content type | none; never starts a turn |
| `participant.added` / `participant.removed` | creator add/remove or non-creator self-leave on `participation-<id>`, with an expected access position; legacy conversation subjects remain readable | conversations, participant intervals with global join/end positions and event ids; child changes record review position and explicit child-only additions | OpenFGA participants and applied receipts; chat sockets, history, files, desktop and approvals check saved changes before IAM catches up |
| `message.posted` | person, or the system for routines | messages | browser delivery (WebSocket) in every mode; only `agent_session` dispatches to its assistant's computer and wakes it if suspended |
| `agent.memory_context_recorded` | server (trusted) | private turn identity, generations, reference additions, scope positions and bounded byte counts; no text; excluded from the public conversation feed | server turn summary; replay creates no dispatch permission |
| `agent.turn_started` / `agent.turn_completed` / `agent.turn_failed` | bridge (reported); server close cleanup (system terminal only) | activity (`executionMode` on starts; `restricted_tool_refused` or `conversation_closed` on failures) | browser (WebSocket); notify on failure |
| `agent.turn_stop_requested` | member command or stop-budget-turns | activity; freeze partial text at this position | bridge removes the turn's grants and tool lists, cancels waits and aborts local requests before interrupting; queued turns do not start; browser keeps partial text on replay |
| `agent.message_delta` | bridge (reported) | messages | encrypted text deltas; browser replay with positions and generations |
| `agent.message_completed` | bridge (reported) | messages | browser (WebSocket). Encrypted deltas are retained for gap-free replay |
| `agent.output_lost` | bridge (reported) | activity | browser (WebSocket); never replayed into context |
| `agent.reasoning_summarised` | bridge (reported) | activity | browser (WebSocket) |
| `agent.command_ran` / `agent.file_changed` | bridge (reported) | activity | browser (WebSocket) |
| `agent.tool_call_started` | bridge (reported) | call id, server id and tool name; no arguments | conversation feed; browser (WebSocket) |
| `agent.native_consent_refused` | bridge (reported) | native request id, named server, bound turn and explicit unsupported refusal; no consent text | conversation feed; browser (WebSocket); grants no permission |
| `agent.native_request_refused` | bridge (reported) | conversationId, turnId, nativeRequestId, requestKind (shell/file_change/permissions/user_input/other), outcome (declined/unsupported); no command, path or prompt | audit only; no chat display or permission grant |
| `tool.dispatch_started` | models process | requestId, serverId, connectionId, gateway generation, recordDigest and reviewRevision; optional remote_https adapter; no request bytes | Consume one published tool permit on `decision-<request>` before sending. Replay never sends a call. |
| `tool.dispatch_recorded` | gateway log ingest or models process | linked request id, call, server, UTC times, duration and dispatch evidence; strict adapter binding names the decision, start, connection, generation, record digest and review revision; adapter_response_received proves responded, not tool success; adapter_transport_uncertain stays outcome_unknown; generic gateway evidence cannot settle a remote_https start; `not_dispatched` with `dispatch_refused` closes a confirmed start when a later check refuses before sending; no arguments | conversation feed; browser (WebSocket) |
| `approval.retry_requested` | requester command | unchanged approval after verified non-dispatch | approval read state; one replacement permit |
| `agent.tool_call_finished` | bridge (reported) | call id, server id, tool name, completed/failed status and optional duration; no result or error text | conversation feed; browser (WebSocket) |
| `file.uploaded` | upload or explicit screenshot command after a clean scan and promotion | conversation files, conversations | deliver bytes over the bridge; wake a suspended computer |
| `file.rejected` | upload or screenshot command after an infected verdict | conversations | refuse the upload clearly; no bytes stored |
| `file.delivered` | command after the computer acknowledges verified bytes | conversation files, conversations | browser may show the workspace path and delivery outcome (`saved` or `kept_existing`); reconnects skip acknowledged files |
| `conversation.closed` | saved on `conversation-<id>`; older `participation-<id>` closes remain readable | conversations | queue cancellation, turn Stop and terminal repair through the bridge watcher |
| `conversation.archive_set` | own state POST: conversationId, memberId, joinEventId, archived; exact human principal and member subject | conversation_list_state in the conversations projection; set this join’s archive choice | none; excludes shared feeds and OpenFGA |
| `conversation.read_advanced` | own state POST: conversationId, memberId, joinEventId, throughPosition, throughEventId; exact human principal and member subject | conversation_list_state; verify the visible row’s identity and keep the furthest read position within this join | none; excludes shared feeds and OpenFGA |

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
| `tool.approval_requested` | decision service (mode Ask) | approvals (optional dispatchBinding hash binds the reviewed backend and instance generation) | notify the requester; approval card |
| `approval.decided` | requester | approvals | deliver the decision to the computer (wake it) |
| `approval.expired` | timer | approvals | tell the computer |
| `approval.cancelled` | decision service / approval reader | approvals | close the card when its logical turn or binding changes; optional typed `cancelReason` records a proved cause |
| `approval.used` | decision service (single use) | approvals | — |
| `effect.observed` | gateway log ingest | audit, usage | settle the actual cost; with no matching permit or a reservation overrun → `security.alert_raised`; a rooted overrun also saves `budget.root_stopped` |
| `effect.uncertain` | settle timeout or `computer.lost` | audit, effects | notify for manual resolution |
| `effect.resolved` | Owner/Admin | audit, effects | evidence, reservation id and integer settledCents; settle or release through settle-budget; a rooted overrun saves `budget.root_stopped` and `security.alert_raised` |

### MCP catalogue, grants and connections

| Event | Emitted by | Projections | Reactions |
| --- | --- | --- | --- |
| `mcp.server_registered` | admin | catalogue (draft; transport kind and optional catalogue reference) | remote: validate SSRF and discover; hosted installation: wait for image checks (not built); older hosted: review startup contract |
| `mcp.image_check_requested` | admin | exact registration, digest, platform, next attempt and expected stream position; catalogue sequence only | Admission reads reset to checking after a failed or expired result. No fetching, scan, discovery, start or dispatch. Replay retains attempt order. |
| `mcp.image_checked` | models system principal | dated signature, licence, vulnerability and malware receipts; catalogue sequence only | Admission reads fold the first matching result for each requested attempt. No discovery, scan, start or dispatch. Replay preserves dates and policy revision. |
| `mcp.server_discovered` | reaction | catalogue (exact tool snapshots, digests, check and expiry dates, server identity and rejection reasons; old undated records remain unavailable) | — |
| `mcp.server_reviewed` | Owner/Admin | exact catalogue, connection, account mode and tool review digests with chosen modes | restrictions apply immediately; widening disables publication |
| `mcp.catalogue_checked` | models catalogue watch on startup, failure or a check before expiry; remote membership comes from bounded same-silo catalogue rows | catalogue (checked saved definitions for the exact server and silo; unchanged checks preserve policyRevision, failed checks advance it, clear expiry and hold intent-backed publication) | old approvals cancel on their next read after a failure, even if evidence was renewed meanwhile |
| `mcp.server_rejected` | reaction (validation failed) | catalogue (rejected, with reason) | notify the admin |
| `mcp.tool_mode_set` | Owner/Admin | tool modes per installed connection and tool revision | next ext_authz call reads current policy |
| `mcp.dispatch_admitted` | models process | catalogue write position only; preserve tool rules, policy revision and check dates | Order one-use send admission with policy and hold changes on `mcp-<server>`. Replay never sends a call. |
| `mcp.server_published` / `mcp.server_unpublished` | admin | catalogue and exact publication intent; a new intent advances this server’s approval revision and holds a callable publication | `prepare-gateway-configuration` orders publication jobs per silo; withdrawal alone prepares nothing; no preparation during replay |
| `gateway.configuration_requested` | ordered publication handler | serial generation, complete reviewed tool entries and source positions | models leader delivers and probes only the latest current record; no replay delivery or call admission |
| `gateway.configuration_observed` | exact response from the live gateway child | generation, recordDigest, configDigest, processRef, outcome, observedAt | evidence only; no call admission or Ready read |
| `mcp.configuration_observed` | live gateway delivery after an exact observation | original publication, review, source position, fragment and gateway digests, generation and process reference | save one receipt per operation on the server stream; restore a drift hold only for the current reviewed publication and fresh evidence; preserve policyRevision and cancelled approvals; no Ready read |
| `mcp.tools_changed` | catalogue check detects changed definitions, declared cost or approval details; local dispatch closes before append and stays closed if saving fails | catalogue (before/after snapshots, dated new catalogue, changed policyRevision and durable drift hold) | shared policy denies calls and cancels old approvals on their next read; the models watch closes dispatch before saving drift; legacy publication cannot clear the hold; restoration needs an exact new review, publication and gateway receipt while evidence is fresh |
| `mcp.instance_start_requested` | reserved lifecycle command; wake is refused for now | exact personal instance identity, installed image, run and original change; 20-second deadline | none; no workload or release handler |
| `mcp.instance_observed` | authenticated, run-bound lifecycle worker | matching run, Pod UID, checked workload and expected sequence; system principal and change id for new reports; starting, failed, stopping, absent or unknown; no callable state | none |
| `mcp.instance_stop_requested` | current owner or admin command | close the exact run with its original start and stop references; `owner_stop` requires the instance owner, while `admin_stop` records the acting admin | `stop-mcp-instance` checks the saved current run, stops its exact Kubernetes workload and records absence when configured |
| `grant.given` / `grant.revoked` (a typed revoke removes only that kind; old untyped revokes remove all matching kinds) | admin or owner; initial model grants from reaction or upgrade; departure revocation reaction | grants | OpenFGA tuples |
| `connection.created` | personal bearer create command after private staging | connection fold (exact reference and generation; identity unverified) | explicit live candidate cleanup keeps current references; no automatic reaction |
| `connection.refreshed` | personal bearer rotate command after private staging; planned OAuth refresh | connection fold replaces the exact reference at the expected generation and revision | `cleanup-connection` confirms the saved rotation and removes superseded exact generations under the shared profile lock; never release on replay |
| `connection.revoked` | personal profile owner command | connection fold invalidates the profile at its expected revision | retain material in the command; `cleanup-connection` confirms the saved revocation and removes invalidated exact generations under the shared profile lock |
| `connection.operation_closed` | live staged-secret reconciliation after its private append deadline | connection fold keeps the current reference and reserves the closed generation number | conditional append at the stage's expected profile position blocks a delayed save; exact UID/version deletion follows confirmation; no replay effects or provider outcome claim |
| `connection.disabled` | current admin command | member/server control stream blocks all personal profile saves, including new profiles | no deletion, enable or credential release; owner reconnect cannot clear the block |

Private instance starts identify the silo, user, opaque profile, server and
`startupAccessGeneration`. This positive integer counts versions of the profile's
startup access material; it contains no secret value. The separate `runGeneration`
counts process starts for that fixed identity.

### Budgets (single-writer actor per silo)

| Event | Emitted by | Projections | Reactions |
| --- | --- | --- | --- |
| `budget.ceiling_set` | admin | budgets, stop-budget-turns | zero or binding lowered ceilings request affected turn stops |
| `budget.root_allowance_set` | budget actor | budgets | — |
| `budget.root_stopped` | budget actor | budgets | — |
| `budget.reserved` | budget actor (inside `ext_authz`) | budgets | — |
| `budget.reservation_expired` | budget actor at expiry | budgets | — |
| `budget.call_dispatch_admitted` | budget actor at the final gateway check | budgets | — |
| `budget.settled` | budget actor (on `effect.observed` or admission rejected before dispatch) | budgets, usage | — |
| `budget.period_started` | timer (00:00 UTC on the 1st) | budgets | — |
| `budget.exhausted` | budget actor | budgets, stop-budget-turns | request affected turn stops; computer interruption delivery is separate |

A root is one turn's fixed allowance. `budget.root_allowance_set` binds rootId,
requesterId, conversationId, turnId, threadId, assistantId, computerId, generation,
payingGroupId and allowanceCents (1–1,000). Allocation holds no money.
`budget.reserved.rootId` optionally links the call's sole hold to that root.
Rooted model holds also save optional `retryDigest` and `bodyDigest` SHA-256 values.
The retry hash covers the silo, root, computer, generation, conversation, turn and
thread from verified credentials, plus the exact forwarded body's hash. It never
uses caller-selected retry headers. Only an open, unadmitted hold without send,
effect or security evidence can be reused. Its complete call binding and amount
must match, including tariff, payer and context hash. Recovery keeps its original
request id and allow decision on `decision-<requestId>`, saving that decision there
if missing. Admission checks the saved body hash. Other states refuse without
appending or releasing money. Non-root calls keep their existing behaviour.
Root totals count those calls over their whole lifetime, across budget periods.
`budget.root_stopped` records allowance_exhausted with attemptedBoundCents and
availableCents, ceiling_stop with the existing budget stopId, or
budget_reservation_exceeded with the reservationId whose actual cost exceeded its hold.
The actor saves an overrun stop before the full settlement and the existing alert.
`requester_stop`, `turn_ended` and `access_revoked` each carry sourceSubject,
sourcePosition and sourceEventId. The actor reads exactly that event before queueing,
then checks its silo and the saved root binding before appending. Requester evidence
is a member `agent.turn_stop_requested`, never the budget form. Turn-end evidence
is a matching chat `computer.turn_closed`, `agent.turn_completed` or `agent.turn_failed`.
Access-loss evidence is requester removal or close on the root's participation stream,
or removal on the requester's member stream. Parent changes are not accepted.
The first stop stays permanent and refunds nothing. Dispatch checks follow separately.
These internal records have no caller, route or reaction yet.

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
expiry and replay preserve that settlement. New reservations carry `dispatchGate: 1`.
Model, MCP and memory sends and provider checks use one `budget.call_dispatch_admitted` command in
that same actor queue. It binds the trusted call id, body hash, decision or provider
request reference, reservation when priced, and the recorded turn, requester,
payer, assistant and computer generation. Optional `rootId` names the hold's root,
or the verified turn's root for zero-cost MCP and memory calls. Model grants look
up the root from the verified conversation and turn, including managed model grants.
The actor checks permanent root Stop after refreshing access in its serial queue.
Refusal releases a proven unadmitted hold at zero through the existing
`budget.settled` not-dispatched path; admitted or uncertain calls keep their holds.
Old dispatch records without `rootId` remain readable. It checks current access, stops and
capacity without holding money twice. Provider reachability checks and reviewed
zero-cost MCP calls (`model: mcp-zero-cost`) need no hold. MCP still requires its
conditional tool-rule admission after budget admission; both must pass before sending.
Managed model calls remain disabled.

The successful conditional append is the send boundary. The pinned gateway has
no send retry policy. Only the first successful admission returns permission;
a duplicate or lost reply cannot return it again. An admitted call may reach the
provider after a later stop. Its hold remains until usage or resolution proves
the cost. Expiry releases a new hold only when there is no admission, provider
dispatch, effect or security evidence. Older holds remain uncertain because their
senders did not require this record. Before recording their uncertainty, expiry saves
`budget.reservation_expired` with the reservation id on the budget stream. This
closes the hold to new admission without changing held or spent cents. Replay
keeps it closed even if the clock moves backwards. Later usage can still settle
its original cost. Model and provider admission cannot race
expiry into releasing a potentially dispatched hold.
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
`budget.exhausted` with every binding reason in one record. Active scope stops
remain in force across actor recovery until their relevant ceiling or UTC period changes. P3-1 records every admission separately as `decision.recorded`.
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

Before a new admin ceiling command appends, the models process checks the chosen
group or shared assistant and any newly selected default payer against their saved
events. Personal, inactive or retired assistants and unknown or foreign groups
refuse without an append or a replacement choice. These histories load before the
short write access check, which watches their exact streams for later changes.
The current saved `installation-default` payer needs no team record when saving
the global default or its own paying-group ceiling. Other payers need a real group.
An exact saved retry checks current caller access and returns its original receipt
before validating the old choice again. These checks add no event types or fields;
the `budget.ceiling_set` registry entry and replay contract remain unchanged.

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
accepts old scope-only records for replay. New records hold all binding reasons:
scope/id, daily/monthly kind, reason, UTC period start/reset, integer ceiling,
settled/held/attempted cents and the relevant configuration event id. Optional
`work` names the refused conversation and turn. A refusal under an existing stop
instead saves `{ stopId, work }` in one conditional append on the same budget stream.
It names the stop already hit and saves the refused identity before returning.
It creates no new stop and reads no history. Repeated refusals of saved identities
append nothing. Replay requires the referenced stop to appear earlier in the stream.
The source event id/position
identifies the stop. Legacy global stops cover both periods conservatively.

The TypeScript budget fold keeps scope stops and known stopped work. A zero or
binding lowered ceiling derives its prohibition immediately from the one
`budget.ceiling_set` append. A changed relevant ceiling or UTC reset permits new
checked work; settlement and unrelated edits clear no stop. Previously stopped
work stays stopped. Reservation and open-hold checks enforce this state. The
shared final dispatch gate, work admission bindings and cancellation follow in
later PRs; this change enables no new dispatch path.

`mcp.server_discovered.tools[].costCents` may be explicitly zero for a reviewed
non-metered tool such as the Odoo fixture. An allowed tool with absent cost is
refused as `unknown_cost`. Discovery hints alone never establish price or access;
hosted provider tools with unknown prices remain disabled.
Remote discovery copies cost and approval details from the tool definition’s
`_meta['io.opencrane/costCents']` and `_meta['io.opencrane/review']`, using the
existing discovered-tool validators. Missing declarations stay absent. Malformed
ones exclude only that tool with `invalid_tool_cost` or `invalid_tool_review`.
The original definition and its digest remain unchanged. Successful credential-free
remote discovery saves `installed-<serverId>` as its connection reference and `none`
as its account mode. HTTP 401/403 still requires a connection.

### Memory

Version-1 `memory.written` records the derived scope identity, initial revision, kind, pin,
expiry, typed sources and unique same-scope dependencies with ciphertext and a revision key reference.
Governed personal remember records an agent principal bound to the requester and links
the conversation, turn and decision request. Its dependencies need signed recalled references.
Append checks that the key reference is derived from the recorded memory revision identity.
The [memory design](../specs/phase-4/p4-12-memory.md) defines the limits and later work.
Unversioned events still parse for replay; unknown ownership stays quarantined.
Encrypted revision storage and the current memory projection are available internally.
The offline operator rebuild reads existing revision keys before each database transaction.
It never creates or deletes keys or runs reactions. Public access is not implemented yet.

| Event | Emitted by | Projections | Reactions |
| --- | --- | --- | --- |
| `memory.maintenance_recorded` | Native nightly scheduler | Payload-free scope night history; `no_changes` reviews exact input revisions and a content position | No dispatch or spending |
| `memory.maintenance_bound` | Authenticated consenting member | Current memory maintenance binding | Native scheduling records intent only; no dispatch or spending |
| `memory.written` | OpenCrane memory MCP (remember) | Postgres memory projection for that scope | mark that scope for nightly dreaming |
| `memory.corrected` | Person-scope HTTP correction; OpenCrane memory MCP (planned); nightly dreaming job (planned) | Publishes the new revision and hides superseded content and dependent facts | `cleanup-memory` destroys superseded and dependent keys and verifies search removal |
| `memory.forgotten` | Authorised person, group and assistant-notes HTTP forget commands | Postgres memory projection hides the fact and all dependent facts | `cleanup-memory` destroys revision and candidate keys in all three scopes and verifies search removal |
| `memory.cleanup_recorded` | Configured cleanup worker after verified deletion or exhausted retries | Memory projection checks the fixed `completed` or `unavailable` outcome without changing fact rows; scope history retains both | — |
| `memory.consolidated` | Reserved for later use; not emitted by MVP dreaming | Postgres memory projection for that scope | — |
| `scope.promotion_requested` / `scope.promoted` | person / approver | scopes | OpenFGA viewer tuples; copy to the target dataset |

For the MVP, `memory.*` events in NATS JetStream are the truth; the Postgres memory projection holds facts per scope and uses full-text search. Replay applies recorded changes without model calls. Scopes are person, assistant notes and flat group only, with no organisation or department memory. Any group member may write group memory without approval. Each member works in their own thread or sub-agent of the group assistant, with personal memory plus group memory; preferences stay personal and shared knowledge goes to the group.

Codex reaches the OpenCrane memory MCP through the local forwarding proxy and agentgateway. `ext_authz` passes allowed scopes from IAM context (assistant grants ∩ requester rights); per-thread turn tokens keep each member's personal memory out of other threads. Memory is never written to the shared computer's disk. Preferences and pinned facts enter the thread's instructions at turn start with a size cap; the rest is fetched with `recall`.

Version-1 corrections carry the full encrypted replacement and retained sources/dependencies,
`expectedRevision`, next `revision`, matching `supersedes` memory/revision and fixed `reason`.
The projection hides superseded revisions and their transitive dependent facts before
opening any text. Cleanup deletes their keys while retaining the current replacement
and its candidate key. The existing completion, exhaustion and recovery rules apply.
Legacy corrections still parse but stop replay. Personal HTTP correction uses this registered event.
Group, notes and MCP correction emitters remain planned.

Version-1 forgotten data records scope identity, memory id, expected revision and the
next tombstone revision. It contains no text, ciphertext or key. The projection reads
metadata through a fixed event position before decrypting any memory. It follows all
saved dependency links in TypeScript, removes affected search text and vectors in one
transaction, and never restores a hidden identity from a later write. Legacy tombstones
still parse, but stop projection replay because their ownership is unknown.
The configured dispatcher destroys person, group and assistant-notes revision keys,
next-revision candidates and pending copies. It records completion only after checking deletion markers and caught-up
search removal. A failed append or verification leaves cleanup pending. Exhausted retries
save one `unavailable` record with the fixed `retry_exhausted` code. The original failed
job stays available for operator replay, which may later record `completed`. The dispatcher
scans saved events in chunks through its checkpoint before starting workers and restores
missing cleanup jobs for all three scopes after job-table loss. Completion, not a read table, decides
whether work is finished. The reaction uses no model calls. HTTP forget and status require
current rights for the target scope.

Nightly dreaming currently records one blocked or missed intent per dirty scope and UTC night. The native pg-boss clock triggers at 02:00 UTC, with a 15-minute start window. Restart records only the latest missed night; facts stay dirty. Computer dispatch and spending remain disabled. Later work will run per scope through the gateway with a budget. It merges duplicates, flags contradictions and expires stale facts through `memory.corrected`; it never crosses scopes. `memory.consolidated` and the existing scope-promotion rows are retained for contract compatibility, with no MVP emitters or promotion reactions enabled. The stream table's older scope description includes these deferred operations. Sharing data across groups is a later design topic.

Cognee is deferred until after the MVP; it may become another projection fed by replaying the same memory events plus document ingestion, without changing the agent's tools.

### Routines and delegation

| Event | Emitted by | Projections | Reactions |
| --- | --- | --- | --- |
| `routine.created` / `routine.updated` / `routine.paused` / `routine.resumed` / `routine.retired` / `routine.reassigned` | server for checked actor | routine facts (pure fold only) | none; routine execution is unavailable |
| `routine.due` | server system | frozen occurrence facts (pure fold only) | none; no input or root is started |
| `routine.occurrence_skipped` / `routine.occurrences_missed` | server system | saved cursor/next facts | none |
| `routine.run_activation_admitted` / `routine.run_finished` | server system | saved run facts | none; records grant no authority |
| `routine.run_stop_requested` | server for checked owner/admin | saved Stop intent | none; execution integration is not built |
| `delegation.started` / `delegation.completed` | server; legacy computer records are replay-only | delegations and computer-root read indexes | no effect reaction; shared native starts retain the admission’s `sharingClass`; native execution remains disabled |

Routine version 1 stores a full encrypted request, one member owner, a team assistant,
its fixed payer, explicit company connection/profile/account and daily/weekly schedule.
Definition, schedule and control revisions bind later records. Due records freeze the request
and occurrence/root/input ids. Skip and missed records carry local slots or a compact range.
Run admission, Stop and completion name the saved run; completion records terminal evidence.
Modern envelopes require the matching routine stream, server source, bound actor and command id.
Exact unversioned cron and firedAt-only records remain replay-only. Mixed formats refuse.
Legacy folds keep Needs migration with no definition, run or execution authority.
Migration requires a full paused modern update. The pure fold starts no work, even for modern dues.
Live grant, identity and budget checks and all execution paths remain unimplemented.
The [accepted design](../specs/phase-4/p4-24-routines.md) describes the later steps.

Delegation version 1 names one root, computer generation, requester and payer. It
records parent/child turns and threads, the native spawn item, content class,
narrowed model/tool/resource/operation/destination scopes and connection/profile
references. `computerAdmission` identifies the computer start event and global position.
Outcomes are `completed`, `failed` or `cancelled`, with terminal evidence and an optional
saved result reference. The first outcome stays fixed on replay, including after late success.
Version-1 delegation envelopes require the server system principal/source and matching subject.
Exact legacy computer-pair and success/failure records remain readable and grant no authority.
Mixed formats refuse. These schemas do not prove ancestry or grant execution access.

Computer start/close records have a separate `task: native_descendant` format with
the same root and ancestry fields. Native closure also accepts cancellation.
The delegation projection indexes these records by silo, assistant, generation and root.
The auth computer summary ignores them, token issuance refuses them, and model admission
refuses them before any hold. Budget replay keeps its existing cents; delegation events
allocate no allowance and reserve or spend nothing. See the
[accepted delegation design](../specs/phase-4/p4-11-delegation.md).

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
| `provider.model_binding_set` | Owner/Admin command | provider metadata and model bindings | Record one assistant or silo default choice or pause. No key rotation, grant or ordinary call. The default reaction records the first verified connection once the chat model is enabled. |
| `provider.managed_calls_drain_set` | Owner/Admin drain command | provider metadata | Stop new model turns while running turns keep their old path. Cancellation is another event. Neither action switches on managed calls or changes spending. |
| `provider.managed_calls_enabled` | Owner/Admin switch-on command after a checked drain | provider metadata | Record managed-call mode on `budget-<silo>` after checking the active drain, explicit default, active provider choices, ended legacy turns and saved spending records. Refuse while any hold or admitted send lacks settlement or release, including after computer loss or turn closure. Refuse uncertain settlements too. One conditional append requires the captured global position to remain unchanged. Advancing the budget stream stops an old writer from saving another hold; later settlement writes can pass only the switch-on marker. Switch-on ends draining. New turns require an own or silo default choice. Refuse old passes before holding money. Ordinary chat remains refused until the managed gateway in PR 5. |
| `provider.verification_requested` | Owner/Admin command | provider metadata | Explicit live check only; no replay dispatch. |
| `provider.verification_dispatched` | authenticated gateway admission | provider metadata | Consume one check, with existing budget reservation for paid tests. |
| `provider.verification_recorded` | live verification reaction or explicit skip | provider metadata | Dated original-attempt outcome, including late results. No dispatch means unknown and zero-cost release; never raw responses or credentials. |

Provider-bound `computer.turn_started` and `computer.turn_closed` records keep
`providerId`, positive `bindingSequence` and `model` together. The position names
the binding event, not the provider configuration revision. Repeating or closing a
turn keeps its original choice. `budget.reserved.modelCall` accepts the optional
provider/position pair. Old records without these fields retain their old meaning
and settle at their recorded model, tariff and payer.

The turn pass signs the provider and binding position. A provider-bound model pass
is refused on the deployment-key gateway before money is held. The switch-on command
enables saved binding selection at turn admission.
Managed provider dispatch remains unavailable until PR 5.

## Named handler subscriptions

These queue names and subscriptions are checked against `libs/events` by
`check:events`. A host enables a handler explicitly. `update-members` can
wrap the members projection; [authz](../../libs/authz/README.md) implements
`update-openfga` for provider, member, assistant, conversation, team and resource-grant
events. Desktop admission additionally requires an explicit member
`shared_desktop` grant. Scope promotion remains deferred.

| Handler | Subscribed events |
| --- | --- |
| `prepare-gateway-configuration` | `mcp.server_published` |
| `stop-mcp-instance` | `mcp.instance_stop_requested` |
| `cleanup-departure` | `member.removed` |
| `cleanup-connection` | `connection.revoked`, `connection.refreshed` |
| `cleanup-memory` | `memory.forgotten`, `memory.corrected` |
| `stop-budget-turns` | `budget.ceiling_set`, `budget.exhausted` |
| `settle-budget` | `effect.observed`, `effect.resolved`, `computer.lost` |
| `update-members` | `member.invited`, `member.joined`, `silo.owner_bootstrapped`, `member.role_changed`, `member.removed`, `member.ownership_confirmed`, `ownership.seeded`, `ownership.transferred`, `ownership.stepped_down` |
| `update-openfga` | `provider.created`, `member.joined`, `silo.owner_bootstrapped`, `member.role_changed`, `member.removed`, `member.ownership_confirmed`, `ownership.seeded`, `ownership.transferred`, `ownership.stepped_down`, `team.created`, `team.member_added`, `team.member_removed`, `assistant.created`, `conversation.created`, `participant.added`, `participant.removed`, `grant.given`, `grant.revoked` |
| `confirm-ownership` | `ownership.transferred` |
| `seed-ownership` | `silo.owner_bootstrapped` |
| `seed-provider-default` | `provider.verification_recorded`, `provider.models_selected` |
| `seed-model-grants` | `member.joined`, `silo.owner_bootstrapped`, `assistant.created` |
| `prepare-personal-key` | `member.joined`, `silo.owner_bootstrapped` |
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
never marks tools reviewed and resets modes to Block; hints only suggest a choice. Drift/unpublish/rejection
quarantines execution. A new publication cannot restore a changed tool's old mode.

Dated snapshots must contain every accepted tool definition. The back end recalculates
its tool revisions and catalogue digest from these definitions before keeping a review
choice or renewing a check. Tool counts, names and copied annotation flags must match.
MCP event subjects must name the same server as their data. Policy replay also checks
the silo. `policyRevision` is derived from saved event positions, never an input field.
An incomplete old list needs a complete discovery before it can authorise a call.

Discovery may also carry `rejectedTools`: up to 1,000 excluded declarations with
an optional safe `name`, a definition `revision` digest and a fixed `reason` code.
These entries carry no definition or policy and are excluded from `toolCount`
and `schemaDigest`. They remain available in event-backed discovery status for
review; legacy events without this field remain readable. See the
[discovery validation contract](../../apps/server/README.robot.md#remote-mcp-registration-p3-3).

`mcp.server_reviewed` names the exact catalogue digest, connection and account mode.
Each tool choice names its definition revision, mode and `reviewDigest`. That digest
covers the saved zero-cost declaration and safe approval details. Allow/Ask requires
explicit `costCents: 0` and approval details, including for read-only tools. The command accepts the
current `policyRevision` as a check, rather than letting the caller choose a new revision.
Discovery never marks review. Review does not grant access or publish a server.
Restrictions take effect immediately. A wider mode withdraws publication until a later
publication command. Replay applies the same rules.

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

Audit replay stores each allowed event's time, safe actor kind and a digest of
its command id. A person id requires a human envelope principal matching the
event's checked command field. System and mismatched principals never become
people. The read table indexes UTC time, event family, actor id and outcome.
Organisation history returns up to 20 anchors by default, each with at most 20
related records. An access-checked detail read pages the remaining records by
event position. Rebuild fills older rows and starts no reactions.

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
summary, just as `effect.observed` does for a model call. An admission refused after
its dispatch was saved records error without relay fields, because no listener
was registered. Missing observations
remain unknown. New relay close receipts always use unknown or error, never success:
a socket byte count cannot prove remote processing. The optional modern shape has
`observationId` and `relay`: exact host/port, checked address or null, permit id,
reason, byte counts and registered/connected/closed times in integer milliseconds.
Reasons are finished, failed, refused, expired, revoked and unavailable.
The id is SHA-256 of JSON `[silo, permitId, "tunnel-close"]`, chosen before registration.
The event and command ids match it on `egress-<requestId>`, from system/models.
The reaction retains at most 4 KiB of safe JSONL per relay before its conditional
append. Files contain no tunnel data or credentials. Identical retries read the
original event; conflicting records are refused. The audit projection rebuilds the
receipt id and outcome without running the reaction or opening a relay. Rich receipt
reads, automatic retry scheduling and startup reconciliation remain later work.

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

### Hosted startup credential review

Hosted `mcp.server_registered` data may include a `credentialContract`. It records
requirements and review references, never credential values. Supported startup
contracts use `credentialMode: startup_short_lived`, memory IPC delivery, enforced
upstream expiry and identity binding, and renewable material. A `startup_capability`
is a separate renewable capability with at most 30 seconds of validity; a
`per_call_lease` cannot supply it. OAuth access material has at most 600 seconds
remaining. Refresh tokens and lasting raw bearers never enter the process.

The review names the image, launcher, dependency, configuration and upstream-binding
SHA-256 digests and an opaque `evidence:` reference. The image digest must match the
registered locator. These fields permit review; their presence alone is not proof
of qualification. A later qualification harness must exercise expiry, renewal,
restart and persistence failures before any hosted startup becomes callable.

The install worker records `mcp.server_rejected` with
`lasting_startup_secret_required` for lasting, environment-only or raw-bearer
requirements, and `startup_contract_unverified` for missing or incompatible evidence.
New hosted installs without a contract remain closed. Compatible startup contracts
stay pending review. Hosted per-call contracts remain for the separate hosted installer.
The tool policy blocks publication for declared startup contracts and saved startup
refusals. Existing per-call connections, including reviewed memory registrations
without a startup contract, keep their existing publication and access checks.
No startup process, credential release, Connect flow or ordinary startup tool call
is enabled by this contract.

Publication intents include commandId, expectedSequence, reviewRevision and a server-derived
fragmentDigest. They leave the legacy published flag false and keep policyRevision unchanged.
The generation stream saves one record per changeRef. Conditional appends order competing
changes; preparation rereads after conflicts. Each member names one exact reviewed entry,
its original change and its source position. Later source events make the record stale.
These are preparation inputs; the full route renderer and fixed model/memory routes remain
for the next part. No worker prepares records on replay, and no record establishes Ready.

Budget turn stops use `reason: budget` and `stopId`, referring to the saved budget
record. They contain no spending amounts or payer ids. Member stops retain their
original `requestedBy` shape. The dispatcher waits for the conversations projection
to reach the source position, then checks exact histories and conditionally appends
one stop per unfinished affected turn. Projection replay never runs this reaction.

Hosted registration can include `installation` with attemptId 1, one platform
(`linux/amd64` or `linux/arm64`) and a public upstream host/port. This complete
request declares a credential-free installation and cannot include credentialContract.
It remains checking without discovery, rejection or network contact. The event time
records when it queued. No image check receipt or admission is implied. Registration
uses the original commandId, a serverId derived from silo and commandId, and one
conditional append. Lost replies recover that event; absence remains unknown.
