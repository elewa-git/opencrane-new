import { expect, it } from 'vitest';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import { mcpCatalogue, ProjectionRunner } from '../src/index.ts';
import { mapMcpCatalogueRows } from '../src/mcp-catalogue.ts';
import { database } from './database.ts';

const registrations = [
  { name: 'startup', contract: { credentialMode: 'unknown' }, published: false },
  { name: 'memory', contract: undefined, published: true },
  { name: 'per-call', contract: { credentialMode: 'per_call' }, published: true },
];

async function preservesCredentialReview(testCase: (typeof registrations)[number]) {
  const nats = await natsFixture();
  const storage = await database('pg');
  const registration = { serverId: 'startup', kind: 'hosted', registeredBy: 'admin',
    locator: `registry.example.test/startup@sha256:${'a'.repeat(64)}`,
    credentialContract: testCase.contract };
  let sequence = 0;
  async function append(type: string, data: unknown) {
    sequence += 1;
    const saved = { ...event(`startup-${sequence}`), type, subject: 'mcp-startup', data };
    const result = await nats.store.append({ event: saved, expectedSequence: sequence - 1 });
    expect(result.status).toBe('appended');
  }
  async function catalogueRow() {
    const result = await storage.db.query('SELECT lifecycle, policy FROM mcp_catalogue');
    return result.rows[0];
  }
  try {
    await append('mcp.server_registered', registration);
    const logger = createLogger('startup-review-test', { level: 'silent' });
    const runner = new ProjectionRunner(storage.db, nats.reader, logger);
    await runner.initialise(mcpCatalogue);
    await runner.run(mcpCatalogue);
    const discovered = { serverId: 'startup', toolCount: 0, schemaDigest: 'a'.repeat(64),
      connectionId: 'forged', accountMode: 'none', tools: [] };
    await append('mcp.server_discovered', discovered);
    await append('mcp.server_published', { serverId: 'startup', publishedBy: 'admin' });
    await runner.run(mcpCatalogue);
    const before = await catalogueRow();
    const lifecycle = testCase.published ? 'published' : 'discovered';
    expect(before).toMatchObject({ lifecycle, policy: {
      startupReviewRequired: !testCase.published, published: testCase.published,
    } });
    await runner.rebuild(mcpCatalogue);
    expect(await catalogueRow()).toEqual(before);
  } finally {
    await storage.close();
    await nats.close();
  }
}
it.each(registrations)('preserves $name review through PostgreSQL updates and replay',
  preservesCredentialReview);

function refusesStartupStatus(lifecycle: string) {
  const row = { server_id: 'startup', source_kind: 'hosted' as const,
    locator: `registry.example.test/startup@sha256:${'a'.repeat(64)}`,
    catalogue_ref: null, server_name: null, server_version: null, tool_count: 0,
    lifecycle, changed_at: '2026-10-10T00:00:00Z', modes: null,
    policy: { connectionId: null, accountMode: null, sequence: 0, tools: [],
      published: false, startupReviewRequired: true },
    rejection_reason: 'connection_required' };
  const rows = mapMcpCatalogueRows([row]);
  expect(rows[0]?.status.kind).toBe(lifecycle === 'published' ? 'needs_input' : 'failed');
}
const legacyStates = ['published', 'rejected'];
it.each(legacyStates)('keeps a startup %s row unavailable in the register',
  refusesStartupStatus);

function keepsExistingMemoryReady() {
  const row = { server_id: 'memory', source_kind: 'hosted' as const,
    locator: `registry.example.test/opencrane/server@sha256:${'a'.repeat(64)}`,
    catalogue_ref: null, server_name: null, server_version: null, tool_count: 1,
    lifecycle: 'published', changed_at: '2026-10-10T00:00:00Z', modes: null };
  const rows = mapMcpCatalogueRows([row]);
  expect(rows[0]?.status.kind).toBe('ready');
}
it('keeps a published memory connection Ready without a startup contract', keepsExistingMemoryReady);
