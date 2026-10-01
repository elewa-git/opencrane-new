// Entry point: starts the Fastify server and attaches the WebSocket
// server to its underlying HTTP server. Run with:
//   node --experimental-strip-types src/main.ts
import { loadAuthConfig } from '@opencrane/auth';
import { connectEventStore } from '@opencrane/event-store';
import { startTelemetry } from '@opencrane/observability';
import { buildServer } from './server.ts';
import { attachWebSocketServer, WEBSOCKET_PATH } from './websocket.ts';

// A no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set, so a laptop or CI run
// with no collector configured stays silent. buildServer() flushes it again
// when the server closes.
startTelemetry({ serviceName: 'opencrane-server' });

const port = Number(process.env['PORT'] ?? 8080);
const host = process.env['HOST'] ?? '0.0.0.0';

const authConfig = loadAuthConfig();
const natsUrl = process.env['NATS_URL']?.trim();
const silo = process.env['SILO_ID']?.trim();
if (natsUrl && (!silo || !authConfig.expectedOrgId)) {
  throw new Error('NATS_URL requires SILO_ID and OIDC_EXPECTED_ORG_ID');
}
const events = natsUrl ? await connectEventStore(natsUrl) : undefined;
const app = buildServer(authConfig, events && silo ? { membership: { silo, store: events.store } } : {});
if (events) app.addHook('onClose', events.close);

await app.listen({ port, host });
attachWebSocketServer(app.server, app.log, authConfig);

app.log.info(`opencrane-server listening on http://${host}:${port} (ws at ${WEBSOCKET_PATH})`);
