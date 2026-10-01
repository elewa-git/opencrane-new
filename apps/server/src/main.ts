// Entry point: starts the Fastify server and attaches the WebSocket
// server to its underlying HTTP server. Run with:
//   node --experimental-strip-types src/main.ts
import { loadAuthConfig } from '@opencrane/auth';
import { connectEventStore } from '@opencrane/event-store';
import { connectMemberFeed } from '@opencrane/projections';
import { installShutdown } from './shutdown.ts';
import type { RealtimeOptions } from './realtime.ts';
import { startTelemetry } from '@opencrane/observability';
import { buildServer } from './server.ts';
import { attachWebSocketServer, WEBSOCKET_PATH } from './websocket.ts';

// A no-op unless an exporter is configured. The process owns shutdown.
startTelemetry({ serviceName: 'opencrane-server' });

const port = Number(process.env['PORT'] ?? 8080);
const host = process.env['HOST'] ?? '0.0.0.0';

const graceMs = Number(process.env['SHUTDOWN_GRACE_MS'] ?? 10_000);
if (!Number.isSafeInteger(graceMs) || graceMs < 1 || graceMs > 2_147_483_647) {
  throw new Error('SHUTDOWN_GRACE_MS must be a positive timer-safe integer');
}
const authConfig = loadAuthConfig();
const natsUrl = process.env['NATS_URL']?.trim();
const silo = process.env['SILO_ID']?.trim();
if (natsUrl && (!silo || !authConfig.expectedOrgId)) {
  throw new Error('NATS_URL requires SILO_ID and OIDC_EXPECTED_ORG_ID');
}
const events = natsUrl ? await connectEventStore(natsUrl) : undefined;
let realtime: RealtimeOptions | undefined;
const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl) {
  const apiUrl = process.env['OPENFGA_API_URL'];
  const storeId = process.env['OPENFGA_STORE_ID'];
  const authorizationModelId = process.env['OPENFGA_MODEL_ID'];
  if (!silo || !authConfig.expectedOrgId || !apiUrl || !storeId || !authorizationModelId) {
    throw new Error('DATABASE_URL requires silo, organisation and OpenFGA binding');
  }
  realtime = { feed: await connectMemberFeed(databaseUrl), binding: { apiUrl, storeId, authorizationModelId, silo } };
}
const app = buildServer(authConfig, {
  processOwnsTelemetry: true,
  ...(events && silo ? { membership: { silo, store: events.store } } : {}),
});

await app.listen({ port, host });
const sockets = attachWebSocketServer(app.server, app.log, authConfig, realtime);
installShutdown(app, sockets, graceMs, async () => {
  const results = await Promise.allSettled([
    events?.close().then(() => app.log.info('event store connection closed')),
    realtime?.feed.close(),
  ]);
  if (results.some((result) => result.status === 'rejected')) throw new Error('Resource cleanup failed');
});

app.log.info(`opencrane-server listening on http://${host}:${port} (ws at ${WEBSOCKET_PATH})`);
