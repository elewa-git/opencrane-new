# Events

For people, read [README.md](README.md) first.

This package is the typed event catalogue used by server validation and the event
core. It defines envelopes, per-type data schemas and examples; it does not
append, project or dispatch events. Its routine fold rebuilds facts in memory.

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
binding. New reservations carry `dispatchGate: 1`; older records remain readable.
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
events record the optional restricted/memory-free mode. A private tool refusal
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
The switch-on command is not built yet. It must drain running legacy turns before saving this
event; schema validation alone cannot prove that condition.

Saving switch-on advances the spending stream. A budget writer using the old position cannot
save another hold. Safe activation must replace that writer after reading the marker. This event
has no production command yet.
The switch-on command is not built yet. It must drain running legacy turns before
saving this event; schema validation alone cannot prove that condition.

Saving switch-on advances the spending stream. A budget writer using the old
position cannot save another hold. The actor can read past this marker to settle
or release holds saved before it, without a restart. It still stops when another
budget writer has saved a change. This event has no production command yet.

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
result. Custody and live membership/grant/profile checks belong to later PRs. There are no routine
subscriptions, scheduler, worker, routes, new dependencies or money ledger.
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
A `not_found` reason requires `unknown`; callable claims and secret fields are refused.
Stop records require a human principal matching `requestedBy`.
These events have no registered reaction and grant no permission or credential release.

## Expired spending holds

`budget.reservation_expired` contains only `reservationId`. It belongs to the
budget stream and closes the hold to new send permission. It changes no cents
and grants no access. The budget actor saves it before expiry uncertainty.
The actor and spending projection restore the closed hold on replay; later usage
can still settle its cost. The event catalogue and registry name the same event.

## MCP send admission

`mcp.dispatch_admitted` records one accepted send on `mcp-<server>`. It carries the
request id, connection, tool name and revision, catalogue digest and backend generation.
It contains no pass, credentials or arguments. Its conditional append orders that
call against policy and quarantine writes. No reaction sends a call on replay.
Only the catalogue write position advances; tool policy and approval revision stay stable.

## Memory cleanup completion

`memory.cleanup_recorded` version 1 names scope id/kind/owner and the initiating `changeId`.
Its only current outcome is `completed`. It requires the matching scope subject,
`opencrane-worker` source/system principal and `commandId` equal to the event id.
It contains no text, encrypted value or key reference. `cleanup-memory` subscribes to
`memory.forgotten` only. Correction cleanup and unavailable evidence remain unimplemented.
