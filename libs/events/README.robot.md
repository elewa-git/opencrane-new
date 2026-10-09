# Events

For people, read [README.md](README.md) first.

This package is the typed event catalogue used by server validation and the event
core. It defines envelopes, per-type data schemas and examples; it does not
append, project, dispatch or replay events.

## Public contract

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
Runtime dependency: Zod only. No app or product-domain dependency belongs here.

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
audience or offline mapping is supplied. The other old memory schemas remain.

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
Text validation limits UTF-8 to 1–4,096 bytes and refuses NUL and lone surrogates.
Source/dependency limits are 8/32; ids use 1–200 ASCII letters, digits, `_` or `-`.
Storage commands and their whole-command size limit are not implemented yet.
