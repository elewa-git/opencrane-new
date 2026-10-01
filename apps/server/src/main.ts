// Entry point: starts the Fastify server and attaches the WebSocket
// server to its underlying HTTP server. Run with:
//   node --experimental-strip-types src/main.ts
import { loadAuthConfig } from '@opencrane/auth';
import { connectEventStore } from '@opencrane/event-store';
import { shutdownTelemetry, startTelemetry } from '@opencrane/observability';
import type { WebSocketServer } from 'ws';
import { buildServer } from './server.ts';
import { attachWebSocketServer, WEBSOCKET_PATH } from './websocket.ts';

// A no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set, so a laptop or CI run
// with no collector configured stays silent. buildServer() flushes it again
// when the server closes.
startTelemetry({ serviceName: 'opencrane-server' });

const port = Number(process.env['PORT'] ?? 8080);
const host = process.env['HOST'] ?? '0.0.0.0';
const shutdownGraceMs = Number(process.env['SHUTDOWN_GRACE_MS'] ?? 10_000);
if (!Number.isSafeInteger(shutdownGraceMs) || shutdownGraceMs <= 0) {
  throw new Error('SHUTDOWN_GRACE_MS must be a positive integer');
}

const authConfig = loadAuthConfig();
const natsUrl = process.env['NATS_URL']?.trim();
const silo = process.env['SILO_ID']?.trim();
if (natsUrl && (!silo || !authConfig.expectedOrgId)) {
  throw new Error('NATS_URL requires SILO_ID and OIDC_EXPECTED_ORG_ID');
}
const events = natsUrl ? await connectEventStore(natsUrl) : undefined;
const app = buildServer(authConfig, events && silo ? { membership: { silo, store: events.store } } : {});

await app.listen({ port, host });
const webSockets = attachWebSocketServer(app.server, app.log, authConfig);

app.log.info(`opencrane-server listening on http://${host}:${port} (ws at ${WEBSOCKET_PATH})`);

async function closeWebSockets(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) {
    client.close(1001, 'server shutting down');
  }

  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  const terminateTimer = setTimeout(() => {
    for (const client of server.clients) {
      client.terminate();
    }
  }, Math.min(250, shutdownGraceMs));
  terminateTimer.unref();

  try {
    await closed;
  } finally {
    clearTimeout(terminateTimer);
  }
}

async function closeTelemetry(): Promise<void> {
  let failed = false;
  let failure: unknown;
  await shutdownTelemetry((error) => {
    failed = true;
    failure = error;
    app.log.error({ err: error }, 'telemetry shutdown failed');
  });
  if (failed) {
    throw failure;
  }
}

async function closeEventStore(): Promise<void> {
  if (!events) return;
  await events.close();
  app.log.info('event store connection closed');
}

let closing = false;
const close = (signal: NodeJS.Signals): void => {
  if (closing) {
    app.log.error({ signal }, 'second termination signal forced exit');
    process.exit(1);
  }
  closing = true;

  const deadline = setTimeout(() => {
    app.log.error({ signal, shutdownGraceMs }, 'server shutdown grace period expired');
    process.exit(1);
  }, shutdownGraceMs);
  deadline.unref();

  const cleanupReserveMs = Math.min(1_000, Math.max(1, Math.floor(shutdownGraceMs / 2)));
  const forceConnections = setTimeout(() => app.server.closeAllConnections(), shutdownGraceMs - cleanupReserveMs);
  forceConnections.unref();

  const firstTasks = [
    { name: 'websocket server', promise: closeWebSockets(webSockets) },
    { name: 'Fastify', promise: app.close() },
    { name: 'telemetry', promise: closeTelemetry() },
  ];
  app.server.closeIdleConnections();

  void Promise.allSettled(firstTasks.map(({ promise }) => promise)).then(async (firstResults) => {
    const eventStoreTask = { name: 'event store', promise: closeEventStore() };
    const tasks = [...firstTasks, eventStoreTask];
    const results = [...firstResults, ...await Promise.allSettled([eventStoreTask.promise])];
    clearTimeout(deadline);
    clearTimeout(forceConnections);
    let failed = false;
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        failed = true;
        app.log.error({ err: result.reason, signal, cleanup: tasks[index]?.name }, 'server shutdown failed');
      }
    });
    process.exit(failed ? 1 : 0);
  });
};
process.on('SIGTERM', () => close('SIGTERM'));
process.on('SIGINT', () => close('SIGINT'));
