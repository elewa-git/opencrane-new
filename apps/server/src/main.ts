import { tokenIssuer } from '@opencrane/auth';
import { desktopConnection } from './computers/desktop.ts';
// Entry point: starts the Fastify server and attaches the WebSocket
// server to its underlying HTTP server. Run with:
//   node --experimental-strip-types src/main.ts
import { conversationKeys } from './chat/keys.ts';
import { startBridges } from './chat/start.ts';
import type { ChatOptions } from './chat/routes.ts';
import { loadAuthConfig } from '@opencrane/auth';
import { connectEventStore } from '@opencrane/event-store';
import { connectComputers, connectMcpCatalogue, connectMemberFeed, connectProjectionDb } from '@opencrane/projections';
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
const events = natsUrl ? await connectEventStore() : undefined;
let realtime: RealtimeOptions | undefined;
let catalogue: ReturnType<typeof connectMcpCatalogue> | undefined;
let computers: ReturnType<typeof connectComputers> | undefined;
let modelDb: ReturnType<typeof connectProjectionDb> | undefined;
const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl) {
  const apiUrl = process.env['OPENFGA_API_URL'];
  const storeId = process.env['OPENFGA_STORE_ID'];
  const authorizationModelId = process.env['OPENFGA_MODEL_ID'];
  if (!silo || !authConfig.expectedOrgId || !apiUrl || !storeId || !authorizationModelId) {
    throw new Error('DATABASE_URL requires silo, organisation and OpenFGA binding');
  }
  realtime = { feed: await connectMemberFeed(databaseUrl), binding: { apiUrl, storeId, authorizationModelId, silo } };
  catalogue = connectMcpCatalogue(databaseUrl);
  computers = connectComputers(databaseUrl);
  modelDb = connectProjectionDb(databaseUrl, () => undefined);
}
const keyDirectory = process.env['CONVERSATION_KEYS_DIR'];
const chat: ChatOptions | undefined = realtime && events && modelDb && keyDirectory ? { silo: realtime.binding.silo, store: events.store,
  db: modelDb.db, feed: realtime.feed, binding: realtime.binding, keys: conversationKeys(keyDirectory) } : undefined;
if (realtime && chat) realtime.chat = chat;
const closeBridges = chat ? await startBridges(chat, process.env['KUBECONFIG']!, process.env['KUBE_NAMESPACE']!,
  process.env['TOKEN_SIGNING_KEY_FILE']!, process.env['TOKEN_ISSUER']!) : undefined;
const budgetDecisionUrl = process.env['MODEL_DECISION_URL'] ?? (process.env['NODE_ENV'] === 'development' ? 'http://127.0.0.1:43001' : undefined);
const budget = budgetDecisionUrl && process.env['TOKEN_SIGNING_KEY_FILE'] && process.env['TOKEN_ISSUER'] ? {
  decisionUrl: budgetDecisionUrl,
  tokens: await tokenIssuer({ privateKeyPath: process.env['TOKEN_SIGNING_KEY_FILE'], issuer: process.env['TOKEN_ISSUER'] }),
} : undefined;
const app = buildServer(authConfig, {
  processOwnsTelemetry: true,
  ...(chat ? { chat, liveView: { ...chat, open: desktopConnection(process.env['KUBECONFIG']!, process.env['KUBE_NAMESPACE']!) } } : {}),
  ...(realtime && events && modelDb ? { audit: { silo: realtime.binding.silo, store: events.store, db: modelDb.db, feed: realtime.feed, binding: realtime.binding } } : {}),
  ...(events && silo ? { membership: { silo, store: events.store } } : {}),
  ...(realtime && catalogue ? { integrations: { silo: realtime.binding.silo, feed: realtime.feed,
    catalogue, discovery: {}, ...(budget ? { budget } : {}), ...(events ? { store: events.store } : {}), ...(modelDb ? { modelDb: modelDb.db } : {}), binding: realtime.binding } } : {}),
  ...(realtime && computers ? { computers: { silo: realtime.binding.silo, feed: realtime.feed,
    computers, binding: realtime.binding } } : {}),
});

const address = await app.listen({ port, host });
const sockets = attachWebSocketServer(app.server, app.log, authConfig, realtime);
installShutdown(app, sockets, graceMs, async () => {
  await closeBridges?.();
  const results = await Promise.allSettled([
    events?.close().then(() => app.log.info('event store connection closed')),
    realtime?.feed.close(),
    catalogue?.close(),
    computers?.close(),
    modelDb?.close(),
  ]);
  if (results.some((result) => result.status === 'rejected')) throw new Error('Resource cleanup failed');
});

app.log.info(`opencrane-server listening on ${address} (ws at ${WEBSOCKET_PATH})`);
