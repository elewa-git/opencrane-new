# libs/event-store

## What this is

Store events in NATS JetStream and read them in order.
An [event](../../GLOSSARY.md#event) is a saved record of one thing that happened.
This package stores the event log for one silo, OpenCrane's private installation
for one customer. It checks events before saving them and gives callers an
ordered way to read them back.

## Where it fits

OpenCrane saves every change as an [event](../../GLOSSARY.md#event) in a log
that is never changed. Everything else, such as read tables and permissions, is
built from that log and can be rebuilt from it. This package keeps that log.
This package belongs to the event core. `apps/server` and `libs/models` save
changes through it. `apps/ops` reads the log for background work and saves the
events its reactions produce. NATS JetStream is the
service that keeps and carries the saved events. The package checks event shapes
with `libs/events`.

```mermaid
flowchart LR
  server["apps/server<br/>back end"] -->|saves changes| store["libs/event-store<br/>event log"]
  models["libs/models<br/>AI rules and budgets"] -->|saves changes| store
  ops["apps/ops<br/>background workers"] -->|reads and saves events| store
  store -->|saves and reads| nats["NATS JetStream<br/>event service"]
  store -.-> events["libs/events<br/>event definitions"]
```

## What it is responsible for

- Save a valid event only if nothing else has changed the same thing since the
  caller last read it. Otherwise report a conflict, so the caller can reload and
  try again.
- Return the earlier result when a caller repeats the same request.
- Read the history of one thing, such as one member, or follow the whole event
  log in order.
- Check that the NATS event stream keeps its history and cannot be deleted.
- Require encrypted NATS connections and the right credentials for each role.

## Processes it handles

1. **The server records a change.** It sends the new event and the number of the
   last event it saw for that thing. The store saves it, or reports a conflict if
   another change came first.
2. **A worker catches up.** It reads events after its saved position, handles them
   in order and can continue from that position after it restarts.

## How to run or test it

Run the type check and event-store tests with these commands. The test command
needs the local NATS test server fetched first. The helper `wireSubject` turns an
event stream name into its NATS name:

```sh
npm run typecheck -w libs/event-store
sh scripts/fetch-nats.sh
npx vitest run libs/event-store/test
```

```ts
import { wireSubject } from '@opencrane/event-store';

const subject = wireSubject('member-alice');
// subject is 'ev.member.alice'.
```

## Where to read more

- [README.robot.md](README.robot.md): settings, exact behaviour, recovery and tests.
- [Events](../events/README.md): the event shapes checked before saving.
- [Projections](../projections/README.md): tables built from the saved event log.
- [Why NATS JetStream holds the event log](../../docs/adr/0001-event-store-nats-jetstream.md).
- [Glossary](../../GLOSSARY.md): plain meanings of shared terms.
