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
function record(type: string, data: unknown, id = type) {
  return { ...event(id), type, subject: 'mcp-fixture', data };
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
    const admission = record('mcp.dispatch_admitted', { serverId: 'fixture',
      connectionId: 'installed', requestId: 'call-1', toolName: 'read',
      toolRevision: revision, schemaDigest, generation: 'instance-1' });
    const publication = record('mcp.server_published', { serverId: 'fixture',
      publishedBy: 'admin' });
    await nats.seed([registration, capture, change, admission, publication]);
    const runner = new ProjectionRunner(storage.db, nats.reader, logger);
    await runner.initialise(mcpCatalogue);
    await runner.run(mcpCatalogue);
    const before = await storage.db.query('SELECT policy FROM mcp_catalogue');
    expect(before.rows[0]?.['policy']).toMatchObject({ checkedAt, expiresAt,
      catalogue: { ...discovery, schemaDigest: emptyDigest, toolCount: 0, tools: [] },
      previousCatalogue: discovery, sequence: 5, policyRevision: 5, published: false });
    await storage.reopen();
    await rebuildMcpCatalogueProjection(storage.db, nats.reader, logger, { verify: true });
    expect((await storage.db.query('SELECT policy FROM mcp_catalogue')).rows).toEqual(before.rows);
    const registeredAgain = record('mcp.server_registered', registration.data, 'register-again');
    const capturedAgain = record('mcp.server_discovered', discovery, 'discover-again');
    const publishedAgain = record('mcp.server_published', publication.data, 'publish-again');
    await nats.seed([registeredAgain, capturedAgain, publishedAgain]);
    const restarted = new ProjectionRunner(storage.db, nats.reader, logger);
    await restarted.run(mcpCatalogue);
    const afterRestart = await storage.db.query('SELECT policy FROM mcp_catalogue');
    expect(afterRestart.rows[0]?.['policy']).toMatchObject({ published: false,
      sequence: 8, catalogue: discovery });
    await rebuildMcpCatalogueProjection(storage.db, nats.reader, logger, { verify: true });
    expect((await storage.db.query('SELECT policy FROM mcp_catalogue')).rows)
      .toEqual(afterRestart.rows);
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

function discoveryCannotReview() {
  const capture = record('mcp.server_discovered', discovery);
  const mode = record('mcp.tool_mode_set', { serverId: 'fixture', toolName: 'read',
    connectionId: 'installed', toolRevision: revision, mode: 'allow', setBy: 'admin' });
  const captured = applyToolPolicy(emptyToolPolicy(), capture, 1);
  const changed = applyToolPolicy(captured, mode, 2);
  expect(changed.tools).toMatchObject([{ reviewed: false, mode: 'block' }]);
  expect(applyToolPolicy(emptyToolPolicy(), capture, 1).tools).toEqual(changed.tools);
}
it('keeps discovery claims and legacy mode choices blocked during replay', discoveryCannotReview);

function retainsPolicyAfterAdmission() {
  const before = discovered();
  const admission = record('mcp.dispatch_admitted', { serverId: 'fixture',
    connectionId: 'installed', requestId: 'call-1', toolName: 'read',
    toolRevision: revision, schemaDigest, generation: 'instance-1' });
  const after = applyToolPolicy(before, admission, 2);
  expect(after).toEqual({ ...before, sequence: 2 });
}
it('advances the write position without changing tool policy after send admission',
  retainsPolicyAfterAdmission);

const laterEvents = ['renewal', 'discovery', 'registration'] as const;
function retainsDriftHold(laterEvent: typeof laterEvents[number]) {
  const before = discovered();
  const change = record('mcp.tools_changed', { serverId: 'fixture',
    previousSchemaDigest: schemaDigest, newSchemaDigest: schemaDigest, catalogue: discovery });
  let held = applyToolPolicy(before, change, 2);
  let later;
  if (laterEvent === 'renewal') {
    later = record('mcp.catalogue_checked', { serverId: 'fixture', outcome: 'unchanged',
      schemaDigest, checkedAt, expiresAt });
  } else if (laterEvent === 'discovery') {
    later = record('mcp.server_discovered', discovery);
  } else {
    later = record('mcp.server_registered', { serverId: 'fixture', kind: 'remote',
      locator: 'https://fixture.example.test', registeredBy: 'admin' });
  }
  held = applyToolPolicy(held, later, 3);
  const publication = record('mcp.server_published', { serverId: 'fixture',
    publishedBy: 'admin' });
  const published = applyToolPolicy(held, publication, 4);
  expect(published.published).toBe(false);
  expect(isToolPolicyAvailable(published, Date.parse(checkedAt))).toBe(false);
}
it.each(laterEvents)('keeps drift held after %s and a late publication', retainsDriftHold);
