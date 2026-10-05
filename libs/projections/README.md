# libs/projections

## What this is

Build and read rebuildable PostgreSQL tables from events.
A [read table](../../GLOSSARY.md#read-table-projection) is a copy arranged so
screens can load data quickly. The package keeps tables for members, groups,
conversations, computers, tool servers and event history. The saved event log
remains the record of what happened, so these tables can be rebuilt.

## Where it fits

This package belongs to the event core. `apps/ops` runs the workers that fill its
tables, and `apps/server` reads those tables. It reads events from
`libs/event-store`, checks their shapes with `libs/events`, and writes to
PostgreSQL, the database for the read tables.

```mermaid
flowchart LR
  ops["apps/ops<br/>background workers"] -->|fills tables| projections["libs/projections<br/>read tables"]
  server["apps/server<br/>back end"] -->|reads tables| pg["PostgreSQL<br/>database"]
  projections -->|writes tables| pg
  projections -.-> store["libs/event-store<br/>saved events"]
  projections -.-> events["libs/events<br/>event definitions"]
```

## What it is responsible for

- Turn ordered events into tables that the server can read.
- Save table changes and each worker's position together in one database step.
- Rebuild supported tables from the event log; some rebuilds can replace live tables.
- Send member-change notices after the table update commits.
- Keep private conversation content out of the event-history table.
- Avoid outside actions while rebuilding tables.

## Processes it handles

1. **A member joins.** The worker reads the saved event and updates the member
   table. It saves its position with the table change, then sends a notice after
   the change commits.
2. **An operator rebuilds a table.** The worker reads the event log again and
   replaces the old table contents. Replaying events does not run reactions or
   make outside calls.

## How to run or test it

Run the package type check with `npm run typecheck -w libs/projections`.
With a runner already connected to a database, event source and logger, a worker
can use the exported `members` projection like this:

```ts
import { ProjectionRunner, members } from '@opencrane/projections';

await runner.initialise(members);
await runner.run(members);
```

## Where to read more

- [README.robot.md](README.robot.md): table details, settings, recovery and tests.
- [Event store](../event-store/README.md): the saved events used to build tables.
- [Handlers](../handlers/README.md): background reactions to saved events.
- [Why NATS JetStream holds the event log](../../docs/adr/0001-event-store-nats-jetstream.md).
- [Glossary](../../GLOSSARY.md): plain meanings of shared terms.
