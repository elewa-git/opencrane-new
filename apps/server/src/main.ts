import { seedOwnership, providerSecrets } from '@opencrane/models';
import { tokenIssuer } from '@opencrane/auth';
import { desktopConnection } from './computers/desktop.ts';
import { storageClient } from './files/storage.ts';
import { scanFile } from './files/scanner.ts';
import type { FileOptions } from './files/routes.ts';
// Entry point: starts the Fastify server and attaches the WebSocket
// server to its underlying HTTP server. Run with:
//   node --experimental-strip-types src/main.ts
import { requireLegacyClosesProjected } from './chat/participation.ts';
import { conversationKeys } from './chat/keys.ts';
import { startChildRecovery } from './chat/child-recovery.ts';
import { startBridges } from './chat/start.ts';
import type { ChatOptions } from './chat/routes.ts';
import { loadAuthConfig } from '@opencrane/auth';
import { connectEventStore } from '@opencrane/event-store';
import { connectComputers, connectMcpCatalogue, connectMemberFeed, connectProjectionDb } from '@opencrane/projections';
import { installShutdown } from './shutdown.ts';
import type { RealtimeOptions } from './realtime.ts';
import { createLogger, startTelemetry } from '@opencrane/observability';
import { buildProductionServer } from './server.ts';
import { attachWebSocketServer, WEBSOCKET_PATH } from './websocket.ts';

// A no-op unless an exporter is configured. The process owns shutdown.
startTelemetry({ serviceName: 'opencrane-server' });

const port = Number(process.env['PORT'] ?? 8080);
const host = process.env['HOST'] ?? '0.0.0.0';
const heartbeatIntervalMs = Number(process.env['WS_HEARTBEAT_INTERVAL_MS'] ?? 15_000);

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
const memoryKeysConfigured = Boolean(process.env['MEMORY_KEY_DIRECTORY']?.trim());
if (databaseUrl) {
  const apiUrl = process.env['OPENFGA_API_URL'];
  const storeId = process.env['OPENFGA_STORE_ID'];
  const authorizationModelId = process.env['OPENFGA_MODEL_ID'];
  if (!silo || !authConfig.expectedOrgId || !apiUrl || !storeId || !authorizationModelId) {
    throw new Error('DATABASE_URL requires silo, organisation and OpenFGA binding');
  }
  realtime = { store: events?.store, feed: await connectMemberFeed(databaseUrl), binding: { apiUrl, storeId, authorizationModelId, silo } };
  catalogue = connectMcpCatalogue(databaseUrl);
  computers = connectComputers(databaseUrl);
  modelDb = connectProjectionDb(databaseUrl, () => undefined);
}
const personalKeyDirectory = process.env['PERSONAL_KEY_DIRECTORY']?.trim();
let onboarding: ChatOptions | undefined;
if (realtime && events && modelDb && personalKeyDirectory) {
  onboarding = { silo: realtime.binding.silo, store: events.store, db: modelDb.db,
    feed: realtime.feed, binding: realtime.binding, keys: conversationKeys(personalKeyDirectory) };
}
const keyDirectory = process.env['CONVERSATION_KEYS_DIR'];
const chat: ChatOptions | undefined = realtime && events && modelDb && keyDirectory ? { silo: realtime.binding.silo, store: events.store,
  db: modelDb.db, feed: realtime.feed, binding: realtime.binding,
  keys: conversationKeys(keyDirectory, process.env['CONVERSATION_WRAP_KEY_FILE']) } : undefined;
if (chat) await requireLegacyClosesProjected(chat.store, chat.db);
if (realtime && chat) realtime.chat = chat;
let files: FileOptions | undefined;
if (chat && process.env['MINIO_CREDENTIALS_FILE']) {
  const objects = storageClient(process.env['MINIO_URL']!, process.env['MINIO_CREDENTIALS_FILE']);
  files = { ...chat, objects, scan: bytes => scanFile(process.env['CLAMD_HOST'] ?? '127.0.0.1', Number(process.env['CLAMD_PORT'] ?? 43310), bytes) };
}
const closeBridges = chat ? await startBridges({ ...chat, ...(files ? { objects: files.objects } : {}), ...(catalogue ? { catalogue } : {}) }, process.env['KUBECONFIG']!, process.env['KUBE_NAMESPACE']!,
  process.env['TOKEN_SIGNING_KEY_FILE']!, process.env['TOKEN_ISSUER']!) : undefined;
