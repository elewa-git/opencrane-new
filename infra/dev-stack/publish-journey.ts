import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import { z } from 'zod';
import type { EventStore } from '@opencrane/event-store';
import { currentPublication, history, publishMcp, readToolPolicy, grantMcp, mcpGrants } from '@opencrane/models';
import { registerRemote } from '../../apps/server/src/integrations/registration.ts';
import { installWorker } from '../../apps/server/src/integrations/install-worker.ts';
import { fixtureNetwork } from './mcp-fixture.ts';
import { readEnv } from './config.ts';

export async function publishJourney(store: EventStore, silo: string, admin: string, locator: string) {
  const settings = await readEnv('binding');
  const binding = { silo, apiUrl: settings['OPENFGA_API_URL']!, storeId: settings['OPENFGA_STORE_ID']!, authorizationModelId: settings['OPENFGA_MODEL_ID']! };
  const app = Fastify();
  const worker = installWorker(app, store, silo, await fixtureNetwork());
  const { serverId } = await registerRemote(store, silo, admin, { locator });
  try { await worker.discover(serverId); } finally { await app.close(); }
  const rows = await history(store, `mcp-${serverId}`, silo);
  const discovery = z.object({ schemaDigest: z.string(), tools: z.array(z.object({ name: z.enum(['read', 'write']), revision: z.string() })) })
    .parse(rows.findLast(row => row.event.type === 'mcp.server_discovered')?.event.data);
  const commandId = randomUUID();
  const tools = discovery.tools.map(tool => ({ ...tool, mode: tool.name === 'read' ? 'allow' : 'ask', costCents: 0,
    ...(tool.name === 'write' ? { review: { action: 'Update order note', consequence: 'The recording HTTPS fixture receives this order note once.',
      targetArgument: 'order', fields: ['order', 'note'], stepUp: false } } : {}) }));
  assert.equal((await publishMcp(store, binding, admin, serverId, { commandId, expectedSequence: (await readToolPolicy(store, silo, serverId)).sequence,
    schemaDigest: discovery.schemaDigest, accountMode: 'none', tools })).status, 'appended');
  const publication = await currentPublication(store, silo, serverId);
  assert(publication, 'Journey requires a reviewed publication');
  const deadline = Date.now() + 90_000;
  while (!(await history(store, `mcp-${serverId}`, silo)).some(row => row.event.type === 'mcp.configuration_applied' &&
    z.object({ changeRef: z.literal(commandId), digest: z.literal(publication.digest) }).safeParse(row.event.data).success)) {
    assert(Date.now() < deadline, 'Exact gateway digest acknowledgement timed out'); await delay(100);
  }
  return { ...publication, async grant(granteeId: string, granteeKind: 'member' | 'assistant') {
    assert.equal((await grantMcp(store, binding, admin, serverId, { commandId: randomUUID(),
      expectedSequence: (await mcpGrants(store, silo, serverId)).sequence, granteeId, granteeKind, action: 'give' })).status, 'appended');
  } };
}
