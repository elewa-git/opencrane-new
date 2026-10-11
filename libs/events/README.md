# libs/events

## What this is

The list of every kind of event OpenCrane records, and the exact data each one carries.
An [event](../../GLOSSARY.md#event) is a saved record of one thing that happened.
This package says which event types exist and what information each one carries.
It checks new memory text and still accepts older encrypted events for replay.
It checks event data, but it does not save events or decide whether a person may act.

## Where it fits

OpenCrane saves every change as an [event](../../GLOSSARY.md#event) in a log
that is never changed. Everything else, such as read tables and permissions, is
built from that log and can be rebuilt from it. This package defines what each
event looks like.
This is shared code in the event core. The event store, background reactions,
read-table builders and `apps/server` use its event definitions and checks.
`libs/models`, `libs/auth` and `libs/authz` also use these definitions for AI rules and
permissions. `apps/ops` uses them in its background workers. The event registry
also uses Zod, a library that checks data shapes.

```mermaid
flowchart LR
  server["apps/server<br/>back end"] -.->|checks reviewed removals and memory commands and records dispatch, consent, refusals and participant facts| events["libs/events<br/>event, memory and destination checks"]
  store["libs/event-store<br/>saved event log"] -.-> events
  projections["libs/projections<br/>read tables"] -.-> events
  workers["libs/handlers and apps/ops<br/>background workers"] -.->|reads assistant and provider choices, drain changes and spending mode| events
  others["libs/models, libs/auth and libs/authz<br/>AI rules and permissions"] -.->|checks turn and spending data| events
  computer["apps/computer<br/>report text check"] -.-> events
  events -.-> zod["Zod<br/>data checks"]
```

## What it is responsible for

- Define exact HTTPS destination rules for the silo, a person or an assistant.

- Defines shared child records with a parent message, fixed payer and named people.
- Defines delegated task relationships and outcomes, including cancellation. Older records
  remain readable. These records grant no permission to run a task.

- Defines tool dispatch records, unsupported consent refusals, requester retries and safe invitation refusal records.
- Records the departure review used for a member removal. Older removals still replay.
- Defines owner appointment requests and confirmations on member records.

- Define records for pausing new model turns, cancelling that pause and switching on managed calls.
  Keep switch-on in the silo’s spending stream.
  Stop new holds while allowing existing holds to settle or be released.
- Define optional provider and binding positions on turn records and spending holds.
- Defines saved provider choices and pauses without granting model access.
- Define the wrapper every event shares (its id, its type, what it is about,
  who caused it and when), and the data each event type carries.
- Check unknown values against the right event shape.
- List which named background reactions subscribe to each event type.
- Keep its event type list in step with the [event catalogue](../../docs/architecture/events.md).

It checks recorded memory ownership fields and keeps old encrypted memory events readable for replay.
Old events without recorded ownership do not grant access. New memory writes refuse
repeated dependencies, so a bad write cannot stop table updates for other scopes.

It defines tool start and finish records that exclude arguments, results and error text.
The computer and server share its check for call ids and tool names.
Tool access decisions can carry a call id. The shared text check refuses hidden
control characters before saving the id.
It also records when part of a private reply was lost before the server could save it.
Refusal records keep a hash of the caller's command id, so that id cannot appear
as private text in the record. A hash is a fixed-length value calculated from the id.
Invitation and join events can record whether a personal assistant was requested.
Older events without that choice still parse. Email-only join events also record
the account issuer and subject. Older joins without those fields remain valid.

Group chat records name each participant explicitly. Participant changes use a
separate event stream so ordinary messages do not change access.

New group chats record at most 97 people, including their creator. Older saved
events keep their original reading rules.

Archive and read choices name one person and their join. They contain no chat text.

## Processes it handles

1. **The event store checks an event before saving it.** It passes the event to
   `parseEventByType`. A badly formed event or an unknown type is refused and
   never saved.
2. **A developer adds an event type.** The registry and event catalogue are
   updated together. `npm run check:events` checks that this list and the event
   catalogue match.

## How to run or test it

Run the type check and focused tests with these commands. A small real call is:

```sh
npm run typecheck -w libs/events
npx vitest run libs/events/test
npm run check:events
```

```ts
import { parseEventByType } from '@opencrane/events';

const result = parseEventByType({ type: 'not.registered' });
// result.success is false and result.reason is 'unknown_event_type'.
```

## Where to read more

- [README.robot.md](README.robot.md): full contracts, examples and test details.
- [Event catalogue](../../docs/architecture/events.md): what each saved event means.
- [Event store](../event-store/README.md): where events are saved.
- [Why NATS JetStream holds the event log](../../docs/adr/0001-event-store-nats-jetstream.md).
- [Glossary](../../GLOSSARY.md): plain meanings of shared terms.
