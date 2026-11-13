import { expect, it } from 'vitest';
import { databases } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { catalogueDigest, validateStoredMcpCatalogue } from '@opencrane/events/mcp-catalogue';
import { history, readToolPolicy } from '@opencrane/models';
import { createLogger } from '@opencrane/observability';
import { toolPolicySchema } from '@opencrane/protocol';
import { mcpCatalogue, pgDb, ProjectionRunner } from '@opencrane/projections';
import { captureCatalogue, ordinaryWrite, rejectedSibling } from './support/ordinary-catalogue.ts';

async function replaysSavedDigestRules() {
  const snapshot = await captureCatalogue([ordinaryWrite, rejectedSibling]);
  const legacy = { ...snapshot, schemaDigest: catalogueDigest(snapshot.tools!),
    checkedAt: '2026-11-12T12:00:00.000Z', expiresAt: '2026-11-12T12:05:00.000Z' };
  Reflect.deleteProperty(legacy, 'declared');
  Reflect.deleteProperty(legacy, 'digestVersion');
  validateStoredMcpCatalogue(legacy);
  const nats = await natsFixture();
  const storage = await databases();
  async function append(type: string, data: unknown) {
    const sequence = await nats.store.head('mcp-fixture');
    const record = { ...event(`catalogue-${sequence}`, 'mcp-fixture', type), data };
    const result = await nats.store.append({ event: record, expectedSequence: sequence });
    expect(result.status).toBe('appended');
  }
  async function catalogueRow() {
    const result = await storage.queue.query<{ policy: unknown }>(
      'SELECT policy FROM mcp_catalogue');
    return result.rows[0];
  }
  try {
    await append('mcp.server_registered', { serverId: 'fixture', kind: 'remote',
      locator: 'https://fixture.example.test/mcp', registeredBy: 'admin' });
    const stored = { ...event('legacy-discovery', 'mcp-fixture', 'mcp.server_discovered'),
      time: '2026-11-12T12:00:00.000Z', data: legacy };
    await nats.seed([stored]);
    const savedLegacy = await history(nats.store, 'mcp-fixture', 'test');
    const oldPolicy = await readToolPolicy(nats.store, 'test', 'fixture');
    expect(oldPolicy.catalogue).toEqual(legacy);
    expect(oldPolicy.tools).toMatchObject([{ name: 'write', reviewed: false, mode: 'block' }]);
    const logger = createLogger('catalogue-replay-test', { level: 'silent' });
    const runner = new ProjectionRunner(pgDb(storage.queue), nats.reader, logger);
    await runner.initialise(mcpCatalogue);
    await runner.rebuild(mcpCatalogue);
    const replayed = await catalogueRow();
    const legacyProjection = toolPolicySchema.parse(replayed?.policy);
    expect(legacyProjection.catalogue).toEqual(legacy);
    await append('mcp.server_discovered', snapshot);
    const current = await readToolPolicy(nats.store, 'test', 'fixture');
    expect(current.catalogue).toEqual(snapshot);
    await runner.run(mcpCatalogue);
    const before = await catalogueRow();
    const currentProjection = toolPolicySchema.parse(before?.policy);
    expect(currentProjection.catalogue).toEqual(snapshot);
    await runner.rebuild(mcpCatalogue);
    expect(await catalogueRow()).toEqual(before);
    const savedCurrent = await history(nats.store, 'mcp-fixture', 'test');
    expect(savedCurrent).toHaveLength(3);
    expect(savedCurrent.slice(0, 2)).toEqual(savedLegacy);
    expect(savedCurrent[2]?.event.data).toEqual(snapshot);
  } finally {
    await storage.close();
    await nats.close();
  }
}
it('replays dated accepted-only history and fresh full-list discovery through policy and rebuild',
  replaysSavedDigestRules);

async function rejectsNewCatalogueDrift() {
  const snapshot = await captureCatalogue([ordinaryWrite, rejectedSibling]);
  expect(snapshot).toMatchObject({ digestVersion: 2, declared: false });
  const changedRejected = { ...snapshot, rejectedTools: [] };
  function validateChangedRejected() {
    validateStoredMcpCatalogue(changedRejected);
  }
  expect(validateChangedRejected).toThrow('Tool catalogue digest mismatch');
  const acceptedOnlyDigest = { ...snapshot, schemaDigest: catalogueDigest(snapshot.tools!) };
  function validateAcceptedOnlyDigest() {
    validateStoredMcpCatalogue(acceptedOnlyDigest);
  }
  expect(validateAcceptedOnlyDigest).toThrow('Tool catalogue digest mismatch');
}
it('requires the full-list digest for new discoveries and detects rejected sibling drift',
  rejectsNewCatalogueDrift);
