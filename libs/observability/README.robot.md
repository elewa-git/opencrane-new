# Observability

For people, read [README.md](README.md) first.

This package supplies structured logs, async context and manual handler spans for
Node services. The server, background workers, event handlers and projections use it
for logs. Only the server starts tracing. It does not store business truth
or guarantee delivery to a collector.

## Public contract and usage

Import `@opencrane/observability` through [src/index.ts](src/index.ts).
From the repository root:

```sh
node --experimental-strip-types --input-type=module -e "import { createLogger } from '@opencrane/observability'; createLogger('example').info({operation: 'startup'}, 'ready')"
```

This emits a JSON log line. `LOG_LEVEL` defaults to `info`.
Use `runWithContext` for safe request/entity identifiers, and `runHandler` to record
handler start/completion/failure and duration. Handler failures are rethrown; callers
own retry deadlines and duplicate-delivery behaviour. Never log personal content.
The logger redacts sensitive field names and drops entire URL queries and fragments
after serialisation, including child bindings and Error properties. Text following
a query is dropped too; Fastify route messages retain their fixed `not found` suffix.
Conversation history paths mask the conversation id. Member change paths mask both the
member id and command id, including role and removal changes. Redaction is not permission
to log secrets.
An invalid log line is replaced with a fixed error record instead of being emitted raw.

`startTelemetry` defaults to disabled unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
It creates manual OTLP/HTTP spans; there is no automatic request instrumentation.
Call `shutdownTelemetry` on shutdown and supply an error callback to report failed flushes.
The wrapper reports flush errors through that callback rather than rejecting shutdown.

## Verification and dependencies

```sh
npm test -- libs/observability
npm run typecheck -w libs/observability
```

Tests cover nested credential redaction and whole-query removal, context isolation, span identifiers,
handler success/failure and telemetry shutdown. No live collector is qualified here.
Runtime dependencies are pino and OpenTelemetry API, Node SDK and OTLP exporter.
Only the telemetry adapter imports the SDK/exporter; tests may inject disposable providers.
This package owns process-local context only. Restart loses buffered diagnostics;
event replay and business recovery belong elsewhere.
See the [architecture and plan](../../plan.md) and [engineering standard](../../docs/process/standards.md).
