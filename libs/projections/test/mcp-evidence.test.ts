import { expect, it } from 'vitest';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import { applyToolPolicy, emptyToolPolicy, mcpCatalogue, ProjectionRunner,
  rebuildMcpCatalogueProjection } from '../src/index.ts';
import { database } from './database.ts';

const checkedAt = '2026-10-10T12:00:00.000Z';
const expiresAt = '2026-10-10T12:05:00.000Z';
const discovery = { serverId: 'fixture', toolCount: 1, schemaDigest: 'a'.repeat(64),
  checkedAt, expiresAt, tools: [{ name: 'read', revision: 'b'.repeat(64),
    reviewed: true, definition: '{"name":"read","inputSchema":{"type":"object"}}' }] };
function record(type: string, data: unknown) {
  return { ...event(type), type, subject: 'mcp-fixture', data };
}
function discovered() {
  return applyToolPolicy(emptyToolPolicy(), record('mcp.server_discovered', discovery), 1);
}

it('keeps the policy revision and choices when unchanged evidence is renewed', () => {
  const before = discovered();
  const check = record('mcp.catalogue_checked', { serverId: 'fixture',
    schemaDigest: discovery.schemaDigest, checkedAt, expiresAt, outcome: 'unchanged' });
  const after = applyToolPolicy(before, check, 2);
  expect(after).toMatchObject({ sequence: 2, policyRevision: 1, checkedAt, expiresAt });
  expect(after.tools).toEqual(before.tools);
  expect(after.catalogue).toBe(before.catalogue);
});

it('retains before and after definitions and blocks changed tools', () => {
  const before = discovered();
  const catalogue = { ...discovery, schemaDigest: 'c'.repeat(64), tools: [] };
  const change = record('mcp.tools_changed', { serverId: 'fixture',
    previousSchemaDigest: discovery.schemaDigest, newSchemaDigest: catalogue.schemaDigest,
    catalogue });
  const after = applyToolPolicy(before, change, 2);
  expect(after.previousCatalogue).toBe(before.catalogue);
  expect(after.catalogue).toEqual(catalogue);
  expect(after).toMatchObject({ policyRevision: 2, published: false, tools: [] });
});

it.skipIf(!process.env['PG_TEST_URL'])('rebuilds exact snapshots and original expiry from NATS', async () => {
  const nats = await natsFixture();
  const storage = await database('pg');
  const logger = createLogger('catalogue-evidence', { level: 'silent' });
  try {
    const registration = record('mcp.server_registered', { serverId: 'fixture',
      kind: 'remote', locator: 'https://fixture.example.test', registeredBy: 'admin' });
    const capture = record('mcp.server_discovered', discovery);
    await nats.seed([registration, capture]);
    const runner = new ProjectionRunner(storage.db, nats.reader, logger);
    await runner.initialise(mcpCatalogue);
    await runner.run(mcpCatalogue);
    const before = await storage.db.query('SELECT policy FROM mcp_catalogue');
    expect(before.rows[0]?.['policy']).toMatchObject({ checkedAt, expiresAt,
      catalogue: discovery });
    await storage.reopen();
    await rebuildMcpCatalogueProjection(storage.db, nats.reader, logger, { verify: true });
    expect((await storage.db.query('SELECT policy FROM mcp_catalogue')).rows).toEqual(before.rows);
  } finally {
    await storage.close();
    await nats.close();
  }
});
