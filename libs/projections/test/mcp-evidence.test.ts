import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import { applyToolPolicy, emptyToolPolicy, mcpCatalogue, ProjectionRunner,
  rebuildMcpCatalogueProjection, isToolPolicyAvailable } from '../src/index.ts';
import { database } from './database.ts';

const checkedAt = '2026-10-10T12:00:00.000Z';
const expiresAt = '2026-10-10T12:05:00.000Z';
const definition = '{"inputSchema":{"type":"object"},"name":"read"}';
const revision = createHash('sha256').update(definition).digest('hex');
const revisions = JSON.stringify([{ name: 'read', revision }]);
const schemaDigest = createHash('sha256').update(revisions).digest('hex');
const emptyDigest = createHash('sha256').update('[]').digest('hex');
const discovery = { serverId: 'fixture', toolCount: 1, schemaDigest,
  checkedAt, expiresAt, tools: [{ name: 'read', revision,
    reviewed: true, definition }] };
function record(type: string, data: unknown) {
  return { ...event(type), type, subject: 'mcp-fixture', data };
}
function discovered() {
  return applyToolPolicy(emptyToolPolicy(), record('mcp.server_discovered', discovery), 1);
}

function renewsEvidence() {
  const before = discovered();
  const check = record('mcp.catalogue_checked', { serverId: 'fixture',
    schemaDigest: discovery.schemaDigest, checkedAt, expiresAt, outcome: 'unchanged' });
  const after = applyToolPolicy(before, check, 2);
  expect(after).toMatchObject({ sequence: 2, policyRevision: 1, checkedAt, expiresAt });
  expect(after.tools).toEqual(before.tools);
  expect(after.catalogue).toBe(before.catalogue);
}
it('keeps the policy revision and choices when unchanged evidence is renewed', renewsEvidence);

function retainsSnapshots() {
  const before = discovered();
  const catalogue = { ...discovery, schemaDigest: emptyDigest, toolCount: 0, tools: [] };
  const change = record('mcp.tools_changed', { serverId: 'fixture',
    previousSchemaDigest: discovery.schemaDigest, newSchemaDigest: catalogue.schemaDigest,
    catalogue });
  const after = applyToolPolicy(before, change, 2);
  expect(after.previousCatalogue).toEqual(before.catalogue);
  expect(after.catalogue).toEqual(catalogue);
  expect(after).toMatchObject({ policyRevision: 2, published: false, tools: [] });
}
it('retains before and after definitions and blocks changed tools', retainsSnapshots);

async function rebuildsEvidence() {
  const nats = await natsFixture();
  const storage = await database('pg');
  const logger = createLogger('catalogue-evidence', { level: 'silent' });
  try {
    const registration = record('mcp.server_registered', { serverId: 'fixture',
      kind: 'remote', locator: 'https://fixture.example.test', registeredBy: 'admin' });
    const capture = record('mcp.server_discovered', discovery);
    const catalogue = { ...discovery, schemaDigest: emptyDigest, toolCount: 0, tools: [] };
    const change = record('mcp.tools_changed', { serverId: 'fixture',
      previousSchemaDigest: discovery.schemaDigest, newSchemaDigest: catalogue.schemaDigest,
      catalogue });
    await nats.seed([registration, capture, change]);
    const runner = new ProjectionRunner(storage.db, nats.reader, logger);
    await runner.initialise(mcpCatalogue);
    await runner.run(mcpCatalogue);
    const before = await storage.db.query('SELECT policy FROM mcp_catalogue');
    expect(before.rows[0]?.['policy']).toMatchObject({ checkedAt, expiresAt,
      catalogue: { ...discovery, schemaDigest: emptyDigest, toolCount: 0, tools: [] },
      previousCatalogue: discovery });
    await storage.reopen();
    await rebuildMcpCatalogueProjection(storage.db, nats.reader, logger, { verify: true });
    expect((await storage.db.query('SELECT policy FROM mcp_catalogue')).rows).toEqual(before.rows);
  } finally {
    await storage.close();
    await nats.close();
  }
}
it.skipIf(!process.env['PG_TEST_URL'])(
  'rebuilds exact snapshots and original expiry from NATS', rebuildsEvidence);

function failedEvidence() {
  const published = { ...discovered(), published: true };
  expect(isToolPolicyAvailable(published, Date.parse(expiresAt))).toBe(false);
  const failure = record('mcp.catalogue_checked', { serverId: 'fixture', outcome: 'failed',
    checkedAt, reason: 'discovery_timeout' });
  const failed = applyToolPolicy(published, failure, 2);
  expect(isToolPolicyAvailable(failed, Date.parse(checkedAt))).toBe(false);
}
it('refuses expired evidence and failed checks without a timer', failedEvidence);
