import { pathToFileURL } from 'node:url';
import type { RemoteNetwork } from './integrations/remote.ts';
import { guardedMcp } from './integrations/guarded-mcp.ts';
import { publishedGateway } from './integrations/published-gateway.ts';
import { conversationKeys } from './chat/keys.ts';
// The lease elects a process; budget decisions themselves only append to NATS.
import { readFile, mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { connectEventStore } from '@opencrane/event-store';
import { connectProjectionDb } from '@opencrane/projections';
import { BudgetActor, startDecision, ingestUsage } from '@opencrane/models';
import { z } from 'zod';
import type { JSONWebKeySet } from 'jose';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
export async function modelsMain(network: RemoteNetwork = {}) {
  const stop = new AbortController();
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
      const decision = await startDecision(actor, { jwks, issuer: required('TOKEN_ISSUER') }, { silo, apiUrl: required('OPENFGA_API_URL'),
        storeId: required('OPENFGA_STORE_ID'), authorizationModelId: required('OPENFGA_MODEL_ID') }, Number(required('MODEL_DECISION_PORT')), process.env['CONVERSATION_KEYS_DIR'] ? conversationKeys(process.env['CONVERSATION_KEYS_DIR']) : undefined);
      const transport = await guardedMcp(events.store, silo, decision.takeMcpPermit, network);
      let gateway: Awaited<ReturnType<typeof publishedGateway>> | undefined;
      try {
        gateway = await publishedGateway(events.store, silo, transport.host, { binary: required('AGENTGATEWAY_BINARY'), configFile: `${directory}/gateway.json`,
          usageFile: `${directory}/usage.jsonl`, keyFile: process.env['MODEL_KEY_FILE'] ?? resolve(import.meta.dirname, '../../../.keys/.openai-key'), port: Number(required('MODEL_GATEWAY_PORT')),
          readinessPort: Number(required('MODEL_READINESS_PORT')), decisionUrl: decision.url, issuer: required('TOKEN_ISSUER'),
          ...(process.env['MODEL_UPSTREAM'] ? { upstream: process.env['MODEL_UPSTREAM'] } : {}),
        });
        while (!stop.signal.aborted) {
          await locked.query('SELECT 1'); // Lease connection loss must stop admission.
          await gateway.reconcile();
          if (!gateway.healthy()) throw new Error('Gateway stopped');
          await ingestUsage(actor, `${directory}/usage.jsonl`);
          await actor.period();
          await actor.expire();
          await delay(100, undefined, { signal: stop.signal });
        }
      } finally { await gateway?.stop(); await transport.close(); await decision.close(); }
    });
  } catch (error) {
    if (!stop.signal.aborted) throw error;
  } finally { await events.close(); await db.close(); }

}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await modelsMain();
