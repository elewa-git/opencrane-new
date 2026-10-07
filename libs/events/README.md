# libs/events

## What this is

The list of every kind of event OpenCrane records, and the exact data each one carries.
An [event](../../GLOSSARY.md#event) is a saved record of one thing that happened.
This package says which event types exist and what information each one carries.
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
  server["apps/server<br/>back end"] -.-> events["libs/events<br/>events and checked tool call ids"]
  store["libs/event-store<br/>saved event log"] -.-> events
  projections["libs/projections<br/>read tables"] -.-> events
  workers["libs/handlers and apps/ops<br/>background workers"] -.-> events
  others["libs/models, libs/auth and libs/authz<br/>AI rules and permissions"] -.-> events
  computer["apps/computer<br/>report text check"] -.-> events
  events -.-> zod["Zod<br/>data checks"]
```

## What it is responsible for

- Define the wrapper every event shares (its id, its type, what it is about,
  who caused it and when), and the data each event type carries.
- Check unknown values against the right event shape.
- List which named background reactions subscribe to each event type.
- Keep its event type list in step with the [event catalogue](../../docs/architecture/events.md).

It defines tool start and finish records that exclude arguments, results and error text.
The computer and server share its check for call ids and tool names.
Tool access decisions can carry a call id. The shared text check refuses hidden
control characters before saving the id.
It also records when part of a private reply was lost before the server could save it.

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
