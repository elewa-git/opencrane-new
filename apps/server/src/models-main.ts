// The lease elects a process; budget decisions themselves only append to NATS.
import { readFile, mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { connectEventStore } from '@opencrane/event-store';
import { connectProjectionDb } from '@opencrane/projections';
import { BudgetActor, startDecision, startGateway, ingestUsage } from '@opencrane/models';
import { z } from 'zod';
import type { JSONWebKeySet } from 'jose';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
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
    await actor.start();
    const decision = await startDecision(actor, jwks, { silo, apiUrl: required('OPENFGA_API_URL'),
      storeId: required('OPENFGA_STORE_ID'), authorizationModelId: required('OPENFGA_MODEL_ID') }, Number(required('MODEL_DECISION_PORT')));
    let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
    try {
      gateway = await startGateway({ binary: required('AGENTGATEWAY_BINARY'), configFile: `${directory}/gateway.json`,
        usageFile: `${directory}/usage.jsonl`, keyFile: resolve(import.meta.dirname, '../../../.keys/.openai-key'), port: Number(required('MODEL_GATEWAY_PORT')),
        readinessPort: Number(required('MODEL_READINESS_PORT')), decisionUrl: decision.url });
      while (!stop.signal.aborted) {
        await locked.query('SELECT 1'); // Lease connection loss must stop admission.
        if (!gateway.healthy()) throw new Error('Gateway stopped');
        await ingestUsage(actor, `${directory}/usage.jsonl`);
        await actor.expire();
        await delay(100, undefined, { signal: stop.signal });
      }
    } finally { await gateway?.stop(); await decision.close(); }
  });
} catch (error) {
  if (!stop.signal.aborted) throw error;
} finally { await events.close(); await db.close(); }
