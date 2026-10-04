import { pathToFileURL } from 'node:url';
import type { RemoteNetwork } from './integrations/remote.ts';
import { tokenIssuer } from '@opencrane/auth';
import { desktopConnection } from './computers/desktop.ts';
import { storageClient } from './files/storage.ts';
import { scanFile } from './files/scanner.ts';
import type { FileOptions } from './files/routes.ts';
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

// eslint-disable-next-line complexity -- Keep optional service wiring together so startup and shutdown share the same resources.
export async function serverMain(discovery: RemoteNetwork = {}) {
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
  let files: FileOptions | undefined;
  if (chat && process.env['MINIO_CREDENTIALS_FILE']) {
    const objects = storageClient(process.env['MINIO_URL']!, process.env['MINIO_CREDENTIALS_FILE']);
    files = { ...chat, objects, scan: bytes => scanFile(process.env['CLAMD_HOST'] ?? '127.0.0.1', Number(process.env['CLAMD_PORT'] ?? 43310), bytes) };
  }
  const closeBridges = chat ? await startBridges({ ...chat, ...(files ? { objects: files.objects } : {}) }, process.env['KUBECONFIG']!, process.env['KUBE_NAMESPACE']!,
    process.env['TOKEN_SIGNING_KEY_FILE']!, process.env['TOKEN_ISSUER']!) : undefined;
  const budgetDecisionUrl = process.env['MODEL_DECISION_URL'] ?? (process.env['NODE_ENV'] === 'development' ? 'http://127.0.0.1:43001' : undefined);
  const budget = budgetDecisionUrl && process.env['TOKEN_SIGNING_KEY_FILE'] && process.env['TOKEN_ISSUER'] ? {
    decisionUrl: budgetDecisionUrl,
    tokens: await tokenIssuer({ privateKeyPath: process.env['TOKEN_SIGNING_KEY_FILE'], issuer: process.env['TOKEN_ISSUER'] }),
  } : undefined;
  const app = buildServer(authConfig, {
    processOwnsTelemetry: true,
    ...(files ? { files } : {}),
    ...(chat ? { chat, liveView: { ...chat, open: desktopConnection(process.env['KUBECONFIG']!, process.env['KUBE_NAMESPACE']!) } } : {}),
    ...(realtime && events && modelDb ? { audit: { silo: realtime.binding.silo, store: events.store, db: modelDb.db, feed: realtime.feed, binding: realtime.binding } } : {}),
    ...(events && silo ? { membership: { silo, store: events.store } } : {}),
    ...(realtime && catalogue ? { integrations: { silo: realtime.binding.silo, feed: realtime.feed,
      catalogue, discovery, ...(budget ? { budget } : {}), ...(events ? { store: events.store } : {}), ...(modelDb ? { modelDb: modelDb.db } : {}), binding: realtime.binding } } : {}),
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

}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await serverMain();
