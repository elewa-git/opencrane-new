# libs/projections

## What this is

Build and read rebuildable PostgreSQL tables from events.
A [read table](../../GLOSSARY.md#read-table-projection) is a copy arranged so
screens can load data quickly. The package keeps tables for members, groups,
model providers, conversations, files, computers, tool servers and a history of
who did what. The saved event log
remains the record of what happened, so these tables can be rebuilt.

## Where it fits

OpenCrane saves every change as an [event](../../GLOSSARY.md#event) in a log
that is never changed. Everything else, such as read tables and permissions, is
built from that log and can be rebuilt from it. This package builds the read
tables.
This package belongs to the event core. `apps/ops` runs the workers that fill its
tables, and `apps/server` reads those tables. It reads events from
`libs/event-store`, checks their shapes with `libs/events`, and writes to
PostgreSQL, the database for the read tables.

```mermaid
flowchart LR
  ops["apps/ops<br/>workers"] -->|fills tables| projections["libs/projections<br/>read tables, tool attempts and computer state"]
  server["apps/server<br/>back end"] -->|reads tables| pg["PostgreSQL<br/>database"]
  projections -->|writes tables| pg
  store["libs/event-store<br/>saved events"] -->|events in order| projections
  projections -.-> events["libs/events<br/>event definitions"]
```

## What it is responsible for

- Turn ordered events into tables that the server can read.
- Copy tool progress and tool access decisions into each conversation's feed.
  Keep the call id so the page can match a decision to its tool call.
- Save table changes and each worker's position together in one database step.
- Rebuild tables from the event log. The replay command rebuilds members,
  groups, model providers, budgets, the tool catalogue, computers and the
  history table while the system runs.
- Store the per-conversation encryption keys used on the dev stack, so chat text
  is only saved in encrypted form.
- Send member-change notices after the table update commits.
- Keep private conversation content out of the event-history table.
- Avoid outside actions while rebuilding tables.

Not built yet: storing those keys safely for real customers.

## Processes it handles

1. **A member joins.** The worker reads the saved event and updates the member
   table. It saves its position with the table change, then sends a notice after
   the change commits.
2. **A computer starts, sleeps or recovers.** The worker saves its current state
   and the time of its last loss. Chat pages read this small record instead of reading
   all of the computer's past events.
3. **An operator rebuilds a table.** They run `npm run replay -- members`. The
   command reads the whole event log again, builds fresh tables on the side and
   swaps them in. It does not run reactions or make outside calls.

## How to run or test it

Run the type check and focused tests with these commands. The tests need the
local NATS test server fetched first:

```sh
npm run typecheck -w libs/projections
sh scripts/fetch-nats.sh
npx vitest run libs/projections/test
```

This example connects the event store and the database, then fills the member
tables. Before you run it, set `DATABASE_URL`, set the NATS settings described
in [the event-store details](../event-store/README.robot.md), and create the
event log once with `npm run provision`.

```ts
import { connectEventStore } from '@opencrane/event-store';
import { createLogger } from '@opencrane/observability';
import { connectProjectionDb, ProjectionRunner, members } from '@opencrane/projections';

const logger = createLogger('members');
function logDatabaseError(error: Error): void {
  logger.error({ err: error }, 'Projection database connection failed');
}

const eventStore = await connectEventStore();
const database = connectProjectionDb(process.env['DATABASE_URL']!, logDatabaseError);
const runner = new ProjectionRunner(database.db, eventStore.store, logger);
await runner.initialise(members);
await runner.run(members);
await database.close();
await eventStore.close();
```

## Where to read more

- [README.robot.md](README.robot.md): table details, settings, recovery and tests.
- [Event store](../event-store/README.md): the saved events used to build tables.
- [Handlers](../handlers/README.md): background reactions to saved events.
- [Why NATS JetStream holds the event log](../../docs/adr/0001-event-store-nats-jetstream.md).
- [Glossary](../../GLOSSARY.md): plain meanings of shared terms.
