import assert from 'node:assert/strict';
import { it, onTestFinished } from 'vitest';
import type { mcpServerRegisteredDataSchema } from '@opencrane/events';
import { databases } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { catalogueDigest, toolReviewDigest } from '@opencrane/events/mcp-catalogue';
import { envelope, history, readToolPolicy } from '@opencrane/models';
import { mcpCatalogue, pgDb } from '@opencrane/projections';
import { mapMcpCatalogueRows, type McpCatalogueRow }
  from '../../../libs/projections/src/mcp-catalogue.ts';
import { remoteCatalogueWatch } from '../src/integrations/remote-catalogue-watch.ts';
import { journeyIntegrationRegistration } from '../../../infra/dev-stack/journey-integration-fixture.ts';
import { journeyTool } from '../../../infra/dev-stack/journey-tool-policy.ts';

async function fixture(originalRemote = false) {
  const nats = await natsFixture();
  onTestFinished(nats.close);
  const storage = await databases();
  onTestFinished(storage.close);
  const db = pgDb(storage.queue);
  await mcpCatalogue.create(db);
  const serverId = 'journey-rows';
  const subject = `mcp-${serverId}`;
  async function append(type: string, data: unknown) {
    const event = envelope('test', subject, type, data);
    event.principal = { kind: 'human', id: 'owner' };
    const expectedSequence = await nats.store.head(subject);
    const result = await nats.store.append({ event, expectedSequence });
    assert.equal(result.status, 'appended');
    await mcpCatalogue.apply(db, event, result.sequence);
  }
  let registration: ReturnType<typeof mcpServerRegisteredDataSchema.parse> = journeyIntegrationRegistration(serverId);
  if (originalRemote) {
    registration = { ...registration, kind: 'remote', locator: 'https://mcp.example.test/mcp' };
  }
  await append('mcp.server_registered', registration);
  const tools = [journeyTool('read', true), journeyTool('write', false)];
  const checkedAt = new Date();
  const expiresAt = new Date(checkedAt.getTime() + 300_000);
  const catalogue = { serverId, connectionId: 'installed', accountMode: 'none',
    tools, toolCount: 2, schemaDigest: catalogueDigest(tools),
    checkedAt: checkedAt.toISOString(), expiresAt: expiresAt.toISOString(),
    serverInfo: { name: 'Journey MCP', version: '1.0.0' } };
  await append('mcp.server_discovered', catalogue);
  const policy = await readToolPolicy(nats.store, 'test', serverId);
  function choice(tool: typeof tools[number]) {
    let mode: 'allow' | 'block' = 'block';
    if (tool.name === 'read') {
      mode = 'allow';
    }
    return { name: tool.name, revision: tool.revision,
      reviewDigest: toolReviewDigest(tool), mode };
  }
  const choices = tools.map(choice);
  await append('mcp.server_reviewed', { serverId, connectionId: 'installed',
    accountMode: 'none', tools: choices,
    policyRevision: policy.policyRevision, catalogueDigest: catalogue.schemaDigest,
    reviewedBy: 'owner' });
  await append('mcp.server_published', { serverId, publishedBy: 'owner' });

  let attempts = 0;
  function unreachable() {
    attempts += 1;
    throw new Error('UNREACHABLE_SECRET_CANARY');
  }
  async function requireLeader() {}
  const watch = remoteCatalogueWatch(db, nats.store, 'test', requireLeader,
    { resolve: unreachable });
  onTestFinished(watch.close);
  async function row() {
    // Replay the watcher's saved events, just as the running projection does.
    const rows = await history(nats.store, subject, 'test');
    await mcpCatalogue.drop(db);
    await mcpCatalogue.create(db);
    for (const saved of rows) {
      await mcpCatalogue.apply(db, saved.event, saved.sequence);
    }
    const result = await db.query<McpCatalogueRow>('SELECT * FROM mcp_catalogue');
    return mapMcpCatalogueRows(result.rows)[0];
  }
  function attemptCount() {
    return attempts;
  }
  return { watch, row, nats, subject, attemptCount };
}

async function originalInterleaving() {
  const setup = await fixture(true);
  assert.equal((await setup.row())?.status.kind, 'ready');
  await assert.rejects(setup.watch.check());
  const rows = await history(setup.nats.store, setup.subject, 'test');
  function eventType(row: typeof rows[number]) {
    return row.event.type;
  }
  assert.deepEqual(rows.map(eventType), [
    'mcp.server_registered', 'mcp.server_discovered', 'mcp.server_reviewed',
    'mcp.server_published', 'mcp.catalogue_checked', 'mcp.catalogue_checked',
  ]);
  const policy = await readToolPolicy(setup.nats.store, 'test', 'journey-rows');
  assert.equal(policy.expiresAt, null);
  assert.equal((await setup.row())?.status.kind, 'disabled');
  assert.equal(setup.attemptCount(), 1);
  assert(!JSON.stringify(rows).includes('UNREACHABLE_SECRET_CANARY'));
}
it('a remote check after injected publication saves failures and removes Ready',
  originalInterleaving);

async function stableJourneyRows() {
  const setup = await fixture();
  assert.equal((await setup.row())?.status.kind, 'ready');
  // Let monitoring run between publication and the startup journey's next row read.
  await setup.watch.check().catch(checkFailed);
  const row = await setup.row();
  assert.equal(row?.status.kind, 'ready');
  assert.equal(row.name, 'Journey MCP');
  assert.equal(row.version, '1.0.0');
  assert.equal(row.toolsTotal, 2);
  assert.equal(row.toolsAllowed, 1);
  assert.equal(setup.attemptCount(), 0);
}
function checkFailed() {
  // Assert the saved row below even when the old remote fixture cannot be reached.
}
it('the typed-row journey fixture remains Ready when remote monitoring runs', stableJourneyRows);
