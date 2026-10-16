import type { ChildProcess } from 'node:child_process';
import { captureDispatchCatalogue } from './integrations/watch-capture.ts';
import { conversationKeys } from './chat/keys.ts';
// The lease chooses which process runs this worker. Budget decisions still only
// append events to NATS.
import { readFile, mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { connectEventStore, isEventStoreUnavailable } from '@opencrane/event-store';
import { connectProjectionDb } from '@opencrane/projections';
import { providerSecrets, BudgetActor, startDecision, startGateway,
  ingestUsage, managedProviderCallsEnabled, mcpDispatchRouteSchema, mcpCatalogueWatch,
  gatewayConfigurationWorker
} from '@opencrane/models';
import { createLogger } from '@opencrane/observability';
import { z } from 'zod';
import type { JSONWebKeySet } from 'jose';
import { tokenIssuer } from '@opencrane/auth';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
const stop = new AbortController();
const logger = createLogger('models');
// Exit before NATS exhausts its reconnect attempts, so the supervisor can reconnect cleanly.
const MAX_EVENT_STORE_OUTAGE_MS = 15_000;

function trackEventStoreOutage(error: unknown, unavailableSince: number | undefined,
  previousErrorName: string | undefined) {
  if (!isEventStoreUnavailable(error)) throw error;
  if (unavailableSince === undefined) {
    const errorName = error instanceof Error ? error.name : typeof error;
    logger.warn({ operation: 'models.budget_tick', errorName }, 'Event store outage started');
    return { unavailableSince: Date.now(), errorName };
  }
  if (Date.now() - unavailableSince > MAX_EVENT_STORE_OUTAGE_MS) throw error;
  return { unavailableSince, errorName: previousErrorName };
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop.abort());
const db = connectProjectionDb(required('DATABASE_URL'), () => stop.abort());
const events = await connectEventStore();
const silo = required('SILO_ID');
const directory = required('MODEL_STATE_DIR');
await mkdir(directory, { recursive: true, mode: 0o700 });
const jwks = z.object({ keys: z.array(z.object({ kty: z.literal('EC'), kid: z.string(), crv: z.literal('P-256'),
  alg: z.literal('ES256').default('ES256'), use: z.literal('sig').default('sig'), x: z.string(), y: z.string() }).strict()).min(1) })
  .parse(JSON.parse(await readFile(required('MODEL_JWKS_FILE'), 'utf8'))) satisfies JSONWebKeySet;
try {
  await db.db.lock!(`budget-leader:${silo}`, async locked => {
    const actor = new BudgetActor(events.store, silo);
    await actor.start(2000, 20000, process.env['DEFAULT_PAYING_GROUP_ID'] ?? 'installation-default');
    const issuer = required('TOKEN_ISSUER');
    const signingFile = process.env['TOKEN_SIGNING_KEY_FILE'];
    let memory: Awaited<ReturnType<typeof tokenIssuer>> | undefined;
    if (signingFile) memory = await tokenIssuer({ privateKeyPath: signingFile, issuer });
    const identity = { jwks, issuer, ...(memory ? { memory } : {}) };
    const binding = { silo, apiUrl: required('OPENFGA_API_URL'),
      storeId: required('OPENFGA_STORE_ID'),
      authorizationModelId: required('OPENFGA_MODEL_ID') };
    const conversationKeyDirectory = process.env['CONVERSATION_KEYS_DIR'];
    let keys: ReturnType<typeof conversationKeys> | undefined;
    if (conversationKeyDirectory) {
      keys = conversationKeys(conversationKeyDirectory);
    }
    async function readManagedMode(timeoutMs: number) {
      try {
        return await managedProviderCallsEnabled(events.store, silo, performance.now() + timeoutMs);
      } catch {
        throw new Error('Recorded provider mode is unavailable');
      }
    }
    const managedCalls = await readManagedMode(10_000);
    const providerSecretDirectory = process.env['PROVIDER_SECRETS_DIR'];
    function modelGatewayRoute(): { managedCalls: true } | { keyFile: string } {
      if (managedCalls) {
        if (process.env['MODEL_KEY_FILE'] !== undefined) {
          throw new Error('A fallback key file is still configured after switch-on');
        }
        if (!providerSecretDirectory) {
          throw new Error('Provider custody is required after switch-on');
        }
        return { managedCalls: true };
      }
      const keyFile = process.env['MODEL_KEY_FILE'] ??
        resolve(import.meta.dirname, '../../../.keys/.openai-key');
      return { keyFile };
    }
    async function requireCurrentMode() {
      if (!managedCalls && await readManagedMode(2000)) {
        throw new Error('Managed provider calls were switched on; restart required');
      }
    }
    const modelRoute = modelGatewayRoute();
    let verification: Parameters<typeof startDecision>[5];
    if (providerSecretDirectory) {
      verification = {
        secrets: providerSecrets(providerSecretDirectory),
        gatewayUrl: `http://127.0.0.1:${required('MODEL_GATEWAY_PORT')}`,
      };
    }
    const mcpRoutes = z.array(mcpDispatchRouteSchema).parse([]);
    const controlPort = Number(required('MODEL_GATEWAY_CONTROL_PORT'));
    const gatewayBinary = required('AGENTGATEWAY_BINARY');
    async function requireDispatchLeader() {
      if (stop.signal.aborted) throw new Error('Models process stopped');
      await locked.query('SELECT 1');
    }
    function serverId(route: typeof mcpRoutes[number]) {
      return route.serverId;
    }
    async function capture(serverId: string, signal: AbortSignal) {
      function matches(route: typeof mcpRoutes[number]) {
        return route.serverId === serverId;
      }
      const route = mcpRoutes.find(matches);
      if (!route) throw new Error('Catalogue route unavailable');
      return captureDispatchCatalogue(route, signal);
    }
    const watchOptions = { serverIds: mcpRoutes.map(serverId), capture,
      requireLeader: requireDispatchLeader };
    const watch = mcpCatalogueWatch(events.store, silo, watchOptions);
    function watchFailed() {
      logger.error('MCP catalogue watch unavailable; calls remain held');
    }
    const dispatchOptions = { routes: mcpRoutes, requireLeader: requireDispatchLeader,
      requireCatalogue: watch.requireCurrent };
    const decisionPort = Number(required('MODEL_DECISION_PORT'));
    const decision = await startDecision(actor, identity, binding, decisionPort,
      keys, verification, dispatchOptions);
    let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
    let configurationWorker: ReturnType<typeof gatewayConfigurationWorker> | undefined;
    function configurationFailed(error: unknown) {
      const errorName = error instanceof Error ? error.name : typeof error;
      logger.error({ operation: 'models.gateway_configuration', errorName });
    }
    function spawned(child: ChildProcess) {
      const options = { db: db.db, store: events.store, silo, child, settings: gatewayOptions,
        configFile: gatewayOptions.configFile,
        controlPort, mode: 'live' as const,
        requireLeader: requireDispatchLeader };
      configurationWorker = gatewayConfigurationWorker(options);
    }
    const gatewayOptions = {
      binary: gatewayBinary, configFile: `${directory}/gateway.json`,
      usageFile: `${directory}/usage.jsonl`,
      ...modelRoute,
      port: Number(required('MODEL_GATEWAY_PORT')),
      readinessPort: Number(required('MODEL_READINESS_PORT')),
      decisionUrl: decision.url, issuer: required('TOKEN_ISSUER'),
      ...(process.env['MODEL_UPSTREAM'] ? { upstream: process.env['MODEL_UPSTREAM'] } : {}),
      mcpRoutes, onChildSpawn: spawned,
    };
    try {
      gateway = await startGateway(gatewayOptions);
      const usageCursor = { offset: 0 };
      let eventStoreUnavailableSince: number | undefined;
      let eventStoreUnavailableErrorName: string | undefined;
      while (!stop.signal.aborted) {
        await locked.query('SELECT 1'); // Lease connection loss must stop admission.
        watch.tick(watchFailed);
        configurationWorker!.tick(configurationFailed);
        if (!gateway.healthy()) throw new Error('Gateway stopped');
        let budgetTickSucceeded = false;
        try {
          // Check NATS availability even when no new usage needs recording.
          await events.store.head();
          await requireCurrentMode();
          await ingestUsage(actor, `${directory}/usage.jsonl`, usageCursor);
          await actor.period();
          await actor.expire();
          budgetTickSucceeded = true;
        } catch (error) {
          const outage = trackEventStoreOutage(error, eventStoreUnavailableSince,
            eventStoreUnavailableErrorName);
          eventStoreUnavailableSince = outage.unavailableSince;
          eventStoreUnavailableErrorName = outage.errorName;
        }
        if (budgetTickSucceeded && eventStoreUnavailableSince !== undefined) {
          logger.info({ operation: 'models.budget_tick', errorName: eventStoreUnavailableErrorName },
            'Event store outage ended');
          eventStoreUnavailableSince = undefined;
          eventStoreUnavailableErrorName = undefined;
        }
        await delay(100, undefined, { signal: stop.signal });
      }
    } finally {
      watch.close();
      await configurationWorker?.close();
      await gateway?.stop();
      await decision.close();
    }
  });
} catch (error) {
  if (!stop.signal.aborted) throw error;
} finally { await events.close(); await db.close(); }
