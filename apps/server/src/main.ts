// Entry point: starts the Fastify server and attaches the WebSocket
// server to its underlying HTTP server. Run with:
//   node --experimental-strip-types src/main.ts
import { startTelemetry } from '@opencrane/observability';
import { buildServer } from './server.ts';
import { attachWebSocketServer, WEBSOCKET_PATH } from './websocket.ts';

// A no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set, so a laptop or CI run
// with no collector configured stays silent. buildServer() flushes it again
// when the server closes.
startTelemetry({ serviceName: 'opencrane-server' });

const port = Number(process.env['PORT'] ?? 8080);
const host = process.env['HOST'] ?? '0.0.0.0';

const app = buildServer();

await app.listen({ port, host });
attachWebSocketServer(app.server, app.log);

app.log.info(`opencrane-server listening on http://${host}:${port} (ws at ${WEBSOCKET_PATH})`);
