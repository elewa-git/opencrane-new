import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { parseEventByType } from '@opencrane/events';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { applyToolPolicy, emptyToolPolicy } from '../src/index.ts';

const checkedAt = '2026-10-10T12:00:00.000Z';
const expiresAt = '2026-10-10T12:05:00.000Z';
const definition = '{"inputSchema":{"type":"object"},"name":"read"}';
const revision = createHash('sha256').update(definition).digest('hex');
const revisionList = JSON.stringify([{ name: 'read', revision }]);
const schemaDigest = createHash('sha256').update(revisionList).digest('hex');
const tool = { name: 'read', revision, reviewed: true, definition };
const catalogue = { serverId: 'fixture', toolCount: 1, schemaDigest,
  checkedAt, expiresAt, connectionId: 'installed', accountMode: 'none', tools: [tool] };

function record(type: string, data: unknown, silo = 'test', subject = 'mcp-fixture') {
  return { ...event(type), type, subject, silo, data };
}
async function refusesAppend(forged: ReturnType<typeof record>) {
  const nats = await natsFixture();
  try {
    const result = await nats.store.append({ event: forged, expectedSequence: 0 });
    expect(result.status).toBe('rejected');
    expect(await nats.store.head(forged.subject)).toBe(0);
  } finally {
    await nats.close();
  }
}

function reviewedPolicy() {
  const discovery = record('mcp.server_discovered', catalogue);
  const state = applyToolPolicy(emptyToolPolicy(), discovery, 1);
  const mode = record('mcp.tool_mode_set', { serverId: 'fixture', connectionId: 'installed',
    toolName: 'read', toolRevision: revision, mode: 'allow', setBy: 'admin' });
  return applyToolPolicy(state, mode, 2);
}
async function refusesForgedRevision(field: 'description' | 'inputSchema' | 'outputSchema') {
  const changedDefinition = JSON.parse(definition) as Record<string, unknown>;
  if (field === 'description') changedDefinition[field] = 'Send private records';
  else changedDefinition[field] = { type: 'string' };
  const changedTool = { ...tool, definition: JSON.stringify(changedDefinition) };
  const changedCatalogue = { ...catalogue, tools: [changedTool] };
  const change = record('mcp.tools_changed', { serverId: 'fixture',
    previousSchemaDigest: schemaDigest, newSchemaDigest: schemaDigest,
    catalogue: changedCatalogue });
  await refusesAppend(change);
  expect(() => applyToolPolicy(reviewedPolicy(), change, 3)).toThrow();
}
it.each(['description', 'inputSchema', 'outputSchema'] as const)(
  'refuses changed %s bytes with the old tool revision', refusesForgedRevision);

async function refusesIncompleteSnapshot(kind: 'definition' | 'count' | 'digest' | 'name') {
  let invalid: unknown;
  if (kind === 'definition') invalid = { ...catalogue, tools: [{ ...tool, definition: undefined }] };
  else if (kind === 'count') invalid = { ...catalogue, toolCount: 2 };
  else if (kind === 'digest') invalid = { ...catalogue, schemaDigest: 'f'.repeat(64) };
  else invalid = { ...catalogue, tools: [{ ...tool, name: 'other' }] };
  const discovery = record('mcp.server_discovered', invalid);
  await refusesAppend(discovery);
  expect(() => applyToolPolicy(emptyToolPolicy(), discovery, 1)).toThrow();
}
it.each(['definition', 'count', 'digest', 'name'] as const)(
  'refuses a dated snapshot with invalid %s evidence', refusesIncompleteSnapshot);

function refusesLegacyRenewal() {
  const legacy = { ...catalogue, checkedAt: undefined, expiresAt: undefined,
    tools: [{ ...tool, definition: undefined }] };
  const saved = applyToolPolicy(emptyToolPolicy(), record('mcp.server_discovered', legacy), 1);
  const check = record('mcp.catalogue_checked', { serverId: 'fixture', outcome: 'unchanged',
    schemaDigest, checkedAt, expiresAt });
  expect(() => applyToolPolicy(saved, check, 2)).toThrow();
}
it('cannot renew a legacy list without complete saved definitions', refusesLegacyRenewal);

function refusesWrongServer() {
  const check = record('mcp.catalogue_checked', { serverId: 'another-server',
    outcome: 'unchanged', schemaDigest, checkedAt, expiresAt });
  expect(parseEventByType(check).success).toBe(false);
  expect(() => applyToolPolicy(reviewedPolicy(), check, 3)).toThrow();
}
it('cannot renew another server on this server stream even with the same digest',
  refusesWrongServer);

function refusesWrongSilo() {
  const check = record('mcp.catalogue_checked', { serverId: 'fixture',
    outcome: 'unchanged', schemaDigest, checkedAt, expiresAt }, 'another-silo');
  expect(() => applyToolPolicy(reviewedPolicy(), check, 3)).toThrow();
}
it('cannot renew the same server name in another silo', refusesWrongSilo);
