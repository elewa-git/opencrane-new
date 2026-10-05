# Observability

## What this is

Shared logs and optional traces for OpenCrane services and background work. Logs are structured JSON lines, with sensitive details removed. Traces can show how long background work takes when a trace collector is configured.

## Where it fits

This shared library is used by the server, background workers and event-processing libraries. It writes logs to standard output and can send traces to a collector, a service that receives timing records.

```mermaid
flowchart LR
  server["apps/server<br/>back end"] -.-> obs["libs/observability<br/>safe logs and traces"]
  ops["apps/ops<br/>background workers"] -.-> obs
  handlers["libs/handlers<br/>event work"] -.-> obs
  projections["libs/projections<br/>read tables"] -.-> obs
  obs -->|writes logs and traces| output["Output and collector<br/>diagnostic records"]
```

## What it is responsible for

- Write structured log lines and remove sensitive fields and web address queries.
- Carry safe request details through asynchronous work.
- Record when an event handler starts, finishes or fails, and how long it takes.
- Start optional OpenTelemetry traces, timing records that link work across services.
- Flush waiting traces during shutdown and report flush failures to the caller.

## Processes it handles

1. **A service starts.** It creates a logger and turns on tracing only when a collector address is configured.
2. **A request or background job runs.** The library carries its safe identifiers into log lines. For a handler, it records the start, result and duration, then passes any failure back to the caller.
3. **A service shuts down.** It asks the tracing SDK to send waiting records and reports any flush error through the supplied callback.

## How to run or test it

```sh
npm test -- libs/observability
npm run typecheck -w libs/observability
```

A small example writes a startup log line:

```ts
import { createLogger } from '@opencrane/observability';

const logger = createLogger('example');
logger.info({ operation: 'startup' }, 'ready');
```

## Where to read more

- [README.robot.md](README.robot.md): redaction rules, settings, shutdown behaviour and tests.
- [The background workers](../../apps/ops/README.md) and [event handlers](../handlers/README.md) use these logs.
- [The glossary](../../GLOSSARY.md) explains shared system terms.
