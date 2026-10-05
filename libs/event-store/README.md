# libs/event-store

## What this is

Store events in NATS JetStream and read them in order.
An [event](../../GLOSSARY.md#event) is a saved record of one thing that happened.
This package stores the event log for one silo, OpenCrane's private installation
for one customer. It checks events before saving them and gives callers an
ordered way to read them back.

## Where it fits

This package belongs to the event core. `apps/server` saves user changes through
it, and `apps/ops` reads the log for background work. NATS JetStream is the
service that keeps and carries the saved events. The package checks event shapes
with `libs/events`.

```mermaid
flowchart LR
  server["apps/server<br/>back end"] -->|saves changes| store["libs/event-store<br/>event log"]
  ops["apps/ops<br/>background workers"] -->|reads events| store
  store -->|saves and reads| nats["NATS JetStream<br/>event service"]
  store -.-> events["libs/events<br/>event definitions"]
```

## What it is responsible for

- Save a valid event only when its expected stream position is current.
- Return the earlier result when a caller repeats the same request.
- Read one stream or follow the event log in order.
- Check that the NATS event stream keeps its history and cannot be deleted.
- Require encrypted NATS connections and the right credentials for each role.

## Processes it handles

1. **The server records a change.** It sends an event and the place it expects in
   the event list. The store saves it or reports a conflict if another change came first.
2. **A worker catches up.** It reads events after its saved position, handles them
   in order and can continue from that position after it restarts.

## How to run or test it

Run the package type check with `npm run typecheck -w libs/event-store`.
The public helper `wireSubject` turns an event stream name into its NATS name:

```ts
import { wireSubject } from '@opencrane/event-store';

const subject = wireSubject('member-alice');
```

## Where to read more

- [README.robot.md](README.robot.md): settings, exact behaviour, recovery and tests.
- [Events](../events/README.md): the event shapes checked before saving.
- [Projections](../projections/README.md): tables built from the saved event log.
- [Why NATS JetStream holds the event log](../../docs/adr/0001-event-store-nats-jetstream.md).
- [Glossary](../../GLOSSARY.md): plain meanings of shared terms.
