import { z } from 'zod';
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
  const changedDefinition = z.record(z.string(), z.unknown()).parse(JSON.parse(definition));
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

function refusesCheckWithoutMatchingSnapshot(kind: 'missing' | 'digest') {
  const saved = kind === 'missing' ? emptyToolPolicy() : reviewedPolicy();
  const digest = kind === 'digest' ? 'f'.repeat(64) : schemaDigest;
  const check = record('mcp.catalogue_checked', { serverId: 'fixture',
    outcome: 'unchanged', schemaDigest: digest, checkedAt, expiresAt });
  function applyCheck() {
    return applyToolPolicy(saved, check, 3);
  }
  expect(applyCheck).toThrow();
}
it.each(['missing', 'digest'] as const)(
  'refuses renewal with a %s snapshot', refusesCheckWithoutMatchingSnapshot);

function refusesDuplicateLegacyNames() {
  const legacy = { ...catalogue, checkedAt: undefined, expiresAt: undefined,
    toolCount: 2, tools: [tool, tool] };
  const discovery = record('mcp.server_discovered', legacy);
  function applyDiscovery() {
    return applyToolPolicy(emptyToolPolicy(), discovery, 1);
  }
  expect(applyDiscovery).toThrow('Duplicate tool names');
}
it('refuses duplicate names in a legacy list too', refusesDuplicateLegacyNames);

function refusesWrongSavedServer() {
  const check = record('mcp.catalogue_checked', { serverId: 'another-server',
    outcome: 'unchanged', schemaDigest, checkedAt, expiresAt }, 'test', 'mcp-another-server');
  expect(parseEventByType(check).success).toBe(true);
  function applyCheck() {
    return applyToolPolicy(reviewedPolicy(), check, 3);
  }
  expect(applyCheck).toThrow('MCP policy identity mismatch');
}
it('refuses a valid check from another server when applying this saved policy',
  refusesWrongSavedServer);

function changedCatalogue() {
  const changedDefinition = '{"description":"New behaviour","inputSchema":{"type":"object"},"name":"read"}';
  const changedRevision = createHash('sha256').update(changedDefinition).digest('hex');
  const changedTool = { ...tool, revision: changedRevision, definition: changedDefinition };
  const addedDefinition = '{"inputSchema":{"type":"object"},"name":"write"}';
  const addedRevision = createHash('sha256').update(addedDefinition).digest('hex');
  const addedTool = { ...tool, name: 'write', revision: addedRevision, definition: addedDefinition };
  const revisions = [{ name: 'read', revision: changedRevision },
    { name: 'write', revision: addedRevision }];
  const digest = createHash('sha256').update(JSON.stringify(revisions)).digest('hex');
  return { ...catalogue, toolCount: 2, schemaDigest: digest, tools: [changedTool, addedTool] };
}

function blocksChangedAndAddedTools() {
  const nextCatalogue = changedCatalogue();
  const change = record('mcp.tools_changed', { serverId: 'fixture',
    previousSchemaDigest: schemaDigest, newSchemaDigest: nextCatalogue.schemaDigest,
    catalogue: nextCatalogue });
  const state = applyToolPolicy(reviewedPolicy(), change, 3);
  expect(state.tools).toMatchObject([
    { name: 'read', reviewed: false, mode: 'block' },
    { name: 'write', reviewed: false, mode: 'block' },
  ]);
  expect(state.policyRevision).toBe(3);
  expect(state.published).toBe(false);
}
it('clears the review and mode of changed and added definitions', blocksChangedAndAddedTools);

function refusesMismatchedChange(field: 'serverId' | 'previousSchemaDigest' | 'newSchemaDigest') {
  const nextCatalogue = changedCatalogue();
  const data = { serverId: 'fixture', previousSchemaDigest: schemaDigest,
    newSchemaDigest: nextCatalogue.schemaDigest, catalogue: nextCatalogue };
  if (field === 'serverId') data.catalogue = { ...nextCatalogue, serverId: 'another-server' };
  else data[field] = 'f'.repeat(64);
  const change = record('mcp.tools_changed', data);
  function applyChange() {
    return applyToolPolicy(reviewedPolicy(), change, 3);
  }
  expect(applyChange).toThrow();
}
it.each(['serverId', 'previousSchemaDigest', 'newSchemaDigest'] as const)(
  'refuses a changed snapshot with a mismatched %s', refusesMismatchedChange);

function refusesInvalidModeChoice(kind: 'connection' | 'revision' | 'review') {
  const before = reviewedPolicy();
  const mode = { serverId: 'fixture', connectionId: 'installed', toolName: 'read',
    toolRevision: revision, mode: 'ask', setBy: 'admin' };
  let saved = before;
  if (kind === 'connection') mode.connectionId = 'another-connection';
  else if (kind === 'revision') mode.toolRevision = 'f'.repeat(64);
  else saved = { ...before, tools: [{ ...before.tools[0]!, reviewed: false, mode: 'block' }] };
  const after = applyToolPolicy(saved, record('mcp.tool_mode_set', mode), 3);
  expect(after.tools).toEqual(saved.tools);
}
it.each(['connection', 'revision', 'review'] as const)(
  'does not apply a mode with mismatched %s evidence', refusesInvalidModeChoice);
