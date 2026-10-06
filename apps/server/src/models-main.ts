import { conversationKeys } from './chat/keys.ts';
// The lease chooses which process runs this worker. Budget decisions still only
// append events to NATS.
import { readFile, mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { connectEventStore, isEventStoreUnavailable } from '@opencrane/event-store';
import { connectProjectionDb } from '@opencrane/projections';
import { providerSecrets, BudgetActor, startDecision, startGateway,
  ingestUsage } from '@opencrane/models';
import { createLogger } from '@opencrane/observability';
import { z } from 'zod';
import type { JSONWebKeySet } from 'jose';

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
    const identity = { jwks, issuer: required('TOKEN_ISSUER') };
    const binding = { silo, apiUrl: required('OPENFGA_API_URL'),
      storeId: required('OPENFGA_STORE_ID'),
      authorizationModelId: required('OPENFGA_MODEL_ID') };
    const conversationKeyDirectory = process.env['CONVERSATION_KEYS_DIR'];
    let keys: ReturnType<typeof conversationKeys> | undefined;
    if (conversationKeyDirectory) {
      keys = conversationKeys(conversationKeyDirectory);
    }
    const providerSecretDirectory = process.env['PROVIDER_SECRETS_DIR'];
    let verification: Parameters<typeof startDecision>[5];
    if (providerSecretDirectory) {
      verification = {
        secrets: providerSecrets(providerSecretDirectory),
        gatewayUrl: `http://127.0.0.1:${required('MODEL_GATEWAY_PORT')}`,
      };
    }
    const decisionPort = Number(required('MODEL_DECISION_PORT'));
    const decision = await startDecision(actor, identity, binding, decisionPort,
      keys, verification);
    let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
    try {
      gateway = await startGateway({ binary: required('AGENTGATEWAY_BINARY'), configFile: `${directory}/gateway.json`,
        usageFile: `${directory}/usage.jsonl`, keyFile: process.env['MODEL_KEY_FILE'] ?? resolve(import.meta.dirname, '../../../.keys/.openai-key'), port: Number(required('MODEL_GATEWAY_PORT')),
        readinessPort: Number(required('MODEL_READINESS_PORT')), decisionUrl: decision.url, issuer: required('TOKEN_ISSUER'),
        ...(process.env['MODEL_UPSTREAM'] ? { upstream: process.env['MODEL_UPSTREAM'] } : {}),
        mcpRoutes: z.array(z.object({ serverId: z.string(), connectionId: z.string(), upstream: z.string() }).strict())
          .parse(JSON.parse(process.env['MODEL_MCP_ROUTES'] ?? '[]')),
      });
      const usageCursor = { offset: 0 };
      let eventStoreUnavailableSince: number | undefined;
      let eventStoreUnavailableErrorName: string | undefined;
      while (!stop.signal.aborted) {
        await locked.query('SELECT 1'); // Lease connection loss must stop admission.
        if (!gateway.healthy()) throw new Error('Gateway stopped');
        let budgetTickSucceeded = false;
        try {
          // Check NATS availability even when no new usage needs recording.
          await events.store.head();
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
    } finally { await gateway?.stop(); await decision.close(); }
  });
} catch (error) {
  if (!stop.signal.aborted) throw error;
} finally { await events.close(); await db.close(); }
