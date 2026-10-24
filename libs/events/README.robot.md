# Events

For people, read [README.md](README.md) first.

This package is the typed event catalogue used by server validation and the event
core. It defines envelopes, per-type data schemas and examples; it does not
append, project or dispatch events. Its routine fold rebuilds facts in memory.
The existing `agent.turn_failed` schema accepts the fixed
`conversation_closed` reason from the server's waiting-input cleanup. It adds
no event type or field. The registry and `docs/architecture/events.md` describe
the same writer.

The package exports `mcpToolModeSetDataSchema` so receipt recovery validates the
saved choice with the same schema as the event registry. No event fields change.

## Takeover approval cancellation

The fixed `takeover` cancellation cause is shared by event and approval reply
schemas. No new data field or event type is introduced. The saved cancellation time
supplies `endedAt`. Used approvals retain their existing evidence. The exact behaviour
is described in the [approval API](../../docs/api/approvals.md).

## Dated MCP catalogue evidence

Tool lists carry check and expiry dates; undated lists cannot authorise calls.
Unchanged checks preserve the approval rule revision while advancing the write position.
The [projection contract](../../libs/projections/README.robot.md#dated-mcp-catalogue-evidence)
records snapshot and expiry rules for #48 PR 1.

The Node entrypoints `@opencrane/events/lossless-json` and
`@opencrane/events/mcp-catalogue` share the existing JSON hash format across discovery,
append validation and policy replay. They use Node's built-in SHA-256 implementation.
They are separate from browser event schemas, so browser builds do not load Node crypto.
`validateMcpCatalogue` checks the complete accepted tool count, distinct names, definition
names, schemas, annotation flags, tool revisions and the catalogue digest.
The event parser binds every MCP event's server id to its exact subject.

## Final dispatch admission

`budget.call_dispatch_admitted` records the call id, body SHA-256 hash, decision
or provider request reference, optional reservation and the trusted model-call
binding. Optional `rootId` equals the hold's root for paid calls and the verified
turn's root for zero-cost calls. The actor checks it after refreshing access and
refuses stopped roots. Old records without this field still replay.
New reservations carry `dispatchGate: 1`; older records remain readable.
Rooted model holds add optional SHA-256 `retryDigest` and `bodyDigest` fields.
Native holds also save `accessExpiresAt`, a nonnegative safe integer of Unix milliseconds.
This is the original access expiry, not the hold's settlement timeout. Replay preserves
it. Native recovery refuses an older hold without that date and never extends it.
The models actor uses these to recover the same open, unadmitted hold and original
request/decision ids. A body mismatch refuses admission. Admitted, settled, expired,
uncertain or evidence-bearing holds cannot grant another send. Old holds without
these fields remain readable and do not acquire retry recovery.
The models actor orders dispatch and expiry on one budget stream. This record
changes no money. Its absence proves non-dispatch only for the new sender contract.
The first successful append permits one gateway send; duplicates grant no send.

## MCP approval transport binding

`tool.approval_requested.dispatchBinding` is an optional SHA-256 digest of the reviewed
transport route, including server, connection, backend address and instance generation.
It participates in the approval id. Missing fields remain readable for replay.
A gateway call with a different current transport binding cannot use that old approval.

## Public contract

Delegation version 1 records one computer generation, root, requester, payer,
parent/child turns and threads, spawn item and narrowed scopes. `dataClass` records
whether the task uses shared or private data; it grants no audience access.
Native computer records and version 1 delegation starts accept optional
`sharingClass: shared_only`. Shared admission copies it from the root and requires
`dataClass: shared`; old private records remain unchanged.
`computerAdmission` names the computer start event and its global position.
Completed records distinguish `completed`, `failed` and `cancelled`, with a terminal
evidence reference and optional saved result reference. Exact unversioned records
remain readable for replay; mixing formats is refused. Modern delegation envelopes
require the matching delegation subject and the `opencrane-server` system principal/source.
The computer schemas use `task: native_descendant` for the separate native format.
Native computer envelopes also require the matching server principal/source and computer subject.
These checks validate records, not ancestry or access. Native execution stays disabled.

Import `@opencrane/events` through [src/index.ts](src/index.ts).
From the repository root, validate unknown input without trusting its declared type:

```sh
node --experimental-strip-types --input-type=module -e "import { parseEventByType } from '@opencrane/events'; console.log(parseEventByType({type: 'not.registered'}))"
```

The result has `success: false` and `reason: 'unknown_event_type'`.
For a registered type, invalid envelope/data produces `invalid_event` and a Zod error;
success returns the validated event. Treat external values as `unknown` until parsed.
Callers still enforce authority, stream ownership and conditional append concurrency.
Schema acceptance alone is not authorisation or evidence that an event was stored.

The [event catalogue](../../docs/architecture/events.md) owns event semantics and
which projection or reaction follows each event. Change that catalogue and this registry
together. Money is safe integer EUR cents; sensitive payloads use ciphertext/key ids,
and credentials appear only as secret references.

## Verification and dependencies

`member.invited` and `member.joined` accept optional
`personalAssistant: provision|none`. Missing fields remain valid for older events.
The server supplies `provision` when accepting an older invitation. Bootstrap
does not accept this field. `test/assistant-choice.test.ts` checks these contracts.

```sh
npm test -- libs/events
npm run typecheck -w libs/events
npm run check:events
```

Tests validate every registry example and reject malformed envelopes, invalid money,
plaintext content, raw credentials and undeclared fields. The catalogue check compares
event names in both directions. The registry is split into definitions and identity
entries to keep hand-written production modules under the size limit.
Runtime dependencies: Zod and `@noble/hashes` 2.4.0. The latter supplies synchronous
SHA-256 for shared Node/browser schemas. Its npm metadata and installed LICENSE were
checked: MIT, OSI-approved; no runtime dependencies.
No app or product-domain dependency belongs here.

Live append, ordered replay, failover and backup/restore remain separate event-store
qualification work. This package alone cannot prove those guarantees.
See the [architecture and plan](../../plan.md) and the [server](../../apps/server/README.md).

New event-store commands require a non-empty `commandId` and `principal`.
The envelope keeps `commandId` optional so older stored events still parse;
its scope is the principal and entity subject, as [principle 7](../../docs/architecture/events.md#principles) specifies.

Private-turn reports add `agent.output_lost` to the conversation stream. Message
commands may request `executionMode: "memory_free"`; agent and computer start
events record the optional restricted/memory-free mode. Child start reports and
computer start events also record `sharingClass: "shared_only"`; the server derives
it from saved child creation and checks the computer's report. It is separate from
execution mode.
A private tool refusal
uses `restricted_tool_refused`. See the [event catalogue](../../docs/architecture/events.md#conversations-and-agent-activity).

## Tool call events

`agent.tool_call_started` and `agent.tool_call_finished` belong to conversation
streams. Both carry `conversationId`, `turnId`, `callId`, `serverId` and
`toolName`. Finished records add `status` (`completed` or `failed`) and optional
non-negative integer `durationMs`. Their strict schemas exclude arguments,
results and error text. Registry examples drive the generated schema tests.
Both names are listed in the event catalogue.

Call ids and tool names share `isToolCallText`, exported at
`@opencrane/events/tool-call`. It accepts 1–200 UTF-16 code units, including
provider punctuation, and excludes Unicode control, format, surrogate,
private-use and unassigned characters. This entrypoint has no dependencies.
The computer image copies it alone; the Zod dispatch schemas live in `tool-dispatch.ts`.
The computer checks it before saving a report; server event validation uses
the same check.

`computerTurnStartedDataSchema` and `computerTurnClosedDataSchema` are exported
for the auth computer summary. It parses the full stored data with the same rules
as the event registry and takes the close status type from the closed schema.
Changing that schema therefore changes the summary's checked types too.

`decision.recorded.callId` is optional and uses `isToolCallText`, like tool reports.
It accepts 1–200 characters and refuses Unicode control, format, surrogate,
private-use and unassigned characters. Parsed MCP requests supply it, including
policy and thread refusals. A request with an unsafe call id is refused and its
decision omits the id. Older events without a call id still parse. The conversation
feed keeps a checked id without storing arguments or results. The id is supplied
by the caller; the turn token does not sign it.

## Memory revisions

`memory.written` now uses a strict version-1 registry schema. `parseEventByType`
also reads the exact old unversioned shape. `memoryWrittenIdentity` returns null for
that shape: its ownership is unknown, so callers must quarantine it. No default
audience or offline mapping is supplied. The old correction schema remains. Version-1 `memory.forgotten` records checked scope
identity, memory id, expectedRevision and revision = expectedRevision + 1. It contains
no text, ciphertext or key. The registry exposes this strict version-1 data shape;
`memoryForgottenEventSchema` and `parseEventByType` also preserve exact legacy tombstones.
The projection stops on those legacy records rather than guessing their ownership.
No forget emitter is enabled. The configured dispatcher can verify key cleanup
and record completion for a saved person tombstone.

Saved memory events must use `parseEventByType`, or `memoryWrittenIdentity` when
only their ownership fields are needed. `getEventDefinition('memory.written')`
returns a `dataSchema` for version 1 only. Calling its `dataSchema.parse` on
unversioned saved data throws; it is not the replay parser. The exported
`memoryWrittenEventSchema` supplies the typed full-event replay shape, including legacy writes.

Server custody hashes JSON `[silo, scopeKind, ownerId]` with SHA-256 and checks
the derived id before using any key. Version-1 event parsing checks identity field
shapes, the subject, command/principal ids, personal-only
preferences, unique same-scope dependencies and the 16,384-byte event limit.
Each dependency identifies a memory id and revision; repeating that pair is refused. Expiry
must follow the recorded event time, so replay does not depend on today's clock.
Write text validation limits UTF-8 to 1–4,096 bytes and refuses C0 controls except tab
and newline, plus lone surrogates. Saved encrypted events still parse; the memory
projection quarantines earlier refused text after decryption.
Source/dependency limits are 8/32; ids use 1–200 ASCII letters, digits, `_` or `-`.
`memoryWrittenDataSchema` exports the version-1 fields for server command validation.
The server enforces the separate 16 KiB whole-command limit.

## Human group records

`conversation.created` commands accept `group` with 2–97 distinct `participantIds`,
including `createdBy`. `groupConversationCommandSchema` checks that write limit;
stored-event parsing keeps the older 100-person limit. Group, person and conversation
ids follow the member-id rule: 1–200 characters, without dots, whitespace, `*` or `>`.
Ids such as `ext:jane` are valid. Conversation ids reject `provider-`.
`groupId` and non-negative safe integer `groupSnapshotPosition` must appear together.
Assistant and payer fields are refused. Direct and legacy session rules stay unchanged.
Participant events and `conversation.closed` own `participation-<id>`.
Append refuses participant events on conversation subjects, but replay still reads them.
For compatibility, close appends also accept the matching conversation subject.
The server writes new closes to participation. Stored participant schemas retain their earlier non-empty
string fields; new appends check the member-id format separately.
`conversationEventId` matches the data id to the exact current or legacy subject.
The event store calls it before append, so mismatched ids cannot block later consumers.

`memoryWrittenDataSchema` exports the typed version-1 fields for server validation.
`apps/server` uses these fields to check human memory writes.

`member.joined` accepts optional `identity: { issuer, sub }` for email-only
acceptance. Issuer is a URL and subject is a non-empty string. Bound invitation
joins keep their old event shape. The member projection checks that the recorded
subject matches the human principal and applies the binding for later reads.

`provider.model_binding_set` records assistant or `silo_default` choices for `chat_turn`, including model, active/paused state, previous binding position and reviewed category/configuration positions. It changes no key, verification evidence or grant.

## Provider identity on turns and reservations

`providerTurnBindingSchema` requires `providerId` and a positive safe integer
`bindingSequence`. `optionalProviderTurnBindingSchema` accepts either both fields
or neither. Turn start/close data also requires `model` when these fields are
present, and excludes `model` when they are absent. Old events still parse.
`budget.reserved.modelCall` accepts the optional pair and keeps its existing
model, price table and payer. These fields do not change settlement calculations.

`test/provider-turn-validation.test.ts` checks model presence on start and close
records separately. Each record needs a model exactly when it names a provider.
Closure tests also check each incomplete provider pair. Storage validation refuses
bad provider ids and fractional or unsafe binding positions on turn and reservation
records.

New owners need `member.ownership_confirmed`: see the [ownership contract](../../docs/api/ownership.md).

## Recorded tool failures and approval actions

The [approval API](../../docs/api/approvals.md) explains tool failure records and approval actions.

The [member API](../../docs/api/members.md#invitation-command-status-and-refusal-history)
describes safe invitation refusal events and their daily limit.

`member.command_refused` stores `originalCommandDigest`, a lower-case 64-hex
SHA-256 digest. It rejects `originalCommandId` and all undeclared fields. The
server hashes the caller's id before recording a refusal and before status lookup.
An id's allowed characters alone cannot exclude a secret or a person's name.
`test/security-rules.test.ts` and the server's refusal tests cover this boundary.
The registry-wide security rule already permits digest fields; no name exception is needed.

`conversation.archive_set` and `conversation.read_advanced` use `chat-state-<memberId>`.
Strict schemas require conversation/member/join ids and an archive boolean or positive safe
read position plus event id. Parsing requires the matching human principal and command id.
These events have no reactions and do not grant access. The server exposes commands;
screens come later.

## Shared child records

`conversation.created` also accepts strict `contextKind: shared_child` with explicit
`mode: agent_session`, fixed `payingGroupId`, `origin` and 1–97 `initialJoins` including
`createdBy`. Each initial join keeps the person's original parent join id/position.
The origin binds parent/source/intent/request/first-input ids and source/intent positions.
Parent joins precede the source; intent follows it. Private legacy parsing is unchanged.
Child participant changes carry `contextKind: shared_child` and `reviewPosition`;
additions require `joinKind: explicit_child`. They grant no parent rights. No emitter exists.
`memberRemovedDataSchema` is exported. `member.removed` accepts optional
`reviewRevision`, a 64-character lowercase SHA-256 value. Older events omit it;
new removal routes require it. It identifies the departure inventory the admin
reviewed. It contains no private history or credentials.

## Hosted startup credential contracts

Hosted registration data accepts an optional `credentialContract` declaration.
`hostedCredentialContractSchema` keeps supported and unsupported requirements
readable for refusal. `startupCredentialContractSchema` and its separate
`StartupCredentialContract` type accept only short-lived startup material:
renewable startup capabilities (at most 30 seconds, using a memory provider),
or OAuth access material (at most 600 seconds, renewed in memory or replaced by
restart). Both require memory IPC, enforced expiry and binding, five SHA-256 digests
and an opaque `evidence:` reference. Per-call leases are excluded. No token value,
refresh token or client secret fits either strict contract. These shapes permit
review only; the server checks image binding and later work must qualify evidence.
Legacy events still parse, but do not gain hosted execution.

`provider.managed_calls_enabled` records the silo's managed-call mode on `budget-<silo>`.
Other subjects are rejected. Its data names the reviewed provider, its unchanged revision,
the changer and the reviewed provider-category position. It carries no key and grants no access.
The server uses `providerSwitchOn` from `libs/models` to save this event after
checking the drain and unresolved spending. Calls use the managed route after the
models process restarts with provider storage configured and its fallback key
setting removed. Checking the event's shape alone does not prove these conditions.

Saving switch-on advances the spending stream. A writer using the old position
cannot save another hold. The budget actor can read past the marker to settle or
release earlier holds without a restart. New holds require a checked managed call.

`provider.managed_calls_drain_set` records `draining`, the expected provider-category
position and the previous drain position with the provider's current revision.
Starting and cancelling both use this event. It grants no access, changes no key
or model choice and reserves no money. A drain command cannot reverse switch-on.

## Destination rule records

`egress.destination_allowed` and `egress.destination_revoked` save one subject's exact
HTTPS hostname and integer port. Commands convert IDNA names to lower-case ASCII;
records require that saved form. Port defaults to 443 in commands. Wildcards, URLs,
IP/numeric hosts, malformed labels and internal names are refused. The reserved
suffixes `localhost`, `local`, `internal`, `lan`, `home`, `svc`, `test`, `invalid`,
`example`, `onion` and `home.arpa` refuse both the name itself and all descendants.
The checks use whole DNS labels after IDNA conversion. DNS address checks
belong to later admission work; no DNS lookup or network permission is added here.
Event parsing checks the stream format, silo scope and human actor. Commands and
projections check its exact identity. Server commands bind each change id to its first saved rule and arguments across the silo.

## Nightly binding contract

`memory.maintenance_bound` records one scope, consenting `memberId`, assistant,
paying group, enabled choice, accepted 100-cent cap and positive config revision.
The cap exports as integer cents with a minimum of zero and accepts only 100.
Only a server event with a matching human principal, scope subject and command id
is accepted. Person scope requires its own member. The record contains no fact
text and grants no spending authority. Run and dirty-scope contracts remain deferred.

## Budget stop

`budget.exhausted` keeps legacy scope-only replay and adds typed integer-cent
reasons. A later refusal uses the strict `{ stopId, work }` shape, with a non-empty
stop id and conversation/turn ids. It cannot mix that reference with reasons or a
legacy scope. The fold checks that the referenced stop already exists.
`test/budget-refusal.test.ts` checks the reference shape and rejects incomplete,
mixed and undeclared fields. The [catalogue](../../docs/architecture/events.md) owns the contract;
the [accepted design](../../docs/specs/phase-3/p3-14-p3-15-budget-stop.md) records later work.

## Control intent

`takeover.refused` belongs to `view-<attemptId>`. Its strict data contains only
attemptId, actorId, conversationId, a SHA-256 inputDigest and reason `requester_only` or `control_conflict`.
Identifiers allow letters, digits, underscores and hyphens, with at most 200 characters.
It is audit-only: replay must not change control or dispatch a reaction.

`takeover.requested` is strict. It requires the computer, generation, Pod,
conversation, requester, reviewed human event, takeover and lease references,
fixed reason and affected turn ids. It belongs to `computer-<assistantId>`.
Legacy started/ended shapes remain readable; consumers treat them as unverified.
The other transitions and modern start/end schemas remain the next split of the
accepted [design](../../docs/specs/phase-3/p3-17-take-control.md).

## Routine contracts

Design [p4-24-routines.md](../../docs/specs/phase-4/p4-24-routines.md), PR row 1.
The [catalogue](../../docs/architecture/events.md#routines-and-delegation) describes the fields.
Envelope checks bind stream, server source, actor and command id; they do not prove live rights.
`foldRoutine` is pure and always returns `executionAvailable: false`. Legacy state has no modern
request or run. `RoutineState.appliedEventIds` retains every accepted modern event id in first
delivery order. Duplicate ids return the existing state after schema and stream checks, even
after later controls or retirement. Legacy records add no facts or applied ids. A failed fold
leaves its input and its applied ids unchanged. Migration requires a complete paused update.
An unfinished run stays recorded across controls; completion checks its ids and keeps the first
result. Definition and due comparisons parse stored values again, so JSONB field ordering
cannot change a binding. Custody and live membership/grant/profile checks belong to later PRs.
This package registers no subscriptions or processes and provides no routes or money ledger.
Tests: `nice -n 10 npx vitest run libs/events/test/routines.test.ts libs/events/test/routine-fold.test.ts`.

### Routine occurrence calculation

PR row 2 exports `calculateRoutineOccurrence` and `previewRoutineOccurrences` at
`@opencrane/events/routine-schedule`. Both accept unknown input and check it strictly.
They reuse the record schedule schema: daily or weekly, local `HH:mm`, named IANA
zone and ISO weekday 1–7 for weekly. The runtime's `Intl` supplies zone rules;
invalid and offset-only zones refuse. No dependency or clock read was added.

Calculation takes `silo`, `routineId`, `scheduleRevision`, `schedule` and `localDate`.
It refuses a weekly date on another weekday. The result includes those local fields,
`occurrenceId`, `status`, `at`, `offsetMinutes`, `repeated` and `checkAt`.
A scheduled slot chooses the earliest UTC instant and sets `checkAt` to that instant.
A `dst_skip` has null instant/offset and sets `checkAt` to the clock-change boundary.
Offsets must use whole minutes, matching the saved slot contract. Historical zones
with second-based offsets refuse. Offsets are sampled every six hours within two days
of the local slot and candidate instants are checked against all intended local fields.

Preview takes the same identity and schedule, plus `now`, `effectiveAt`, optional
`afterLocalDate` and `count` (default 5, maximum 50). Count includes skipped slots.
Every returned `checkAt` is strictly after both supplied times. Dates advance on the
local calendar. The caller passes the last consumed local date as `afterLocalDate`
to prevent a backwards clock from revisiting it. These functions save no cursor;
later event commands still have to claim each occurrence once.

The id is lower-case SHA-256 of UTF-8 JSON
`[silo, routineId, scheduleRevision, localDate, localTime, zone]`, using the stored
zone spelling. Repeats and skips retain their intended local identity. Delivery
time and definition revision do not enter the hash. Saved claimed timestamps
must be reused rather than recalculated after a runtime time-zone update.
Manual ids, schedulers, routes and firing remain later work.

Focused tests: `nice -n 10 npx vitest run libs/events/test/routine-schedule.test.ts`.
They cover Brussels daily/weekly repeat and skip, Lord Howe half-hour changes,
Kolkata without DST, leap dates, invalid input, future-only preview, a backwards
caller clock and fixed expected hashes. Changing the process clock changes no result.

## Private survey contracts

`onboarding.survey_step_saved` and `onboarding.survey_restarted` use `personal-<memberId>`
(wire `ev.personal.<memberId>`). Strict version-1 schemas require the matching human
principal, command id and `opencrane-server` source. The full event limit is 16,384 bytes.
Saved steps require `ciphertextDigest`: lower-case 64-hex SHA-256 of the base64-decoded
ciphertext bytes, including the nonce and authentication tag. Parsing recomputes it
without keys and refuses missing, malformed or mismatched values. `keyId` is unchanged.
`surveyAnswersSchema` checks four typed steps, UTF-8 text up to 4,096 bytes,
name/pronouns up to 200/100 characters, 16 distinct groups/tasks and the fixed style/task ids.
It refuses controls and lone surrogates through the existing memory text check.
Survey text stays data; no command or route is enabled. See the
[accepted design](../../docs/specs/phase-4/p4-18-account-persona-welcome.md).

## Exact tool review

`mcp.server_reviewed` records exact catalogue and review digests, connection/account mode,
all tool choices, the existing policy revision checked and the human reviewer.
The resulting policy revision comes from the saved event position.

## Personal instance records

`mcp.instance_start_requested`, `mcp.instance_observed` and
`mcp.instance_stop_requested` use `mcp-instance-<instanceId>` subjects.
Start binds the silo, user, opaque profile, server and startup access generation,
plus installed connection, image/install generation, upstream and workload digests.
`startupAccessGeneration` counts versions of the profile's startup access material.
It is a positive integer, contains no secret value and is separate from `runGeneration`.
Malformed instance data returns `invalid_event` rather than throwing from the identity check.
The deadline is positive and at most 20 seconds after the requested time.
Observations bind the original start, run, Pod UID and workload digest.
New reports include `expectedSequence` and require a system principal and command id.
Older saved observations may omit the revision. No bearer value enters an event.
A `not_found` reason requires `unknown`; callable claims and secret fields are refused.
Stop records require a human principal matching `requestedBy`. `owner_stop` requires
the instance owner in the fold. `admin_stop` records an owner or admin command on
the same event type and makes the owner's status read show why the run is stopping.
`stop-mcp-instance` subscribes to saved stops when the ops host has MCP_KUBE_NAMESPACE.
It records absence for the exact stopped run. These events grant no permission or release.

## Expired spending holds

`budget.reservation_expired` contains only `reservationId`. It belongs to the
budget stream and closes the hold to new send permission. It changes no cents
and grants no access. The budget actor saves it before expiry uncertainty.
The actor and spending projection restore the closed hold on replay; later usage
can still settle its cost. The event catalogue and registry name the same event.

## MCP send admission

`tool.dispatch_started` uses `decision-<requestId>` and the fixed event and command id
`<requestId>:tool-dispatch-started`. Its strict fields are requestId (UUID), serverId,
connectionId, generation (positive gateway generation), recordDigest (SHA-256) and
reviewRevision (positive saved review position). It consumes a published call's permit
before any send; it does not claim an upstream outcome. It has no reaction on replay.
`tool.dispatch_recorded` remains the later outcome record used by approval retries.
Its evidence also accepts `dispatch_refused`: the models process refused a call after
confirming its start was saved and before opening an upstream connection. It pairs this
with `outcome: not_dispatched` on the same decision stream. This evidence does not enable
an approval retry; the existing retry check still requires `connection_refused`.

`mcp.dispatch_admitted` records one accepted send on `mcp-<server>`. It carries the
request id, connection, tool name and revision, catalogue digest and backend generation.
It contains no pass, credentials or arguments. Its conditional append orders that
call against policy and quarantine writes. No reaction sends a call on replay.
Only the catalogue write position advances; tool policy and approval revision stay stable.

## Memory cleanup results

`memory.cleanup_recorded` version 1 names scope id/kind/owner and the initiating `changeId`.
Its outcome is `completed` or `unavailable`. Unavailable requires the fixed
`retry_exhausted` failure code; completion has no failure code. It requires the
matching scope subject,
`opencrane-worker` source/system principal and `commandId` equal to the event id.
It contains no text, encrypted value or key reference. `cleanup-memory` subscribes to
`memory.forgotten` only. A later completion may follow unavailable evidence for the same
change after operator replay. Correction cleanup remains unimplemented.

## Nightly intent records

`memory.maintenance_recorded` belongs to `scope-<scopeId>`. Its strict schema
accepts due/null, refused/qualification_blocked, missed/window_missed or overlap,
and no_changes/null with `reviewedPosition`.
It records nightId, batchKey, inputRevision, UTC date, binding revision, member,
100-cent accepted cap, intendedAt, selectedAt and at most 32 revision references.
It carries no plaintext, root allowance or dispatch permission. `due` represents
unresolved work; this scheduler emits refused, missed or no_changes records.
Older records without `reviewedPosition` still parse. Only `no_changes` reviews its
exact input references; the position also closes a forgotten-only change.

## Personal bearer activation records (P3-8 PR 2)

`connection.created` and `connection.refreshed` retain their old strict fields and add
optional `activation`. When present, this strict object requires the installed connection,
personal owner kind and purpose, generation, exact UID/resourceVersion, endpointDigest,
operationId, changedBy, expectedSequence, appendUntil and bearer_create/bearer_rotation reason.
The secretRef is a `secret:` reference to the custody name. No material or material-derived
hash is recorded. endpointDigest hashes the registered locator only. The private custody
adapter retains the material verifier. Missing activation is accepted for legacy replay;
it supplies no usable generation. No new event type or release reaction is registered.

## Private turn memory reference records

`agent.memory_context_recorded` is a server-only conversation event, capped at 16 KiB
including the envelope. It refuses computer reports. `inputGeneration` identifies
one prepared set of turn inputs; it is metadata, not another dispatch pass.
`prepared` starts with no loaded references. `loaded` carries initial input or recall
additions. A recall record's `dispatchDigest` is the signed context's existing
`dispatch.permitDigest`. `callDigest` hashes the call id and input generation.
Neither digest covers memory text.
`invalidated` and `ended` carry fixed reasons and no additions or bytes.
The strict schema bounds each addition list, scope positions and byte counts.
The server summary checks transitions and cumulative limits. No production writer is
connected in this change. This contract does not qualify native memory or prove delivery.

## Personal connection invalidation records

`connection.revoked` adds optional expectedSequence and the fixed `owner_requested` reason
to preserve legacy replay. New owner commands supply both. It does not confirm deletion.
`connection.disabled` is a strict record containing userId, serverId, profile, disabledBy,
expectedSequence and the fixed `admin_disabled` reason. Its member/server control stream
covers all personal profiles, including new ones; profile names the reviewed target.
Neither event contains material or a material-derived hash. Disable has no registered
reaction, and no enable or cleanup command is supplied in this first part of P3-8 row 3.

## Departure cleanup subscription

`cleanup-departure` receives `member.removed`. The dispatcher only acts on saved
removals with `reviewRevision`. It reuses `team.member_removed`, `grant.revoked`
and `assistant.settings_changed`, then uses `computer.suspended` for idle personal computers.
`member.departure_cleanup_completed` belongs to `memberaudit-<memberId>` and holds
`memberId`, `removalId` and strict `sections`: groups, grants, assistant and computer.
Each list holds at most 100 safe event-id references. It confirms stored results and
OpenFGA receipts; it does not restore access or trigger another reaction.
API applying/unknown/complete status remains pending.

## Publication preparation (P3-4 PR 2a; Part of #45)

Extended `mcp.server_published` data requires commandId, expectedSequence, reviewRevision
and fragmentDigest together. Legacy records remain readable. `gateway.configuration_requested`
records reviewed entries, original change references, source positions and a SHA-256 digest.
Header names belong to the later renderer constants; no header values or definitions are saved here.

## Root spending allowance (P4-8 PR 4, first part; #90 and #93)

`BudgetActor.setRootAllowance(binding, firstCallBoundCents)` saves the reviewed bound
only when every remaining cap and the first call fit. It derives rootId as SHA-256
of JSON `[silo, conversationId, turnId]`. Identical retries return the saved record.
`reserve` takes optional rootId as its fifth argument; rooted turns must supply it
and match every saved identity field. The saved root position replaces admittedAt.
`rootTotals` uses the existing reservations, BigInt sums and lifetime settlement.
Roots stay out of `budgetSummary`. Refusals contain fixed reasons and availableCents.
Allowance, ceiling and call-overrun stops are permanent; settlement and replay still work.
An overrun uses the existing `budget_reservation_exceeded` reason and names its
reservationId. The actor saves the first stop before settlement, then records the
full cost and the existing alert. Repeated settlement adds no stop or charge.
A failed settlement or alert can be retried without reopening the root.
Tests in `libs/models/test/root-budget.test.ts` use real NATS and PostgreSQL.
`BudgetActor.stopRoot(rootId, reason, subject, position)` accepts requester_stop,
turn_ended and access_revoked. It reads one event with `readEventAt` under a separate
ten-second deadline before queueing. Inside the queue it checks the saved root,
silo, event type, stream and relevant turn, computer and person ids. It records
sourceSubject, sourcePosition and sourceEventId. Invalid or unavailable evidence
returns the fixed `Root stop evidence refused` error and appends nothing.
The first saved stop is returned on valid retries, including a later different reason.
Only member Stop counts as requester evidence; the budget Stop form is refused.
Chat turn close, completion or failure counts as turn-end evidence. Requester removal
or close on participation, or requester removal on member, counts as access loss.
Parent removal and creator departure remain for activation reconciliation.
`libs/models/test/root-stop-evidence.test.ts` checks exact references, rejected evidence, serial
ordering, lost replies, duplicate-window expiry, old writers and PostgreSQL replay.
No new caller, reaction, route or running-turn interruption is connected here.
Trusted call ids, grant/dispatch checks and the child dispatcher remain in row 5.
There is no route, caller, running-turn fan-out or model call in this part.

## Child request contract

`conversation.child_requested` belongs to the parent conversation. Its strict schema
requires 1–97 distinct original parent joins before the source, including the requester,
and an integer allowance bound of 1–1,000 cents. Its envelope requires the server source,
a human requester principal, matching subject and command id, and no computer report.

## Hosted registration — first part of P3-6 PR 4

Hosted registration may carry a complete `installation`: attemptId 1, platform
(`linux/amd64` or `linux/arm64`) and upstream host/port. It cannot also carry a
credentialContract. Older hosted records still parse. The existing parser binds
serverId to the MCP stream subject. No new event types are added in this split.

Dated receipts and the admission GET are implemented below. Recheck commands and
evidence storage remain for part c. Image fetch, scans, deployment and evidence bytes are outside this part.
Fresh-install qualification: NOT RUN.

## Safe budget turn stop records

`agent.turn_stop_requested` accepts either the unchanged member fields or
`conversationId`, `turnId`, `reason: budget`, `stopId`. Both alternatives are strict.
The conversation contains no cents, ceiling, payer or copied budget reasons.
`stop-budget-turns` receives ceiling changes and exhaustion, including per-turn stops.
No root event is added. Stop schemas live outside the near-full `data.ts`.
The package exports `agentTurnStopRequestedDataSchema` for bridge delivery.

## Expired bearer save closure

`connection.operation_closed` requires userId, serverId, profile, operationId, generation,
expectedSequence, appendUntil and the fixed `append_deadline_passed` reason. It carries no
credential or provider outcome. The connection fold requires the fixed system principal
`models`, matching bindings, the previous position and a time after the deadline.
The event id is SHA-256 of JSON `[silo, subject, "connection.operation_closed", operationId]`.
Live reconciliation appends at the private stage's expected position. Replay only rebuilds
references and closed operations; it performs no custody, provider or release work.

## Gateway load observations

`gateway.configuration_observed` records generation, recordDigest, configDigest,
processRef, outcome (`loaded`) and observedAt on `gateway-config-<silo>`.
It is evidence from an exact live control response, not readiness or a file write.
It grants no permission. The Ready read remains unbuilt.

## Hosted image admission receipts

Defines strict signature, licence, vulnerability and malware receipts in
`mcp.image_checked`. Pass and fail require reportDigest; fail also requires short
reasonCodes. Dated verdicts carry checkedAt, expiresAt and engineVersion; scanner
verdicts also name their database digest and update date. A not_run verdict is
allowed only alongside a failed check. No report bytes or credentials are saved.

## Per-server gateway receipts

`mcp.configuration_observed` uses a strict schema in `gateway-configuration.ts`.
It records serverId, changeRef, reviewRevision, fragmentDigest, sourceSequence,
generation, recordDigest, configDigest, processRef and observedAt. These are saved
configuration references, with no request bodies or credentials. The event parser
requires the matching MCP subject. This receipt grants no call permission.

## Reviewed child answers

Final and interim text publication follow the [HTTP contract](../../docs/api/group-chats.md#reviewed-child-publication).
`childResultPublishedDataSchema` requires a SHA-256 review digest and parent-key
ciphertext. Final publications require result id, position and turn references.
Interim publications accept either all three references or none for human text.
Partial references, file fields and plaintext fields are refused.

## Gateway publication subscription

`prepare-gateway-configuration` subscribes only to `mcp.server_published`.
No event type or field was added. Withdrawal-only preparation remains deferred.

## Saved computer pausing

`takeover.pausing` names the computer, generation, Pod, takeover and affected turns.
It records bridge and supervisor epochs, `executionProof: exited` and
`quietProof: unavailable`. It grants no writer or work admission. The server saves
it only after matching receipts, with one conditional computer-stream append.
`takeover.paused` has the same binding and epochs, `quietProof: complete` and no
writer fields. `takeover.failed` has the binding and only reason `pause_timeout`.
Both are strict and keep work blocked. Replay calls neither supervisor nor bridge.
The deadline runner that calls the failure command is deferred to PR 2h.
Failed records retain the request's turn limit so an oversized intent can fail.
Signed gates and quiet proof remain capped at 64 turns.

## Budget admission refusal records

Chat `computer.turn_closed` records accept optional `budgetStopId`. Older closes
remain valid. The server keeps this reference when a spending limit refuses a
start, so a retry can record the same decision after the ceiling rises.
`decision.recorded` also covers these pre-call model denials from the server bridge.

## Relay closure observation

`egress.observed` accepts the existing strict shape or a modern strict shape with
`observationId` and `relay`. The modern record carries the close callback's safe
host, port, address, permit, byte counts, integer times and fixed reason. It permits
only unknown/error outcomes. Parse checks bind its id and commandId to the SHA-256
of JSON `[silo, permitId, "tunnel-close"]`, its exact egress stream and system/models.
New fields pass the unchanged risky-name check. Existing legacy observations remain
readable. No new event type or handler subscription is added.

## Versioned memory corrections

`memory.corrected` version 1 replaces the full encrypted value, with `expectedRevision`,
next `revision`, matching `supersedes` memory/revision and a fixed `reason` enum.
It shares written-value bounds and refuses self-dependencies and shared preferences.
The registry retains the explicit legacy alternative and example; full event parsing
checks version-1 encryption bounds and identity. No correction command is exposed yet.

## Saved approval dates and cancellation reasons

The [approval API](../../docs/api/approvals.md) defines the optional UTC fields,
first-use retention and dated permit list. Dates come from approval event envelopes,
not read tables or the read clock. `approval.cancelled` has its own strict schema
with an optional `cancelReason`; old events still parse without one. Expiry uses
`approval.expired` and has no cancellation reason. Reads preserve unknown outcomes.

`apps/server/test/approvals.test.ts` checks restart, audit rebuild, delayed reads,
recorded causes, old cancellations, retry history and identical hidden-id refusals.
The reader recognises direct requester/assistant tool-grant revocations only.
Other access refusals do not invent cancellation evidence. A missing turn and
clock-only catalogue expiry still cancel without a reason. UI, native consent,
retry delivery and fresh-install qualification remain outside this change.

## Hosted image check requests

`mcp.image_check_requested` records serverId, attemptId (at least 2), imageDigest,
platform, registrationRevision and expectedSequence. Its command id and human actor
live in the event envelope. `mcp.image_checked` accepts positive attempt numbers;
the models fold checks that each result belongs to the current requested attempt.

`cleanup-connection` subscribes to `connection.revoked` and `connection.refreshed`.
It performs live exact-generation cleanup after confirming saved profile history.
This adds no event type or payload field. Replay starts no cleanup.

## Child start failures

`conversation.child_start_failed` requires an opencrane-server system writer,
matching parent subject and command id, no report, strict fields and attempt 1–3.
`conversation.child_retry_requested` requires a human server writer, matching parent
subject and command id, no report and attempt 2–3. It carries only conversationId,
requestId, retryId, failureEventId and attempt. The command checks the original requester.
The [API](../../docs/api/group-chats.md#reviewed-child-requests) lists fixed stages and reasons.

## Native request refusals

`agent.native_request_refused` is a strict conversation record with conversationId,
turnId, nativeRequestId, requestKind (shell, file_change, permissions, user_input, other)
and outcome (declined, unsupported). It contains no callId, command, path, reason or prompt.
Elicitation uses the unchanged `agent.native_consent_refused` contract. The new record
grants no access and is excluded from chat display. The bridge reports it only for a
matching running memory-free turn while the takeover gate remains open.

## Remote tool outcomes

`tool.dispatch_started.adapter` optionally identifies `remote_https`; older records still
parse. `tool.dispatch_recorded.adapter` is a strict binding containing `decisionId`,
`startId`, `connectionId`, `generation`, `recordDigest` and `reviewRevision`. The envelope
supplies the silo. `adapter_response_received` requires this binding and `responded`;
`adapter_transport_uncertain` requires it and `outcome_unknown`. Generic gateway evidence
cannot carry the binding. `adapter_dispatch_refused` requires the same binding and
`not_dispatched`. Only a confirmed saved start refused before opening a connection
can produce this evidence; a lost start reply remains unknown.
The models process validates these references against the consumed permit and saved start.
Schema validation alone grants no authority to write an observation.

## Streaming report receipts

Only `agent.message_delta` may carry `report.preceding`: up to 63 earlier sequence/digest
pairs, strictly increasing and below `report.sequence`. All belong to the same encrypted
message delta. The outer digest identifies the last original report, not combined text.
Older reports remain valid. The bridge checks every original identity before combining.
The parser retains one validator per registered type, but validates every input afresh.
It caches no payloads, permissions or validation results.

## Explicit personal account choices

`connection.selected` is a strict select/clear union on the connection category.
Both variants bind userId, serverId, connectionId and expectedSequence. Select requires
profileId and positive profileRevision; clear omits both. The envelope supplies the human
actor and stable commandId. The models fold checks the subject, actor and deterministic
id (SHA-256 of JSON `[silo, subject, changeRef]`). No handler subscribes to this event.
Activation schemas still accept only personal ownerKind and purpose.

## Checked child activation

`conversation.child_activated` belongs to the child conversation and requires a human
server principal matching `requestedBy`, matching command/event ids and no report.
Its strict data binds the parent intent, child creation and first input by id and ordered
global position, plus the original request, assistant, payer and attempt 1–3.
No text, credentials or cents are copied. It has no reaction and grants no execution.

## Routine permission subscriptions

`update-openfga` subscribes to the existing `routine.created`, `routine.reassigned`
and `routine.retired` events. The permission library applies their modern ownership
and lifecycle changes with exact receipts. Legacy events give no routine permissions.
The [permission contract](../authz/README.robot.md#routine-permissions) describes
retired metadata, read checks and the stopped-services model/subscription upgrade.
Other routine events still start no work.

`routineControlSchema` is exported for the internal owner pause to validate and compare
saved control facts. Its event shape and subscriptions are unchanged; it starts no work.