const budgetDecisionUrl = process.env['MODEL_DECISION_URL'] ?? (process.env['NODE_ENV'] === 'development' ? 'http://127.0.0.1:43001' : undefined);
const budget = budgetDecisionUrl && process.env['TOKEN_SIGNING_KEY_FILE'] && process.env['TOKEN_ISSUER'] ? {
  decisionUrl: budgetDecisionUrl,
  tokens: await tokenIssuer({ privateKeyPath: process.env['TOKEN_SIGNING_KEY_FILE'], issuer: process.env['TOKEN_ISSUER'] }),
} : undefined;
const membership = events && silo ? {
  silo,
  store: events.store,
  ...(modelDb ? { db: modelDb.db } : {}),
} : undefined;
const app = buildProductionServer(authConfig, {
  processOwnsTelemetry: true,
  ...(onboarding ? { onboarding } : {}),
  ...(chat ? { chat, liveView: { ...chat, open: desktopConnection(process.env['KUBECONFIG']!, process.env['KUBE_NAMESPACE']!) } } : {}),
  ...(realtime && events && modelDb ? { audit: { silo: realtime.binding.silo, store: events.store, db: modelDb.db, feed: realtime.feed, binding: realtime.binding } } : {}),
  ...(files ? { files } : {}),
  ...(realtime && events && modelDb ? { providers: {
    silo: realtime.binding.silo, store: events.store, db: modelDb.db,
    feed: realtime.feed, binding: realtime.binding,
    ...(process.env['PROVIDER_SECRETS_DIR'] ? {
      secrets: providerSecrets(process.env['PROVIDER_SECRETS_DIR']) } : {}),
    ...(budget ? { verification: budget } : {}),
  } } : {}),
  ...(realtime && events && modelDb ? { groups: { silo: realtime.binding.silo, store: events.store, db: modelDb.db, feed: realtime.feed, binding: realtime.binding } } : {}),
  ...(realtime && events && modelDb ? { memberReads: {
    silo: realtime.binding.silo, store: events.store, db: modelDb.db,
    feed: realtime.feed, binding: realtime.binding,
  } } : {}),
  ...(realtime && events && modelDb ? { invitationEmail: {
    silo: realtime.binding.silo, store: events.store, db: modelDb.db,
    feed: realtime.feed, binding: realtime.binding,
  } } : {}),
  ...(realtime && events && modelDb ? { modelAccess: {
    silo: realtime.binding.silo, store: events.store, db: modelDb.db,
    feed: realtime.feed, binding: realtime.binding,
  } } : {}),
  ...(realtime && events && modelDb && memoryKeysConfigured ? { memory: {
    silo: realtime.binding.silo, store: events.store, db: modelDb.db,
    feed: realtime.feed, binding: realtime.binding,
    keyDirectory: process.env['MEMORY_KEY_DIRECTORY']!.trim(),
    ...(process.env['MEMORY_MCP_GENERATION'] ?
      { dispatchGeneration: process.env['MEMORY_MCP_GENERATION'] } : {}),
    ...(chat ? { chat } : {}),
    ...(budget ? { identity: { jwks: budget.tokens.jwks,
      issuer: process.env['TOKEN_ISSUER']! } } : {}),
  } } : {}),
  ...(realtime && events && modelDb ? { ownership: {
    silo: realtime.binding.silo, store: events.store, db: modelDb.db,
    feed: realtime.feed, binding: realtime.binding,
  } } : {}),
  ...(membership ? { membership } : {}),
  ...(realtime && events && modelDb ? { mcpInstances: {
    silo: realtime.binding.silo, store: events.store, db: modelDb.db,
    feed: realtime.feed, binding: realtime.binding,
  } } : {}),
  ...(realtime && catalogue ? { integrations: { silo: realtime.binding.silo, feed: realtime.feed,
    catalogue, discovery: {}, ...(budget ? { budget } : {}), ...(events ? { store: events.store } : {}), ...(modelDb ? { modelDb: modelDb.db } : {}), binding: realtime.binding } } : {}),
  ...(realtime && computers && events ? { computers: { store: events.store, silo: realtime.binding.silo, feed: realtime.feed,
    computers, binding: realtime.binding } } : {}),
});

if (events && silo) {
  try {
    await seedOwnership(events.store, silo);
  } catch (error) {
    // Failed seeding leaves owner commands unavailable, while sign-in and health stay usable.
    app.log.error({ err: error, operation: 'ownership.seed' }, 'Ownership seed unavailable');
  }
}
const closeChildRecovery = chat ? startChildRecovery(chat, createLogger('child-recovery')) : undefined;
const address = await app.listen({ port, host });
const sockets = attachWebSocketServer(app.server, app.log, authConfig, realtime,
  undefined, heartbeatIntervalMs);
installShutdown(app, sockets, graceMs, async () => {
  await closeChildRecovery?.();
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
