// Entry point: starts the Fastify server and attaches the WebSocket
// server to its underlying HTTP server. Run with:
//   node --experimental-strip-types src/main.ts
import { buildServer } from './server.ts';
import { attachWebSocketServer, WEBSOCKET_PATH } from './websocket.ts';

const port = Number(process.env['PORT'] ?? 8080);
const host = process.env['HOST'] ?? '0.0.0.0';

const app = buildServer();

await app.listen({ port, host });
attachWebSocketServer(app.server, app.log);

app.log.info(`opencrane-server listening on http://${host}:${port} (ws at ${WEBSOCKET_PATH})`);
